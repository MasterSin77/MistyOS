import { chromium } from 'playwright'

const BASE_URL = process.env.MISTYOS_BASE_URL || 'http://127.0.0.1:5180'
const TIMELINES = ['default-atmosphere', 'runner-carve-diagnosis']

async function publishTimelineToActiveProject(page, timelineId) {
  const updated = await page.evaluate((targetTimelineId) => {
    const registryRaw = localStorage.getItem('mistyos.authoring.projects.v1')
    const activeProjectRaw = localStorage.getItem('mistyos.authoring.activeProjectId.v1')
    const registry = registryRaw ? JSON.parse(registryRaw) : { projects: [] }
    const activeProjectEntry = activeProjectRaw ? JSON.parse(activeProjectRaw) : {}

    const activeProjectId = String(
      activeProjectEntry?.projectId || registry?.projects?.[0]?.projectId || '',
    ).trim()

    if (!activeProjectId) {
      return { ok: false, reason: 'missing-active-project' }
    }

    const projectKey = `mistyos.authoring.project.v1.${activeProjectId}`
    const projectRaw = localStorage.getItem(projectKey)
    if (!projectRaw) {
      return { ok: false, reason: 'missing-project-document', activeProjectId }
    }

    const project = JSON.parse(projectRaw)
    const sourcePayload = project?.savedDocument?.runtimePayload || project?.publishedDocument?.runtimePayload || null
    const runtimePayload = sourcePayload
      ? JSON.parse(JSON.stringify(sourcePayload))
      : {
        schemaVersion: 1,
        selectedSceneId: null,
        selectedPresetId: null,
        selectedTimelineId: targetTimelineId,
        startupMode: 'immediate',
        timelineDurationSec: targetTimelineId === 'runner-carve-diagnosis' ? 70 : 180,
        loopPlayback: true,
        normalizedClips: [],
        authoredTimeline: null,
        settingsSnapshot: {},
      }

    runtimePayload.selectedTimelineId = targetTimelineId
    runtimePayload.authoredTimeline = null

    const nowIso = new Date().toISOString()
    const nextSavedRevision = Number(project?.savedDocument?.savedRevision || 0) + 1
    const nextPublishRevision = Number(project?.publishedDocument?.publishRevision || 0) + 1

    project.savedDocument = {
      schemaVersion: 1,
      savedRevision: nextSavedRevision,
      savedAt: nowIso,
      runtimePayload,
    }

    project.publishedDocument = {
      schemaVersion: 1,
      publishRevision: nextPublishRevision,
      publishedAt: nowIso,
      restartToken: `playwright-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      fromSavedRevision: nextSavedRevision,
      runtimePayload,
    }

    project.metadata = {
      ...(project.metadata || {}),
      updatedAt: nowIso,
      lastPublishedAt: nowIso,
    }

    localStorage.setItem(projectKey, JSON.stringify(project))
    localStorage.setItem('mistyos.authoring.activeProjectId.v1', JSON.stringify({ projectId: activeProjectId }))

    return {
      ok: true,
      activeProjectId,
      projectKey,
      publishRevision: nextPublishRevision,
      timelineId: targetTimelineId,
    }
  }, timelineId)

  if (!updated?.ok) {
    throw new Error(`Unable to publish timeline ${timelineId}: ${updated?.reason || 'unknown'}`)
  }

  return updated
}

async function collectRuntimeSnapshot(page) {
  return page.evaluate(() => {
    const rainDebug = window.__MISTYOS_PRESENTATION_RAIN_DEBUG || null
    const runtime = window.__MISTYOS_PRESENTATION_RUNTIME || null

    return {
      hasRainDebug: Boolean(rainDebug),
      hasRuntimeControls: Boolean(runtime?.resetTimeToZero && runtime?.seekFirstRainWindow),
      rainDebug,
      clockDebug: runtime?.clockDebug || null,
      hasCurrentTimeText: Boolean(document.body.innerText.includes('currentTimeSec:')),
      hasLoopTimeText: Boolean(document.body.innerText.includes('loopTimeSec:')),
      hasDurationText: Boolean(document.body.innerText.includes('durationSec:')),
    }
  })
}

async function runTimelineValidation(page, timelineId) {
  const published = await publishTimelineToActiveProject(page, timelineId)

  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__MISTYOS_PRESENTATION_RAIN_DEBUG && window.__MISTYOS_PRESENTATION_RUNTIME)

  const initial = await collectRuntimeSnapshot(page)

  await page.getByRole('button', { name: 'Reset Time 0.0' }).click()
  await page.waitForTimeout(150)
  const afterReset = await collectRuntimeSnapshot(page)

  await page.getByRole('button', { name: 'Seek First Rain Window' }).click()
  await page.waitForTimeout(120)
  const afterSeek = await collectRuntimeSnapshot(page)

  const resetTimeSec = Number(afterReset?.rainDebug?.currentTimeSec || 0)
  const seekRainIntensity = Number(afterSeek?.rainDebug?.rainIntensity || 0)
  const seekActiveRainClipCount = Number(afterSeek?.rainDebug?.activeRainClipCount || 0)

  const assertions = {
    hasMetadataTimeFields: Boolean(
      initial.hasCurrentTimeText && initial.hasLoopTimeText && initial.hasDurationText,
    ),
    resetSetsTimeNearZero: resetTimeSec <= 0.5,
    seekFindsNonZeroRain: seekRainIntensity > 0,
    seekFindsActiveRainClips: seekActiveRainClipCount > 0,
    runtimeControlsPresent: Boolean(initial.hasRuntimeControls),
  }

  return {
    timelineId,
    publishRevision: published.publishRevision,
    initial,
    afterReset,
    afterSeek,
    assertions,
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()

  try {
    await page.goto(`${BASE_URL}/studio`, { waitUntil: 'domcontentloaded' })

    const results = []
    for (const timelineId of TIMELINES) {
      const result = await runTimelineValidation(page, timelineId)
      results.push(result)
    }

    console.log(JSON.stringify({
      baseUrl: BASE_URL,
      validatedTimelines: TIMELINES,
      results,
    }, null, 2))
  } finally {
    await context.close()
    await browser.close()
  }
}

main().catch((error) => {
  console.error('[verify-presentation-time-controls] Failed:', error)
  process.exitCode = 1
})
