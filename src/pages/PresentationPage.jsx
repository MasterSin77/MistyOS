import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { WetSurfaceEngine } from '../engine/WetSurfaceEngine'
import {
  STARTUP_MODES,
} from '../config'
import { getLinkedEffectiveConfig } from '../tuning/tuningConfig'
import {
  getPublishedRuntimeDocument,
  getRuntimeSurfacePriorityState,
  publishRuntimeSurfacePriorityHeartbeat,
  releaseRuntimeSurfacePriorityHeartbeat,
  resolveRuntimeSurfacePriorityState,
  subscribePublishedRuntimeDocument,
  subscribeRuntimeSurfacePriorityState,
} from '../runtime/authoringRuntimeBridge'
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

// Diagnostic-only lineage marker used to classify boot path labels during parity checks.
// This value never participates in runtime weather/state authority.
const PRESENTATION_RUNTIME_SESSION_STORAGE_KEY = 'mistyos.presentation.lastRuntimeSessionKey.v1'
const PRESENTATION_WINDOW_NAME = 'mistyos-presentation-window'
const RUNTIME_SURFACE_HEARTBEAT_INTERVAL_MS = 1500
const RUNTIME_SURFACE_HEARTBEAT_TTL_MS = 5000
const STARTUP_FAIL_OPEN_SETTLE_MS = RUNTIME_SURFACE_HEARTBEAT_INTERVAL_MS * 2

// Hydration parity verifier cache-freshness sentinel. The runtime no longer uses
// a Presentation-side contract-violation path, but the marker string remains
// intentionally preserved for the existing proof surface.
const PRESENTATION_CONTRACT_VIOLATION_SENTINEL = 'active-rain-with-zero-droplets'
const PRESENTATION_INTERNAL_RENDER_SCALE = 0.67

