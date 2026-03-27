import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { WetSurfaceEngine } from '../engine/WetSurfaceEngine'
import {
  STARTUP_MODES,
} from '../config'
import { createSchedulerRuntime } from '../scheduler/runtime'
import { createFourQuadrantRegionModel } from '../scheduler/region-model'
import { getLinkedEffectiveConfig } from '../tuning/tuningConfig'
import { getPublishedRuntimeDocument, subscribePublishedRuntimeDocument } from '../runtime/authoringRuntimeBridge'
import {
  buildRuntimeWeatherDrivenConfig,
  resolveRuntimeExecutionFromPayload,
  shortRuntimePayloadHash,
} from '../runtime/runtimeExecution'
import { getLatestVerificationArtifact, subscribeVerificationArtifacts } from '../verification/verificationArtifactStore'
import { recordRuntimeSample } from '../verification/runtimeSampleStore'

/**
 * MistyOS runtime contract (non-negotiable):
 * 1) Two-surface architecture: Studio authoring -> Publish -> Presentation restart.
 * 2) Presentation is a pure consumer of published runtime payload.
 * 3) Scheduler timeline is the sole temporal authority for runtime weather.
 * 4) Rain/fog/wetness must derive deterministically from scheduler-sampled weather.
 * 5) Engine startup must be idempotent across cold start, publish restart, and browser refresh.
 */

function isDevRuntime() {
  try {
    return Boolean(import.meta?.env?.DEV)
  } catch {
    return false
  }
}

function devLog(event, details) {
  if (!isDevRuntime()) {
    return
  }

  console.info('[MistyOS][Presentation]', {
    event,
    ...details,
  })
}

function summarizeTimelineWeatherTracks(runtimeTimeline) {
  const tracks = Array.isArray(runtimeTimeline?.weatherTracks) ? runtimeTimeline.weatherTracks : []
  const summary = {
    total: tracks.length,
    rain: 0,
    fogBuildup: 0,
    fogClearing: 0,
    mist: 0,
    washdown: 0,
    wind: 0,
    regions: {},
  }

  tracks.forEach((track) => {
    const kind = String(track?.kind || '')
    if (Object.hasOwn(summary, kind)) {
      summary[kind] += 1
    }
    const region = String(track?.region || 'global')
    summary.regions[region] = (summary.regions[region] || 0) + 1
  })

  return summary
}

function classifyRainFogMismatch({
  rainContribution,
  fogContribution,
  rainIntensity,
  dropletsPerSeconds,
  publishRevision,
}) {
  const lowRain = rainIntensity <= 0.001
  const lowDropletRate = dropletsPerSeconds <= 90
  const fogActive = fogContribution > 0.015
  const rainTrackActive = rainContribution > 0.015

  if (rainTrackActive && lowDropletRate) {
    return {
      className: 'rain-track-active-but-droplets-low',
      severity: 'high',
      reason: 'Scheduler rain contribution is active but runtime droplets stay near baseline.',
      publishRevision,
    }
  }

  if (lowRain && fogActive) {
    return {
      className: 'fog-active-rain-zero',
      severity: 'medium',
      reason: 'Fog tracks contribute while rain is zero at sampled time.',
      publishRevision,
    }
  }

  return {
    className: 'none',
    severity: 'none',
    reason: null,
    publishRevision,
  }
}

// Diagnostic-only lineage marker used to classify boot path labels during parity checks.
// This value never participates in runtime weather/state authority.
const PRESENTATION_RUNTIME_SESSION_STORAGE_KEY = 'mistyos.presentation.lastRuntimeSessionKey.v1'
const STARTUP_FIRST_LIVE_ENGINE_FRAME = 1
const STARTUP_FIRST_LIVE_SAMPLE_SEC = STARTUP_FIRST_LIVE_ENGINE_FRAME / 60
const STARTUP_FRAME_SYNC_END_FRAME = STARTUP_FIRST_LIVE_ENGINE_FRAME + 1

const resolveStartupPhaseTag = (sampleCallSite = '') => {
  if (sampleCallSite === 'start:shared-pre-start-bootstrap' || sampleCallSite === 'start:static-hold-pre-start-bootstrap') {
    return 'canonical-bootstrap'
  }
  if (sampleCallSite === 'onStats:startup-first-live-boundary') {
    return 'first-live-boundary'
  }
  if (sampleCallSite === 'updateAtmosphere:startup-frame-sync') {
    return 'startup-frame-sync'
  }
  if (
    sampleCallSite === 'updateAtmosphere:canonical-zero-handoff' ||
    sampleCallSite === 'updateAtmosphere:startup-frame0-hold'
  ) {
    return 'pre-live-hold'
  }
  return 'non-startup'
}

  /**
   * Legacy Presentation bootstrap helper retained for diagnostics/fallback.
   *
   * Scans the scheduler for the first active rain window using a fine-grained step
   * (0.01 s) for the first 30 s, then a coarser 0.5 s step for the remainder.
   * The fine scan catches brief rain windows produced by compiled clip timelines where
   * envelope points are spaced far apart and the round-trip through parseTimelineToClips
   * produces 0.1-second clips that the previous 0.25 s scan step skipped entirely.
   *
   * Returns the first rain window time, the sampled weather there, and the
   * buildRuntimeWeatherDrivenConfig result ready to apply to the engine before start().
   *
  * Slice C moves canonical pre-start bootstrap ownership into the engine boundary.
  * This helper remains available for scheduler-only diagnostics and defensive fallback.
   */
  function resolvePreStartBootstrapConfig(schedulerRuntime, basePreset, timelineDurationSec) {
    const empty = {
      firstRainWindowSec: null,
      rainContributionFound: false,
      preStartSec: 0,
      rainAtZero: 0,
      rainAtWindow: 0,
      dropletsPerSeconds: 0,
      weather: null,
      drivenConfig: null,
      scanSteps: 0,
    }
    if (!schedulerRuntime || !basePreset) {
      return empty
    }

    const durationSec = Math.max(0.001, schedulerRuntime.durationSec || timelineDurationSec || 180)

    // Capture rain at t=0 for paired diagnostics (before seeking elsewhere).
    const snapAtZero = schedulerRuntime.sample({ elapsedSec: 0, fps: 60 })
    const rainAtZero = snapAtZero?.weather?.rain || 0

    let firstRainWindowSec = null
    let rainContributionFound = false
    let scanSteps = 0

    // Phase 1: fine-grained scan for the first 30 s.
    // Catches brief compiled-clip rain windows (e.g. 0.04–0.10 s) that a 0.25 s step misses.
    const fineUntilSec = Math.min(30, durationSec)
    for (let t = 0; t <= fineUntilSec; t += 0.01) {
      scanSteps += 1
      const snap = schedulerRuntime.sample({ elapsedSec: t, fps: 60, includeDiagnostics: true })
      const rainVal = snap?.weather?.rain || 0
      if (rainVal > 0.001) {
        if (firstRainWindowSec === null) {
          firstRainWindowSec = t
        }
        const rainContribs = (snap?.diagnostics?.weatherTrackContributions || [])
          .filter((e) => e.kind === 'rain' && (e.contribution || 0) > 0)
        if (rainContribs.length > 0) {
          firstRainWindowSec = t
          rainContributionFound = true
          break
        }
      }
    }

    // Phase 2: coarser scan for the remainder of the timeline.
    if (!rainContributionFound) {
      for (let t = fineUntilSec + 0.5; t <= durationSec; t += 0.5) {
        scanSteps += 1
        const snap = schedulerRuntime.sample({ elapsedSec: t, fps: 60, includeDiagnostics: true })
        const rainVal = snap?.weather?.rain || 0
        if (rainVal > 0.001) {
          if (firstRainWindowSec === null) {
            firstRainWindowSec = t
          }
          const rainContribs = (snap?.diagnostics?.weatherTrackContributions || [])
            .filter((e) => e.kind === 'rain' && (e.contribution || 0) > 0)
          if (rainContribs.length > 0) {
            firstRainWindowSec = t
            rainContributionFound = true
            break
          }
        }
      }
    }

    const preStartSec = Number.isFinite(firstRainWindowSec) ? firstRainWindowSec : 0
    const preStartSnap = schedulerRuntime.sample({ elapsedSec: preStartSec, fps: 60, includeDiagnostics: true })
    const weather = preStartSnap?.weather || null
    const drivenConfig = weather ? buildRuntimeWeatherDrivenConfig(basePreset, weather) : null
    const rainAtWindow = weather?.rain || 0
    const dropletsPerSeconds = drivenConfig?.renderer?.dropletsPerSeconds || 0

    return {
      firstRainWindowSec,
      rainContributionFound,
      preStartSec,
      rainAtZero,
      rainAtWindow,
      dropletsPerSeconds,
      weather,
      drivenConfig,
      scanSteps,
      snapAtZero,
      preStartSnap,
    }
  }

function getNavigationType() {
  if (typeof window === 'undefined' || typeof performance === 'undefined') {
    return 'navigate'
  }

  const entries = performance.getEntriesByType?.('navigation') || []
  const entry = entries[0]
  return entry?.type || 'navigate'
}

function resolveVerificationSampleLabel({ runtimeSessionKey, publishRevision, restartToken }) {
  if (publishRevision <= 0 || restartToken === 'local-default') {
    return 'initial-load'
  }

  if (typeof window === 'undefined') {
    return 'post-publish'
  }

  let previousRuntimeSessionKey = null
  try {
    previousRuntimeSessionKey = window.sessionStorage.getItem(PRESENTATION_RUNTIME_SESSION_STORAGE_KEY)
  } catch {
    previousRuntimeSessionKey = null
  }

  // Classification only for diagnostics metadata in captured samples.
  const navigationType = getNavigationType()
  if (navigationType === 'reload' && previousRuntimeSessionKey === runtimeSessionKey) {
    return 'manual-refresh'
  }

  return 'post-publish'
}

