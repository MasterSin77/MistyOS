import { chromium } from 'playwright'

// Isolator contract:
// - This script is a classifier for startup-boundary trustworthiness.
// - It must fail only on deterministic divergence in boundary outputs.
// - Expected wall-clock startup drift is reported as harness-induced drift,
//   not as a runtime bug by itself.

const BASE_URL = process.env.MISTYOS_BASE_URL || 'http://127.0.0.1:5183'
const TIMELINE_ID = process.env.MISTYOS_TIMELINE_ID || 'runner-carve-diagnosis'
const DETERMINISTIC_SEED = Number(process.env.MISTYOS_DETERMINISTIC_SEED || 133742)
const BOOT_TIMEOUT_MS = Number(process.env.MISTYOS_BOOT_TIMEOUT_MS || 20000)
const FLOAT_EPSILON = Number(process.env.MISTYOS_FLOAT_EPSILON || 1e-12)
const NON_DETERMINISTIC_CALLSITE = 'updateAtmosphere:getPresentationTimeSec'

function fail(details) {
  throw new Error(JSON.stringify({ ok: false, ...details }, null, 2))
}

function nearlyEqual(left, right, epsilon = FLOAT_EPSILON) {
  return Math.abs(Number(left || 0) - Number(right || 0)) <= epsilon
}

function normalizeLineageEntry(entry) {
  return {
    callOriginBucket: String(entry?.callOriginBucket || ''),
    sampleCallSite: String(entry?.sampleCallSite || ''),
    engineFrame: Number(entry?.engineFrame ?? -1),
    wetnessFrameCounter: Number(entry?.wetnessFrameCounter ?? -1),
    packetId: Number(entry?.packetId ?? -1),
    rawElapsedSec: Number.isFinite(Number(entry?.rawElapsedSec)) ? Number(entry.rawElapsedSec) : null,
    normalizedSampleSec: Number.isFinite(Number(entry?.normalizedSampleSec)) ? Number(entry.normalizedSampleSec) : null,
    sampledRainIntensityBeforeDerive: Number.isFinite(Number(entry?.sampledRainIntensityBeforeDerive))
      ? Number(entry.sampledRainIntensityBeforeDerive)
      : null,
    derivedRainIntensity: Number.isFinite(Number(entry?.derivedRainIntensity)) ? Number(entry.derivedRainIntensity) : null,
    derivedDropletsPerSeconds: Number.isFinite(Number(entry?.derivedDropletsPerSeconds))
      ? Number(entry.derivedDropletsPerSeconds)
      : null,
  }
}

function isWallClockDrivenCallSite(callSite) {
  return String(callSite || '') === NON_DETERMINISTIC_CALLSITE
}

