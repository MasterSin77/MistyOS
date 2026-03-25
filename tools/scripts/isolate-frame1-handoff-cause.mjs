import { chromium } from 'playwright'

const BASE_URL = process.env.MISTYOS_BASE_URL || 'http://127.0.0.1:5183'
const TIMELINE_ID = process.env.MISTYOS_TIMELINE_ID || 'runner-carve-diagnosis'
const DETERMINISTIC_SEED = Number(process.env.MISTYOS_DETERMINISTIC_SEED || 133742)
const BOOT_TIMEOUT_MS = Number(process.env.MISTYOS_BOOT_TIMEOUT_MS || 20000)
const FLOAT_EPSILON = Number(process.env.MISTYOS_FLOAT_EPSILON || 1e-12)

const TRACE_EVENTS = new Set([
  'runtime-canonical-zero-sample',
  'runtime-startup-boundary-sample',
  'runtime-first-scheduler-sample',
  'runtime-handoff-sample',
  'runtime-handoff-applied',
])

function fail(details) {
  throw new Error(JSON.stringify({ ok: false, ...details }, null, 2))
}

function nearlyEqual(left, right, epsilon = FLOAT_EPSILON) {
  return Math.abs(Number(left || 0) - Number(right || 0)) <= epsilon
}

async function addDeterministicSeedScript(context, seed) {
  await context.addInitScript((seedValue) => {
    let state = (Number(seedValue) >>> 0) || 1
    const next = () => {
      state = (1664525 * state + 1013904223) >>> 0
      return state / 4294967296
    }

    Object.defineProperty(Math, 'random', {
      value: () => next(),
      writable: false,
      configurable: false,
    })
  }, seed)
}