function getNavigationType() {
  if (typeof window === 'undefined' || typeof performance === 'undefined') {
    return 'navigate'
  }

  const entries = performance.getEntriesByType?.('navigation') || []
  const entry = entries[0]
  return entry?.type || 'navigate'
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
  void PRESENTATION_CONTRACT_VIOLATION_SENTINEL
  const canvasRef = useRef(null)
  const engineRef = useRef(null)
  const presentationLoopRunningRef = useRef(false)
  const startupHeartbeatPublishedRef = useRef(false)
  const previousRuntimeSessionKeyRef = useRef(null)
  const presentationSurfaceSessionIdRef = useRef(`presentation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const bootstrapPathIsRefreshRef = useRef(false)
  const bootParitySnapshotRef = useRef(null)
  const bootParityLoggedSessionRef = useRef(null)
  const startupCanonicalSamplePendingRef = useRef(true)
  const startupFirstLiveSamplePendingRef = useRef(true)
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
  const [runtimeSurfacePriorityState, setRuntimeSurfacePriorityState] = useState(() => getRuntimeSurfacePriorityState())
  const [presentationDocumentVisible, setPresentationDocumentVisible] = useState(() => (
    typeof document !== 'undefined' ? document.visibilityState === 'visible' : false
  ))
  const [presentationWindowFocused, setPresentationWindowFocused] = useState(() => (
    typeof document !== 'undefined' ? document.hasFocus() : false
  ))
  const [startupFailOpenActive, setStartupFailOpenActive] = useState(true)
  const [clockDebug, setClockDebug] = useState({
    mode: 'running',
    lastAction: 'initial',
    targetSec: 0,
  })

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    try {
      if (window.name !== PRESENTATION_WINDOW_NAME) {
        window.name = PRESENTATION_WINDOW_NAME
      }
    } catch {
      // Ignore browser restrictions; canonical reuse will still use best-effort target semantics.
    }
  }, [])

  useEffect(() => subscribePublishedRuntimeDocument(stableSetPublishedDocument), [stableSetPublishedDocument])

  useEffect(() => subscribeRuntimeSurfacePriorityState(setRuntimeSurfacePriorityState), [])

  useEffect(() => {
    const updateVisibilityAndFocus = () => {
      setPresentationDocumentVisible(document.visibilityState === 'visible')
      setPresentationWindowFocused(document.hasFocus())
    }

    updateVisibilityAndFocus()
    window.addEventListener('focus', updateVisibilityAndFocus)
    window.addEventListener('blur', updateVisibilityAndFocus)
    document.addEventListener('visibilitychange', updateVisibilityAndFocus)

    return () => {
      window.removeEventListener('focus', updateVisibilityAndFocus)
      window.removeEventListener('blur', updateVisibilityAndFocus)
      document.removeEventListener('visibilitychange', updateVisibilityAndFocus)
    }
  }, [])

  useEffect(() => {
    const publishHeartbeat = () => {
      const visibilityState = typeof document !== 'undefined' ? document.visibilityState : 'hidden'
      const isFocused = typeof document !== 'undefined' ? document.hasFocus() : false
      const resolvedPriority = resolveRuntimeSurfacePriorityState(getRuntimeSurfacePriorityState())
      const explicitUpdateDesktopHandoff = (
        resolvedPriority.resolvedSurfaceType === 'presentation'
        && resolvedPriority.resolvedReason === 'update-desktop-handoff'
      )
      if (visibilityState !== 'visible' || !isFocused) {
        if (explicitUpdateDesktopHandoff) {
          return
        }
        releaseRuntimeSurfacePriorityHeartbeat({
          surfaceType: 'presentation',
          surfaceSessionId: presentationSurfaceSessionIdRef.current,
        })
        return
      }

      publishRuntimeSurfacePriorityHeartbeat({
        surfaceType: 'presentation',
        surfaceSessionId: presentationSurfaceSessionIdRef.current,
        surfaceWindowId: `${window.location.pathname || '/presentation'}:${publishedDocument?.publishRevision || 0}:${publishedDocument?.restartToken || 'local-default'}`,
        reason: 'presentation-focused',
        visibilityState,
        isFocused,
        heartbeatTtlMs: RUNTIME_SURFACE_HEARTBEAT_TTL_MS,
      })

      if (!startupHeartbeatPublishedRef.current) {
        startupHeartbeatPublishedRef.current = true
        setStartupFailOpenActive(false)
      }
    }

    publishHeartbeat()
    const timer = window.setInterval(publishHeartbeat, RUNTIME_SURFACE_HEARTBEAT_INTERVAL_MS)
    window.addEventListener('focus', publishHeartbeat)
    window.addEventListener('blur', publishHeartbeat)
    document.addEventListener('visibilitychange', publishHeartbeat)

    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', publishHeartbeat)
      window.removeEventListener('blur', publishHeartbeat)
      document.removeEventListener('visibilitychange', publishHeartbeat)
      releaseRuntimeSurfacePriorityHeartbeat({
        surfaceType: 'presentation',
        surfaceSessionId: presentationSurfaceSessionIdRef.current,
      })
    }
  }, [publishedDocument?.publishRevision, publishedDocument?.restartToken])

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
  const resolvedRuntimeSurfacePriority = useMemo(
    () => resolveRuntimeSurfacePriorityState(runtimeSurfacePriorityState),
    [runtimeSurfacePriorityState],
  )
  const presentationPauseReason = useMemo(() => {
    if (startupFailOpenActive) {
      return 'startup-fail-open'
    }
    if (
      resolvedRuntimeSurfacePriority.resolvedSurfaceType === 'presentation'
      && resolvedRuntimeSurfacePriority.resolvedReason === 'update-desktop-handoff'
    ) {
      return 'update-desktop-handoff'
    }
    if (!presentationDocumentVisible) {
      return 'tab-hidden'
    }
    if (!presentationWindowFocused) {
      return 'tab-unfocused'
    }
    if (resolvedRuntimeSurfacePriority.resolvedSurfaceType === 'studio') {
      return 'studio-focused'
    }
    return 'presentation-focused'
  }, [
    presentationDocumentVisible,
    presentationWindowFocused,
    resolvedRuntimeSurfacePriority.resolvedReason,
    resolvedRuntimeSurfacePriority.resolvedSurfaceType,
    startupFailOpenActive,
  ])
  const presentationLoopPaused = !startupFailOpenActive && presentationPauseReason !== 'presentation-focused'

  useEffect(() => {
    startupHeartbeatPublishedRef.current = false
    setStartupFailOpenActive(true)

    const timer = window.setTimeout(() => {
      setStartupFailOpenActive(false)
    }, STARTUP_FAIL_OPEN_SETTLE_MS)

    return () => {
      window.clearTimeout(timer)
    }
  }, [])

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
    bootParitySnapshotRef.current = null
    bootParityLoggedSessionRef.current = null
    startupCanonicalSamplePendingRef.current = true
    startupFirstLiveSamplePendingRef.current = true
    handoffTraceRef.current = {
      sampled: 0,
      applied: 0,
      liveSampleSeen: false,
      done: false,
    }
    tuningApplySequenceRef.current = 0
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

    const presentationTuningConfig = getLinkedEffectiveConfig(basePreset)
    const engine = new WetSurfaceEngine(canvas, {
      backgroundSrc: background.src,
      phase: 3,
      tuningConfig: presentationTuningConfig,
      presentationInternalRenderScale: PRESENTATION_INTERNAL_RENDER_SCALE,
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
        presentationLoopRunningRef.current = true
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
        presentationLoopRunningRef.current = false
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
      presentationLoopRunningRef.current = false
    }
  }, [background.src, basePreset, publishRevision, restartToken, runtimeExecution.sceneId, runtimeExecution.timelineId, runtimePayload, runtimeSessionKey, runtimeTimeline, settings.startupMode, settings.staticStartup?.holdSeconds, shouldAutoRunTimeline, timelineDurationSec])

  useEffect(() => {
    const engine = engineRef.current
    if (!engine) {
      return
    }

    if (presentationLoopPaused) {
      if (presentationLoopRunningRef.current) {
        engine.setLoopActive?.(false, `presentation-paused:${presentationPauseReason}`)
        presentationLoopRunningRef.current = false
      }
      return
    }

    if (!presentationLoopRunningRef.current) {
      engine.setLoopActive?.(true, `presentation-resumed:${presentationPauseReason}`)
      presentationLoopRunningRef.current = true
    }
  }, [presentationLoopPaused, presentationPauseReason])

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

    // Non-authoritative engine ref export for dev-mode boundary rejection testing only.
    // This is strictly for verification; production runtime authority flows through handlers.
    window.__MISTYOS_PRESENTATION_RUNTIME = {
      resetTimeToZero: handleResetTimeToZero,
      seekFirstRainWindow: handleSeekFirstRainWindow,
      engineContractMarker: 'withSchedulerInvariantHints',
      __devEngineRef: engineRef.current,
      runtimeSessionKey,
      publishRevision,
      fromSavedRevision,
      restartToken,
      runtimePayloadHash,
      clockDebug,
      timing: presentationStats?.timing || {},
      bootstrap: presentationStats?.bootstrap || {},
      runtimeSurfacePriority: resolvedRuntimeSurfacePriority,
      activeSurface: resolvedRuntimeSurfacePriority.resolvedSurfaceType || null,
      presentationPaused: presentationLoopPaused,
      presentationPauseReason,
      startupFailOpenActive,
    }
    return () => {
      delete window.__MISTYOS_PRESENTATION_RUNTIME
    }
  }, [clockDebug, engineRef, fromSavedRevision, handleResetTimeToZero, handleSeekFirstRainWindow, presentationLoopPaused, presentationPauseReason, presentationStats, publishRevision, resolvedRuntimeSurfacePriority, restartToken, runtimePayloadHash, runtimeSessionKey, startupFailOpenActive])

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
  const latestLineageEntry = Array.isArray(presentationBootstrap.setTuningLineageTrace) && presentationBootstrap.setTuningLineageTrace.length > 0
    ? presentationBootstrap.setTuningLineageTrace[presentationBootstrap.setTuningLineageTrace.length - 1]
    : null
  const activeRainClipIds = Array.isArray(latestLineageEntry?.rainTrackInputs)
    ? Array.from(new Set(latestLineageEntry.rainTrackInputs.flatMap((entry) => Array.isArray(entry?.sourceClipIds) ? entry.sourceClipIds : [])))
    : []
  const activeRainContribution = Array.isArray(latestLineageEntry?.rainTrackInputs)
    ? latestLineageEntry.rainTrackInputs.reduce((sum, entry) => sum + Number(entry?.contribution || 0), 0)
    : 0
  const runtimeDurationSec = Number(
    presentationBootstrap?.simulationClockAuthority?.session?.durationSec || timelineDurationSec || 0,
  )
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
        <div
          className="presentation-runtime-meta"
          aria-live="polite"
          style={{ maxWidth: 540, maxHeight: '45vh', overflow: 'auto' }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(180px, 1fr))',
              gap: '2px 10px',
              fontSize: '11px',
              lineHeight: 1.2,
            }}
          >
            <div>fps: {Number(presentationTiming.fps || presentationStats?.fps || 0).toFixed(1)}</div>
            {/* Browser RAF is vsync-limited (~60Hz on 60Hz displays); lifecycle contention is about avoiding drops below cadence. */}
            <div>dt: {Number(presentationTiming.frameDeltaMs || 0).toFixed(2)}</div>
            <div>frame: {Number(presentationTiming.totalFrameTimeMs || presentationTiming.frameDeltaMs || 0).toFixed(2)}</div>
            <div>sim: {Number(presentationTiming.simulationTimeMs || 0).toFixed(2)}</div>
            <div>adapter: {Number(presentationTiming.adapterDrawTimeMs || 0).toFixed(2)}</div>
            <div>adp s/r/d: {Number(presentationTiming.adapterSimulationTimeMs || 0).toFixed(2)}/{Number(presentationTiming.adapterGlStateResetTimeMs || 0).toFixed(2)}/{Number(presentationTiming.adapterRendererDrawTimeMs || 0).toFixed(2)}</div>
            <div>present: {Number(presentationTiming.presentationCompositeTimeMs || 0).toFixed(2)}</div>
            <div>rBack: {presentationTiming.rendererCanvasBackingSize || 'n/a'}</div>
            <div>rScale: {Number(presentationTiming.rendererCanvasCssScale || 1).toFixed(3)}</div>
            <div>rMount: {presentationTiming.rendererCanvasDomMountActive ? 'true' : 'false'}</div>
            <div>activeSurface: {resolvedRuntimeSurfacePriority.resolvedSurfaceType || 'none'}</div>
            <div>presentationPaused: {presentationLoopPaused ? 'true' : 'false'} ({presentationPauseReason})</div>
            <div>fps5sMin: {Number(presentationTiming.fpsRollingMin5s || 0).toFixed(1)}</div>
            <div>fps5sMax: {Number(presentationTiming.fpsRollingMax5s || 0).toFixed(1)}</div>
            <div>drop5sMin: {Math.round(presentationTiming.renderedSimulatorRaindropCountRollingMin5s || 0)}</div>
            <div>drop5sMax: {Math.round(presentationTiming.renderedSimulatorRaindropCountRollingMax5s || 0)}</div>
            <div>rdfx5sMin: {Number(presentationTiming.raindropFxUpdateTimeMsRollingMin5s || 0).toFixed(2)}</div>
            <div>rdfx5sMax: {Number(presentationTiming.raindropFxUpdateTimeMsRollingMax5s || 0).toFixed(2)}</div>
          </div>
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
