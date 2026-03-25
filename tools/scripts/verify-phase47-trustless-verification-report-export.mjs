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
  const tempDir = await mkdtemp(join(tmpdir(), 'mistyos-phase47-'))
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
  const commandButton = commandLabel.locator('xpath=ancestor::button[1]').first()
  await commandButton.waitFor({ state: 'visible', timeout: 15000 })
  const elementHandle = await commandButton.elementHandle()
  if (elementHandle) {
    await page.waitForFunction((button) => !button.hasAttribute('disabled'), elementHandle, { timeout: 20000 })
  }
  await commandButton.click()
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

  await page.getByRole('button', { name: /^Save$/ }).click()
  await page.waitForTimeout(1200)

  await invokeToolsCommand(page, /^Run Full Verification Suite \+ Export Report$/i)

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
      return Boolean(
        artifact
          && artifact.publishRevision > 0
          && artifact.restartToken
          && artifact.scenarioKind === 'full-suite',
      )
    } catch {
      return false
    }
  }, undefined, { timeout: 600000 })

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
      projectName: projectDoc?.metadata?.name || null,
      savedRevision: projectDoc?.savedDocument?.savedRevision || null,
      publishedRevision: projectDoc?.publishedDocument?.publishRevision || null,
      publishedRestartToken: projectDoc?.publishedDocument?.restartToken || null,
      latestSummary,
      latestArtifact,
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

  const exportDownloadPromise = page.waitForEvent('download')
  await invokeToolsCommand(page, /^Export Latest Verification Report$/i)
  const exportDownload = await exportDownloadPromise
  const exportedJson = await readJsonFromDownload(exportDownload)

  assert(exportedJson.artifactType === 'mistyos-runtime-verification-report', 'Unexpected verification report artifact type.')
  assert(Number(exportedJson.schemaVersion) >= 2, 'Expected schemaVersion >= 2 for verification report export.')
  assert(Boolean(exportedJson.createdAt), 'createdAt is required.')
  assert(Boolean(exportedJson.projectId), 'projectId is required.')
  if (persistedState.projectName) {
    assert(exportedJson.projectName === persistedState.projectName, 'projectName mismatch with current project metadata.')
  }

  assert(Number(exportedJson.saveRevision) >= 1, 'saveRevision is required and must be >= 1.')
  assert(exportedJson.publishRevision === persistedState.publishedRevision, 'publishRevision mismatch.')
  assert(exportedJson.restartToken === persistedState.publishedRestartToken, 'restartToken mismatch.')
  assert(Boolean(exportedJson.sceneId), 'sceneId is required.')
  assert(Boolean(exportedJson.timelineId), 'timelineId is required.')
  assert(Boolean(exportedJson.scenarioName), 'scenarioName is required.')
  assert(exportedJson.scenarioKind === 'full-suite', 'Expected full-suite verification artifact.')
  assert(Array.isArray(exportedJson.scenarios), 'scenarios must be an array for full-suite report.')
  assert(exportedJson.scenarios.length > 1, 'scenarios must include more than one scenario result.')

  assert(typeof exportedJson.overall?.pass === 'boolean', 'overall.pass is required boolean.')
  assert(Array.isArray(exportedJson.assertionResults), 'assertionResults must be an array.')
  assert(Number.isFinite(Number(exportedJson.sampleCount)), 'sampleCount is required.')
  assert(Array.isArray(exportedJson.fieldCoverage), 'fieldCoverage must be an array.')
  assert(exportedJson.fieldCoverage.length > 0, 'fieldCoverage must not be empty for full-suite report.')
  assert(Array.isArray(exportedJson.scenarioWindows), 'scenarioWindows must be an array.')

  for (const scenarioResult of exportedJson.scenarios) {
    assert(Boolean(scenarioResult.scenarioId), 'Each scenario entry must include scenarioId.')
    assert(Boolean(scenarioResult.scenarioName), 'Each scenario entry must include scenarioName.')
    assert(typeof scenarioResult.pass === 'boolean', 'Each scenario entry must include boolean pass.')
    assert(Array.isArray(scenarioResult.assertionResults), 'Each scenario entry must include assertionResults array.')
    assert(Array.isArray(scenarioResult.samples), 'Each scenario entry must include canonical samples array.')
  }

  const hasRuntimeSamples = Array.isArray(exportedJson.runtimeSamples)
  const hasBoundedPayload = Boolean(exportedJson.runtimeSamplePayload && typeof exportedJson.runtimeSamplePayload === 'object')
  assert(hasRuntimeSamples || hasBoundedPayload, 'Report must include runtimeSamples or runtimeSamplePayload.')

  assert(exportedJson.summary && typeof exportedJson.summary === 'object', 'summary object is required.')
  assert(['pass', 'fail'].includes(String(exportedJson.summary.passFail || '').toLowerCase()), 'summary.passFail is required.')

  assert(exportedJson.lineage && typeof exportedJson.lineage === 'object', 'lineage object is required.')
  assert(exportedJson.lineage.publishRevision === persistedState.publishedRevision, 'lineage.publishRevision mismatch.')
  assert(exportedJson.lineage.restartToken === persistedState.publishedRestartToken, 'lineage.restartToken mismatch.')
  assert(exportedJson.lineage.sceneId === exportedJson.sceneId, 'lineage.sceneId mismatch with top-level sceneId.')
  assert(exportedJson.lineage.timelineId === exportedJson.timelineId, 'lineage.timelineId mismatch with top-level timelineId.')

  console.log('[Phase4.7 Verify] PASS')
  console.log(JSON.stringify({
    baseUrl,
    activeProjectId: persistedState.activeProjectId,
    projectName: persistedState.projectName,
    scenario: exportedJson.scenarioName,
    scenarioCount: exportedJson.scenarios.length,
    pass: exportedJson.overall?.pass,
    publishRevision: exportedJson.publishRevision,
    restartToken: exportedJson.restartToken,
  }, null, 2))
} finally {
  await browser.close()
}