function isExpectedStartupLiveBoundaryCallSite(callSite) {
  const value = String(callSite || '')
  return value === 'updateAtmosphere:startup-frame-sync' || value === NON_DETERMINISTIC_CALLSITE
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
  await page.goto(`${BASE_URL}/?rdfxDebug=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => {
    const stats = window.__MISTYOS_PRESENTATION_STATS || {}
    const bootstrap = stats?.bootstrap || {}
    const frames = Array.isArray(bootstrap.initialFrameDiagnostics) ? bootstrap.initialFrameDiagnostics : []
    const lineage = Array.isArray(bootstrap.setTuningLineageTrace) ? bootstrap.setTuningLineageTrace : []
    const boundaryIndex = lineage.findIndex((entry) => entry?.sampleCallSite === 'onStats:startup-first-live-boundary')
    const hasPostBoundary = boundaryIndex >= 0 && lineage.slice(boundaryIndex + 1).some((entry) => String(entry?.sampleCallSite || '').startsWith('updateAtmosphere:'))
    return frames.length >= 3 && hasPostBoundary
  }, undefined, { timeout: BOOT_TIMEOUT_MS })

  const payload = await page.evaluate(() => {
    const stats = window.__MISTYOS_PRESENTATION_STATS || {}
    const bootstrap = stats?.bootstrap || {}
    return {
      frames: Array.isArray(bootstrap.initialFrameDiagnostics)
        ? bootstrap.initialFrameDiagnostics.map((entry) => ({ ...entry }))
        : [],
      lineage: Array.isArray(bootstrap.setTuningLineageTrace)
        ? bootstrap.setTuningLineageTrace.map((entry) => ({ ...entry }))
        : [],
    }
  })

  const lineage = Array.isArray(payload?.lineage) ? payload.lineage : []
  const boundaryIndex = lineage.findIndex((entry) => entry?.sampleCallSite === 'onStats:startup-first-live-boundary')
  const boundary = boundaryIndex >= 0 ? normalizeLineageEntry(lineage[boundaryIndex]) : null
  const postBoundaryEntries = boundaryIndex >= 0
    ? lineage
      .slice(boundaryIndex + 1)
      .filter((entry) => String(entry?.sampleCallSite || '').startsWith('updateAtmosphere:'))
      .map((entry) => normalizeLineageEntry(entry))
    : []
  const firstLivePostBoundary = postBoundaryEntries[0] || null

  const frame1 = (Array.isArray(payload?.frames) ? payload.frames : []).find((entry) => Number(entry?.frameIndex ?? -1) === 1) || null

  if (!boundary || !firstLivePostBoundary || !frame1) {
    fail({
      stage: 'handoff-capture',
      metric: 'startup-boundary-markers',
      mode,
      boundaryFound: Boolean(boundary),
      postBoundaryEntryFound: Boolean(firstLivePostBoundary),
      frame1Found: Boolean(frame1),
      lineageLength: lineage.length,
    })
  }

  return {
    mode,
    boundary,
    firstLivePostBoundary,
    frame1,
  }
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

    const publishBoundary = publishRestart.boundary
    const coldBoundary = coldLoad.boundary
    const harnessDrift = []

    if (!nearlyEqual(publishBoundary.rawElapsedSec, coldBoundary.rawElapsedSec) ||
        !nearlyEqual(publishBoundary.normalizedSampleSec, coldBoundary.normalizedSampleSec)) {
      fail({
        stage: 'frame0-frame1-handoff',
        metric: 'firstLiveSampleTime',
        publishRestartValue: {
          rawElapsedSec: publishBoundary.rawElapsedSec,
          normalizedSampleSec: publishBoundary.normalizedSampleSec,
        },
        coldLoadValue: {
          rawElapsedSec: coldBoundary.rawElapsedSec,
          normalizedSampleSec: coldBoundary.normalizedSampleSec,
        },
        frameIndex: 1,
        phaseMarker: {
          publishRestartEngineFrameBeforeSample: publishBoundary.engineFrame,
          coldLoadEngineFrameBeforeSample: coldBoundary.engineFrame,
          publishRestartSampleCallSite: publishBoundary.sampleCallSite,
          coldLoadSampleCallSite: coldBoundary.sampleCallSite,
        },
      })
    }

    if (!nearlyEqual(publishBoundary.engineFrame, coldBoundary.engineFrame) ||
        !nearlyEqual(publishBoundary.wetnessFrameCounter, coldBoundary.wetnessFrameCounter)) {
      fail({
        stage: 'frame0-frame1-handoff',
        metric: 'releaseOrdering',
        publishRestartValue: {
          engineFrame: publishBoundary.engineFrame,
          wetnessFrameCounter: publishBoundary.wetnessFrameCounter,
          sampleCallSite: publishBoundary.sampleCallSite,
        },
        coldLoadValue: {
          engineFrame: coldBoundary.engineFrame,
          wetnessFrameCounter: coldBoundary.wetnessFrameCounter,
          sampleCallSite: coldBoundary.sampleCallSite,
        },
        frameIndex: 1,
      })
    }

    if (!nearlyEqual(publishRestart.frame1.rainIntensity, coldLoad.frame1.rainIntensity)) {
      fail({
        stage: 'frame0-frame1-handoff',
        metric: 'appliedRainIntensityAfterFirstLiveUpdate',
        publishRestartValue: publishRestart.frame1.rainIntensity,
        coldLoadValue: coldLoad.frame1.rainIntensity,
        frameIndex: 1,
      })
    }

    if (!nearlyEqual(publishRestart.frame1.dropletsPerSeconds, coldLoad.frame1.dropletsPerSeconds)) {
      fail({
        stage: 'frame0-frame1-handoff',
        metric: 'appliedDropletsPerSecondsAfterFirstLiveUpdate',
        publishRestartValue: publishRestart.frame1.dropletsPerSeconds,
        coldLoadValue: coldLoad.frame1.dropletsPerSeconds,
        frameIndex: 1,
      })
    }

    const publishSample = publishRestart.firstLivePostBoundary
    const coldSample = coldLoad.firstLivePostBoundary

    if (publishSample.sampleCallSite !== coldSample.sampleCallSite) {
      if (isExpectedStartupLiveBoundaryCallSite(publishSample.sampleCallSite) && isExpectedStartupLiveBoundaryCallSite(coldSample.sampleCallSite)) {
        harnessDrift.push({
          factor: 'post-boundary-callsite-variant',
          publishRestartCallSite: publishSample.sampleCallSite,
          coldLoadCallSite: coldSample.sampleCallSite,
          publishRestartEngineFrame: publishSample.engineFrame,
          coldLoadEngineFrame: coldSample.engineFrame,
        })
      } else {
        fail({
          stage: 'frame0-frame1-handoff',
          metric: 'postBoundaryCallSite',
          publishRestartValue: publishSample.sampleCallSite,
          coldLoadValue: coldSample.sampleCallSite,
          frameIndex: 1,
        })
      }
    }

    const containsWallClockDrivenSample = isWallClockDrivenCallSite(publishSample.sampleCallSite) || isWallClockDrivenCallSite(coldSample.sampleCallSite)
    if (containsWallClockDrivenSample) {
      harnessDrift.push({
        factor: 'post-boundary-wall-clock-sample-time',
        publishRestartValue: {
          rawElapsedSec: publishSample.rawElapsedSec,
          normalizedSampleSec: publishSample.normalizedSampleSec,
        },
        coldLoadValue: {
          rawElapsedSec: coldSample.rawElapsedSec,
          normalizedSampleSec: coldSample.normalizedSampleSec,
        },
      })
    } else if (!nearlyEqual(publishSample.rawElapsedSec, coldSample.rawElapsedSec) || !nearlyEqual(publishSample.normalizedSampleSec, coldSample.normalizedSampleSec)) {
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
      })
    }

    if (!nearlyEqual(publishSample.derivedRainIntensity, coldSample.derivedRainIntensity)) {
      fail({
        stage: 'frame0-frame1-handoff',
        metric: 'postBoundaryDerivedRainIntensity',
        publishRestartValue: publishSample.derivedRainIntensity,
        coldLoadValue: coldSample.derivedRainIntensity,
        frameIndex: 1,
      })
    }

    if (!nearlyEqual(publishSample.derivedDropletsPerSeconds, coldSample.derivedDropletsPerSeconds)) {
      fail({
        stage: 'frame0-frame1-handoff',
        metric: 'postBoundaryDerivedDropletsPerSeconds',
        publishRestartValue: publishSample.derivedDropletsPerSeconds,
        coldLoadValue: coldSample.derivedDropletsPerSeconds,
        frameIndex: 1,
      })
    }

    if (!nearlyEqual(publishSample.sampledRainIntensityBeforeDerive, coldSample.sampledRainIntensityBeforeDerive)) {
      if (containsWallClockDrivenSample) {
        harnessDrift.push({
          factor: 'post-boundary-wall-clock-sampled-rain',
          publishRestartValue: publishSample.sampledRainIntensityBeforeDerive,
          coldLoadValue: coldSample.sampledRainIntensityBeforeDerive,
          publishRestartSampleCallSite: publishSample.sampleCallSite,
          coldLoadSampleCallSite: coldSample.sampleCallSite,
        })
      } else {
        fail({
          stage: 'frame0-frame1-handoff',
          metric: 'sampledRainIntensityFirstLiveUpdate',
          publishRestartValue: publishSample.sampledRainIntensityBeforeDerive,
          coldLoadValue: coldSample.sampledRainIntensityBeforeDerive,
          frameIndex: 1,
        })
      }
    }

    console.log(JSON.stringify({
      ok: true,
      classification: harnessDrift.length > 0 ? 'harness-induced-drift' : 'deterministic-pass',
      harnessDrift,
      message: harnessDrift.length > 0
        ? 'Frame1 isolator detected wall-clock boundary drift but no deterministic runtime divergence in compared boundary outputs.'
        : 'No frame1 handoff divergence detected in deterministic boundary outputs.',
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