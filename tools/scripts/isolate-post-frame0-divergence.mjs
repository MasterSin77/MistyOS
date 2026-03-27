import { chromium } from 'playwright'

// Isolator contract:
// - This script classifies post-frame0 startup behavior into deterministic divergence
//   vs harness-induced startup drift.
// - Startup wall-clock/callsite variants are reported as harness drift.
// - Hard failures are reserved for deterministic lineage/config divergence.

const BASE_URL = process.env.MISTYOS_BASE_URL || 'http://127.0.0.1:5183'
const TIMELINE_ID = process.env.MISTYOS_TIMELINE_ID || 'runner-carve-diagnosis'
const DETERMINISTIC_SEED = Number(process.env.MISTYOS_DETERMINISTIC_SEED || 133742)
const BOOT_TIMEOUT_MS = Number(process.env.MISTYOS_BOOT_TIMEOUT_MS || 20000)
const FRAME_DIAGNOSTIC_COUNT = Number(process.env.MISTYOS_FRAME_DIAGNOSTIC_COUNT || 20)
const FLOAT_EPSILON = Number(process.env.MISTYOS_FLOAT_EPSILON || 1e-9)
const NON_DETERMINISTIC_CALLSITE = 'updateAtmosphere:getPresentationTimeSec'

function fail(details) {
  throw new Error(JSON.stringify({ ok: false, ...details }, null, 2))
}

function numbersEqual(left, right, epsilon = FLOAT_EPSILON) {
  if (left == null && right == null) {
    return true
  }
  if (left == null || right == null) {
    return false
  }
  return Math.abs(Number(left) - Number(right)) <= epsilon
}

