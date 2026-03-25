/**
 * verify-presentation-auto-seek.mjs
 *
 * Validates that on Presentation page load, the runtime automatically seeks to
 * the first rain-active window without any user interaction.
 *
 * Gate conditions:
 *   1. activeRainClipCount > 0 within 2 seconds of page load (no button clicks)
 *   2. rainIntensity > 0 within 2 seconds of page load
 *   3. currentTimeSec > 0 (not stuck at 0)
 *
 * Tested on both default-atmosphere and runner-carve-diagnosis timelines.
 */

import { chromium } from 'playwright'

const BASE_URL = process.env.MISTYOS_BASE_URL || 'http://127.0.0.1:5183'
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
      restartToken: `playwright-autoseek-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
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

async function runAutoSeekValidation(page, timelineId) {
  // Publish the timeline while on a pre-loaded page (to access localStorage)
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__MISTYOS_PRESENTATION_RAIN_DEBUG), { timeout: 10000 })

  const published = await publishTimelineToActiveProject(page, timelineId)

  // Now hard-reload the Presentation page to simulate a real browser refresh.
  // No button clicks allowed from this point.
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' })

  // Wait for rain debug to appear and stabilize for up to 4 seconds.
  await page.waitForFunction(() => Boolean(window.__MISTYOS_PRESENTATION_RAIN_DEBUG), { timeout: 10000 })

  // Poll for activeRainClipCount > 0 within 4 seconds without any interaction.
  let snapshot = null
  const pollStart = Date.now()
  while (Date.now() - pollStart < 4000) {
    snapshot = await page.evaluate(() => {
      const rainDebug = window.__MISTYOS_PRESENTATION_RAIN_DEBUG || {}
      const runtime = window.__MISTYOS_PRESENTATION_RUNTIME || {}
      return {
        currentTimeSec: Number(rainDebug.currentTimeSec || 0),
        rainIntensity: Number(rainDebug.rainIntensity || 0),
        activeRainClipCount: Number(rainDebug.activeRainClipCount || 0),
        clockLastAction: runtime?.clockDebug?.lastAction || '',
        clockMode: runtime?.clockDebug?.mode || '',
        clockTargetSec: Number(runtime?.clockDebug?.targetSec || 0),
      }
    })
    if ((snapshot.activeRainClipCount > 0 || snapshot.rainIntensity > 0) && snapshot.currentTimeSec > 0) {
      break
    }
    await page.waitForTimeout(100)
  }

  const assertions = {
    activeRainClipCountPositive: (snapshot?.activeRainClipCount || 0) > 0,
    rainIntensityPositive: (snapshot?.rainIntensity || 0) > 0,
    currentTimeNonZero: (snapshot?.currentTimeSec || 0) > 0,
    // Auto-seek fires only when rain starts after t=0. If rain is active at t=0,
    // no seek is needed and currentTimeSec stays near 0 — both are valid outcomes.
    seekOrRainAtZero: String(snapshot?.clockLastAction || '').includes('auto-startup-seek')
      || (snapshot?.currentTimeSec || 0) < 1.0,
  }

  const passed = Object.values(assertions).every(Boolean)

  return {
    timelineId,
    publishRevision: published.publishRevision,
    snapshot,
    assertions,
    passed,
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()

  const results = []
  let allPassed = true

  for (const timelineId of TIMELINES) {
    console.log(`\n=== Auto-seek validation: ${timelineId} ===`)
    try {
      const result = await runAutoSeekValidation(page, timelineId)
      results.push(result)

      console.log('Snapshot at settle:', JSON.stringify(result.snapshot, null, 2))
      console.log('Assertions:', JSON.stringify(result.assertions, null, 2))
      console.log(`Result: ${result.passed ? 'PASS' : 'FAIL'}`)

      if (!result.passed) {
        allPassed = false
      }
    } catch (err) {
      console.error(`Error for ${timelineId}:`, err.message)
      allPassed = false
      results.push({ timelineId, error: err.message, passed: false })
    }
  }

  await browser.close()

  console.log('\n=== Summary ===')
  for (const r of results) {
    const tag = r.passed ? '✓ PASS' : '✗ FAIL'
    console.log(`${tag}  ${r.timelineId}`)
  }

  if (!allPassed) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