function withSchedulerInvariantHints(drivenConfig, weather) {
  if (!drivenConfig) {
    return null
  }

  return {
    ...drivenConfig,
    debug: {
      ...(drivenConfig.debug || {}),
      runtimeSchedulerRainActive: Number(weather?.rain || 0) > 0.001,
      runtimeSampledRainIntensity: Number(weather?.rain || 0),
    },
  }
}

function summarizeRainTrackInputs(snapshot) {
  const contributions = Array.isArray(snapshot?.diagnostics?.weatherTrackContributions)
    ? snapshot.diagnostics.weatherTrackContributions
    : []

  return contributions
    .filter((entry) => entry?.kind === 'rain')
    .map((entry) => ({
      trackKey: String(entry?.trackKey || ''),
      contribution: Number(entry?.contribution || 0),
      envelopeValue: Number(entry?.envelopeValue || 0),
      interpolationT: Number(entry?.interpolationT || 0),
      previousPointTimeSec: Number(entry?.previousPoint?.timeSec || 0),
      previousPointValue: Number(entry?.previousPoint?.value || 0),
      nextPointTimeSec: Number(entry?.nextPoint?.timeSec || 0),
      nextPointValue: Number(entry?.nextPoint?.value || 0),
      sourceClipIds: Array.isArray(entry?.sourceClipIds) ? [...entry.sourceClipIds] : [],
    }))
}

function extractRainSamplingTrace(snapshot, details = {}) {
  const diagnostics = snapshot?.diagnostics || {}
  const rainTracks = (diagnostics.weatherTrackContributions || [])
    .filter((entry) => entry.kind === 'rain')
    .map((entry) => ({
      trackKey: entry.trackKey,
      sourceClipIds: Array.isArray(entry.sourceClipIds) ? [...entry.sourceClipIds] : [],
      envelopeValue: Number(entry.envelopeValue || 0),
      contribution: Number(entry.contribution || 0),
      regionWeight: Number(entry.regionWeight || 0),
      envelopeSampleSec: Number(entry.envelopeSampleSec || 0),
      interpolationT: Number(entry.interpolationT || 0),
      previousPoint: entry.previousPoint ? {
        timeSec: Number(entry.previousPoint.timeSec || 0),
        value: Number(entry.previousPoint.value || 0),
      } : null,
      nextPoint: entry.nextPoint ? {
        timeSec: Number(entry.nextPoint.timeSec || 0),
        value: Number(entry.nextPoint.value || 0),
      } : null,
    }))

  return {
    callSite: details.callSite || 'unknown',
    rawElapsedSec: Number.isFinite(details.rawElapsedSec) ? details.rawElapsedSec : null,
    currentTimeSec: Number.isFinite(details.currentTimeSec) ? details.currentTimeSec : null,
    loopTimeSec: Number(snapshot?.sampleSec || 0),
    rainIntensity: Number(snapshot?.weather?.rain || 0),
    clockDebug: details.clockDebug || null,
    sampleInput: diagnostics.sampleInput || null,
    rainTracks,
  }
}

