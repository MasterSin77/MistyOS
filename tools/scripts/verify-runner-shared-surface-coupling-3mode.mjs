import { chromium } from 'playwright'

const BASE_URL = process.env.MISTYOS_BASE_URL || 'http://127.0.0.1:5183'
const TIMELINE_ID = process.env.MISTYOS_TIMELINE_ID || 'runner-carve-diagnosis'
const DETERMINISTIC_SEED = Number(process.env.MISTYOS_DETERMINISTIC_SEED || 133742)
const WAIT_BEFORE_REFRESH_MS = Number(process.env.MISTYOS_WAIT_BEFORE_REFRESH_MS || 2500)
const PHASE_LOCK_TIMEOUT_MS = Number(process.env.MISTYOS_PHASE_LOCK_TIMEOUT_MS || 20000)
const PHASE_LOCK_PACKET_WARMUP = Number(process.env.MISTYOS_PHASE_LOCK_PACKET_WARMUP || 24)
const PHASE_LOCK_CAPTURE_PACKETS = Number(process.env.MISTYOS_PHASE_LOCK_CAPTURE_PACKETS || 6)

const STAGES = {
  BOOT: 'boot-stats-available',
  PHASE_LOCK: 'phase-lock-capture',
  RUNNER_ACTIVITY: 'runner-activity-detected',
  CONTINUITY: 'runner-path-continuity',
  ACCUMULATION: 'wetness-accumulation',
  FOG_RESPONSE: 'fog-response-to-wetness',
  DECAY: 'decay-over-time',
  CROSS_MODE: 'cross-mode-determinism',
}

const METRIC_BANDS = {
  continuityGapMean: { stage: STAGES.CONTINUITY, min: 0.034, max: 0.044 },
  depthGainMean: { stage: STAGES.ACCUMULATION, min: 0.011, max: 0.0134 },
  fogResponseMean: { stage: STAGES.FOG_RESPONSE, min: 0.078, max: 0.118 },
  recoveryLossMean: { stage: STAGES.DECAY, min: 0.037, max: 0.0392 },
  fogDecayRatioMean: { stage: STAGES.DECAY, min: 0.999, max: 1.001 },
}

