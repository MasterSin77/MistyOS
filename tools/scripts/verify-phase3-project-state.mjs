import { chromium } from 'playwright'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

async function readJsonFromDownload(download) {
  const tempDir = await mkdtemp(join(tmpdir(), 'mistyos-phase3-'))
  const targetPath = join(tempDir, download.suggestedFilename())
  await download.saveAs(targetPath)
  const contents = await readFile(targetPath, 'utf8')
  await rm(tempDir, { recursive: true, force: true })
  return JSON.parse(contents)
}

const baseUrl = process.env.MISTYOS_BASE_URL || 'http://127.0.0.1:5176'

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ acceptDownloads: true })
const page = await context.newPage()

try {
  await page.goto(`${baseUrl}/studio`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.studio-footer-status', { timeout: 15000 })

  await page.evaluate(() => localStorage.clear())
  await page.goto(`${baseUrl}/studio`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.studio-footer-status', { timeout: 15000 })

  const statusTextInitial = await page.locator('.studio-footer-status').innerText()
  assert(/Project:\s*Project 1/i.test(statusTextInitial), 'Initial active project was not Project 1.')

  // Create an edit then Save.
  await page.locator('.tl-track-row--state').first().click({ position: { x: 100, y: 10 } })
  await page.getByRole('button', { name: 'Save' }).click()
  await page.waitForFunction(() => /Saved:\s*r\d+/i.test(document.querySelector('.studio-footer-status')?.textContent || ''))

  // Save As should create a new project, set active, and reset saved revision to 1.
  page.once('dialog', (dialog) => dialog.accept('Phase3 SaveAs Project'))
  await page.keyboard.press('Alt+f')
  const saveAsLabel = page.locator('.studio-menu-command-label', { hasText: /^Save As$/i }).first()
  await saveAsLabel.locator('xpath=ancestor::button[1]').click()

  await page.waitForFunction(() => {
    const text = document.querySelector('.studio-footer-status')?.textContent || ''
    return /Project:\s*Phase3 SaveAs Project/i.test(text) && /Saved:\s*r1/i.test(text)
  })

  // Switch back to the original project via command path and confirm footer updates.
  await page.keyboard.press('Alt+f')
  await page.locator('.studio-menu-cascade-trigger', { hasText: 'Context' }).first().hover()
  const switchProjectLabel = page.locator('.studio-menu-command-label', { hasText: /Switch to /i }).first()
  await switchProjectLabel.locator('xpath=ancestor::button[1]').click()
  await page.waitForFunction(() => /Project:\s*Project 1/i.test(document.querySelector('.studio-footer-status')?.textContent || ''))

  // Import should create a new project identity and show warning when references are missing.
  const importPayload = {
    type: 'mistyos-project',
    metadata: { name: 'Imported Missing Refs' },
    runtimePayload: {
      schemaVersion: 1,
      selectedSceneId: 'missing-scene',
      selectedPresetId: 'missing-preset',
      selectedTimelineId: 'missing-timeline',
      normalizedClips: [],
      authoredTimeline: null,
      loopPlayback: true,
      settingsSnapshot: {},
    },
  }

  page.once('dialog', (dialog) => dialog.accept())
  await page.locator('.studio-hidden-input').setInputFiles({
    name: 'imported-project.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(importPayload), 'utf8'),
  })

  await page.waitForFunction(() => {
    const text = document.querySelector('.studio-footer-status')?.textContent || ''
    return /Project:\s*Imported Missing Refs/i.test(text) && /Warning:/i.test(text)
  })

  // Export full authoring state JSON.
  await page.keyboard.press('Alt+f')
  await page.locator('.studio-menu-cascade-trigger', { hasText: 'Export' }).first().hover()
  const authoringDownloadPromise = page.waitForEvent('download')
  const exportAuthoringLabel = page.locator('.studio-menu-command-label', { hasText: 'Export Authoring State' }).first()
  await exportAuthoringLabel.locator('xpath=ancestor::button[1]').click()
  const authoringDownload = await authoringDownloadPromise
  const authoringJson = await readJsonFromDownload(authoringDownload)

  assert(authoringJson.type === 'mistyos-project', 'Export Authoring State did not produce mistyos-project JSON.')
  assert(authoringJson.metadata && authoringJson.metadata.projectId, 'Export Authoring State missing project metadata.')
  assert(authoringJson.workingRuntimePayload && typeof authoringJson.workingRuntimePayload === 'object', 'Export Authoring State missing workingRuntimePayload.')
  assert(authoringJson.savedDocument && authoringJson.savedDocument.runtimePayload, 'Export Authoring State missing savedDocument payload.')

  // Export runtime payload JSON.
  await page.keyboard.press('Alt+f')
  await page.locator('.studio-menu-cascade-trigger', { hasText: 'Export' }).first().hover()
  const runtimeDownloadPromise = page.waitForEvent('download')
  const exportRuntimeLabel = page.locator('.studio-menu-command-label', { hasText: 'Export Runtime Payload' }).first()
  await exportRuntimeLabel.locator('xpath=ancestor::button[1]').click()
  const runtimeDownload = await runtimeDownloadPromise
  const runtimeJson = await readJsonFromDownload(runtimeDownload)

  assert(runtimeJson.type === 'mistyos-runtime-payload', 'Export Runtime Payload did not produce expected JSON type.')
  assert(runtimeJson.runtimePayload && typeof runtimeJson.runtimePayload === 'object', 'Export Runtime Payload missing runtimePayload object.')

  console.log('[Phase3 Verify] PASS')
  console.log(JSON.stringify({ baseUrl, activeProject: 'Imported Missing Refs' }, null, 2))
} finally {
  await browser.close()
}
