import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { WetSurfaceEngine } from '../engine/WetSurfaceEngine'
import {
  STARTUP_MODES,
} from '../config'
import { getLinkedEffectiveConfig } from '../tuning/tuningConfig'
import { getPublishedRuntimeDocument, subscribePublishedRuntimeDocument } from '../runtime/authoringRuntimeBridge'
import {
  resolveRuntimeExecutionFromPayload,
  shortRuntimePayloadHash,
} from '../runtime/runtimeExecution'
import { getLatestVerificationArtifact, subscribeVerificationArtifacts } from '../verification/verificationArtifactStore'

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

const PRESENTATION_CONTRACT_VIOLATION_MARKER = 'active-rain-with-zero-droplets'

// Diagnostic-only lineage marker used to classify boot path labels during parity checks.
// This value never participates in runtime weather/state authority.
const PRESENTATION_RUNTIME_SESSION_STORAGE_KEY = 'mistyos.presentation.lastRuntimeSessionKey.v1'

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

  const handleResetTimeToZero = useCallback(() => {
    const nowMs = performance.now()
    engineRef.current?.resetSimulationClock?.({ reason: 'dev-control-reset-time-0', startSec: 0, nowMs })
    setClockDebug({ mode: 'running', lastAction: 'dev-control-reset-time-0', targetSec: 0 })
  }, [])

  const handleSeekFirstRainWindow = useCallback(() => {
    const nowMs = performance.now()
    const result = engineRef.current?.seekToBootstrapFirstRainWindow?.({
      reason: 'dev-control-seek-first-rain-window',
      nowMs,
      lockAtTarget: true,
    })
    if (!result?.applied || !Number.isFinite(result?.targetSec)) {
      setClockDebug((prev) => ({
        ...prev,
        lastAction: 'seek-first-rain-window-not-found',
      }))
      return
    }
    setClockDebug({ mode: 'locked', lastAction: 'dev-control-seek-first-rain-window', targetSec: Number(result.targetSec) })
  }, [])

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
  }, [publishRevision, publishedDocument?.fromSavedRevision, publishedDocument?.publishRevision, publishedDocument?.restartToken, restartToken, runtimeSessionKey])

  useEffect(() => {
    setAtmosphereVisible(settings.startupMode !== STARTUP_MODES.STATIC_THEN_FADE)
  }, [runtimeSessionKey, settings.startupMode])

  const basePreset = runtimeExecution.basePreset

  const background = scene.background || { type: 'image', src: '/media/rain-room.jpg' }

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
      },
    })

    // Consolidated runtime session context handoff: Presentation publishes session
    // lineage and runtime inputs; engine owns startup/runtime execution boundaries.
    engine.setRuntimeSessionContext?.({
      runtimeSessionKey,
      bootPath: bootstrapPathIsRefreshRef.current ? 'refresh' : 'publish-restart',
      publishRevision,
      restartToken,
      durationSec: timelineDurationSec,
      sceneId: runtimeExecution.sceneId,
      timelineId: runtimeExecution.timelineId,
      runtimeTimeline,
      basePreset,
      includeDiagnostics: isDevRuntime(),
      initialApplySequence: Number(tuningApplySequenceRef.current || 0),
      startupEnabled: shouldAutoRunTimeline,
      steadyLiveEnabled: shouldAutoRunTimeline,
      updateIntervalSec: 1 / 30,
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
        const bootstrap = engine.runCanonicalBootstrapAuthority?.({
          runtimeSessionKey,
          basePreset,
          timelineDurationSec,
          sampleCallSite: 'start:static-hold-pre-start-bootstrap',
          startupInvocationSource: 'start-static-hold',
        })
        if (Number.isFinite(Number(bootstrap?.applySequence))) {
          tuningApplySequenceRef.current = Number(bootstrap.applySequence) + 1
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
          engine.seekSimulationClock?.(firstRainSec, { reason: 'auto-startup-seek-first-rain', nowMs: performance.now() })
          setClockDebug({ mode: 'running', lastAction: 'auto-startup-seek-first-rain', targetSec: firstRainSec })
        }
      }, holdMs)

      return () => {
        window.clearTimeout(startTimer)
        engine.stop()
        engineRef.current = null
      }
    }

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

    const bootstrap = engine.runCanonicalBootstrapAuthority?.({
      runtimeSessionKey,
      basePreset,
      timelineDurationSec,
      sampleCallSite: 'start:shared-pre-start-bootstrap',
      startupInvocationSource: 'start-shared-bootstrap',
    })
    if (Number.isFinite(Number(bootstrap?.applySequence))) {
      tuningApplySequenceRef.current = Number(bootstrap.applySequence) + 1
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

    // Seek the engine clock to the first active rain window so steady-live sampling
    // immediately targets a time with rain and sustains dropletsPerSeconds above baseline.
    const firstRainSec = bootstrap.firstRainWindowSec
    if (Number.isFinite(firstRainSec) && firstRainSec > 0) {
      engine.seekSimulationClock?.(firstRainSec, { reason: 'auto-startup-seek-first-rain', nowMs: performance.now() })
      setClockDebug({ mode: 'running', lastAction: 'auto-startup-seek-first-rain', targetSec: firstRainSec })
    }

    return () => {
      engine.stop()
      engineRef.current = null
    }
  }, [background.src, basePreset, publishRevision, restartToken, runtimeExecution.sceneId, runtimeExecution.timelineId, runtimePayload, runtimeSessionKey, runtimeTimeline, settings.startupMode, settings.staticStartup?.holdSeconds, shouldAutoRunTimeline, timelineDurationSec])

  useEffect(() => {
    if (!shouldAutoRunTimeline) {
      return
    }

    const timing = presentationStats?.timing || {}
    const bootstrap = presentationStats?.bootstrap || {}
    const lineage = Array.isArray(bootstrap.setTuningLineageTrace) ? bootstrap.setTuningLineageTrace : []
    const canonicalZeroEntry = lineage.find((entry) => entry?.sampleCallSite === 'engine:startup-canonical-zero-handoff') || null
    const firstLiveBoundaryEntry = lineage.find((entry) => entry?.sampleCallSite === 'engine:startup-first-live-boundary') || null

    if (canonicalZeroEntry && startupCanonicalSamplePendingRef.current) {
      startupCanonicalSamplePendingRef.current = false
      startupPreFrameAppliedSignatureRef.current = JSON.stringify({
        engineFrame: Number(canonicalZeroEntry?.engineFrame ?? 0),
        sampleSec: Number(canonicalZeroEntry?.normalizedSampleSec || 0),
      })

      if (isDevRuntime()) {
        devLog('runtime-canonical-zero-sample', {
          runtimeSessionKey,
          bootPath: bootstrapPathIsRefreshRef.current ? 'refresh' : 'publish-restart',
          publishRevision: publishedDocument?.publishRevision || 0,
          restartToken: publishedDocument?.restartToken || 'local-default',
          payloadHash: shortRuntimePayloadHash(runtimePayload),
          timelineId: runtimeExecution.timelineId,
          sample: canonicalZeroEntry,
        })
      }
    }

    if (firstLiveBoundaryEntry && startupFirstLiveSamplePendingRef.current) {
      startupFirstLiveSamplePendingRef.current = false
      startupPreFrameAppliedSignatureRef.current = null

      if (isDevRuntime()) {
        devLog('runtime-startup-boundary-sample', {
          runtimeSessionKey,
          bootPath: bootstrapPathIsRefreshRef.current ? 'refresh' : 'publish-restart',
          publishRevision,
          restartToken,
          payloadHash: shortRuntimePayloadHash(runtimePayload),
          timelineId: runtimeExecution.timelineId,
          sample: firstLiveBoundaryEntry,
          engineFrameAfterApply: Number(engineRef.current?.wetnessFrameCounter || 0),
          appliedRainIntensity: Number(engineRef.current?.tuningConfig?.debug?.runtimeSampledRainIntensity || 0),
          appliedDropletsPerSeconds: Number(engineRef.current?.tuningConfig?.renderer?.dropletsPerSeconds || 0),
        })
      }
    }

    if (
      isDevRuntime() &&
      !handoffTraceRef.current.done &&
      timing.runtimeWeatherApplyAuthority === 'engine-steady-live'
    ) {
      handoffTraceRef.current.liveSampleSeen = true
      handoffTraceRef.current.done = true
      devLog('runtime-steady-live-authority-engine', {
        runtimeSessionKey,
        bootPath: bootstrapPathIsRefreshRef.current ? 'refresh' : 'publish-restart',
        publishRevision: publishedDocument?.publishRevision || 0,
        restartToken: publishedDocument?.restartToken || 'local-default',
        payloadHash: shortRuntimePayloadHash(runtimePayload),
        timelineId: runtimeExecution.timelineId,
        authority: timing.runtimeWeatherApplyAuthority || 'unknown',
        source: timing.runtimeWeatherApplySource || 'unknown',
        callSite: timing.runtimeWeatherApplyCallSite || 'unknown',
        steadyLiveApplyCount: Number(timing.runtimeSteadyLiveApplyCount || 0),
      })
    }
  }, [presentationStats, publishRevision, publishedDocument?.publishRevision, publishedDocument?.restartToken, restartToken, runtimeExecution.timelineId, runtimePayload, runtimeSessionKey, shouldAutoRunTimeline])

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
      engineContractMarker: 'withSchedulerInvariantHints',
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