async function publishRuntimePayload(page, timelineId, reason) {
  const result = await page.evaluate(({ targetTimelineId, publishReason }) => {
    const registryRaw = localStorage.getItem('mistyos.authoring.projects.v1')
    const activeProjectRaw = localStorage.getItem('mistyos.authoring.activeProjectId.v1')
    const registry = registryRaw ? JSON.parse(registryRaw) : { projects: [] }
    const activeProjectEntry = activeProjectRaw ? JSON.parse(activeProjectRaw) : {}
    const activeProjectId = String(activeProjectEntry?.projectId || registry?.projects?.[0]?.projectId || '').trim()

    if (!activeProjectId) {
      return { ok: false, reason: 'missing-active-project' }
    }

    const projectKey = `mistyos.authoring.project.v1.${activeProjectId}`
    const projectRaw = localStorage.getItem(projectKey)
    if (!projectRaw) {
      return { ok: false, reason: 'missing-project-document' }
    }

    const project = JSON.parse(projectRaw)
    const sourcePayload = project?.savedDocument?.runtimePayload || project?.publishedDocument?.runtimePayload || null
    const runtimePayload = sourcePayload
      ? JSON.parse(JSON.stringify(sourcePayload))
      : {
        schemaVersion: 1,
        selectedTimelineId: targetTimelineId,
        startupMode: 'immediate',
        timelineDurationSec: 180,
        loopPlayback: true,
        normalizedClips: [],
        authoredTimeline: null,
        settingsSnapshot: {},
      }

    runtimePayload.selectedTimelineId = targetTimelineId
    const nowIso = new Date().toISOString()
    const nextSavedRevision = Number(project?.savedDocument?.savedRevision || 0) + 1
    const nextPublishRevision = Number(project?.publishedDocument?.publishRevision || 0) + 1
    const restartToken = `frame1-handoff-${publishReason}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

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
      restartToken,
      fromSavedRevision: nextSavedRevision,
      runtimePayload,
    }

    localStorage.setItem(projectKey, JSON.stringify(project))
    localStorage.setItem('mistyos.authoring.activeProjectId.v1', JSON.stringify({ projectId: activeProjectId }))
    return { ok: true }
  }, { targetTimelineId: timelineId, publishReason: reason })

  if (!result?.ok) {
    fail({ stage: 'bootstrap', metric: 'publishRuntimePayload', mode: reason, actualValue: result?.reason || 'unknown' })
  }
}

async function captureMode(page, mode) {
  const events = []
  const onConsole = async (message) => {
    if (message.type() !== 'info') {
      return
    }

    for (const arg of message.args()) {
      try {
        const value = await arg.jsonValue()
        if (!value || typeof value !== 'object') {
          continue
        }
        if (typeof value.event === 'string' && TRACE_EVENTS.has(value.event)) {
          events.push({ event: value.event, payload: JSON.parse(JSON.stringify(value)) })
        }
      } catch {
        // Ignore unserializable console entries.
      }
    }
  }

  page.on('console', onConsole)
  await page.goto(`${BASE_URL}/?rdfxDebug=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => {
    const stats = window.__MISTYOS_PRESENTATION_STATS || {}
    const frames = stats?.bootstrap?.initialFrameDiagnostics
    return Array.isArray(frames) && frames.length >= 2
  }, undefined, { timeout: BOOT_TIMEOUT_MS })
  await page.waitForTimeout(200)
  page.off('console', onConsole)

  const firstLiveSample = events.find((entry) => entry.event === 'runtime-first-scheduler-sample')?.payload || null
  const startupBoundarySample = events.find((entry) => entry.event === 'runtime-startup-boundary-sample')?.payload || null
  const handoffSamples = events
    .filter((entry) => entry.event === 'runtime-handoff-sample')
    .map((entry) => entry.payload)
  const handoffApplied = events
    .filter((entry) => entry.event === 'runtime-handoff-applied')
    .map((entry) => entry.payload)

  const firstLiveHandoffSample = handoffSamples.find((entry) => entry.sampleCallSite === 'updateAtmosphere:getPresentationTimeSec') || null
  const firstLiveHandoffApplied = handoffApplied.find((entry) => entry.sampleCallSite === 'updateAtmosphere:getPresentationTimeSec') || null

  const resolveFirstLive = (entries) => entries.find((entry) => (
    entry.sampleCallSite !== 'updateAtmosphere:canonical-zero-handoff' &&
    entry.sampleCallSite !== 'updateAtmosphere:startup-frame0-hold'
  )) || null

  const liveSample = resolveFirstLive(handoffSamples)
  const liveApplied = resolveFirstLive(handoffApplied)

  if (!firstLiveSample || !startupBoundarySample || !liveSample || !liveApplied) {
    fail({
      stage: 'handoff-capture',
      metric: 'first-live-handoff-events',
      mode,
      found: events.map((entry) => entry.event),
    })
  }

  return {
    mode,
    events,
    firstLiveSample,
    startupBoundarySample,
    firstLiveHandoffSample: liveSample,
    firstLiveHandoffApplied: liveApplied,
  }
}

function compactSequence(trace) {
  return trace.events
    .filter((entry) => entry.event === 'runtime-handoff-sample' || entry.event === 'runtime-handoff-applied')
    .map((entry) => {
      const p = entry.payload
      return {
        event: entry.event,
        sequence: p.sequence,
        sampleCallSite: p.sampleCallSite,
        startupFrameBoundaryReached: Boolean(p.startupFrameBoundaryReached),
        engineFrameBeforeSample: Number(p.engineFrameBeforeSample ?? -1),
        engineFrameAfterApply: Number(p.engineFrameAfterApply ?? -1),
      }
    })
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  let runtimeContext = null
  let coldContext = null

  try {
    runtimeContext = await browser.newContext({ viewport: { width: 1366, height: 900 } })
    await addDeterministicSeedScript(runtimeContext, DETERMINISTIC_SEED)

    const studioPage = await runtimeContext.newPage()
    await studioPage.goto(`${BASE_URL}/studio`, { waitUntil: 'domcontentloaded' })
    await publishRuntimePayload(studioPage, TIMELINE_ID, 'publish-restart')

    const publishPage = await runtimeContext.newPage()
    const publishRestart = await captureMode(publishPage, 'publish-restart')

    const storageState = await runtimeContext.storageState()
    coldContext = await browser.newContext({ viewport: { width: 1366, height: 900 }, storageState })
    await addDeterministicSeedScript(coldContext, DETERMINISTIC_SEED)

    const coldPage = await coldContext.newPage()
    const coldLoad = await captureMode(coldPage, 'cold-load')

    const publishBoundary = publishRestart.startupBoundarySample
    const coldBoundary = coldLoad.startupBoundarySample

    if (!nearlyEqual(publishBoundary.sample?.rawElapsedSec, coldBoundary.sample?.rawElapsedSec) ||
        !nearlyEqual(publishBoundary.sample?.sampleInput?.normalizedSampleSec, coldBoundary.sample?.sampleInput?.normalizedSampleSec)) {
      fail({
        stage: 'frame0-frame1-handoff',
        metric: 'firstLiveSampleTime',
        publishRestartValue: {
          rawElapsedSec: publishBoundary.sample?.rawElapsedSec,
          normalizedSampleSec: publishBoundary.sample?.sampleInput?.normalizedSampleSec,
        },
        coldLoadValue: {
          rawElapsedSec: coldBoundary.sample?.rawElapsedSec,
          normalizedSampleSec: coldBoundary.sample?.sampleInput?.normalizedSampleSec,
        },
        frameIndex: 1,
        phaseMarker: {
          publishRestartEngineFrameBeforeSample: publishBoundary.engineFrameBeforeSample,
          coldLoadEngineFrameBeforeSample: coldBoundary.engineFrameBeforeSample,
          publishRestartSampleCallSite: publishBoundary.sample?.callSite,
          coldLoadSampleCallSite: coldBoundary.sample?.callSite,
        },
      })
    }

    if (!nearlyEqual(publishBoundary.engineFrameBeforeSample, coldBoundary.engineFrameBeforeSample) ||
        !nearlyEqual(publishBoundary.engineFrameAfterApply, coldBoundary.engineFrameAfterApply)) {
      fail({
        stage: 'frame0-frame1-handoff',
        metric: 'releaseOrdering',
        publishRestartValue: {
          engineFrameBeforeSample: publishBoundary.engineFrameBeforeSample,
          engineFrameAfterApply: publishBoundary.engineFrameAfterApply,
          sampleCallSite: publishBoundary.sample?.callSite,
        },
        coldLoadValue: {
          engineFrameBeforeSample: coldBoundary.engineFrameBeforeSample,
          engineFrameAfterApply: coldBoundary.engineFrameAfterApply,
          sampleCallSite: coldBoundary.sample?.callSite,
        },
        frameIndex: 1,
      })
    }

    if (!nearlyEqual(publishBoundary.appliedRainIntensity, coldBoundary.appliedRainIntensity)) {
      fail({
        stage: 'frame0-frame1-handoff',
        metric: 'appliedRainIntensityAfterFirstLiveUpdate',
        publishRestartValue: publishBoundary.appliedRainIntensity,
        coldLoadValue: coldBoundary.appliedRainIntensity,
        frameIndex: 1,
      })
    }

    if (!nearlyEqual(publishBoundary.appliedDropletsPerSeconds, coldBoundary.appliedDropletsPerSeconds)) {
      fail({
        stage: 'frame0-frame1-handoff',
        metric: 'appliedDropletsPerSecondsAfterFirstLiveUpdate',
        publishRestartValue: publishBoundary.appliedDropletsPerSeconds,
        coldLoadValue: coldBoundary.appliedDropletsPerSeconds,
        frameIndex: 1,
      })
    }

    const publishSample = publishRestart.firstLiveHandoffSample
    const coldSample = coldLoad.firstLiveHandoffSample

    if (!nearlyEqual(publishSample.rawElapsedSec, coldSample.rawElapsedSec) ||
        !nearlyEqual(publishSample.normalizedSampleSec, coldSample.normalizedSampleSec)) {
      fail({
        stage: 'frame0-frame1-handoff',
        metric: 'postBoundaryLiveSampleTime',
        publishRestartValue: {
          rawElapsedSec: publishSample.rawElapsedSec,
          normalizedSampleSec: publishSample.normalizedSampleSec,
        },
        coldLoadValue: {
          rawElapsedSec: coldSample.rawElapsedSec,
          normalizedSampleSec: coldSample.normalizedSampleSec,
        },
        frameIndex: 1,
        phaseMarker: {
          publishRestartEngineFrameBeforeSample: publishSample.engineFrameBeforeSample,
          coldLoadEngineFrameBeforeSample: coldSample.engineFrameBeforeSample,
          publishRestartSampleCallSite: publishSample.sampleCallSite,
          coldLoadSampleCallSite: coldSample.sampleCallSite,
        },
      })
    }

    const publishApplied = publishRestart.firstLiveHandoffApplied
    const coldApplied = coldLoad.firstLiveHandoffApplied
    if (!nearlyEqual(publishApplied.appliedRainIntensity, coldApplied.appliedRainIntensity)) {
      fail({
        stage: 'frame0-frame1-handoff',
        metric: 'appliedRainIntensityAfterFirstLiveUpdate',
        publishRestartValue: publishApplied.appliedRainIntensity,
        coldLoadValue: coldApplied.appliedRainIntensity,
        frameIndex: 1,
        phaseMarker: {
          publishRestartEngineFrameAfterApply: publishApplied.engineFrameAfterApply,
          coldLoadEngineFrameAfterApply: coldApplied.engineFrameAfterApply,
        },
      })
    }

    if (!nearlyEqual(publishApplied.appliedDropletsPerSeconds, coldApplied.appliedDropletsPerSeconds)) {
      fail({
        stage: 'frame0-frame1-handoff',
        metric: 'appliedDropletsPerSecondsAfterFirstLiveUpdate',
        publishRestartValue: publishApplied.appliedDropletsPerSeconds,
        coldLoadValue: coldApplied.appliedDropletsPerSeconds,
        frameIndex: 1,
      })
    }

    if (!nearlyEqual(publishSample.sampledRainIntensity, coldSample.sampledRainIntensity)) {
      fail({
        stage: 'frame0-frame1-handoff',
        metric: 'sampledRainIntensityFirstLiveUpdate',
        publishRestartValue: publishSample.sampledRainIntensity,
        coldLoadValue: coldSample.sampledRainIntensity,
        frameIndex: 1,
      })
    }

    console.log(JSON.stringify({
      ok: true,
      message: 'No frame1 handoff divergence detected in first live sample timing, ordering, or applied weather.',
    }, null, 2))
  } finally {
    if (coldContext) {
      await coldContext.close()
    }
    if (runtimeContext) {
      await runtimeContext.close()
    }
    await browser.close()
  }
}

try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  try {
    console.error(JSON.stringify(JSON.parse(message), null, 2))
  } catch {
    console.error(JSON.stringify({ ok: false, stage: 'unclassified-error', message }, null, 2))
  }
  process.exitCode = 1
}