function arraysEqual(left, right) {
  const l = Array.isArray(left) ? left : []
  const r = Array.isArray(right) ? right : []
  if (l.length !== r.length) {
    return false
  }
  for (let index = 0; index < l.length; index += 1) {
    if (String(l[index]) !== String(r[index])) {
      return false
    }
  }
  return true
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
    const restartToken = `post-frame0-${publishReason}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

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

async function captureMode(page, mode, { nav = 'goto' } = {}) {
  if (nav === 'reload') {
    await page.reload({ waitUntil: 'domcontentloaded' })
  } else {
    await page.goto(`${BASE_URL}/?rdfxDebug=1`, { waitUntil: 'domcontentloaded' })
  }

  await page.waitForFunction((requiredCount) => {
    const stats = window.__MISTYOS_PRESENTATION_STATS || {}
    const frames = stats?.bootstrap?.initialFrameDiagnostics
    return Array.isArray(frames) && frames.length >= requiredCount
  }, FRAME_DIAGNOSTIC_COUNT, { timeout: BOOT_TIMEOUT_MS })

  const frames = await page.evaluate(() => {
    const stats = window.__MISTYOS_PRESENTATION_STATS || {}
    const bootstrap = stats?.bootstrap || {}
    return Array.isArray(bootstrap.initialFrameDiagnostics)
      ? bootstrap.initialFrameDiagnostics.map((entry) => ({ ...entry }))
      : []
  })

  const setTuningLineageTrace = await page.evaluate(() => {
    const stats = window.__MISTYOS_PRESENTATION_STATS || {}
    const bootstrap = stats?.bootstrap || {}
    return Array.isArray(bootstrap.setTuningLineageTrace)
      ? bootstrap.setTuningLineageTrace.map((entry) => ({ ...entry }))
      : []
  })

  return { mode, frames, setTuningLineageTrace }
}

function normalizeRainTrackInput(input) {
  return {
    trackKey: String(input?.trackKey || ''),
    contribution: Number(input?.contribution || 0),
    envelopeValue: Number(input?.envelopeValue || 0),
    interpolationT: Number(input?.interpolationT || 0),
    previousPointTimeSec: Number(input?.previousPointTimeSec || 0),
    previousPointValue: Number(input?.previousPointValue || 0),
    nextPointTimeSec: Number(input?.nextPointTimeSec || 0),
    nextPointValue: Number(input?.nextPointValue || 0),
    sourceClipIds: Array.isArray(input?.sourceClipIds) ? [...input.sourceClipIds] : [],
  }
}

function normalizeLineageEntry(entry) {
  return {
    callOriginBucket: String(entry?.callOriginBucket || ''),
    sampleCallSite: String(entry?.sampleCallSite || ''),
    callerPath: String(entry?.callerPath || ''),
    startupSequenceIndex: Number(entry?.startupSequenceIndex ?? -1),
    setTuningConfigCallIndex: Number(entry?.setTuningConfigCallIndex ?? -1),
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
    rainTrackInputs: Array.isArray(entry?.rainTrackInputs)
      ? entry.rainTrackInputs.map((input) => normalizeRainTrackInput(input))
      : [],
  }
}

function sameIdentity(left, right) {
  return (
    left.callOriginBucket === right.callOriginBucket &&
    left.sampleCallSite === right.sampleCallSite &&
    left.engineFrame === right.engineFrame &&
    left.wetnessFrameCounter === right.wetnessFrameCounter &&
    left.packetId === right.packetId
  )
}

function findFirstLiveBoundaryIndex(trace) {
  return trace.findIndex((entry) => entry.sampleCallSite === 'onStats:startup-first-live-boundary')
}

function postBoundaryWeatherLineage(trace) {
  const normalized = trace.map((entry) => normalizeLineageEntry(entry))
  const boundaryIndex = findFirstLiveBoundaryIndex(normalized)
  if (boundaryIndex < 0) {
    return { boundaryIndex, entries: [] }
  }

  const entries = normalized
    .slice(boundaryIndex + 1)
    .filter((entry) => entry.sampleCallSite.startsWith('updateAtmosphere:'))
    .filter((entry) => entry.engineFrame <= 3)

  return { boundaryIndex, entries, boundaryEntry: normalized[boundaryIndex] }
}

function reportDivergence({ stage, field, publishValue, coldValue, frameIndex, packetId, matchedPrefixBeforeDivergence }) {
  fail({
    stage,
    field,
    publishRestartValue: publishValue,
    coldLoadValue: coldValue,
    frameIndex: Number(frameIndex ?? -1),
    packetId: Number(packetId ?? -1),
    matchedPrefixBeforeDivergence: matchedPrefixBeforeDivergence || null,
  })
}

function compareRainTrackInputs(publishEntry, coldEntry, matchedPrefixBeforeDivergence) {
  const publishInputs = Array.isArray(publishEntry?.rainTrackInputs) ? publishEntry.rainTrackInputs : []
  const coldInputs = Array.isArray(coldEntry?.rainTrackInputs) ? coldEntry.rainTrackInputs : []

  if (publishInputs.length !== coldInputs.length) {
    reportDivergence({
      stage: 'scheduler-rain-inputs',
      field: 'rainTrackInputs.length',
      publishValue: publishInputs.length,
      coldValue: coldInputs.length,
      frameIndex: publishEntry.engineFrame,
      packetId: publishEntry.packetId,
      matchedPrefixBeforeDivergence,
    })
  }

  for (let inputIndex = 0; inputIndex < publishInputs.length; inputIndex += 1) {
    const p = publishInputs[inputIndex]
    const c = coldInputs[inputIndex]
    const checks = [
      ['trackKey', p.trackKey, c.trackKey, false],
      ['contribution', p.contribution, c.contribution, true],
      ['envelopeValue', p.envelopeValue, c.envelopeValue, true],
      ['interpolationT', p.interpolationT, c.interpolationT, true],
      ['previousPointTimeSec', p.previousPointTimeSec, c.previousPointTimeSec, true],
      ['previousPointValue', p.previousPointValue, c.previousPointValue, true],
      ['nextPointTimeSec', p.nextPointTimeSec, c.nextPointTimeSec, true],
      ['nextPointValue', p.nextPointValue, c.nextPointValue, true],
    ]

    for (const [field, pv, cv, numeric] of checks) {
      const equal = numeric ? numbersEqual(pv, cv) : String(pv) === String(cv)
      if (!equal) {
        reportDivergence({
          stage: 'scheduler-rain-inputs',
          field: `rainTrackInputs[${inputIndex}].${field}`,
          publishValue: pv,
          coldValue: cv,
          frameIndex: publishEntry.engineFrame,
          packetId: publishEntry.packetId,
          matchedPrefixBeforeDivergence,
        })
      }
    }

    if (!arraysEqual(p.sourceClipIds, c.sourceClipIds)) {
      reportDivergence({
        stage: 'scheduler-rain-inputs',
        field: `rainTrackInputs[${inputIndex}].sourceClipIds`,
        publishValue: p.sourceClipIds,
        coldValue: c.sourceClipIds,
        frameIndex: publishEntry.engineFrame,
        packetId: publishEntry.packetId,
        matchedPrefixBeforeDivergence,
      })
    }
  }
}

function comparePostBoundaryWeatherLineage(publishRestart, coldLoad, harnessDrift) {
  const publish = postBoundaryWeatherLineage(publishRestart.setTuningLineageTrace)
  const cold = postBoundaryWeatherLineage(coldLoad.setTuningLineageTrace)

  if (publish.boundaryIndex < 0 || cold.boundaryIndex < 0) {
    reportDivergence({
      stage: 'post-first-live-boundary-anchor',
      field: 'first-live-boundary-entry-present',
      publishValue: publish.boundaryIndex >= 0,
      coldValue: cold.boundaryIndex >= 0,
      frameIndex: -1,
      packetId: -1,
      matchedPrefixBeforeDivergence: null,
    })
  }

  const publishBoundary = publish.boundaryEntry
  const coldBoundary = cold.boundaryEntry
  if (!sameIdentity(publishBoundary, coldBoundary)) {
    reportDivergence({
      stage: 'post-first-live-boundary-anchor',
      field: 'first-live-boundary-identity',
      publishValue: publishBoundary,
      coldValue: coldBoundary,
      frameIndex: publishBoundary.engineFrame,
      packetId: publishBoundary.packetId,
      matchedPrefixBeforeDivergence: null,
    })
  }

  const comparedCount = Math.min(publish.entries.length, cold.entries.length)
  let matchedPrefixBeforeDivergence = {
    stage: 'post-first-live-boundary-anchor',
    field: 'first-live-boundary-identity',
    frameIndex: publishBoundary.engineFrame,
    packetId: publishBoundary.packetId,
  }

  for (let index = 0; index < comparedCount; index += 1) {
    const p = publish.entries[index]
    const c = cold.entries[index]

    const identityChecks = [
      ['callOriginBucket', p.callOriginBucket, c.callOriginBucket, false],
      ['sampleCallSite', p.sampleCallSite, c.sampleCallSite, false],
      ['engineFrame', p.engineFrame, c.engineFrame, true],
      ['wetnessFrameCounter', p.wetnessFrameCounter, c.wetnessFrameCounter, true],
      ['packetId', p.packetId, c.packetId, true],
    ]

    for (const [field, pv, cv, numeric] of identityChecks) {
      const equal = numeric ? numbersEqual(pv, cv) : String(pv) === String(cv)
      if (!equal) {
        const callSiteVariant =
          (field === 'callOriginBucket' || field === 'sampleCallSite') &&
          isExpectedStartupLiveBoundaryCallSite(p.sampleCallSite) &&
          isExpectedStartupLiveBoundaryCallSite(c.sampleCallSite)

        const packetVariant =
          field === 'packetId' &&
          isExpectedStartupLiveBoundaryCallSite(p.sampleCallSite) &&
          isExpectedStartupLiveBoundaryCallSite(c.sampleCallSite)

        const frameVariant =
          (field === 'engineFrame' || field === 'wetnessFrameCounter') &&
          isExpectedStartupLiveBoundaryCallSite(p.sampleCallSite) &&
          isExpectedStartupLiveBoundaryCallSite(c.sampleCallSite)

        if (callSiteVariant || packetVariant || frameVariant) {
          harnessDrift.push({
            factor: 'post-boundary-callsite-variant',
            field,
            frameIndex: p.engineFrame,
            packetId: p.packetId,
            publishRestartSampleCallSite: p.sampleCallSite,
            coldLoadSampleCallSite: c.sampleCallSite,
            publishRestartValue: pv,
            coldLoadValue: cv,
          })
          continue
        }

        reportDivergence({
          stage: 'weather-apply-lineage',
          field,
          publishValue: pv,
          coldValue: cv,
          frameIndex: p.engineFrame,
          packetId: p.packetId,
          matchedPrefixBeforeDivergence,
        })
      }
      matchedPrefixBeforeDivergence = {
        stage: 'weather-apply-lineage',
        field,
        frameIndex: p.engineFrame,
        packetId: p.packetId,
      }
    }

    const containsWallClockDrivenSample = isWallClockDrivenCallSite(p.sampleCallSite) || isWallClockDrivenCallSite(c.sampleCallSite)

    const timingChecks = [
      ['rawElapsedSec', p.rawElapsedSec, c.rawElapsedSec],
      ['normalizedSampleSec', p.normalizedSampleSec, c.normalizedSampleSec],
    ]

    for (const [field, pv, cv] of timingChecks) {
      if (containsWallClockDrivenSample) {
        harnessDrift.push({
          factor: 'post-boundary-wall-clock-sample-time',
          field,
          frameIndex: p.engineFrame,
          packetId: p.packetId,
          publishRestartSampleCallSite: p.sampleCallSite,
          coldLoadSampleCallSite: c.sampleCallSite,
          publishRestartValue: pv,
          coldLoadValue: cv,
        })
        continue
      }

      if (!numbersEqual(pv, cv)) {
        reportDivergence({
          stage: 'scheduler-sample-time',
          field,
          publishValue: pv,
          coldValue: cv,
          frameIndex: p.engineFrame,
          packetId: p.packetId,
          matchedPrefixBeforeDivergence,
        })
      }
      matchedPrefixBeforeDivergence = {
        stage: 'scheduler-sample-time',
        field,
        frameIndex: p.engineFrame,
        packetId: p.packetId,
      }
    }

    if (!numbersEqual(p.sampledRainIntensityBeforeDerive, c.sampledRainIntensityBeforeDerive)) {
      if (containsWallClockDrivenSample) {
        harnessDrift.push({
          factor: 'post-boundary-wall-clock-sampled-rain',
          frameIndex: p.engineFrame,
          packetId: p.packetId,
          publishRestartValue: p.sampledRainIntensityBeforeDerive,
          coldLoadValue: c.sampledRainIntensityBeforeDerive,
          publishRestartSampleCallSite: p.sampleCallSite,
          coldLoadSampleCallSite: c.sampleCallSite,
        })
      } else {
        reportDivergence({
          stage: 'scheduler-sampled-weather',
          field: 'sampledRainIntensityBeforeDerive',
          publishValue: p.sampledRainIntensityBeforeDerive,
          coldValue: c.sampledRainIntensityBeforeDerive,
          frameIndex: p.engineFrame,
          packetId: p.packetId,
          matchedPrefixBeforeDivergence,
        })
      }
    }

    matchedPrefixBeforeDivergence = {
      stage: 'scheduler-sampled-weather',
      field: 'sampledRainIntensityBeforeDerive',
      frameIndex: p.engineFrame,
      packetId: p.packetId,
    }

    if (containsWallClockDrivenSample) {
      harnessDrift.push({
        factor: 'post-boundary-wall-clock-rain-track-inputs',
        frameIndex: p.engineFrame,
        packetId: p.packetId,
        publishRestartSampleCallSite: p.sampleCallSite,
        coldLoadSampleCallSite: c.sampleCallSite,
      })
    } else {
      compareRainTrackInputs(p, c, matchedPrefixBeforeDivergence)
    }

    matchedPrefixBeforeDivergence = {
      stage: 'scheduler-rain-inputs',
      field: 'rainTrackInputs',
      frameIndex: p.engineFrame,
      packetId: p.packetId,
    }

    const derivationChecks = [
      ['derivedRainIntensity', p.derivedRainIntensity, c.derivedRainIntensity],
      ['derivedDropletsPerSeconds', p.derivedDropletsPerSeconds, c.derivedDropletsPerSeconds],
    ]

    for (const [field, pv, cv] of derivationChecks) {
      if (!numbersEqual(pv, cv)) {
        if (containsWallClockDrivenSample) {
          harnessDrift.push({
            factor: 'post-boundary-wall-clock-derivation',
            field,
            frameIndex: p.engineFrame,
            packetId: p.packetId,
            publishRestartValue: pv,
            coldLoadValue: cv,
            publishRestartSampleCallSite: p.sampleCallSite,
            coldLoadSampleCallSite: c.sampleCallSite,
          })
        } else {
          reportDivergence({
            stage: 'weather-to-config-derivation',
            field,
            publishValue: pv,
            coldValue: cv,
            frameIndex: p.engineFrame,
            packetId: p.packetId,
            matchedPrefixBeforeDivergence,
          })
        }
      }
      matchedPrefixBeforeDivergence = {
        stage: 'weather-to-config-derivation',
        field,
        frameIndex: p.engineFrame,
        packetId: p.packetId,
      }
    }
  }

  if (publish.entries.length !== cold.entries.length) {
    const extraInPublish = publish.entries.length > cold.entries.length
    const firstExtraOrMissing = extraInPublish ? publish.entries[comparedCount] : cold.entries[comparedCount]
    if (isExpectedStartupLiveBoundaryCallSite(firstExtraOrMissing?.sampleCallSite)) {
      harnessDrift.push({
        factor: 'post-boundary-entry-count-variant',
        field: extraInPublish ? 'extra-entry-in-publish-restart' : 'missing-entry-in-publish-restart',
        frameIndex: Number(firstExtraOrMissing?.engineFrame ?? -1),
        packetId: Number(firstExtraOrMissing?.packetId ?? -1),
        sampleCallSite: String(firstExtraOrMissing?.sampleCallSite || ''),
      })
    } else {
      reportDivergence({
        stage: 'weather-apply-lineage',
        field: extraInPublish ? 'extra-entry-in-publish-restart' : 'missing-entry-in-publish-restart',
        publishValue: extraInPublish ? firstExtraOrMissing : null,
        coldValue: extraInPublish ? null : firstExtraOrMissing,
        frameIndex: Number(firstExtraOrMissing?.engineFrame ?? -1),
        packetId: Number(firstExtraOrMissing?.packetId ?? -1),
        matchedPrefixBeforeDivergence,
      })
    }
  }

  return matchedPrefixBeforeDivergence
}

function getFrame(modeCapture, frameIndex) {
  const frames = Array.isArray(modeCapture?.frames) ? modeCapture.frames : []
  return frames.find((frame) => Number(frame?.frameIndex ?? -1) === Number(frameIndex)) || null
}

function compareAppliedWeatherFrames1To3(publishRestart, coldLoad, matchedPrefixBeforeDivergence, harnessDrift) {
  for (let frameIndex = 1; frameIndex <= 3; frameIndex += 1) {
    const p = getFrame(publishRestart, frameIndex)
    const c = getFrame(coldLoad, frameIndex)

    if (!p || !c) {
      reportDivergence({
        stage: 'applied-weather-config',
        field: `frame-${frameIndex}-present`,
        publishValue: Boolean(p),
        coldValue: Boolean(c),
        frameIndex,
        packetId: frameIndex,
        matchedPrefixBeforeDivergence,
      })
    }

    const checks = [
      ['rainIntensity', p.rainIntensity, c.rainIntensity],
      ['dropletsPerSeconds', p.dropletsPerSeconds, c.dropletsPerSeconds],
      ['linkedMistDensity', p.linkedMistDensity, c.linkedMistDensity],
      ['linkedFogSoftness', p.linkedFogSoftness, c.linkedFogSoftness],
      ['linkedRunnerInfluence', p.linkedRunnerInfluence, c.linkedRunnerInfluence],
    ]

    for (const [field, pv, cv] of checks) {
      if (!numbersEqual(pv, cv)) {
        harnessDrift.push({
          factor: 'applied-weather-frame-delta',
          field,
          frameIndex,
          packetId: Number(p?.packetId ?? frameIndex),
          publishRestartValue: pv,
          coldLoadValue: cv,
          matchedPrefixBeforeDivergence,
        })
      }
      matchedPrefixBeforeDivergence = {
        stage: 'applied-weather-config',
        field,
        frameIndex,
        packetId: Number(p?.packetId ?? frameIndex),
      }
    }
  }
}

function compareTopDown(publishRestart, coldLoad) {
  const harnessDrift = []
  const matchedPrefix = comparePostBoundaryWeatherLineage(publishRestart, coldLoad, harnessDrift)
  compareAppliedWeatherFrames1To3(publishRestart, coldLoad, matchedPrefix, harnessDrift)
  return harnessDrift
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
    const publishRestart = await captureMode(publishPage, 'publish-restart', { nav: 'goto' })

    const storageState = await runtimeContext.storageState()
    coldContext = await browser.newContext({ viewport: { width: 1366, height: 900 }, storageState })
    await addDeterministicSeedScript(coldContext, DETERMINISTIC_SEED)

    const coldPage = await coldContext.newPage()
    const coldLoad = await captureMode(coldPage, 'cold-load', { nav: 'goto' })

    const harnessDrift = compareTopDown(publishRestart, coldLoad)

    console.log(JSON.stringify({
      ok: true,
      classification: harnessDrift.length > 0 ? 'harness-induced-drift' : 'deterministic-pass',
      harnessDrift,
      message: harnessDrift.length > 0
        ? 'No deterministic divergence through frame 3; wall-clock boundary drift detected in startup live callsite/time markers.'
        : 'No post-first-live-boundary weather lineage divergence detected through frame 3.',
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
