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
  const tempDir = await mkdtemp(join(tmpdir(), 'mistyos-phase46-'))
  const targetPath = join(tempDir, download.suggestedFilename())
  await download.saveAs(targetPath)
  const contents = await readFile(targetPath, 'utf8')
  await rm(tempDir, { recursive: true, force: true })
  return JSON.parse(contents)
}

async function invokeToolsCommand(page, commandLabelRegex) {
  await page.keyboard.press('Alt+t')
  const commandLabel = page.locator('.studio-menu-command-label', { hasText: commandLabelRegex }).first()
  await commandLabel.waitFor({ state: 'visible', timeout: 15000 })
  await commandLabel.locator('xpath=ancestor::button[1]').click()
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

  // Save to satisfy the existing publish workflow gate.
  await page.getByRole('button', { name: /^Save$/ }).click()
  await page.waitForFunction(() => /Saved:\s*r\d+/i.test(document.querySelector('.studio-footer-status')?.textContent || ''))

  // Force scenario to lineage check so this script is independent of authored weather content.
  await page.evaluate(() => {
    const groups = Array.from(document.querySelectorAll('.inspector-group'))
    const verificationGroup = groups.find((group) => group.querySelector('h4')?.textContent?.includes('Verification'))
    const select = verificationGroup?.querySelector('select')
    if (!select) {
      throw new Error('Verification scenario select was not found.')
    }

    const option = Array.from(select.options).find((entry) => entry.text.includes('Save/Publish/Restart Lineage Check'))
    if (!option) {
      throw new Error('Lineage check scenario option was not found.')
    }

    select.value = option.value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })

  // Command path: run verification from Tools menu.
  await invokeToolsCommand(page, /^Run Verification$/i)

  await page.waitForFunction(() => {
    try {
      const parse = (key) => {
        const raw = localStorage.getItem(key)
        return raw ? JSON.parse(raw) : null
      }

      const index = parse('mistyos.verification.artifacts.index.v1') || []
      if (!Array.isArray(index) || index.length === 0) {
        return false
      }

      const latest = index[0]
      if (!latest?.artifactId) {
        return false
      }

      const artifact = parse(`mistyos.verification.artifact.v1.${latest.artifactId}`)
      return Boolean(artifact && artifact.publishRevision > 0 && artifact.restartToken)
    } catch {
      return false
    }
  }, { timeout: 20000 })

  const persistedState = await page.evaluate(() => {
    const parse = (key) => {
      const raw = localStorage.getItem(key)
      return raw ? JSON.parse(raw) : null
    }

    const activeProjectId = parse('mistyos.authoring.activeProjectId.v1')?.projectId || null
    const projectDoc = activeProjectId ? parse(`mistyos.authoring.project.v1.${activeProjectId}`) : null
    const index = parse('mistyos.verification.artifacts.index.v1') || []
    const latestSummary = Array.isArray(index) ? index[0] : null
    const latestArtifact = latestSummary?.artifactId
      ? parse(`mistyos.verification.artifact.v1.${latestSummary.artifactId}`)
      : null

    return {
      activeProjectId,
      publishedRevision: projectDoc?.publishedDocument?.publishRevision || null,
      publishedRestartToken: projectDoc?.publishedDocument?.restartToken || null,
      latestSummary,
      latestArtifact,
      studioText: document.body.textContent || '',
    }
  })

  assert(persistedState.latestSummary, 'Verification artifact index did not include a latest summary.')
  assert(persistedState.latestArtifact, 'Verification artifact payload was not persisted.')
  assert(
    persistedState.latestArtifact.publishRevision === persistedState.publishedRevision,
    'Artifact publishRevision does not match current published lineage.',
  )
  assert(
    persistedState.latestArtifact.restartToken === persistedState.publishedRestartToken,
    'Artifact restartToken does not match current published lineage.',
  )
  assert(/Last Status/i.test(persistedState.studioText), 'Studio verification surface is missing Last Status row.')
  assert(/Pass\/Fail/i.test(persistedState.studioText), 'Studio verification surface is missing Pass/Fail row.')

  // Command path: export the latest verification artifact JSON.
  const exportDownloadPromise = page.waitForEvent('download')
  await invokeToolsCommand(page, /^Export Latest Verification Report$/i)
  const exportDownload = await exportDownloadPromise
  const exportedJson = await readJsonFromDownload(exportDownload)

  assert(
    exportedJson.artifactType === 'mistyos-runtime-verification-report'
      || exportedJson.artifactType === 'mistyos-runtime-verification',
    'Exported artifact JSON has unexpected type.',
  )
  assert(
    exportedJson.publishRevision === persistedState.publishedRevision,
    'Exported artifact publishRevision does not match current published lineage.',
  )
  assert(
    exportedJson.restartToken === persistedState.publishedRestartToken,
    'Exported artifact restartToken does not match current published lineage.',
  )

  // Presentation DEV linkage should show latest verification status for current published run.
  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.presentation-runtime-meta', { timeout: 15000 })

  const presentationText = await page.locator('.presentation-runtime-meta').innerText()
  assert(/verificationScenario:/i.test(presentationText), 'Presentation runtime meta is missing verification scenario linkage.')
  assert(/verificationPassFail:/i.test(presentationText), 'Presentation runtime meta is missing pass/fail linkage.')
  assert(/verificationPublishRevision:/i.test(presentationText), 'Presentation runtime meta is missing publishRevision linkage.')
  assert(/verificationRestartToken:/i.test(presentationText), 'Presentation runtime meta is missing restartToken linkage.')

  console.log('[Phase4.6 Verify] PASS')
  console.log(JSON.stringify({
    baseUrl,
    activeProjectId: persistedState.activeProjectId,
    scenario: exportedJson.scenarioName,
    pass: exportedJson.pass,
    publishRevision: exportedJson.publishRevision,
    restartToken: exportedJson.restartToken,
  }, null, 2))
} finally {
  await browser.close()
}