const CROSS_MODE_RELATIVE_TOLERANCE = {
  continuityGapMean: 0.02,
  depthGainMean: 0.02,
  fogResponseMean: 0.02,
  recoveryLossMean: 0.02,
  fogDecayRatioMean: 0.01,
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fail(stage, mode, details) {
  throw new Error(JSON.stringify({ ok: false, stage, mode, details }, null, 2))
}

function failContract({ stage, mode, metric, expectedRange, actualValue, phaseMarker = null, divergedMode = null, relativeDelta = null, tolerance = null }) {
  const details = {
    metric,
    expectedRange,
    actualValue,
  }
  if (phaseMarker !== null) {
    details.phaseMarker = phaseMarker
  }
  if (divergedMode !== null) {
    details.divergedMode = divergedMode
  }
  if (relativeDelta !== null) {
    details.relativeDelta = relativeDelta
  }
  if (tolerance !== null) {
    details.tolerance = tolerance
  }
  fail(stage, mode, details)
}

function assertRange(stage, mode, metric, value, range, phaseMarker) {
  if (value < range.min || value > range.max) {
    failContract({
      stage,
      mode,
      metric,
      expectedRange: { min: range.min, max: range.max },
      actualValue: value,
      phaseMarker,
    })
  }
}

function average(values) {
  if (!values.length) {
    return 0
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function relativeDelta(a, b) {
  const denom = Math.max(1e-6, Math.abs(a), Math.abs(b))
  return Math.abs(a - b) / denom
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

    window.__MISTYOS_DETERMINISTIC_RANDOM = {
      seed: Number(seedValue),
      algorithm: 'lcg32',
    }
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
        selectedSceneId: null,
        selectedPresetId: null,
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
    const restartToken = `runner-shared-coupling-${publishReason}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

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

    return {
      ok: true,
      publishRevision: nextPublishRevision,
      restartToken,
    }
  }, {
    targetTimelineId: timelineId,
    publishReason: reason,
  })

  if (!result?.ok) {
    failContract({
      stage: STAGES.BOOT,
      mode: reason,
      metric: 'publishRuntimePayload',
      expectedRange: { min: 1, max: 1 },
      actualValue: 0,
      phaseMarker: result?.reason || 'unknown',
    })
  }

  return result
}

async function waitForPresentationDiagnostics(page, mode) {
  const ready = await page.waitForFunction(() => {
    return Boolean(
      window.__MISTYOS_PRESENTATION_STATS?.timing
      && window.__MISTYOS_PRESENTATION_RUNTIME?.resetTimeToZero
      && window.__MISTYOS_PRESENTATION_RUNTIME?.seekFirstRainWindow
      && window.__MISTYOS_PRESENTATION_RAIN_DEBUG,
    )
  }, { timeout: PHASE_LOCK_TIMEOUT_MS }).catch(() => null)

  if (!ready) {
    failContract({
      stage: STAGES.BOOT,
      mode,
      metric: 'presentationDiagnosticsReady',
      expectedRange: { min: 1, max: 1 },
      actualValue: 0,
    })
  }
}

async function phaseLockMode(page, mode) {
  const requested = await page.evaluate(() => {
    const runtime = window.__MISTYOS_PRESENTATION_RUNTIME
    runtime.resetTimeToZero()
    runtime.seekFirstRainWindow()
    return {
      runtimeSessionKey: runtime.runtimeSessionKey || null,
      publishRevision: Number(runtime.publishRevision || 0),
      requestedAction: 'dev-control-seek-first-rain-window',
    }
  })

  const locked = await page.waitForFunction(() => {
    const runtime = window.__MISTYOS_PRESENTATION_RUNTIME
    const clock = runtime?.clockDebug || {}
    return clock.lastAction === 'dev-control-seek-first-rain-window' && clock.mode === 'locked' && Number.isFinite(Number(clock.targetSec))
  }, { timeout: PHASE_LOCK_TIMEOUT_MS }).catch(() => null)

  if (!locked) {
    failContract({
      stage: STAGES.PHASE_LOCK,
      mode,
      metric: 'phaseLockFirstRainWindow',
      expectedRange: { min: 1, max: 1 },
      actualValue: 0,
      phaseMarker: requested,
    })
  }

  const phaseMarker = await page.evaluate(() => {
    const runtime = window.__MISTYOS_PRESENTATION_RUNTIME || {}
    const clock = runtime.clockDebug || {}
    const rain = window.__MISTYOS_PRESENTATION_RAIN_DEBUG || {}
    const timing = window.__MISTYOS_PRESENTATION_STATS?.timing || {}
    return {
      type: 'first-rain-window-locked',
      targetSec: Number(clock.targetSec || 0),
      loopTimeSec: Number(rain.loopTimeSec || 0),
      currentTimeSec: Number(rain.currentTimeSec || 0),
      basePacketId: Number(timing.runnerCarveDiagnosticsPacketId || 0),
      baseWetnessFrameCounter: Number(timing.wetnessFrameCounter || 0),
    }
  })

  return {
    ...requested,
    ...phaseMarker,
  }
}

async function capturePhaseLockedPackets(page, mode, phaseMarker) {
  const capture = await page.evaluate(async ({ warmupPackets, capturePackets, timeoutMs }) => {
    const readPacket = () => {
      const timing = window.__MISTYOS_PRESENTATION_STATS?.timing || {}
      const rain = window.__MISTYOS_PRESENTATION_RAIN_DEBUG || {}
      return {
        packetId: Number(timing.runnerCarveDiagnosticsPacketId || 0),
        wetnessFrameCounter: Number(timing.wetnessFrameCounter || 0),
        loopTimeSec: Number(rain.loopTimeSec || 0),
        currentTimeSec: Number(rain.currentTimeSec || 0),
        runnerCarveSamples: Number(timing.runnerCarveSamples || 0),
        runnerCarveGapFraction: Number(timing.runnerCarveGapFraction || 0),
        runnerCarveDepthGainMean: Number(timing.runnerCarveDepthGainMean || 0),
        runnerCarveRecoveryLossMean: Number(timing.runnerCarveRecoveryLossMean || 0),
        runnerCarveFogResponseRatioMean: Number(timing.runnerCarveFogResponseRatioMean || 0),
        runnerCarveFogDecayRatioMean: Number(timing.runnerCarveFogDecayRatioMean || 0),
      }
    }

    const basePacket = readPacket()
    const targetPacketId = basePacket.packetId + warmupPackets

    return await new Promise((resolve) => {
      const packets = []
      const packetIds = []
      const startedAt = performance.now()

      const step = () => {
        const packet = readPacket()
        if (performance.now() - startedAt > timeoutMs) {
          resolve({ ok: false, targetPacketId, lastPacket: packet })
          return
        }

        if (!packetIds.includes(packet.packetId) && packet.packetId >= targetPacketId && packet.runnerCarveSamples > 0) {
          packetIds.push(packet.packetId)
          packets.push(packet)
          if (packets.length >= capturePackets) {
            resolve({ ok: true, targetPacketId, packetIds, packets })
            return
          }
        }

        requestAnimationFrame(step)
      }

      requestAnimationFrame(step)
    })
  }, {
    warmupPackets: PHASE_LOCK_PACKET_WARMUP,
    capturePackets: PHASE_LOCK_CAPTURE_PACKETS,
    timeoutMs: PHASE_LOCK_TIMEOUT_MS,
  })

  if (!capture?.ok) {
    failContract({
      stage: STAGES.PHASE_LOCK,
      mode,
      metric: 'phaseLockedRunnerPackets',
      expectedRange: { min: PHASE_LOCK_CAPTURE_PACKETS, max: PHASE_LOCK_CAPTURE_PACKETS },
      actualValue: 0,
      phaseMarker: {
        ...phaseMarker,
        targetPacketId: capture?.targetPacketId ?? null,
        lastPacket: capture?.lastPacket ?? null,
      },
    })
  }

  return capture
}

function summarizeCapturedPackets(mode, phaseMarker, capture) {
  const packets = Array.isArray(capture?.packets) ? capture.packets : []
  if (!packets.length) {
    failContract({
      stage: STAGES.RUNNER_ACTIVITY,
      mode,
      metric: 'runnerCarveSamples',
      expectedRange: { min: 1, max: Number.POSITIVE_INFINITY },
      actualValue: 0,
      phaseMarker,
    })
  }

  const metrics = {
    continuityGapMean: average(packets.map((packet) => packet.runnerCarveGapFraction)),
    depthGainMean: average(packets.map((packet) => packet.runnerCarveDepthGainMean)),
    fogResponseMean: average(packets.map((packet) => packet.runnerCarveFogResponseRatioMean)),
    recoveryLossMean: average(packets.map((packet) => packet.runnerCarveRecoveryLossMean)),
    fogDecayRatioMean: average(packets.map((packet) => packet.runnerCarveFogDecayRatioMean)),
  }

  const resolvedPhaseMarker = {
    ...phaseMarker,
    targetPacketId: capture.targetPacketId,
    packetIds: capture.packetIds,
  }

  assertRange(STAGES.CONTINUITY, mode, 'continuityGapMean', metrics.continuityGapMean, METRIC_BANDS.continuityGapMean, resolvedPhaseMarker)
  assertRange(STAGES.ACCUMULATION, mode, 'depthGainMean', metrics.depthGainMean, METRIC_BANDS.depthGainMean, resolvedPhaseMarker)
  assertRange(STAGES.FOG_RESPONSE, mode, 'fogResponseMean', metrics.fogResponseMean, METRIC_BANDS.fogResponseMean, resolvedPhaseMarker)
  assertRange(STAGES.DECAY, mode, 'recoveryLossMean', metrics.recoveryLossMean, METRIC_BANDS.recoveryLossMean, resolvedPhaseMarker)
  assertRange(STAGES.DECAY, mode, 'fogDecayRatioMean', metrics.fogDecayRatioMean, METRIC_BANDS.fogDecayRatioMean, resolvedPhaseMarker)

  return {
    mode,
    phaseMarker: resolvedPhaseMarker,
    packetCount: packets.length,
    metrics,
  }
}

async function captureMode(page, mode, { nav = 'goto' } = {}) {
  if (nav === 'reload') {
    await page.reload({ waitUntil: 'domcontentloaded' })
  } else {
    await page.goto(`${BASE_URL}/?rdfxDebug=1`, { waitUntil: 'domcontentloaded' })
  }

  await waitForPresentationDiagnostics(page, mode)
  const phaseMarker = await phaseLockMode(page, mode)
  const capture = await capturePhaseLockedPackets(page, mode, phaseMarker)
  return summarizeCapturedPackets(mode, phaseMarker, capture)
}

function assertCrossModeDeterminism(runs) {
  for (let leftIndex = 0; leftIndex < runs.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < runs.length; rightIndex += 1) {
      const left = runs[leftIndex]
      const right = runs[rightIndex]

      for (const metricName of Object.keys(CROSS_MODE_RELATIVE_TOLERANCE)) {
        const delta = relativeDelta(Number(left.metrics[metricName] || 0), Number(right.metrics[metricName] || 0))
        const tolerance = CROSS_MODE_RELATIVE_TOLERANCE[metricName]
        if (delta > tolerance) {
          failContract({
            stage: STAGES.CROSS_MODE,
            mode: right.mode,
            metric: metricName,
            expectedRange: { min: 0, max: tolerance },
            actualValue: delta,
            phaseMarker: right.phaseMarker,
            divergedMode: left.mode,
            relativeDelta: delta,
            tolerance,
          })
        }
      }
    }
  }
}

async function runVerifierOnce() {
  const browser = await chromium.launch({ headless: true })

  try {
    const runtimeContext = await browser.newContext({ viewport: { width: 1366, height: 900 } })
    await addDeterministicSeedScript(runtimeContext, DETERMINISTIC_SEED)

    const runtimePage = await runtimeContext.newPage()
    await runtimePage.goto(`${BASE_URL}/studio`, { waitUntil: 'domcontentloaded' })
    await publishRuntimePayload(runtimePage, TIMELINE_ID, 'publish-restart')

    const publishRestart = await captureMode(runtimePage, 'publish-restart', { nav: 'goto' })
    await sleep(WAIT_BEFORE_REFRESH_MS)
    const manualRefresh = await captureMode(runtimePage, 'manual-refresh-after-idle', { nav: 'reload' })

    const sharedStorageState = await runtimeContext.storageState()
    const coldContext = await browser.newContext({ viewport: { width: 1366, height: 900 }, storageState: sharedStorageState })
    await addDeterministicSeedScript(coldContext, DETERMINISTIC_SEED)

    const coldPage = await coldContext.newPage()
    const coldLoad = await captureMode(coldPage, 'cold-load-cleared-sessionStorage', { nav: 'goto' })
    await coldContext.close()
    await runtimeContext.close()

    const runs = [publishRestart, manualRefresh, coldLoad]
    assertCrossModeDeterminism(runs)

    return {
      ok: true,
      baseUrl: BASE_URL,
      timelineId: TIMELINE_ID,
      deterministicSeed: DETERMINISTIC_SEED,
      phaseLock: {
        warmupPackets: PHASE_LOCK_PACKET_WARMUP,
        capturePackets: PHASE_LOCK_CAPTURE_PACKETS,
      },
      runs,
    }
  } finally {
    await browser.close()
  }
}

try {
  console.log(JSON.stringify(await runVerifierOnce(), null, 2))
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  try {
    console.error(JSON.stringify(JSON.parse(message), null, 2))
  } catch {
    console.error(JSON.stringify({ ok: false, stage: 'unclassified-error', message }, null, 2))
  }
  process.exitCode = 1
}