function PresentationPage() {
  const canvasRef = useRef(null)
  const engineRef = useRef(null)
  const schedulerRef = useRef(null)
  const clockAnchorMsRef = useRef(performance.now())
  const clockOffsetSecRef = useRef(0)
  const clockLockedSecRef = useRef(null)
  const previousRuntimeSessionKeyRef = useRef(null)
  const rainMismatchFramesRef = useRef(0)
  const lastMismatchClassRef = useRef('none')
  const verificationSampleIndexRef = useRef(0)
  const verificationCaptureActiveRef = useRef(false)
  const verificationSampleLabelRef = useRef('initial-load')
  const bootstrapPathIsRefreshRef = useRef(false)
  const bootParitySnapshotRef = useRef(null)
  const bootParityLoggedSessionRef = useRef(null)
  const startupCanonicalSamplePendingRef = useRef(true)
  const startupFirstLiveSamplePendingRef = useRef(true)
  const startupPreFrameAppliedSignatureRef = useRef(null)
  const firstRuntimeSampleLoggedRef = useRef(false)
  const handoffTraceRef = useRef({
    sampled: 0,
    applied: 0,
    liveSampleSeen: false,
    done: false,
  })
  const tuningApplySequenceRef = useRef(0)

  const [publishedDocument, setPublishedDocument] = useState(() => getPublishedRuntimeDocument())
  const [isLauncherHovered, setIsLauncherHovered] = useState(false)

    // Stable updater: skip setState when the incoming published document carries the same
    // publishRevision + restartToken as the current one.  The subscribePublishedRuntimeDocument
    // subscription fires an immediate notify() on mount, which would otherwise give runtimePayload
    // a new object reference (deepClone inside normalizePublishedDocument) and trigger a second
    // engine creation on browser refresh even though the payload content is identical.
    const stableSetPublishedDocument = useCallback((doc) => {
      setPublishedDocument((prev) => {
        if (
          prev?.publishRevision === doc?.publishRevision &&
          prev?.restartToken === doc?.restartToken
        ) {
          return prev
        }
        return doc
      })
    }, [])

  const [atmosphereVisible, setAtmosphereVisible] = useState(true)
  const [latestVerificationArtifact, setLatestVerificationArtifact] = useState(null)
  const [presentationStats, setPresentationStats] = useState({ timing: {} })
  const presentationStatsRef = useRef({ timing: {} })
  const updateAtmosphereEffectRunCountRef = useRef(0)
  const updateAtmosphereInvocationCountRef = useRef(0)
  const [rainDebug, setRainDebug] = useState({
    currentTimeSec: 0,
    loopTimeSec: 0,
    durationSec: 0,
    rainIntensity: 0,
    activeRainClipCount: 0,
    activeRainClipIds: [],
    weather: {
      wind: 0,
      rain: 0,
      mist: 0,
      washdown: 0,
      fogBuildup: 0,
      fogClearing: 0,
    },
    drivenDropletsPerSeconds: 0,
  })
  const [clockDebug, setClockDebug] = useState({
    mode: 'running',
    lastAction: 'initial',
    targetSec: 0,
  })

  useEffect(() => subscribePublishedRuntimeDocument(stableSetPublishedDocument), [stableSetPublishedDocument])

  useEffect(() => {
    presentationStatsRef.current = presentationStats
  }, [presentationStats])

  useEffect(() => {
    const refreshVerificationStatus = () => {
      const lineageFilter = {
        publishRevision: publishedDocument?.publishRevision || undefined,
        restartToken: publishedDocument?.restartToken || undefined,
        sceneId: publishedDocument?.runtimePayload?.selectedSceneId || undefined,
        timelineId: publishedDocument?.runtimePayload?.selectedTimelineId || undefined,
      }

      const lineageArtifact = getLatestVerificationArtifact(lineageFilter)
      setLatestVerificationArtifact(lineageArtifact || null)
    }

    refreshVerificationStatus()
    return subscribeVerificationArtifacts(() => {
      refreshVerificationStatus()
    })
  }, [
    publishedDocument?.publishRevision,
    publishedDocument?.restartToken,
    publishedDocument?.runtimePayload?.selectedSceneId,
    publishedDocument?.runtimePayload?.selectedTimelineId,
  ])

  const runtimePayload = publishedDocument?.runtimePayload || null
  const hasPublishedTimelinePayload = Boolean(runtimePayload?.selectedTimelineId || runtimePayload?.authoredTimeline)
  const runtimeExecution = useMemo(
    () => resolveRuntimeExecutionFromPayload(runtimePayload),
    [runtimePayload],
  )
  const settings = runtimeExecution.settings
  const scene = runtimeExecution.scene
  const runtimeTimeline = runtimeExecution.timeline

  const runtimeSessionKey = `${publishedDocument?.publishRevision || 0}:${publishedDocument?.restartToken || 'local-default'}`
  const runtimePayloadHash = shortRuntimePayloadHash(runtimePayload)
  const publishRevision = publishedDocument?.publishRevision || 0
  const fromSavedRevision = publishedDocument?.fromSavedRevision || 0
  const restartToken = publishedDocument?.restartToken || 'local-default'
  const shouldAutoRunTimeline = hasPublishedTimelinePayload || settings.presentation?.autoRunTimeline === true
  const timelineDurationSec = runtimeTimeline?.duration?.seconds || 180

  const resetPresentationClock = useCallback((reason = 'manual-reset') => {
    const now = performance.now()
    clockAnchorMsRef.current = now
    clockOffsetSecRef.current = 0
    clockLockedSecRef.current = null
    // Slice B scaffold plumbing: mirror Presentation reset into engine-owned clock seam.
    // Presentation remains the active driver in this transitional pass.
    engineRef.current?.resetSimulationClock?.({
      reason,
      startSec: 0,
      nowMs: now,
    })
    if (isDevRuntime()) {
      devLog('presentation-clock-reset', {
        reason,
        anchorMs: now,
        offsetSec: 0,
        lockedSec: null,
      })
    }
    setClockDebug({
      mode: 'running',
      lastAction: reason,
      targetSec: 0,
    })
  }, [])

  const seekPresentationClock = useCallback((targetSec, options = {}) => {
    const durationSec = Math.max(0.001, timelineDurationSec)
    const now = performance.now()
    const clampedTargetSec = clamp(targetSec, 0, durationSec)

    if (options.lockAtTarget) {
      clockLockedSecRef.current = clampedTargetSec
    } else {
      clockLockedSecRef.current = null
      clockOffsetSecRef.current = clampedTargetSec
      clockAnchorMsRef.current = now
    }

    engineRef.current?.seekSimulationClock?.(clampedTargetSec, {
      reason: options.reason || 'seek',
      lockAtTarget: options.lockAtTarget === true,
      nowMs: now,
    })

    setClockDebug({
      mode: options.lockAtTarget ? 'locked' : 'running',
      lastAction: options.reason || 'seek',
      targetSec: clampedTargetSec,
    })
  }, [timelineDurationSec])

  const getPresentationTimeSec = useCallback(() => {
    const now = performance.now()
    if (Number.isFinite(clockLockedSecRef.current)) {
      const lockedSec = clockLockedSecRef.current
      engineRef.current?.mirrorPresentationClockSample?.({
        source: 'presentation-get-time',
        callSite: 'getPresentationTimeSec:locked',
        currentTimeSec: lockedSec,
        nowMs: now,
      })
      return lockedSec
    }
    const elapsedSec = Math.max(0, (now - clockAnchorMsRef.current) / 1000)
    const currentSec = Math.max(0, clockOffsetSecRef.current + elapsedSec)
    engineRef.current?.mirrorPresentationClockSample?.({
      source: 'presentation-get-time',
      callSite: 'getPresentationTimeSec:running',
      currentTimeSec: currentSec,
      nowMs: now,
    })
    return currentSec
  }, [])

  const findFirstActiveRainWindowSec = useCallback(() => {
    const runtime = schedulerRef.current
    if (!runtime) {
      return null
    }

    const durationSec = Math.max(0.001, runtime.durationSec || timelineDurationSec || 180)
    const stepSec = 0.25

    let firstWeatherRainSec = null
    for (let sampleSec = 0; sampleSec <= durationSec; sampleSec += stepSec) {
      const snapshot = runtime.sample({
        elapsedSec: sampleSec,
        fps: 60,
        includeDiagnostics: true,
      })

      if (firstWeatherRainSec === null && (snapshot?.weather?.rain || 0) > 0.001) {
        firstWeatherRainSec = sampleSec
      }

      const rainContributions = (snapshot?.diagnostics?.weatherTrackContributions || [])
        .filter((entry) => entry.kind === 'rain' && (entry.contribution || 0) > 0)

      if ((snapshot?.weather?.rain || 0) > 0.001 && rainContributions.length > 0) {
        return sampleSec
      }
    }

    return firstWeatherRainSec
  }, [timelineDurationSec])

  const handleResetTimeToZero = useCallback(() => {
    resetPresentationClock('dev-control-reset-time-0')
  }, [resetPresentationClock])

  const handleSeekFirstRainWindow = useCallback(() => {
    const firstRainWindowSec = findFirstActiveRainWindowSec()
    if (!Number.isFinite(firstRainWindowSec)) {
      setClockDebug((prev) => ({
        ...prev,
        lastAction: 'seek-first-rain-window-not-found',
      }))
      return
    }

    seekPresentationClock(firstRainWindowSec, {
      lockAtTarget: true,
      reason: 'dev-control-seek-first-rain-window',
    })
  }, [findFirstActiveRainWindowSec, seekPresentationClock])

  useEffect(() => {
    let previousSessionKey = previousRuntimeSessionKeyRef.current
    if (!previousSessionKey && typeof window !== 'undefined') {
      try {
        previousSessionKey = window.sessionStorage.getItem(PRESENTATION_RUNTIME_SESSION_STORAGE_KEY)
      } catch {
        previousSessionKey = null
      }
    }

    const navigationType = getNavigationType()
    const isManualRefresh = navigationType === 'reload' && previousSessionKey === runtimeSessionKey
    
    if (previousSessionKey && previousSessionKey !== runtimeSessionKey) {
      devLog('restart-trigger', {
        previousRuntimeSessionKey: previousSessionKey,
        nextRuntimeSessionKey: runtimeSessionKey,
        publishRevision: publishedDocument?.publishRevision || 0,
        fromSavedRevision: publishedDocument?.fromSavedRevision || 0,
        restartToken: publishedDocument?.restartToken || 'local-default',
      })
    }
    previousRuntimeSessionKeyRef.current = runtimeSessionKey
    bootstrapPathIsRefreshRef.current = isManualRefresh
    rainMismatchFramesRef.current = 0
    lastMismatchClassRef.current = 'none'
    verificationSampleIndexRef.current = 0
    verificationCaptureActiveRef.current = false
    bootParitySnapshotRef.current = null
    bootParityLoggedSessionRef.current = null
    startupCanonicalSamplePendingRef.current = true
    startupFirstLiveSamplePendingRef.current = true
    startupPreFrameAppliedSignatureRef.current = null
    firstRuntimeSampleLoggedRef.current = false
    handoffTraceRef.current = {
      sampled: 0,
      applied: 0,
      liveSampleSeen: false,
      done: false,
    }
    tuningApplySequenceRef.current = 0
    verificationSampleLabelRef.current = resolveVerificationSampleLabel({
      runtimeSessionKey,
      publishRevision,
      restartToken,
    })
    if (typeof window !== 'undefined') {
      try {
        // Diagnostic boot-lineage memo for parity reporting only.
        window.sessionStorage.setItem(PRESENTATION_RUNTIME_SESSION_STORAGE_KEY, runtimeSessionKey)
      } catch {
        // Ignore storage failures in strict/private environments.
      }
    }
    resetPresentationClock('publish-restart')
  }, [publishRevision, publishedDocument?.fromSavedRevision, publishedDocument?.publishRevision, publishedDocument?.restartToken, resetPresentationClock, restartToken, runtimeSessionKey])

  useEffect(() => {
    setAtmosphereVisible(settings.startupMode !== STARTUP_MODES.STATIC_THEN_FADE)
  }, [runtimeSessionKey, settings.startupMode])

  const basePreset = runtimeExecution.basePreset

  const background = scene.background || { type: 'image', src: '/media/rain-room.jpg' }

    useEffect(() => {
      schedulerRef.current = createSchedulerRuntime(runtimeTimeline, {
        regionModel: createFourQuadrantRegionModel({ softness: 0.45 }),
        includeDiagnostics: isDevRuntime(),
      })
      const weatherTrackSummary = summarizeTimelineWeatherTracks(runtimeTimeline)
      // DIAGNOSTIC: log payload fingerprint + timeline lineage so both boot paths can be compared.
      devLog('scheduler-recreated', {
        runtimeSessionKey,
        publishRevision,
        restartToken,
        timelineId: runtimeExecution.timelineId,
        selectedTimelineId: runtimePayload?.selectedTimelineId || 'none',
        hasAuthoredTimeline: Boolean(runtimePayload?.authoredTimeline),
        runtimePayloadHash: shortRuntimePayloadHash(runtimePayload),
        weatherTrackSummary,
      })

      // DIAGNOSTIC POINT 1: fine-grained scan for rain window (mirrors resolvePreStartBootstrapConfig)
      // so scheduler log and engine bootstrap log can be compared side-by-side.
      if (isDevRuntime()) {
        const runtime = schedulerRef.current
        const scanResult = resolvePreStartBootstrapConfig(runtime, null, runtime.durationSec || 180)
        const sampleAt0 = runtime.sample({ elapsedSec: 0, fps: 60, includeDiagnostics: true })
        const rainContribsAtFirst = scanResult.firstRainWindowSec !== null
          ? (runtime.sample({
            elapsedSec: scanResult.firstRainWindowSec,
            fps: 60,
            includeDiagnostics: true,
          })?.diagnostics?.weatherTrackContributions || [])
            .filter((e) => e.kind === 'rain' && (e.contribution || 0) > 0)
          : []

        devLog('timeline-hydration-rain-clips', {
          runtimeSessionKey,
          publishRevision,
          restartToken,
          payloadHash: shortRuntimePayloadHash(runtimePayload),
          timelineId: runtimeExecution.timelineId,
          durationSec: runtime.durationSec || 180,
          clipCounts: sampleAt0?.clipCounts,
          rainAtZero: scanResult.rainAtZero,
          firstRainWindowSec: scanResult.firstRainWindowSec,
          rainContributionFound: scanResult.rainContributionFound,
          rainAtFirstWindow: scanResult.rainAtWindow,
          activeRainClipContributions: rainContribsAtFirst.map((e) => ({
            kind: e.kind,
            contribution: e.contribution,
            sourceClipIds: e.sourceClipIds,
          })),
          activeWeatherCounts: sampleAt0?.activeWeatherCounts,
          activeWeatherClipIds: sampleAt0?.activeWeatherClipIds,
        })
      }
    }, [publishRevision, restartToken, runtimeExecution.timelineId, runtimePayload, runtimeSessionKey, runtimeTimeline])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      return undefined
    }

    if (isDevRuntime()) {
      devLog('presentation-runtime-payload-ready', {
        runtimeSessionKey,
        bootPath: bootstrapPathIsRefreshRef.current ? 'refresh' : 'publish-restart',
        publishRevision,
        restartToken,
        payloadHash: shortRuntimePayloadHash(runtimePayload),
        timelineId: runtimeExecution.timelineId,
      })
    }

    // Reset stale pixels before creating the next runtime session engine.
    const ctx = canvas.getContext('2d')
    ctx?.clearRect(0, 0, canvas.width, canvas.height)

    const engine = new WetSurfaceEngine(canvas, {
      backgroundSrc: background.src,
      phase: 3,
      tuningConfig: getLinkedEffectiveConfig(basePreset),
      onStats: (stats) => {
        setPresentationStats(stats)

        if (!shouldAutoRunTimeline) {
          return
        }

        if (startupCanonicalSamplePendingRef.current || !startupFirstLiveSamplePendingRef.current) {
          return
        }

        const runtime = schedulerRef.current
        const activeEngine = engineRef.current
        if (!runtime || !activeEngine) {
          return
        }

        const engineFrameBeforeSample = Number(stats?.timing?.wetnessFrameCounter || 0)
        if (engineFrameBeforeSample < STARTUP_FIRST_LIVE_ENGINE_FRAME) {
          return
        }

        const startupSnapshot = runtime.sample({
          elapsedSec: STARTUP_FIRST_LIVE_SAMPLE_SEC,
          fps: 60,
          includeDiagnostics: isDevRuntime(),
        })
        const startupWeather = startupSnapshot?.weather || null
        const startupDrivenConfig = startupWeather
          ? buildRuntimeWeatherDrivenConfig(basePreset, startupWeather)
          : null
        const startupHintedConfig = withSchedulerInvariantHints(startupDrivenConfig, startupWeather)

        if (!startupHintedConfig) {
          return
        }

        const startupTrace = {
          sampleCallSite: 'onStats:startup-first-live-boundary',
          sampleSequence: Number(tuningApplySequenceRef.current || 0),
          startupPhaseTag: 'first-live-boundary',
          startupInvocationSource: 'onStats',
          startupSequenceIndex: Number(tuningApplySequenceRef.current || 0),
          startupEngineFrame: Number(engineFrameBeforeSample || 0),
          startupWetnessFrameCounter: Number(stats?.timing?.wetnessFrameCounter || engineFrameBeforeSample || 0),
          startupPacketId: Number(stats?.timing?.runnerCarveDiagnosticsPacketId ?? -1),
          rawElapsedSec: Number(STARTUP_FIRST_LIVE_SAMPLE_SEC || 0),
          normalizedSampleSec: Number(startupSnapshot?.sampleSec || 0),
          sampledRainIntensityBeforeDerive: Number(startupWeather?.rain || 0),
          derivedRainIntensity: Number(startupHintedConfig?.renderer?.rainIntensity || 0),
          derivedDropletsPerSeconds: Number(startupHintedConfig?.renderer?.dropletsPerSeconds || 0),
          rainTrackInputs: summarizeRainTrackInputs(startupSnapshot),
        }
        activeEngine.enqueueRuntimeInputEnvelope?.({
          source: 'presentation:onStats:startup-first-live-boundary',
          phaseTag: 'first-live-boundary',
          sampleCallSite: 'onStats:startup-first-live-boundary',
          applyBoundary: 'presentation-startup-first-live-boundary',
          sequence: Number(tuningApplySequenceRef.current || 0),
          runtimeSessionKey,
          sample: {
            rawElapsedSec: Number(STARTUP_FIRST_LIVE_SAMPLE_SEC || 0),
            sampleSec: Number(startupSnapshot?.sampleSec || 0),
          },
          weather: startupWeather,
          derivedConfig: startupHintedConfig,
          linkedConfig: getLinkedEffectiveConfig(startupHintedConfig),
          tuningApplyTrace: startupTrace,
        })
        activeEngine.consumeRuntimeInputQueueAtBoundary?.('presentation-startup-first-live-boundary')
        tuningApplySequenceRef.current += 1
        startupFirstLiveSamplePendingRef.current = false

        if (isDevRuntime()) {
          devLog('runtime-startup-boundary-sample', {
            runtimeSessionKey,
            bootPath: bootstrapPathIsRefreshRef.current ? 'refresh' : 'publish-restart',
            publishRevision,
            restartToken,
            payloadHash: shortRuntimePayloadHash(runtimePayload),
            timelineId: runtimeExecution.timelineId,
            sample: extractRainSamplingTrace(startupSnapshot, {
              callSite: 'onStats:startup-first-live-boundary',
              rawElapsedSec: STARTUP_FIRST_LIVE_SAMPLE_SEC,
            }),
            engineFrameBeforeSample,
            engineFrameAfterApply: Number(activeEngine?.wetnessFrameCounter || 0),
            appliedRainIntensity: Number(activeEngine?.tuningConfig?.debug?.runtimeSampledRainIntensity || 0),
            appliedDropletsPerSeconds: Number(activeEngine?.tuningConfig?.renderer?.dropletsPerSeconds || 0),
          })
        }
      },
    })

    // Slice A scaffold wiring only: provide session lineage context to engine-owned
    // startup authority diagnostics. Startup control flow remains Presentation-driven.
    engine.setSessionStartupAuthorityContext?.({
      runtimeSessionKey,
      bootPath: bootstrapPathIsRefreshRef.current ? 'refresh' : 'publish-restart',
      publishRevision,
      restartToken,
    })
    engine.setSimulationClockContext?.({
      runtimeSessionKey,
      durationSec: timelineDurationSec,
    })

    if (isDevRuntime()) {
      devLog('presentation-engine-created', {
        runtimeSessionKey,
        bootPath: bootstrapPathIsRefreshRef.current ? 'refresh' : 'publish-restart',
        publishRevision,
        restartToken,
        payloadHash: shortRuntimePayloadHash(runtimePayload),
        timelineId: runtimeExecution.timelineId,
      })
    }

    engineRef.current = engine

    // Determine bootstrap path: refresh vs publish restart
    // bootstrapPathIsRefreshRef.current is set in the runtimeSessionKey useEffect above
    const isManualRefresh = bootstrapPathIsRefreshRef.current
    // Diagnostic-only path marker. Do not use this to branch weather logic.
    if (isManualRefresh) {
      engine.bootstrapInfo.refreshPath = true
      engine.bootstrapInfo.publishRestartPath = false
    } else {
      engine.bootstrapInfo.refreshPath = false
      engine.bootstrapInfo.publishRestartPath = true
    }

    const startEngine = () => {
      try {
        engine.start()
        devLog('engine-started', {
          runtimeSessionKey,
          sceneId: runtimeExecution.sceneId,
          sampleSec: 0,
        })
        return true
      } catch (error) {
        devLog('engine-start-failed', {
          runtimeSessionKey,
          sceneId: runtimeExecution.sceneId,
          message: error instanceof Error ? error.message : String(error),
        })
        return false
      }
    }

    if (settings.startupMode === STARTUP_MODES.STATIC_THEN_FADE) {
      const holdMs = Math.max(0, (settings.staticStartup?.holdSeconds ?? 1.8) * 1000)
      const startTimer = window.setTimeout(() => {
        // Shared bootstrap: resolve first rain window via fine-grained scan and pre-apply
        // weather-driven config so initializeRaindropRenderer is primed with correct
        // dropletsPerSeconds on this startup path too.
        const bootstrap = engine.resolveCanonicalPreStartBootstrap?.({
          schedulerRuntime: schedulerRef.current,
          basePreset,
          timelineDurationSec,
        }) || resolvePreStartBootstrapConfig(schedulerRef.current, basePreset, timelineDurationSec)
        if (bootstrap.drivenConfig) {
          const hintedConfig = withSchedulerInvariantHints(bootstrap.drivenConfig, bootstrap.weather)
          engine.stageTuningApplyTrace?.({
            sampleCallSite: 'start:static-hold-pre-start-bootstrap',
            sampleSequence: Number(tuningApplySequenceRef.current || 0),
            startupPhaseTag: 'canonical-bootstrap',
            startupInvocationSource: 'start-static-hold',
            startupSequenceIndex: Number(tuningApplySequenceRef.current || 0),
            startupEngineFrame: Number(engine?.wetnessFrameCounter || 0),
            startupWetnessFrameCounter: Number(engine?.wetnessFrameCounter || 0),
            startupPacketId: -1,
            rawElapsedSec: Number(bootstrap.preStartSec || 0),
            normalizedSampleSec: Number(bootstrap.preStartSnap?.sampleSec || bootstrap.preStartSec || 0),
            sampledRainIntensityBeforeDerive: Number(bootstrap.weather?.rain || 0),
            derivedRainIntensity: Number(hintedConfig?.renderer?.rainIntensity || 0),
            derivedDropletsPerSeconds: Number(hintedConfig?.renderer?.dropletsPerSeconds || 0),
            rainTrackInputs: summarizeRainTrackInputs(bootstrap.preStartSnap),
          })
          engine.setTuningConfig(getLinkedEffectiveConfig(hintedConfig))
          tuningApplySequenceRef.current += 1
        }
        devLog('pre-start-bootstrap-result', {
          runtimeSessionKey,
          bootPath: 'static-hold',
          startupMode: settings.startupMode,
          payloadHash: shortRuntimePayloadHash(runtimePayload),
          selectedTimelineId: runtimePayload?.selectedTimelineId || 'none',
          timelineId: runtimeExecution.timelineId,
          publishRevision,
          restartToken,
          firstRainWindowSec: bootstrap.firstRainWindowSec,
          rainContributionFound: bootstrap.rainContributionFound,
          preStartSec: bootstrap.preStartSec,
          rainAtZero: bootstrap.rainAtZero,
          rainAtWindow: bootstrap.rainAtWindow,
          drivenDropletsPerSeconds: bootstrap.dropletsPerSeconds,
          scanSteps: bootstrap.scanSteps,
        })
        devLog('pre-start-engine-state', {
          runtimeSessionKey,
          bootPath: 'static-hold',
          startupMode: settings.startupMode,
          payloadHash: shortRuntimePayloadHash(runtimePayload),
          selectedTimelineId: runtimePayload?.selectedTimelineId || 'none',
          firstRainWindowSec: bootstrap.firstRainWindowSec,
          rainAtZero: bootstrap.rainAtZero,
          rainAtWindow: bootstrap.rainAtWindow,
          preStartSec: bootstrap.preStartSec,
          dropletsPerSeconds: engine.tuningConfig?.renderer?.dropletsPerSeconds,
          rendererExists: Boolean(engine.raindropRenderer),
        })
        bootParitySnapshotRef.current = {
          runtimeSessionKey,
          bootPath: 'static-hold',
          startupMode: settings.startupMode,
          payloadHash: shortRuntimePayloadHash(runtimePayload),
          selectedTimelineId: runtimePayload?.selectedTimelineId || 'none',
          timelineId: runtimeExecution.timelineId,
          publishRevision,
          restartToken,
          firstRainWindowSec: bootstrap.firstRainWindowSec,
          preStartSec: bootstrap.preStartSec,
          rainAtZero: bootstrap.rainAtZero,
          rainAtWindow: bootstrap.rainAtWindow,
          preStartDropletsPerSeconds: engine.tuningConfig?.renderer?.dropletsPerSeconds || 0,
        }
        startEngine()
        setAtmosphereVisible(true)
        const firstRainSec = bootstrap.firstRainWindowSec
        if (Number.isFinite(firstRainSec) && firstRainSec > 0) {
          seekPresentationClock(firstRainSec, { reason: 'auto-startup-seek-first-rain' })
        }
      }, holdMs)

      return () => {
        window.clearTimeout(startTimer)
        engine.stop()
        engineRef.current = null
      }
    }

    resetPresentationClock('runtime-session-start')

    // DIAGNOSTIC: log startup path fingerprint before bootstrap so both refresh and
    // publish-restart emit an identical-keyed event for side-by-side comparison.
    devLog('presentation-startup-begin', {
      runtimeSessionKey,
      bootPath: bootstrapPathIsRefreshRef.current ? 'refresh' : 'publish-restart',
      publishRevision,
      restartToken,
      payloadHash: shortRuntimePayloadHash(runtimePayload),
      timelineId: runtimeExecution.timelineId,
      selectedTimelineId: runtimePayload?.selectedTimelineId || 'none',
      hasAuthoredTimeline: Boolean(runtimePayload?.authoredTimeline),
    })

    // Shared bootstrap: find first active rain window using fine-grained scan (0.01 s steps)
    // and pre-apply the weather-driven config BEFORE engine.start() so
    // initializeRaindropRenderer creates the RaindropFX instance with the correct
    // dropletsPerSeconds. Both publish-restart and browser-refresh call this same helper
    // so the renderer is primed identically from the same published payload.
    const bootstrap = engine.resolveCanonicalPreStartBootstrap?.({
      schedulerRuntime: schedulerRef.current,
      basePreset,
      timelineDurationSec,
    }) || resolvePreStartBootstrapConfig(schedulerRef.current, basePreset, timelineDurationSec)
    if (bootstrap.drivenConfig) {
      const hintedConfig = withSchedulerInvariantHints(bootstrap.drivenConfig, bootstrap.weather)
      engine.stageTuningApplyTrace?.({
        sampleCallSite: 'start:shared-pre-start-bootstrap',
        sampleSequence: Number(tuningApplySequenceRef.current || 0),
        startupPhaseTag: 'canonical-bootstrap',
        startupInvocationSource: 'start-shared-bootstrap',
        startupSequenceIndex: Number(tuningApplySequenceRef.current || 0),
        startupEngineFrame: Number(engine?.wetnessFrameCounter || 0),
        startupWetnessFrameCounter: Number(engine?.wetnessFrameCounter || 0),
        startupPacketId: -1,
        rawElapsedSec: Number(bootstrap.preStartSec || 0),
        normalizedSampleSec: Number(bootstrap.preStartSnap?.sampleSec || bootstrap.preStartSec || 0),
        sampledRainIntensityBeforeDerive: Number(bootstrap.weather?.rain || 0),
        derivedRainIntensity: Number(hintedConfig?.renderer?.rainIntensity || 0),
        derivedDropletsPerSeconds: Number(hintedConfig?.renderer?.dropletsPerSeconds || 0),
        rainTrackInputs: summarizeRainTrackInputs(bootstrap.preStartSnap),
      })
      engine.setTuningConfig(getLinkedEffectiveConfig(hintedConfig))
      tuningApplySequenceRef.current += 1
    }

    // Paired diagnostic: identical log event on both boot paths for divergence detection.
    devLog('pre-start-bootstrap-result', {
      runtimeSessionKey,
      bootPath: bootstrapPathIsRefreshRef.current ? 'refresh' : 'publish-restart',
      startupMode: settings.startupMode,
      payloadHash: shortRuntimePayloadHash(runtimePayload),
      selectedTimelineId: runtimePayload?.selectedTimelineId || 'none',
      timelineId: runtimeExecution.timelineId,
      publishRevision,
      restartToken,
      firstRainWindowSec: bootstrap.firstRainWindowSec,
      rainContributionFound: bootstrap.rainContributionFound,
      preStartSec: bootstrap.preStartSec,
      rainAtZero: bootstrap.rainAtZero,
      rainAtWindow: bootstrap.rainAtWindow,
      drivenDropletsPerSeconds: bootstrap.dropletsPerSeconds,
      scanSteps: bootstrap.scanSteps,
      sampleAtZero: extractRainSamplingTrace(bootstrap.snapAtZero, {
        callSite: 'resolvePreStartBootstrapConfig:elapsedSec=0',
        rawElapsedSec: 0,
      }),
      sampleAtFirstWindow: extractRainSamplingTrace(bootstrap.preStartSnap, {
        callSite: 'resolvePreStartBootstrapConfig:preStartSec',
        rawElapsedSec: bootstrap.preStartSec,
      }),
    })
    devLog('pre-start-engine-state', {
      runtimeSessionKey,
      bootPath: bootstrapPathIsRefreshRef.current ? 'refresh' : 'publish-restart',
      startupMode: settings.startupMode,
      payloadHash: shortRuntimePayloadHash(runtimePayload),
      selectedTimelineId: runtimePayload?.selectedTimelineId || 'none',
      firstRainWindowSec: bootstrap.firstRainWindowSec,
      rainAtZero: bootstrap.rainAtZero,
      rainAtWindow: bootstrap.rainAtWindow,
      preStartSec: bootstrap.preStartSec,
      dropletsPerSeconds: engine.tuningConfig?.renderer?.dropletsPerSeconds,
      rendererExists: Boolean(engine.raindropRenderer),
    })
    bootParitySnapshotRef.current = {
      runtimeSessionKey,
      bootPath: bootstrapPathIsRefreshRef.current ? 'refresh' : 'publish-restart',
      startupMode: settings.startupMode,
      payloadHash: shortRuntimePayloadHash(runtimePayload),
      selectedTimelineId: runtimePayload?.selectedTimelineId || 'none',
      timelineId: runtimeExecution.timelineId,
      publishRevision,
      restartToken,
      firstRainWindowSec: bootstrap.firstRainWindowSec,
      preStartSec: bootstrap.preStartSec,
      rainAtZero: bootstrap.rainAtZero,
      rainAtWindow: bootstrap.rainAtWindow,
      preStartDropletsPerSeconds: engine.tuningConfig?.renderer?.dropletsPerSeconds || 0,
    }

    startEngine()
    setAtmosphereVisible(true)

    // Seek the presentation clock to the first active rain window so the atmosphere loop
    // immediately samples at a time with rain and sustains dropletsPerSeconds above baseline.
    const firstRainSec = bootstrap.firstRainWindowSec
    if (Number.isFinite(firstRainSec) && firstRainSec > 0) {
      seekPresentationClock(firstRainSec, { reason: 'auto-startup-seek-first-rain' })
    }

    return () => {
      engine.stop()
      engineRef.current = null
    }
  }, [background.src, basePreset, publishRevision, resetPresentationClock, restartToken, runtimeExecution.sceneId, runtimeExecution.timelineId, runtimePayload, runtimeSessionKey, seekPresentationClock, settings.startupMode, settings.staticStartup?.holdSeconds, shouldAutoRunTimeline, timelineDurationSec])

  useEffect(() => {
    if (!schedulerRef.current || !engineRef.current || !shouldAutoRunTimeline) {
      return undefined
    }

    updateAtmosphereEffectRunCountRef.current += 1

    const updateAtmosphere = (invocationSource = 'interval-tick') => {
      updateAtmosphereInvocationCountRef.current += 1

      const currentTimeSec = getPresentationTimeSec()
      let sampleElapsedSec = currentTimeSec
      let sampleCallSite = 'updateAtmosphere:getPresentationTimeSec'
      const engineStartupFrameIndex = Number(engineRef.current?.wetnessFrameCounter || 0)
      const startupFrameBoundaryReached = engineStartupFrameIndex >= STARTUP_FIRST_LIVE_ENGINE_FRAME
      if (startupCanonicalSamplePendingRef.current || startupFirstLiveSamplePendingRef.current || !startupFrameBoundaryReached) {
        sampleElapsedSec = 0
        sampleCallSite = startupCanonicalSamplePendingRef.current
          ? 'updateAtmosphere:canonical-zero-handoff'
          : 'updateAtmosphere:startup-frame0-hold'
      } else if (engineStartupFrameIndex <= STARTUP_FRAME_SYNC_END_FRAME) {
        sampleElapsedSec = engineStartupFrameIndex / 60
        sampleCallSite = 'updateAtmosphere:startup-frame-sync'
      }
      const startupPhaseTag = resolveStartupPhaseTag(sampleCallSite)
      engineRef.current?.noteSimulationSampleBoundary?.({
        elapsedSec: sampleElapsedSec,
        callSite: sampleCallSite,
        startupPhaseTag,
        engineFrame: engineStartupFrameIndex,
      })
      const snapshot = schedulerRef.current.sample({
        elapsedSec: sampleElapsedSec,
        fps: 60,
        includeDiagnostics: isDevRuntime(),
      })
      const weather = snapshot.weather
      const schedulerFog = clamp((weather?.fogBuildup || 0) - (weather?.fogClearing || 0), 0, 1)
      const durationSec = Math.max(0.001, schedulerRef.current?.durationSec || timelineDurationSec || 180)
      const engineFrameBeforeSample = Number(engineRef.current?.wetnessFrameCounter || 0)

      const drivenConfig = buildRuntimeWeatherDrivenConfig(basePreset, weather)
      const hintedConfig = withSchedulerInvariantHints(drivenConfig, weather)
      const tuningApplyTrace = {
        sampleCallSite,
        sampleSequence: Number(tuningApplySequenceRef.current || 0),
        startupPhaseTag,
        startupInvocationSource: String(invocationSource || 'interval-tick'),
        startupSequenceIndex: Number(tuningApplySequenceRef.current || 0),
        startupEngineFrame: Number(engineStartupFrameIndex || 0),
        startupWetnessFrameCounter: Number(presentationStatsRef.current?.timing?.wetnessFrameCounter || engineStartupFrameIndex || 0),
        startupPacketId: Number(presentationStatsRef.current?.timing?.runnerCarveDiagnosticsPacketId ?? -1),
        updateInvocationSource: String(invocationSource || 'interval-tick'),
        updateAtmosphereEffectRunCount: Number(updateAtmosphereEffectRunCountRef.current || 0),
        updateAtmosphereInvocationCount: Number(updateAtmosphereInvocationCountRef.current || 0),
        rawElapsedSec: Number(sampleElapsedSec || 0),
        normalizedSampleSec: Number(snapshot?.sampleSec || 0),
        sampledRainIntensityBeforeDerive: Number(weather?.rain || 0),
        derivedRainIntensity: Number(hintedConfig?.renderer?.rainIntensity || 0),
        derivedDropletsPerSeconds: Number(hintedConfig?.renderer?.dropletsPerSeconds || 0),
        rainTrackInputs: summarizeRainTrackInputs(snapshot),
      }
      const linkedConfig = getLinkedEffectiveConfig(hintedConfig)

      const isStartupPreFrameSample =
        sampleCallSite === 'updateAtmosphere:canonical-zero-handoff' ||
        sampleCallSite === 'updateAtmosphere:startup-frame0-hold'
      const startupPreFrameApplySignature = isStartupPreFrameSample
        ? JSON.stringify({
          frame: engineStartupFrameIndex,
          sampleSec: Number(snapshot?.sampleSec || 0),
          sampledRain: Number(weather?.rain || 0),
          sampledDropletsPerSeconds: Number(drivenConfig?.renderer?.dropletsPerSeconds || 0),
        })
        : null

      if (isDevRuntime() && !handoffTraceRef.current.done) {
        devLog('runtime-handoff-sample', {
          runtimeSessionKey,
          bootPath: bootstrapPathIsRefreshRef.current ? 'refresh' : 'publish-restart',
          publishRevision: publishedDocument?.publishRevision || 0,
          restartToken: publishedDocument?.restartToken || 'local-default',
          payloadHash: shortRuntimePayloadHash(runtimePayload),
          timelineId: runtimeExecution.timelineId,
          sequence: handoffTraceRef.current.sampled,
          sampleCallSite,
          startupFrameBoundaryReached,
          startupCanonicalSamplePending: startupCanonicalSamplePendingRef.current,
          engineFrameBeforeSample,
          rawElapsedSec: Number(sampleElapsedSec || 0),
          normalizedSampleSec: Number(snapshot?.sampleSec || 0),
          sampledRainIntensity: Number(weather?.rain || 0),
          sampledDropletsPerSeconds: Number(drivenConfig?.renderer?.dropletsPerSeconds || 0),
        })
        handoffTraceRef.current.sampled += 1
      }

      if (isDevRuntime() && sampleCallSite === 'updateAtmosphere:canonical-zero-handoff') {
        startupCanonicalSamplePendingRef.current = false
        devLog('runtime-canonical-zero-sample', {
          runtimeSessionKey,
          bootPath: bootstrapPathIsRefreshRef.current ? 'refresh' : 'publish-restart',
          publishRevision: publishedDocument?.publishRevision || 0,
          restartToken: publishedDocument?.restartToken || 'local-default',
          payloadHash: shortRuntimePayloadHash(runtimePayload),
          timelineId: runtimeExecution.timelineId,
          sample: extractRainSamplingTrace(snapshot, {
            callSite: sampleCallSite,
            rawElapsedSec: sampleElapsedSec,
            currentTimeSec,
            clockDebug: {
              mode: clockLockedSecRef.current != null ? 'locked' : 'running',
              offsetSec: clockOffsetSecRef.current,
              lockedSec: clockLockedSecRef.current,
              anchorAgeMs: performance.now() - clockAnchorMsRef.current,
            },
          }),
        })
      }

      if (isDevRuntime() && !firstRuntimeSampleLoggedRef.current) {
        if (
          sampleCallSite !== 'updateAtmosphere:canonical-zero-handoff' &&
          sampleCallSite !== 'updateAtmosphere:startup-frame0-hold' &&
          startupFrameBoundaryReached
        ) {
          firstRuntimeSampleLoggedRef.current = true
          devLog('runtime-first-scheduler-sample', {
            runtimeSessionKey,
            bootPath: bootstrapPathIsRefreshRef.current ? 'refresh' : 'publish-restart',
            publishRevision: publishedDocument?.publishRevision || 0,
            restartToken: publishedDocument?.restartToken || 'local-default',
            payloadHash: shortRuntimePayloadHash(runtimePayload),
            timelineId: runtimeExecution.timelineId,
            sample: extractRainSamplingTrace(snapshot, {
              callSite: sampleCallSite,
              rawElapsedSec: sampleElapsedSec,
              currentTimeSec,
              clockDebug: {
                mode: clockLockedSecRef.current != null ? 'locked' : 'running',
                offsetSec: clockOffsetSecRef.current,
                lockedSec: clockLockedSecRef.current,
                anchorAgeMs: performance.now() - clockAnchorMsRef.current,
              },
            }),
          })
        }
      }

      if (isStartupPreFrameSample) {
        const previousSignature = startupPreFrameAppliedSignatureRef.current
        if (previousSignature !== startupPreFrameApplySignature) {
          startupPreFrameAppliedSignatureRef.current = startupPreFrameApplySignature
          engineRef.current?.enqueueRuntimeInputEnvelope?.({
            source: 'presentation:updateAtmosphere',
            phaseTag: tuningApplyTrace.startupPhaseTag,
            sampleCallSite,
            applyBoundary: 'presentation-updateAtmosphere',
            sequence: Number(tuningApplySequenceRef.current || 0),
            runtimeSessionKey,
            sample: {
              rawElapsedSec: Number(sampleElapsedSec || 0),
              sampleSec: Number(snapshot?.sampleSec || 0),
            },
            weather,
            derivedConfig: hintedConfig,
            linkedConfig,
            tuningApplyTrace,
          })
          engineRef.current?.consumeRuntimeInputQueueAtBoundary?.('presentation-updateAtmosphere')
          tuningApplySequenceRef.current += 1
        }
      } else {
        startupPreFrameAppliedSignatureRef.current = null
        engineRef.current?.enqueueRuntimeInputEnvelope?.({
          source: 'presentation:updateAtmosphere',
          phaseTag: tuningApplyTrace.startupPhaseTag,
          sampleCallSite,
          applyBoundary: 'presentation-updateAtmosphere',
          sequence: Number(tuningApplySequenceRef.current || 0),
          runtimeSessionKey,
          sample: {
            rawElapsedSec: Number(sampleElapsedSec || 0),
            sampleSec: Number(snapshot?.sampleSec || 0),
          },
          weather,
          derivedConfig: hintedConfig,
          linkedConfig,
          tuningApplyTrace,
        })
        engineRef.current?.consumeRuntimeInputQueueAtBoundary?.('presentation-updateAtmosphere')
        tuningApplySequenceRef.current += 1
      }
      const engineFrameAfterApply = Number(engineRef.current?.wetnessFrameCounter || 0)

      if (isDevRuntime() && !handoffTraceRef.current.done) {
        if (
          sampleCallSite === 'updateAtmosphere:getPresentationTimeSec' ||
          sampleCallSite === 'updateAtmosphere:first-live-deterministic-handoff'
        ) {
          handoffTraceRef.current.liveSampleSeen = true
        }

        devLog('runtime-handoff-applied', {
          runtimeSessionKey,
          bootPath: bootstrapPathIsRefreshRef.current ? 'refresh' : 'publish-restart',
          publishRevision: publishedDocument?.publishRevision || 0,
          restartToken: publishedDocument?.restartToken || 'local-default',
          payloadHash: shortRuntimePayloadHash(runtimePayload),
          timelineId: runtimeExecution.timelineId,
          sequence: handoffTraceRef.current.applied,
          sampleCallSite,
          startupFrameBoundaryReached,
          engineFrameAfterApply,
          appliedRainIntensity: Number(engineRef.current?.tuningConfig?.debug?.runtimeSampledRainIntensity || 0),
          appliedDropletsPerSeconds: Number(engineRef.current?.tuningConfig?.renderer?.dropletsPerSeconds || 0),
        })
        handoffTraceRef.current.applied += 1

        if (handoffTraceRef.current.liveSampleSeen && engineFrameAfterApply >= 1) {
          handoffTraceRef.current.done = true
        }
      }

      if (isDevRuntime()) {
        const rainContributions = (snapshot?.diagnostics?.weatherTrackContributions || [])
          .filter((entry) => entry.kind === 'rain' && (entry.contribution || 0) > 0)
        const fogContributions = (snapshot?.diagnostics?.weatherTrackContributions || [])
          .filter((entry) => (entry.kind === 'fogBuildup' || entry.kind === 'fogClearing' || entry.kind === 'mist') && (entry.contribution || 0) > 0)
        const activeRainClipIds = new Set(
          rainContributions.flatMap((entry) => Array.isArray(entry.sourceClipIds) ? entry.sourceClipIds : []),
        )
        const activeFogClipIds = new Set(
          fogContributions.flatMap((entry) => Array.isArray(entry.sourceClipIds) ? entry.sourceClipIds : []),
        )
        const rainContribution = rainContributions.reduce((sum, entry) => sum + (entry.contribution || 0), 0)
        const fogContribution = fogContributions.reduce((sum, entry) => sum + (entry.contribution || 0), 0)

        const mismatch = classifyRainFogMismatch({
          rainContribution,
          fogContribution,
          rainIntensity: weather?.rain || 0,
          dropletsPerSeconds: drivenConfig?.renderer?.dropletsPerSeconds || 0,
          publishRevision: publishedDocument?.publishRevision || 0,
        })

        // Hard invariant for refresh/publish/cold-start parity verification:
        // if scheduler reports active rain lineage but runtime resolves to zero droplets,
        // surface hydration startup is broken and must be treated as a contract violation.
        const resolvedDropletsPerSeconds = drivenConfig?.renderer?.dropletsPerSeconds || 0
        if (rainContribution > 0.001 && resolvedDropletsPerSeconds <= 0) {
          console.error('[MistyOS][Presentation][ContractViolation]', {
            event: 'active-rain-with-zero-droplets',
            runtimeSessionKey,
            publishRevision: publishedDocument?.publishRevision || 0,
            restartToken: publishedDocument?.restartToken || 'local-default',
            runtimePayloadHash: shortRuntimePayloadHash(runtimePayload),
            timelineId: runtimeExecution.timelineId,
            selectedTimelineId: runtimePayload?.selectedTimelineId || 'none',
            currentTimeSec,
            loopTimeSec: snapshot?.sampleSec || 0,
            rainIntensity: weather?.rain || 0,
            rainContribution,
            drivenDropletsPerSeconds: resolvedDropletsPerSeconds,
            bootPath: bootstrapPathIsRefreshRef.current ? 'refresh' : 'publish-restart',
          })
        }

        if (mismatch.className === 'none') {
          rainMismatchFramesRef.current = 0
          lastMismatchClassRef.current = 'none'
        } else {
          rainMismatchFramesRef.current += 1
          const shouldLog =
            lastMismatchClassRef.current !== mismatch.className ||
            rainMismatchFramesRef.current === 1 ||
            rainMismatchFramesRef.current % 30 === 0
          if (shouldLog) {
            devLog('rain-fog-mismatch', {
              runtimeSessionKey,
              publishRevision: publishedDocument?.publishRevision || 0,
              fromSavedRevision: publishedDocument?.fromSavedRevision || 0,
              restartToken: publishedDocument?.restartToken || 'local-default',
              mismatchClass: mismatch.className,
              mismatchSeverity: mismatch.severity,
              mismatchFrames: rainMismatchFramesRef.current,
              currentTimeSec,
              loopTimeSec: snapshot?.sampleSec || 0,
              durationSec,
              rainIntensity: weather?.rain || 0,
              rainContribution,
              fogContribution,
              drivenDropletsPerSeconds: drivenConfig?.renderer?.dropletsPerSeconds || 0,
              activeRainClipCount: activeRainClipIds.size || rainContributions.length,
              activeFogClipCount: activeFogClipIds.size || fogContributions.length,
              activeRainClipIds: Array.from(activeRainClipIds),
              activeFogClipIds: Array.from(activeFogClipIds),
              runtimePayloadHash: shortRuntimePayloadHash(runtimePayload),
            })
          }
          lastMismatchClassRef.current = mismatch.className
        }

        setRainDebug({
          currentTimeSec,
          loopTimeSec: snapshot?.sampleSec || 0,
          durationSec,
          rainIntensity: weather?.rain || 0,
          activeRainClipCount: activeRainClipIds.size || rainContributions.length,
          activeRainClipIds: Array.from(activeRainClipIds),
          activeFogClipCount: activeFogClipIds.size || fogContributions.length,
          activeFogClipIds: Array.from(activeFogClipIds),
          weather: {
            wind: weather?.wind || 0,
            rain: weather?.rain || 0,
            mist: weather?.mist || 0,
            washdown: weather?.washdown || 0,
            fogBuildup: weather?.fogBuildup || 0,
            fogClearing: weather?.fogClearing || 0,
          },
          rainContribution,
          fogContribution,
          mismatchClass: mismatch.className,
          mismatchSeverity: mismatch.severity,
          mismatchFrames: rainMismatchFramesRef.current,
          mismatchReason: mismatch.reason,
          effectiveRefillRate: drivenConfig?.surfaceWetness?.refillRate || 0,
          drivenDropletsPerSeconds: drivenConfig?.renderer?.dropletsPerSeconds || 0,
        })
      }

      const verificationActive = typeof window !== 'undefined' && window.MISTY_VERIFICATION_ACTIVE === true
      if (!verificationActive) {
        verificationCaptureActiveRef.current = false
      } else {
        if (!verificationCaptureActiveRef.current) {
          verificationCaptureActiveRef.current = true
          verificationSampleIndexRef.current = 0
        }

        const rendererStats = presentationStatsRef.current?.renderer || {}
        const sampleIndex = verificationSampleIndexRef.current
        recordRuntimeSample({
          time: snapshot?.sampleSec || 0,
          wind: weather?.wind || 0,
          rain: weather?.rain || 0,
          mist: weather?.mist || 0,
          fog: schedulerFog,
          activeIntentIds: Array.isArray(snapshot?.activeIntentEvents)
            ? snapshot.activeIntentEvents.map((event) => event?.id).filter(Boolean)
            : [],
          clipCounts: snapshot?.clipCounts,
          activeIntentsByType: snapshot?.activeIntentsByType,
          activeWeatherCounts: snapshot?.activeWeatherCounts,
          activeWeatherClipIds: snapshot?.activeWeatherClipIds,
          metadata: {
            runtimeSessionKey,
            publishRevision,
            restartToken,
            sampleIndex,
            sampleLabel: verificationSampleLabelRef.current,
            currentTimeSec,
            loopTimeSec: snapshot?.sampleSec || 0,
          },
          render: {
            ready: Boolean(rendererStats?.ready),
            renderCalled: Boolean(rendererStats?.renderCalled),
            renderSucceeded: Boolean(rendererStats?.renderSucceeded),
            simulatorRaindropCount: Number(rendererStats?.simulatorRaindropCount || 0),
            lastInputCount: Number(rendererStats?.lastInputCount || 0),
            frameSampleReady: Boolean(rendererStats?.frameSampleReady),
            frameDeltaEnergy: Number(rendererStats?.frameDeltaEnergy || 0),
          },
          bootstrap: presentationStats?.bootstrap || {},
        })
        verificationSampleIndexRef.current += 1
      }
    }

    const timer = window.setInterval(() => updateAtmosphere('interval-tick'), 1000 / 30)
    updateAtmosphere('effect-immediate')
    return () => window.clearInterval(timer)
  }, [basePreset, getPresentationTimeSec, publishRevision, publishedDocument?.fromSavedRevision, publishedDocument?.publishRevision, publishedDocument?.restartToken, restartToken, runtimePayload, runtimeSessionKey, shouldAutoRunTimeline, timelineDurationSec])

  useEffect(() => {
    if (!isDevRuntime()) {
      return
    }
    if (bootParityLoggedSessionRef.current === runtimeSessionKey) {
      return
    }

    const snapshot = bootParitySnapshotRef.current
    if (!snapshot || snapshot.runtimeSessionKey !== runtimeSessionKey) {
      return
    }

    const renderer = presentationStats?.renderer || {}
    const bootstrap = presentationStats?.bootstrap || {}
    const rendererReady = Boolean(renderer.ready)
    const emissionCount = Number(renderer.simulatorRaindropCount || 0)
    if (!rendererReady && emissionCount <= 0) {
      return
    }

    devLog('boot-parity-first-frame', {
      mode: snapshot.bootPath,
      startupMode: snapshot.startupMode,
      runtimeSessionKey,
      payloadHash: snapshot.payloadHash,
      selectedTimelineId: snapshot.selectedTimelineId,
      timelineId: snapshot.timelineId,
      publishRevision: snapshot.publishRevision,
      restartToken: snapshot.restartToken,
      firstRainWindowSec: snapshot.firstRainWindowSec,
      preStartSec: snapshot.preStartSec,
      rainAtZero: snapshot.rainAtZero,
      rainAtBootstrap: snapshot.rainAtWindow,
      preStartDropletsPerSeconds: snapshot.preStartDropletsPerSeconds,
      adapterInitDropletsPerSeconds: Number(bootstrap.adapterInitDropletsPerSeconds || 0),
      firstFrameRainCount: emissionCount,
      rendererReady,
      renderSucceeded: Boolean(renderer.renderSucceeded),
    })

    // Concise regression summary for mode-to-mode comparisons.
    devLog('boot-parity-summary', {
      mode: snapshot.bootPath,
      payloadHash: snapshot.payloadHash,
      timelineId: snapshot.timelineId,
      sampledRainIntensity: snapshot.rainAtWindow,
      preStartDropletsPerSeconds: snapshot.preStartDropletsPerSeconds,
      adapterInitDropletsPerSeconds: Number(bootstrap.adapterInitDropletsPerSeconds || 0),
      firstFrameRainCount: emissionCount,
    })

    bootParityLoggedSessionRef.current = runtimeSessionKey
  }, [presentationStats, runtimeSessionKey])

  useEffect(() => {
    const shortcut = settings.presentation?.launcher?.shortcut || 'Alt+Shift+M'
    const handler = (event) => {
      if (matchesShortcut(shortcut, event)) {
        event.preventDefault()
        window.open(settings.presentation?.launcher?.studioRoute || '/studio', '_blank', 'noopener')
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [settings.presentation?.launcher?.shortcut, settings.presentation?.launcher?.studioRoute])

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return undefined
    }

    window.__MISTYOS_PRESENTATION_STATS = presentationStats
    return () => {
      delete window.__MISTYOS_PRESENTATION_STATS
    }
  }, [presentationStats])

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return undefined
    }

    window.__MISTYOS_PRESENTATION_RAIN_DEBUG = rainDebug
    window.__MISTYOS_PRESENTATION_RUNTIME = {
      resetTimeToZero: handleResetTimeToZero,
      seekFirstRainWindow: handleSeekFirstRainWindow,
      runtimeSessionKey,
      publishRevision,
      fromSavedRevision,
      restartToken,
      runtimePayloadHash,
      clockDebug,
      rainDebug,
    }
    return () => {
      delete window.__MISTYOS_PRESENTATION_RAIN_DEBUG
      delete window.__MISTYOS_PRESENTATION_RUNTIME
    }
  }, [clockDebug, fromSavedRevision, handleResetTimeToZero, handleSeekFirstRainWindow, publishRevision, rainDebug, restartToken, runtimePayloadHash, runtimeSessionKey])

  const fadeSeconds = settings.staticStartup?.fadeInSeconds ?? 2.2
  const launcherLabel = settings.presentation?.launcher?.label || 'MistyOS'
  const launcherOpacity = isLauncherHovered
    ? settings.presentation?.launcher?.hoverOpacity ?? 0.9
    : settings.presentation?.launcher?.idleOpacity ?? 0.16
  const publishedMetaLabel = publishedDocument
    ? `Published r${publishedDocument.publishRevision} | ${formatRuntimeTimestamp(publishedDocument.publishedAt)}`
    : 'Published runtime: none'
  const timelineMetaLabel = runtimeTimeline?.name || runtimeTimeline?.id || 'unnamed timeline'
  const sceneMetaId = runtimePayload?.selectedSceneId || scene?.id || 'unknown'
  const timelineMetaId = runtimePayload?.selectedTimelineId || runtimeTimeline?.id || 'unknown'
  const runtimeTimelineResolvedId = runtimeTimeline?.id || 'unknown'
  const verificationScenarioName = latestVerificationArtifact?.scenarioName || 'none'
  const verificationPassFail = !latestVerificationArtifact
    ? 'n/a'
    : latestVerificationArtifact.pass
      ? 'pass'
      : 'fail'
  const verificationPublishRevision = latestVerificationArtifact?.publishRevision ?? 'n/a'
  const verificationRestartToken = latestVerificationArtifact?.restartToken || 'n/a'
  const presentationTiming = presentationStats?.timing || {}
  const presentationRenderer = presentationStats?.renderer || {}
  const presentationBootstrap = presentationStats?.bootstrap || {}

  return (
    <div className="presentation-shell">
      <BackgroundLayer background={background} />
      <canvas
        key={runtimeSessionKey}
        ref={canvasRef}
        className="wet-canvas presentation-canvas"
        style={{
          opacity: atmosphereVisible ? 1 : 0,
          transition: `opacity ${fadeSeconds}s ease`,
        }}
        aria-label="MistyOS atmospheric presentation"
      />

      <button
        type="button"
        className="mistyos-launcher"
        style={{ opacity: launcherOpacity }}
        onMouseEnter={() => setIsLauncherHovered(true)}
        onMouseLeave={() => setIsLauncherHovered(false)}
        onClick={() => window.open(settings.presentation?.launcher?.studioRoute || '/studio', '_blank', 'noopener')}
        aria-label="Open MistyOS Studio"
      >
        {launcherLabel}
      </button>

      {import.meta.env.DEV ? (
        <div className="presentation-runtime-meta" aria-live="polite">
          <div>{publishedMetaLabel}</div>
          <div>publishRevision: {publishRevision}</div>
          <div>fromSavedRevision: {fromSavedRevision}</div>
          <div>restartToken: {restartToken}</div>
          <div>sceneId: {sceneMetaId}</div>
          <div>timelineId: {timelineMetaId}</div>
          <div>runtimeTimelineId: {runtimeTimelineResolvedId}</div>
          <div>runtimePayloadHash: {runtimePayloadHash}</div>
          <div>timeline: {timelineMetaLabel}</div>
          <div>verificationScenario: {verificationScenarioName}</div>
          <div>verificationPassFail: {verificationPassFail}</div>
          <div>verificationPublishRevision: {verificationPublishRevision}</div>
          <div>verificationRestartToken: {verificationRestartToken}</div>
          <div>runnerCarveMode: {presentationTiming.runnerCarveLastMode || 'none'}</div>
          <div>runnerCarveInterpolationActive: {presentationTiming.runnerCarveInterpolationActive ? 'yes' : 'no'}</div>
          <div>runnerCarvePrevMatchSource: {presentationTiming.runnerCarveLastPreviousMatchSource || 'none'}</div>
          <div>runnerCarveProximityMatches: {presentationTiming.runnerCarveInterpolationProximityMatches || 0}</div>
          <div>runnerCarvePrevPos: ({(presentationTiming.runnerCarveLastPrevX || 0).toFixed(1)}, {(presentationTiming.runnerCarveLastPrevY || 0).toFixed(1)})</div>
          <div>runnerCarveCurrPos: ({(presentationTiming.runnerCarveLastCurrX || 0).toFixed(1)}, {(presentationTiming.runnerCarveLastCurrY || 0).toFixed(1)})</div>
          <div>runnerCarveSegmentLength: {(presentationTiming.runnerCarveLastSegmentLength || 0).toFixed(2)}</div>
          <div>runnerCarveDepositionRadius: {(presentationTiming.runnerCarveLastRadius || 0).toFixed(2)}</div>
          <div>runnerCarveSpacingRatioMean: {(presentationTiming.runnerCarveSpacingRatioMean || 0).toFixed(2)}</div>
          <div>runnerCarveGapFraction: {(((presentationTiming.runnerCarveGapFraction || 0) * 100)).toFixed(1)}%</div>
          <div>runnerCarveDepthGainMean: {(presentationTiming.runnerCarveDepthGainMean || 0).toFixed(4)}</div>
          <div>runnerCarvePostSmoothRetentionMean: {(presentationTiming.runnerCarvePostSmoothRetentionMean || 0).toFixed(2)}</div>
          <div>runnerCarveRecoveryRatioMean: {(presentationTiming.runnerCarveRecoveryRatioMean || 0).toFixed(2)}</div>
          <div>clockMode: {clockDebug.mode}</div>
          <div>clockLastAction: {clockDebug.lastAction}</div>
          <div>clockTargetSec: {(clockDebug.targetSec || 0).toFixed(2)}</div>
          <div>currentTimeSec: {(rainDebug.currentTimeSec || 0).toFixed(2)}</div>
          <div>loopTimeSec: {(rainDebug.loopTimeSec || 0).toFixed(2)}</div>
          <div>durationSec: {(rainDebug.durationSec || 0).toFixed(2)}</div>
          <div>rainIntensity: {(rainDebug.rainIntensity || 0).toFixed(3)}</div>
          <div>activeRainClipCount: {rainDebug.activeRainClipCount || 0}</div>
          <div>activeRainClipIds: {rainDebug.activeRainClipIds?.length ? rainDebug.activeRainClipIds.join(', ') : 'none'}</div>
          <div>activeFogClipCount: {rainDebug.activeFogClipCount || 0}</div>
          <div>activeFogClipIds: {rainDebug.activeFogClipIds?.length ? rainDebug.activeFogClipIds.join(', ') : 'none'}</div>
          <div>rainContribution: {(rainDebug.rainContribution || 0).toFixed(3)}</div>
          <div>fogContribution: {(rainDebug.fogContribution || 0).toFixed(3)}</div>
          <div>weather.wind: {(rainDebug.weather?.wind || 0).toFixed(3)}</div>
          <div>weather.rain: {(rainDebug.weather?.rain || 0).toFixed(3)}</div>
          <div>weather.mist: {(rainDebug.weather?.mist || 0).toFixed(3)}</div>
          <div>weather.washdown: {(rainDebug.weather?.washdown || 0).toFixed(3)}</div>
          <div>weather.fogBuildup: {(rainDebug.weather?.fogBuildup || 0).toFixed(3)}</div>
          <div>weather.fogClearing: {(rainDebug.weather?.fogClearing || 0).toFixed(3)}</div>
          <div>effectiveRefillRate: {(rainDebug.effectiveRefillRate || 0).toFixed(4)}</div>
          <div>drivenDropletsPerSeconds: {Math.round(rainDebug.drivenDropletsPerSeconds || 0)}</div>
          <div>rainFogMismatchClass: {rainDebug.mismatchClass || 'none'}</div>
          <div>rainFogMismatchSeverity: {rainDebug.mismatchSeverity || 'none'}</div>
          <div>rainFogMismatchFrames: {rainDebug.mismatchFrames || 0}</div>
          <div>rainFogMismatchReason: {rainDebug.mismatchReason || 'none'}</div>
          <div>render.simulatorRaindropCount: {Number(presentationRenderer.simulatorRaindropCount || 0)}</div>
          <div>render.renderSucceeded: {presentationRenderer.renderSucceeded ? 'true' : 'false'}</div>
          <div>bootstrap.rendererCreated: {presentationBootstrap.rendererCreated ? 'true' : 'false'}</div>
          <div>bootstrap.rendererAttached: {presentationBootstrap.rendererAttached ? 'true' : 'false'}</div>
          <div>bootstrap.initialWeatherApplied: {presentationBootstrap.initialWeatherApplied ? 'true' : 'false'}</div>
          <div>bootstrap.initialRainApplied: {presentationBootstrap.initialRainApplied ? 'true' : 'false'}</div>
          <div>bootstrap.initialFogApplied: {presentationBootstrap.initialFogApplied ? 'true' : 'false'}</div>
          <div>bootstrap.seededDropletCount: {Number(presentationBootstrap.seededDropletCount || 0)}</div>
          <div>bootstrap.firstVisibleRainFrame: {Number.isFinite(presentationBootstrap.firstVisibleRainFrame) ? presentationBootstrap.firstVisibleRainFrame : -1}</div>
          <div>bootstrap.firstRenderFrameTime: {(Number(presentationBootstrap.firstRenderFrameTime || 0)).toFixed(2)}</div>
          <div>bootstrap.refreshPath: {presentationBootstrap.refreshPath ? 'true' : 'false'}</div>
          <div>bootstrap.publishRestartPath: {presentationBootstrap.publishRestartPath ? 'true' : 'false'}</div>
            <div>bootstrap.adapterInitDropletsPerSeconds: {Number(presentationBootstrap.adapterInitDropletsPerSeconds || 0)}</div>
          <div className="presentation-runtime-controls">
            <button type="button" onClick={handleResetTimeToZero}>Reset Time 0.0</button>
            <button type="button" onClick={handleSeekFirstRainWindow}>Seek First Rain Window</button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function BackgroundLayer({ background }) {
  if (background.type === 'video') {
    return (
      <video
        className="presentation-background"
        src={background.src}
        autoPlay={background.autoplay !== false}
        muted={background.muted !== false}
        loop={background.loop !== false}
        playsInline
      />
    )
  }

  return <img className="presentation-background" src={background.src} alt="Atmospheric scene" />
}

function matchesShortcut(shortcut, event) {
  const parts = String(shortcut || '').split('+').map((part) => part.trim().toLowerCase())
  if (!parts.length) {
    return false
  }

  const keyPart = parts.find((part) => !['ctrl', 'control', 'alt', 'shift', 'meta', 'cmd'].includes(part))
  if (!keyPart) {
    return false
  }

  const wantCtrl = parts.includes('ctrl') || parts.includes('control')
  const wantAlt = parts.includes('alt')
  const wantShift = parts.includes('shift')
  const wantMeta = parts.includes('meta') || parts.includes('cmd')

  return (
    event.key.toLowerCase() === keyPart &&
    Boolean(event.ctrlKey) === wantCtrl &&
    Boolean(event.altKey) === wantAlt &&
    Boolean(event.shiftKey) === wantShift &&
    Boolean(event.metaKey) === wantMeta
  )
}

function formatRuntimeTimestamp(value) {
  if (!value) {
    return 'n/a'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return 'n/a'
  }

  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export default PresentationPage
