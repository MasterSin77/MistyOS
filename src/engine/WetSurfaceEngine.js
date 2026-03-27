const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
import { RaindropFxRendererAdapter } from './RaindropFxRendererAdapter'
import { SurfaceWetnessField } from './SurfaceWetnessField'
import { DEFAULT_TUNING_CONFIG, deepClone, mergeDeep } from '../tuning/tuningConfig'
import { buildRuntimeWeatherDrivenConfig } from '../runtime/runtimeExecution'

const ENGINE_SESSION_STARTUP_PHASES = {
  CONSTRUCTED: 'constructed',
  BOOTSTRAP_READY: 'bootstrap-ready',
  CANONICAL_BOOTSTRAP_APPLIED: 'canonical-bootstrap-applied',
  STARTUP_HOLD: 'startup-hold',
  FIRST_LIVE_BOUNDARY_REACHED: 'first-live-boundary-reached',
  STEADY_LIVE: 'steady-live',
  STOPPED: 'stopped',
}

const ENGINE_SIMULATION_CLOCK_PHASES = {
  CONSTRUCTED: 'constructed',
  CANONICAL_STARTUP: 'canonical-startup',
  FIRST_LIVE_BOUNDARY: 'first-live-boundary',
  STEADY_LIVE: 'steady-live',
  LOCKED: 'locked',
  STOPPED: 'stopped',
}


/**
 * MistyOS runtime contract (non-negotiable):
 * 1) Two-surface architecture: Studio authoring -> Publish -> Presentation restart.
 * 2) Presentation is a pure consumer of published runtime payload.
 * 3) Scheduler timeline is the sole temporal authority for runtime weather.
 * 4) Rain/fog/wetness must derive deterministically from scheduler-sampled weather.
 * 5) Engine startup must be idempotent across cold start, publish restart, and browser refresh.
 */

export class WetSurfaceEngine {
  constructor(canvas, { backgroundSrc, phase = 3, onStats, tuningConfig, resizeMode = 'window', viewportElement = null }) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.backgroundSrc = backgroundSrc
    this.phase = phase
    this.onStats = onStats
    this.resizeMode = resizeMode === 'element' ? 'element' : 'window'
    this.viewportElement = viewportElement
    this.resizeObserver = null

    this.backgroundImage = new Image()
    this.backgroundImage.decoding = 'async'
    this.backgroundImage.src = backgroundSrc

    this.fogCanvas = document.createElement('canvas')
    this.fogCtx = this.fogCanvas.getContext('2d')
    this.fogImageData = null
    this.gpuOverlay = null
    this.gpuWetnessSimulation = null
    this.gpuInteractionWriteQueue = []
    this.gpuInteractionWriteQueueMax = 4096
    this.gpuInteractionWriteEnqueueCounter = 0

    this.animationFrame = null
    this.running = false
    this.firstTickLogged = false
    this.lastTime = performance.now()
    this.tuningConfig = mergeDeep(DEFAULT_TUNING_CONFIG, tuningConfig || {})
    this.tuningSignature = JSON.stringify(this.tuningConfig)
    this.fogLevel = this.tuningConfig.fogSurface.baseFogLevel
    this.lastAppliedFogScale = clamp(this.tuningConfig.fogSurface.fogScale, 0.2, 1)
    this.surfaceWetnessField = new SurfaceWetnessField(1, 1, {
      initialWetness: this.tuningConfig.surfaceWetness.initialWetness,
      maxWetness: this.tuningConfig.surfaceWetness.maxWetness,
      refillRate: this.tuningConfig.surfaceWetness.refillRate,
      recoveryRate: this.tuningConfig.surfaceWetness.recoveryRate,
      diffusionRate: this.tuningConfig.surfaceWetness.diffusionRate,
      trailRecoveryRate: this.tuningConfig.surfaceWetness.trailRecoveryRate,
      runnerMemoryRecoveryRate: this.tuningConfig.surfaceWetness.runnerMemoryRecoveryRate,
    })
    this.droplets = []
    this.previousRendererDropState = new Map()
    this.raindropRenderer = null
    this.raindropRendererReady = false
    this.rendererAttachInFlight = false

    this.isWriting = false
    this.pointerActive = false
    this.lastPointer = null
    this.pointerPhase = Math.random() * Math.PI * 2

    const query = new URLSearchParams(window.location.search)
    this.rendererDebugEnabled = query.get('rdfxDebug') === '1'
    this.rendererOnlyDebug = query.get('rdfxOnly') === '1'
    let devRuntime = false
    try {
      devRuntime = Boolean(import.meta?.env?.DEV)
    } catch {
      devRuntime = false
    }
    this.runnerCarveDiagnosticsEnabled = devRuntime && (query.get('runnerCarveDiag') === '1' || this.rendererDebugEnabled)
    this.runnerCarveDiagnosticsLastLogMs = 0
    this._isDevEnv = devRuntime
    this.rendererDebugInfo = {
      renderCalled: false,
      renderSucceeded: false,
      frameDeltaEnergy: 0,
      frameSampleReady: false,
      renderedDropletPixelCoverage: 0,
      rendererVisiblePixelCoverage: 0,
      rendererAlphaMean: 0,
    }
    // Bootstrap diagnostics only: parity observability for refresh/publish/cold-start.
    // These fields are never authoritative simulation inputs.
    this.bootstrapInfo = {
      rendererCreated: false,
      rendererAttached: false,
      initialWeatherApplied: false,
      initialRainApplied: false,
      initialFogApplied: false,
      seededDropletCount: 0,
      firstVisibleRainFrame: -1,
      firstRenderFrameTime: 0,
      refreshPath: false,
      publishRestartPath: false,
      initialFrameDiagnostics: [],
      wetnessLifecycleTrace: [],
      setTuningLineageTrace: [],
      canonicalPreStartBootstrap: null,
    }
    // Slice A scaffold: engine-owned startup/session phase model.
    // This is diagnostics-only in this pass; Presentation still drives startup behavior.
    this.sessionStartupAuthority = {
      schemaVersion: 1,
      currentPhase: ENGINE_SESSION_STARTUP_PHASES.CONSTRUCTED,
      phaseHistory: [
        {
          phase: ENGINE_SESSION_STARTUP_PHASES.CONSTRUCTED,
          reason: 'engine-constructor',
          atWetnessFrameCounter: 0,
          atPerfNowMs: Number(performance.now() || 0),
        },
      ],
      session: {
        runtimeSessionKey: null,
        bootPath: 'unknown',
        publishRevision: null,
        restartToken: null,
      },
      flags: {
        sawCanonicalBootstrap: false,
        sawStartupHold: false,
        sawFirstLiveBoundary: false,
        sawSteadyLive: false,
      },
      lastTransition: null,
    }
    // Slice B scaffold: engine-owned simulation clock/session timing model.
    // In this transitional pass it is diagnostics-first and mirrors current Presentation-driven
    // control flow. Later slices can migrate timing ownership onto this boundary.
    this.simulationClockAuthority = {
      schemaVersion: 1,
      session: {
        runtimeSessionKey: null,
        durationSec: 180,
      },
      phase: ENGINE_SIMULATION_CLOCK_PHASES.CONSTRUCTED,
      anchorNowMs: Number(performance.now() || 0),
      offsetSec: 0,
      lockedSec: null,
      currentTimeSec: 0,
      loopTimeSec: 0,
      frameStepCount: 0,
      totalAdvancedSec: 0,
      lastAdvancedDtSec: 0,
      startupPhaseAtLastUpdate: ENGINE_SESSION_STARTUP_PHASES.CONSTRUCTED,
      lastOperation: 'constructor',
      lastSampleBoundary: null,
      history: [],
    }
    this.rendererProbeCanvas = document.createElement('canvas')
    this.rendererProbeCanvas.width = 64
    this.rendererProbeCanvas.height = 36
    this.rendererProbeCtx = this.rendererProbeCanvas.getContext('2d', { willReadFrequently: true })
    this.previousProbeSample = null
    this.backgroundFreezeCanvas = document.createElement('canvas')
    this.backgroundFreezeCtx = this.backgroundFreezeCanvas.getContext('2d')
    this.backgroundFrozen = false
    this.timing = {
      avgFrameMs: 0,
      engineMs: 0,
      rendererMs: 0,
      wetnessMs: 0,
      simulatedDropletCount: 0,
      surfaceDropletCount: 0,
      rendererSamplingSource: 'fog-canvas-alpha-compat',
      rendererWetnessSampleMean: 0,
      rendererWetnessSampleVariance: 0,
      rendererTrailSampleMean: 0,
      rendererRunnerSampleMean: 0,
      rendererChannelCoverage: 0,
      debugWetnessPeak: 0,
      debugTrailPeak: 0,
      debugRunnerPeak: 0,
      rendererCarveCoverage: 0,
      wetnessBackend: 'cpu-grid',
      interactionBackend: 'cpu-direct',
      compatibilityMode: 'cpu-compat',
      gpuInteractionWritesQueued: 0,
      gpuInteractionWritesConsumed: 0,
      gpuInteractionWritesDropped: 0,
      gpuInteractionWritesCoalesced: 0,
      gpuInteractionPressure: 'low',
      gpuInteractionWriteBudget: 128,
      runnerCarveSamples: 0,
      runnerCarveSegmentSamples: 0,
      runnerCarvePointSamples: 0,
      runnerCarveDistanceMean: 0,
      runnerCarveDistanceMax: 0,
      runnerCarveLastMode: 'none',
      runnerCarveInterpolationActive: false,
      runnerCarveInterpolationProximityMatches: 0,
      runnerCarveLastPreviousMatchSource: 'none',
      runnerCarveLastDistance: 0,
      runnerCarveLastSegmentLength: 0,
      runnerCarveLastRadius: 0,
      runnerCarveLastStrength: 0,
      runnerCarveLastPrevX: 0,
      runnerCarveLastPrevY: 0,
      runnerCarveLastCurrX: 0,
      runnerCarveLastCurrY: 0,
      runnerCarveSpacingRatioMean: 0,
      runnerCarveSpacingRatioMax: 0,
      runnerCarveGapFraction: 0,
      runnerCarveDepthGainMean: 0,
      runnerCarvePostSmoothRetentionMean: 0,
      runnerCarveRecoveryRatioMean: 0,
      runnerCarveRecoveryLossMean: 0,
      runnerCarveFogAlphaMean: 0,
      runnerCarveFogResponseRatioMean: 0,
      runnerCarveFogDecayRatioMean: 0,
      runnerCarveDepthGainFrame: 0,
      sampledDropletDiagnostics: [],
      runnerCarveDiagnosticsPacketId: 0,
      wetnessFrameCounter: 0,
      runnerCarveLastSpacingRatio: 0,
      runnerCarveLastBeforeDepth: 0,
      runnerCarveLastAfterDepth: 0,
      runnerCarveLastPostSmoothDepth: 0,
      runnerCarveLastRecoveredDepth: 0,
      runnerCarveLastFogAlpha: 0,
      runnerCarveLastRecoveredFogAlpha: 0,
      gpuSimKernel: 'off',
      gpuSimReadbackMs: 0,
      cpuFogAlphaMean: 0,
      gpuFogAlphaMean: 0,
      gpuCpuAlphaDelta: 0,
      gpuCpuAlphaMae: 0,
      cpuFogAlphaVariance: 0,
      gpuFogAlphaVariance: 0,
      gpuCpuVarianceDelta: 0,
      gpuCpuTileMaxMae: 0,
      gpuCpuTileHotspot: 'n/a',
      gpuParityGateStatus: 'n/a',
      gpuParityGateFailures: 'n/a',
      gpuOverlayUvMode: 'flip-upload',
      gpuOverlayFogAlphaMean: 0,
      gpuOverlayFogAlphaMax: 0,
      gpuOverlayPresentTarget: '2d-cpu',
      gpuOverlayPresentFramebuffer: 'n/a',
      gpuOverlayPresentSamples: 'cpu-fog-canvas',
      gpuOverlayPresentSceneSource: '2d-main-scene',
      gpuOverlayPresentClearRgba: '2d-clearRect',
      gpuOverlayPresentBlendEnabled: 'n/a',
      gpuOverlayPresentBlendMode: 'n/a',
      gpuOverlayPresentAlphaConvention: 'n/a',
      gpuOverlayPresentContextAlpha: 'n/a',
      gpuOverlayPresentContextPremultiplied: 'n/a',
      overlayMs: 0,
      overlayBackend: 'cpu-2d',
      dropletProcessingMs: 0,
      clearingMs: 0,
      diffusionMs: 0,
      imageConvertMs: 0,
    }
    this.sceneAgeSec = 0
    this.wetnessFrameCounter = 0
    this.lastBaseWetnessSynced = this.fogLevel
    this.baseWetnessSyncThreshold = 0.0025
    this.wetnessTrendHistory = []
    this.lastWetnessTrendSampleSec = 0
    this.perfLogEnabled = query.get('wetPerfLog') === '1'
    this.lastFrameTimestamp = 0
    this.integrationCounters = {
      setTuningConfigCalls: 0,
      applyLiveSettingsCalls: 0,
    }
    this.pendingTuningApplyTrace = null
    // Slice D scaffold: explicit Presentation->Engine input envelope queue.
    // Inputs can be derived in Presentation for now, but application moment is engine-owned
    // through enqueue + consume-at-boundary APIs.
    this.runtimeInputQueue = []
    this.runtimeInputAuthority = {
      schemaVersion: 1,
      enqueuedCount: 0,
      consumedCount: 0,
      lastEnqueuedEnvelope: null,
      lastConsumedEnvelope: null,
      recentConsumedEnvelopes: [],
    }
    this.runtimeRainContractViolationLogged = false
    this.runnerCarveCurrentFrameProbes = []
    this.runnerCarvePendingRecoveryProbes = []

    this.resize = this.resize.bind(this)
    this.animate = this.animate.bind(this)
    this.onPointerDown = this.onPointerDown.bind(this)
    this.onPointerMove = this.onPointerMove.bind(this)
    this.onPointerUp = this.onPointerUp.bind(this)

    this.recordWetnessLifecycleTrace('constructor-ready')
  }

  recordWetnessLifecycleTrace(step, extra = {}) {
    const trace = this.bootstrapInfo?.wetnessLifecycleTrace
    if (!Array.isArray(trace) || trace.length >= 64) {
      return
    }

    trace.push({
      step,
      engineWetnessFrameCounter: Number(this.wetnessFrameCounter || 0),
      surfaceFrameId: Number(this.surfaceWetnessField?.frameId || 0),
      baseWetness: Number(this.surfaceWetnessField?.getDisplayWetness?.() || 0),
      fogLevel: Number(this.fogLevel || 0),
      lastBaseWetnessSynced: Number(this.lastBaseWetnessSynced || 0),
      setTuningConfigCalls: Number(this.integrationCounters?.setTuningConfigCalls || 0),
      applyLiveSettingsCalls: Number(this.integrationCounters?.applyLiveSettingsCalls || 0),
      ...extra,
    })
  }

  stageTuningApplyTrace(meta = null) {
    this.updateSessionStartupPhaseFromTuningTrace(meta)
    this.pendingTuningApplyTrace = meta && typeof meta === 'object'
      ? { ...meta }
      : null
  }

  setSessionStartupAuthorityContext(context = null) {
    const input = context && typeof context === 'object' ? context : {}
    this.sessionStartupAuthority.session = {
      runtimeSessionKey: input.runtimeSessionKey != null ? String(input.runtimeSessionKey) : null,
      bootPath: input.bootPath != null ? String(input.bootPath) : 'unknown',
      publishRevision: Number.isFinite(Number(input.publishRevision)) ? Number(input.publishRevision) : null,
      restartToken: input.restartToken != null ? String(input.restartToken) : null,
    }

    this.simulationClockAuthority.session = {
      ...this.simulationClockAuthority.session,
      runtimeSessionKey: input.runtimeSessionKey != null ? String(input.runtimeSessionKey) : null,
    }

  }

  setSimulationClockContext(context = null) {
    const input = context && typeof context === 'object' ? context : {}
    const nextDurationSec = Number.isFinite(Number(input.durationSec))
      ? Math.max(0.001, Number(input.durationSec))
      : Number(this.simulationClockAuthority.session?.durationSec || 180)

    this.simulationClockAuthority.session = {
      runtimeSessionKey: input.runtimeSessionKey != null
        ? String(input.runtimeSessionKey)
        : this.simulationClockAuthority.session?.runtimeSessionKey ?? null,
      durationSec: nextDurationSec,
    }
  }

  normalizeSimulationClockLoopTime(timeSec) {
    const durationSec = Math.max(0.001, Number(this.simulationClockAuthority.session?.durationSec || 180))
    const value = Number.isFinite(Number(timeSec)) ? Number(timeSec) : 0
    return value >= 0 ? value % durationSec : ((value % durationSec) + durationSec) % durationSec
  }

  pushSimulationClockHistory(event) {
    const history = this.simulationClockAuthority.history
    if (!Array.isArray(history)) {
      return
    }
    history.push(event)
    if (history.length > 128) {
      history.shift()
    }
  }

  updateSimulationClockPhaseFromStartup() {
    const startupPhase = String(this.sessionStartupAuthority.currentPhase || ENGINE_SESSION_STARTUP_PHASES.CONSTRUCTED)
    this.simulationClockAuthority.startupPhaseAtLastUpdate = startupPhase

    if (startupPhase === ENGINE_SESSION_STARTUP_PHASES.STOPPED) {
      this.simulationClockAuthority.phase = ENGINE_SIMULATION_CLOCK_PHASES.STOPPED
    } else if (Number.isFinite(this.simulationClockAuthority.lockedSec)) {
      this.simulationClockAuthority.phase = ENGINE_SIMULATION_CLOCK_PHASES.LOCKED
    } else if (startupPhase === ENGINE_SESSION_STARTUP_PHASES.FIRST_LIVE_BOUNDARY_REACHED) {
      this.simulationClockAuthority.phase = ENGINE_SIMULATION_CLOCK_PHASES.FIRST_LIVE_BOUNDARY
    } else if (startupPhase === ENGINE_SESSION_STARTUP_PHASES.STEADY_LIVE) {
      this.simulationClockAuthority.phase = ENGINE_SIMULATION_CLOCK_PHASES.STEADY_LIVE
    } else if (
      startupPhase === ENGINE_SESSION_STARTUP_PHASES.BOOTSTRAP_READY ||
      startupPhase === ENGINE_SESSION_STARTUP_PHASES.CANONICAL_BOOTSTRAP_APPLIED ||
      startupPhase === ENGINE_SESSION_STARTUP_PHASES.STARTUP_HOLD
    ) {
      this.simulationClockAuthority.phase = ENGINE_SIMULATION_CLOCK_PHASES.CANONICAL_STARTUP
    } else {
      this.simulationClockAuthority.phase = ENGINE_SIMULATION_CLOCK_PHASES.CONSTRUCTED
    }

  }

  resetSimulationClock(options = {}) {
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Number(performance.now() || 0)
    const reason = String(options.reason || 'reset')
    const startSec = Number.isFinite(Number(options.startSec)) ? Math.max(0, Number(options.startSec)) : 0

    this.simulationClockAuthority.anchorNowMs = nowMs
    this.simulationClockAuthority.offsetSec = startSec
    this.simulationClockAuthority.lockedSec = null
    this.simulationClockAuthority.currentTimeSec = startSec
    this.simulationClockAuthority.loopTimeSec = this.normalizeSimulationClockLoopTime(startSec)
    this.simulationClockAuthority.lastOperation = `reset:${reason}`

    this.updateSimulationClockPhaseFromStartup()
    this.pushSimulationClockHistory({
      op: 'reset',
      reason,
      atNowMs: nowMs,
      currentTimeSec: this.simulationClockAuthority.currentTimeSec,
      loopTimeSec: this.simulationClockAuthority.loopTimeSec,
      phase: this.simulationClockAuthority.phase,
      startupPhase: this.simulationClockAuthority.startupPhaseAtLastUpdate,
    })
  }

  seekSimulationClock(targetSec, options = {}) {
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Number(performance.now() || 0)
    const lockAtTarget = options.lockAtTarget === true
    const reason = String(options.reason || 'seek')
    const durationSec = Math.max(0.001, Number(this.simulationClockAuthority.session?.durationSec || 180))
    const clampedSec = clamp(Number(targetSec || 0), 0, durationSec)

    this.simulationClockAuthority.anchorNowMs = nowMs
    if (lockAtTarget) {
      this.simulationClockAuthority.lockedSec = clampedSec
      this.simulationClockAuthority.currentTimeSec = clampedSec
    } else {
      this.simulationClockAuthority.lockedSec = null
      this.simulationClockAuthority.offsetSec = clampedSec
      this.simulationClockAuthority.currentTimeSec = clampedSec
    }
    this.simulationClockAuthority.loopTimeSec = this.normalizeSimulationClockLoopTime(clampedSec)
    this.simulationClockAuthority.lastOperation = `seek:${reason}`

    this.updateSimulationClockPhaseFromStartup()
    if (lockAtTarget) {
      this.simulationClockAuthority.phase = ENGINE_SIMULATION_CLOCK_PHASES.LOCKED
    }

    this.pushSimulationClockHistory({
      op: 'seek',
      reason,
      lockAtTarget,
      targetSec: clampedSec,
      atNowMs: nowMs,
      phase: this.simulationClockAuthority.phase,
      startupPhase: this.simulationClockAuthority.startupPhaseAtLastUpdate,
    })
  }

  sampleSimulationClock(nowMs = performance.now()) {
    const nowValue = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Number(performance.now() || 0)
    const lockedSec = this.simulationClockAuthority.lockedSec
    if (Number.isFinite(lockedSec)) {
      this.simulationClockAuthority.currentTimeSec = Number(lockedSec)
      this.simulationClockAuthority.loopTimeSec = this.normalizeSimulationClockLoopTime(lockedSec)
      this.simulationClockAuthority.lastOperation = 'sample:locked'
      this.updateSimulationClockPhaseFromStartup()
      this.simulationClockAuthority.phase = ENGINE_SIMULATION_CLOCK_PHASES.LOCKED
      return Number(lockedSec)
    }

    const elapsedSec = Math.max(0, (nowValue - Number(this.simulationClockAuthority.anchorNowMs || nowValue)) / 1000)
    const currentSec = Math.max(0, Number(this.simulationClockAuthority.offsetSec || 0) + elapsedSec)
    this.simulationClockAuthority.currentTimeSec = currentSec
    this.simulationClockAuthority.loopTimeSec = this.normalizeSimulationClockLoopTime(currentSec)
    this.simulationClockAuthority.lastOperation = 'sample:running'
    this.updateSimulationClockPhaseFromStartup()
    return currentSec
  }

  mirrorPresentationClockSample(sample = null) {
    const input = sample && typeof sample === 'object' ? sample : {}
    const nowMs = Number.isFinite(Number(input.nowMs)) ? Number(input.nowMs) : Number(performance.now() || 0)
    const currentTimeSec = Number.isFinite(Number(input.currentTimeSec)) ? Math.max(0, Number(input.currentTimeSec)) : null

    if (currentTimeSec === null) {
      return
    }

    this.simulationClockAuthority.currentTimeSec = currentTimeSec
    this.simulationClockAuthority.loopTimeSec = this.normalizeSimulationClockLoopTime(currentTimeSec)
    this.simulationClockAuthority.lastOperation = `mirror:${String(input.source || 'presentation')}`
    this.updateSimulationClockPhaseFromStartup()

    this.pushSimulationClockHistory({
      op: 'mirror',
      source: String(input.source || 'presentation'),
      callSite: String(input.callSite || ''),
      currentTimeSec,
      atNowMs: nowMs,
      phase: this.simulationClockAuthority.phase,
      startupPhase: this.simulationClockAuthority.startupPhaseAtLastUpdate,
    })
  }

  noteSimulationSampleBoundary(boundary = null) {
    const input = boundary && typeof boundary === 'object' ? boundary : {}
    const elapsedSec = Number.isFinite(Number(input.elapsedSec)) ? Math.max(0, Number(input.elapsedSec)) : null
    if (elapsedSec === null) {
      return
    }

    this.simulationClockAuthority.lastSampleBoundary = {
      elapsedSec,
      callSite: String(input.callSite || 'unknown'),
      startupPhaseTag: String(input.startupPhaseTag || 'non-startup'),
      engineFrame: Number.isFinite(Number(input.engineFrame)) ? Number(input.engineFrame) : Number(this.wetnessFrameCounter || 0),
      atNowMs: Number.isFinite(Number(input.nowMs)) ? Number(input.nowMs) : Number(performance.now() || 0),
    }
  }

  noteSimulationFrameAdvance(dtSec, nowMs = performance.now()) {
    const nextDt = Number.isFinite(Number(dtSec)) ? Math.max(0, Number(dtSec)) : 0
    const nowValue = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Number(performance.now() || 0)

    this.simulationClockAuthority.frameStepCount += 1
    this.simulationClockAuthority.totalAdvancedSec += nextDt
    this.simulationClockAuthority.lastAdvancedDtSec = nextDt
    this.simulationClockAuthority.lastOperation = 'frame-advance'
    this.sampleSimulationClock(nowValue)
  }

  getSimulationClockSnapshot() {
    return {
      schemaVersion: Number(this.simulationClockAuthority.schemaVersion || 1),
      session: {
        runtimeSessionKey: this.simulationClockAuthority.session?.runtimeSessionKey ?? null,
        durationSec: Number(this.simulationClockAuthority.session?.durationSec || 180),
      },
      phase: String(this.simulationClockAuthority.phase || ENGINE_SIMULATION_CLOCK_PHASES.CONSTRUCTED),
      startupPhaseAtLastUpdate: String(this.simulationClockAuthority.startupPhaseAtLastUpdate || ENGINE_SESSION_STARTUP_PHASES.CONSTRUCTED),
      anchorNowMs: Number(this.simulationClockAuthority.anchorNowMs || 0),
      offsetSec: Number(this.simulationClockAuthority.offsetSec || 0),
      lockedSec: Number.isFinite(this.simulationClockAuthority.lockedSec) ? Number(this.simulationClockAuthority.lockedSec) : null,
      currentTimeSec: Number(this.simulationClockAuthority.currentTimeSec || 0),
      loopTimeSec: Number(this.simulationClockAuthority.loopTimeSec || 0),
      frameStepCount: Number(this.simulationClockAuthority.frameStepCount || 0),
      totalAdvancedSec: Number(this.simulationClockAuthority.totalAdvancedSec || 0),
      lastAdvancedDtSec: Number(this.simulationClockAuthority.lastAdvancedDtSec || 0),
      lastOperation: String(this.simulationClockAuthority.lastOperation || 'none'),
      lastSampleBoundary: this.simulationClockAuthority.lastSampleBoundary
        ? { ...this.simulationClockAuthority.lastSampleBoundary }
        : null,
      history: Array.isArray(this.simulationClockAuthority.history)
        ? this.simulationClockAuthority.history.map((entry) => ({ ...entry }))
        : [],
    }
  }

  advanceSessionStartupPhase(nextPhase, reason = 'unspecified', extra = null) {
    const previousPhase = String(this.sessionStartupAuthority.currentPhase || ENGINE_SESSION_STARTUP_PHASES.CONSTRUCTED)
    if (previousPhase === nextPhase) {
      return
    }

    const transition = {
      phase: nextPhase,
      reason: String(reason || 'unspecified'),
      atWetnessFrameCounter: Number(this.wetnessFrameCounter || 0),
      atPerfNowMs: Number(performance.now() || 0),
      ...(extra && typeof extra === 'object' ? extra : {}),
    }

    this.sessionStartupAuthority.currentPhase = nextPhase
    this.sessionStartupAuthority.lastTransition = { ...transition }

    const history = this.sessionStartupAuthority.phaseHistory
    if (Array.isArray(history)) {
      history.push(transition)
      if (history.length > 96) {
        history.shift()
      }
    }

    if (nextPhase === ENGINE_SESSION_STARTUP_PHASES.CANONICAL_BOOTSTRAP_APPLIED) {
      this.sessionStartupAuthority.flags.sawCanonicalBootstrap = true
    } else if (nextPhase === ENGINE_SESSION_STARTUP_PHASES.STARTUP_HOLD) {
      this.sessionStartupAuthority.flags.sawStartupHold = true
    } else if (nextPhase === ENGINE_SESSION_STARTUP_PHASES.FIRST_LIVE_BOUNDARY_REACHED) {
      this.sessionStartupAuthority.flags.sawFirstLiveBoundary = true
    } else if (nextPhase === ENGINE_SESSION_STARTUP_PHASES.STEADY_LIVE) {
      this.sessionStartupAuthority.flags.sawSteadyLive = true
    }

    this.updateSimulationClockPhaseFromStartup()
  }

  updateSessionStartupPhaseFromTuningTrace(stagedApplyTrace = null) {
    const trace = stagedApplyTrace && typeof stagedApplyTrace === 'object' ? stagedApplyTrace : null
    if (!trace) {
      return
    }

    const sampleCallSite = String(trace.sampleCallSite || '')
    const startupPhaseTag = String(trace.startupPhaseTag || '')

    if (startupPhaseTag === 'canonical-bootstrap' || sampleCallSite.startsWith('start:')) {
      this.advanceSessionStartupPhase(ENGINE_SESSION_STARTUP_PHASES.CANONICAL_BOOTSTRAP_APPLIED, sampleCallSite || startupPhaseTag)
      return
    }

    if (
      startupPhaseTag === 'pre-live-hold' ||
      sampleCallSite === 'updateAtmosphere:canonical-zero-handoff' ||
      sampleCallSite === 'updateAtmosphere:startup-frame0-hold'
    ) {
      this.advanceSessionStartupPhase(ENGINE_SESSION_STARTUP_PHASES.STARTUP_HOLD, sampleCallSite || startupPhaseTag)
      return
    }

    if (startupPhaseTag === 'first-live-boundary' || sampleCallSite === 'onStats:startup-first-live-boundary') {
      this.advanceSessionStartupPhase(ENGINE_SESSION_STARTUP_PHASES.FIRST_LIVE_BOUNDARY_REACHED, sampleCallSite || startupPhaseTag)
      return
    }

    if (startupPhaseTag === 'non-startup' || sampleCallSite === 'updateAtmosphere:getPresentationTimeSec') {
      if (this.sessionStartupAuthority.flags.sawFirstLiveBoundary) {
        this.advanceSessionStartupPhase(ENGINE_SESSION_STARTUP_PHASES.STEADY_LIVE, sampleCallSite || startupPhaseTag)
      }
    }
  }

  getSessionStartupAuthoritySnapshot() {
    return {
      schemaVersion: Number(this.sessionStartupAuthority.schemaVersion || 1),
      currentPhase: String(this.sessionStartupAuthority.currentPhase || ENGINE_SESSION_STARTUP_PHASES.CONSTRUCTED),
      session: {
        runtimeSessionKey: this.sessionStartupAuthority.session?.runtimeSessionKey ?? null,
        bootPath: this.sessionStartupAuthority.session?.bootPath ?? 'unknown',
        publishRevision: this.sessionStartupAuthority.session?.publishRevision ?? null,
        restartToken: this.sessionStartupAuthority.session?.restartToken ?? null,
      },
      flags: {
        sawCanonicalBootstrap: Boolean(this.sessionStartupAuthority.flags?.sawCanonicalBootstrap),
        sawStartupHold: Boolean(this.sessionStartupAuthority.flags?.sawStartupHold),
        sawFirstLiveBoundary: Boolean(this.sessionStartupAuthority.flags?.sawFirstLiveBoundary),
        sawSteadyLive: Boolean(this.sessionStartupAuthority.flags?.sawSteadyLive),
      },
      lastTransition: this.sessionStartupAuthority.lastTransition
        ? { ...this.sessionStartupAuthority.lastTransition }
        : null,
      phaseHistory: Array.isArray(this.sessionStartupAuthority.phaseHistory)
        ? this.sessionStartupAuthority.phaseHistory.map((entry) => ({ ...entry }))
        : [],
    }
  }

  buildRuntimeInputEnvelope(input = {}) {
    const payload = input && typeof input === 'object' ? input : {}
    const sample = payload?.sample && typeof payload.sample === 'object' ? payload.sample : {}
    const weather = payload?.weather && typeof payload.weather === 'object' ? payload.weather : null
    const source = String(payload.source || 'unknown')
    const applyBoundary = String(payload.applyBoundary || 'presentation-update-boundary')
    const sequence = Number.isFinite(Number(payload.sequence)) ? Number(payload.sequence) : this.runtimeInputAuthority.enqueuedCount

    return {
      envelopeKind: 'runtime-weather-config-update',
      source,
      phaseTag: String(payload.phaseTag || 'non-startup'),
      sampleCallSite: String(payload.sampleCallSite || ''),
      applyBoundary,
      sequence,
      runtimeSessionKey: payload.runtimeSessionKey != null ? String(payload.runtimeSessionKey) : null,
      sample: {
        rawElapsedSec: Number.isFinite(Number(sample.rawElapsedSec)) ? Number(sample.rawElapsedSec) : null,
        sampleSec: Number.isFinite(Number(sample.sampleSec)) ? Number(sample.sampleSec) : null,
      },
      weather: weather
        ? {
          wind: Number(weather.wind || 0),
          rain: Number(weather.rain || 0),
          mist: Number(weather.mist || 0),
          washdown: Number(weather.washdown || 0),
          fogBuildup: Number(weather.fogBuildup || 0),
          fogClearing: Number(weather.fogClearing || 0),
        }
        : null,
      derivedConfig: payload.derivedConfig && typeof payload.derivedConfig === 'object'
        ? deepClone(payload.derivedConfig)
        : null,
      linkedConfig: payload.linkedConfig && typeof payload.linkedConfig === 'object'
        ? deepClone(payload.linkedConfig)
        : null,
      tuningApplyTrace: payload.tuningApplyTrace && typeof payload.tuningApplyTrace === 'object'
        ? { ...payload.tuningApplyTrace }
        : null,
      enqueueNowMs: Number(performance.now() || 0),
      consumedNowMs: null,
      consumedBoundary: null,
    }
  }

  enqueueRuntimeInputEnvelope(input = {}) {
    const envelope = this.buildRuntimeInputEnvelope(input)
    this.runtimeInputQueue.push(envelope)
    this.runtimeInputAuthority.enqueuedCount += 1
    this.runtimeInputAuthority.lastEnqueuedEnvelope = {
      sequence: envelope.sequence,
      source: envelope.source,
      applyBoundary: envelope.applyBoundary,
      phaseTag: envelope.phaseTag,
      sampleSec: envelope.sample?.sampleSec ?? null,
      runtimeSessionKey: envelope.runtimeSessionKey,
      enqueueNowMs: envelope.enqueueNowMs,
    }
    return envelope
  }

  consumeRuntimeInputQueueAtBoundary(boundary = 'presentation-update-boundary') {
    const boundaryTag = String(boundary || 'presentation-update-boundary')
    if (!Array.isArray(this.runtimeInputQueue) || this.runtimeInputQueue.length === 0) {
      return null
    }

    const index = this.runtimeInputQueue.findIndex((envelope) => {
      const applyBoundary = String(envelope?.applyBoundary || '')
      return applyBoundary === boundaryTag || applyBoundary === 'any'
    })

    if (index < 0) {
      return null
    }

    const [envelope] = this.runtimeInputQueue.splice(index, 1)
    if (!envelope) {
      return null
    }

    if (envelope.tuningApplyTrace) {
      this.stageTuningApplyTrace(envelope.tuningApplyTrace)
    }
    if (envelope.linkedConfig) {
      this.setTuningConfig(envelope.linkedConfig)
    }

    envelope.consumedNowMs = Number(performance.now() || 0)
    envelope.consumedBoundary = boundaryTag
    this.runtimeInputAuthority.consumedCount += 1
    this.runtimeInputAuthority.lastConsumedEnvelope = {
      sequence: envelope.sequence,
      source: envelope.source,
      applyBoundary: envelope.applyBoundary,
      phaseTag: envelope.phaseTag,
      sampleSec: envelope.sample?.sampleSec ?? null,
      runtimeSessionKey: envelope.runtimeSessionKey,
      consumedBoundary: boundaryTag,
      consumedNowMs: envelope.consumedNowMs,
    }

    this.runtimeInputAuthority.recentConsumedEnvelopes.push({
      sequence: envelope.sequence,
      source: envelope.source,
      phaseTag: envelope.phaseTag,
      sampleSec: envelope.sample?.sampleSec ?? null,
      consumedBoundary: boundaryTag,
      consumedNowMs: envelope.consumedNowMs,
    })
    if (this.runtimeInputAuthority.recentConsumedEnvelopes.length > 32) {
      this.runtimeInputAuthority.recentConsumedEnvelopes.shift()
    }

    return envelope
  }

  getRuntimeInputAuthoritySnapshot() {
    return {
      schemaVersion: Number(this.runtimeInputAuthority.schemaVersion || 1),
      queueDepth: Array.isArray(this.runtimeInputQueue) ? this.runtimeInputQueue.length : 0,
      enqueuedCount: Number(this.runtimeInputAuthority.enqueuedCount || 0),
      consumedCount: Number(this.runtimeInputAuthority.consumedCount || 0),
      lastEnqueuedEnvelope: this.runtimeInputAuthority.lastEnqueuedEnvelope
        ? { ...this.runtimeInputAuthority.lastEnqueuedEnvelope }
        : null,
      lastConsumedEnvelope: this.runtimeInputAuthority.lastConsumedEnvelope
        ? { ...this.runtimeInputAuthority.lastConsumedEnvelope }
        : null,
      recentConsumedEnvelopes: Array.isArray(this.runtimeInputAuthority.recentConsumedEnvelopes)
        ? this.runtimeInputAuthority.recentConsumedEnvelopes.map((entry) => ({ ...entry }))
        : [],
      pendingEnvelopeHeaders: Array.isArray(this.runtimeInputQueue)
        ? this.runtimeInputQueue.map((envelope) => ({
          sequence: envelope.sequence,
          source: envelope.source,
          applyBoundary: envelope.applyBoundary,
          phaseTag: envelope.phaseTag,
          sampleSec: envelope.sample?.sampleSec ?? null,
        }))
        : [],
    }
  }

  resolveCanonicalPreStartBootstrap(options = {}) {
    const schedulerRuntime = options?.schedulerRuntime || null
    const basePreset = options?.basePreset || null
    const timelineDurationSec = Number.isFinite(Number(options?.timelineDurationSec))
      ? Number(options.timelineDurationSec)
      : 180

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
      snapAtZero: null,
      preStartSnap: null,
    }

    if (!schedulerRuntime || !basePreset) {
      return empty
    }

    const durationSec = Math.max(0.001, schedulerRuntime.durationSec || timelineDurationSec || 180)
    const snapAtZero = schedulerRuntime.sample({ elapsedSec: 0, fps: 60 })
    const rainAtZero = snapAtZero?.weather?.rain || 0

    let firstRainWindowSec = null
    let rainContributionFound = false
    let scanSteps = 0

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

    const result = {
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

    this.bootstrapInfo.canonicalPreStartBootstrap = {
      firstRainWindowSec: Number.isFinite(firstRainWindowSec) ? Number(firstRainWindowSec) : null,
      rainContributionFound: Boolean(rainContributionFound),
      preStartSec: Number(preStartSec || 0),
      rainAtZero: Number(rainAtZero || 0),
      rainAtWindow: Number(rainAtWindow || 0),
      dropletsPerSeconds: Number(dropletsPerSeconds || 0),
      scanSteps: Number(scanSteps || 0),
      computedAtWetnessFrameCounter: Number(this.wetnessFrameCounter || 0),
      startupPhase: String(this.sessionStartupAuthority.currentPhase || ''),
    }

    return result
  }

  resolveSetTuningOriginBucket(stagedApplyTrace) {
    const source = stagedApplyTrace && typeof stagedApplyTrace === 'object' ? stagedApplyTrace : {}
    const sampleCallSite = String(source?.sampleCallSite || '')
    const startupPhaseTag = String(source?.startupPhaseTag || '')

    if (sampleCallSite.startsWith('start:') || startupPhaseTag === 'canonical-bootstrap') {
      return 'canonical-bootstrap'
    }
    if (sampleCallSite === 'updateAtmosphere:startup-frame-sync' || startupPhaseTag === 'startup-frame-sync') {
      return 'startup-frame-sync'
    }
    if (
      sampleCallSite === 'updateAtmosphere:canonical-zero-handoff' ||
      sampleCallSite === 'updateAtmosphere:startup-frame0-hold' ||
      startupPhaseTag === 'pre-live-hold'
    ) {
      return 'pre-live-hold'
    }
    if (sampleCallSite === 'onStats:startup-first-live-boundary' || startupPhaseTag === 'first-live-boundary') {
      return 'first-live-boundary'
    }
    if (sampleCallSite === 'engine:bootstrap-seed' || startupPhaseTag === 'engine-seed') {
      return 'engine-seed'
    }
    if (sampleCallSite === 'engine:bootstrap-reapply' || startupPhaseTag === 'bootstrap-reapply') {
      return 'bootstrap-reapply'
    }

    return sampleCallSite ? `other:${sampleCallSite}` : 'other:unstaged'
  }

  recordSetTuningLineageTrace(stagedApplyTrace, details = {}) {
    const trace = this.bootstrapInfo?.setTuningLineageTrace
    if (!Array.isArray(trace) || trace.length >= 96) {
      return
    }

    const source = stagedApplyTrace && typeof stagedApplyTrace === 'object' ? stagedApplyTrace : {}
    const callSite = String(source?.sampleCallSite || details?.callerPath || 'engine:setTuningConfig:unstaged')
    const startupPhaseTag = String(source?.startupPhaseTag || 'non-startup')
    const originBucket = this.resolveSetTuningOriginBucket(stagedApplyTrace)

    trace.push({
      startupPhaseTag,
      startupInvocationSource: String(source?.startupInvocationSource || source?.updateInvocationSource || ''),
      sampleCallSite: callSite,
      callerPath: callSite,
      callOriginBucket: originBucket,
      startupSequenceIndex: Number.isFinite(Number(source?.startupSequenceIndex))
        ? Number(source.startupSequenceIndex)
        : Number(this.integrationCounters?.setTuningConfigCalls || 0) - 1,
      setTuningConfigCallIndex: Number(this.integrationCounters?.setTuningConfigCalls || 0),
      throughApplyLiveSettings: Boolean(details?.throughApplyLiveSettings),
      directWithoutApplyLiveSettings: !Boolean(details?.throughApplyLiveSettings),
      engineFrame: Number(source?.startupEngineFrame ?? this.wetnessFrameCounter ?? 0),
      wetnessFrameCounter: Number(source?.startupWetnessFrameCounter ?? this.timing?.wetnessFrameCounter ?? this.wetnessFrameCounter ?? 0),
      packetId: Number(source?.startupPacketId ?? this.timing?.runnerCarveDiagnosticsPacketId ?? -1),
      rawElapsedSec: Number.isFinite(Number(source?.rawElapsedSec)) ? Number(source.rawElapsedSec) : null,
      normalizedSampleSec: Number.isFinite(Number(source?.normalizedSampleSec)) ? Number(source.normalizedSampleSec) : null,
      sampledRainIntensityBeforeDerive: Number.isFinite(Number(source?.sampledRainIntensityBeforeDerive))
        ? Number(source.sampledRainIntensityBeforeDerive)
        : null,
      derivedRainIntensity: Number.isFinite(Number(source?.derivedRainIntensity)) ? Number(source.derivedRainIntensity) : null,
      derivedDropletsPerSeconds: Number.isFinite(Number(source?.derivedDropletsPerSeconds))
        ? Number(source.derivedDropletsPerSeconds)
        : null,
      rainTrackInputs: Array.isArray(source?.rainTrackInputs)
        ? source.rainTrackInputs.map((input) => ({
          trackKey: String(input?.trackKey || ''),
          contribution: Number(input?.contribution || 0),
          envelopeValue: Number(input?.envelopeValue || 0),
          interpolationT: Number(input?.interpolationT || 0),
          previousPointTimeSec: Number(input?.previousPointTimeSec || 0),
          previousPointValue: Number(input?.previousPointValue || 0),
          nextPointTimeSec: Number(input?.nextPointTimeSec || 0),
          nextPointValue: Number(input?.nextPointValue || 0),
          sourceClipIds: Array.isArray(input?.sourceClipIds) ? [...input.sourceClipIds] : [],
        }))
        : [],
      setTuningConfigCalls: Number(this.integrationCounters?.setTuningConfigCalls || 0),
      applyLiveSettingsCalls: Number(this.integrationCounters?.applyLiveSettingsCalls || 0),
    })
  }

  setTuningConfig(nextConfig) {
    const stagedApplyTrace = this.pendingTuningApplyTrace && typeof this.pendingTuningApplyTrace === 'object'
      ? { ...this.pendingTuningApplyTrace }
      : null
    this.pendingTuningApplyTrace = null

    this.integrationCounters.setTuningConfigCalls += 1
    const merged = mergeDeep(DEFAULT_TUNING_CONFIG, nextConfig || {})
    const signature = JSON.stringify(merged)
    const shouldApplyLiveSettings = signature !== this.tuningSignature

    this.recordSetTuningLineageTrace(stagedApplyTrace, {
      throughApplyLiveSettings: shouldApplyLiveSettings,
      callerPath: stagedApplyTrace?.sampleCallSite || 'engine:setTuningConfig:unstaged',
    })

    if (signature === this.tuningSignature) {
      return
    }

    this.tuningSignature = signature
    this.tuningConfig = merged
    
    // Bootstrap tracking: on first weather application
    if (!this.bootstrapInfo.initialWeatherApplied) {
      this.bootstrapInfo.initialWeatherApplied = true
      const rainIntensity = this.tuningConfig?.renderer?.rainIntensity || 0
      const fogValue = this.tuningConfig?.fogSurface?.baseFogLevel || 0
      if (rainIntensity > 0.001) {
        this.bootstrapInfo.initialRainApplied = true
      }
      if (fogValue > 0.001) {
        this.bootstrapInfo.initialFogApplied = true
      }
    }
    
    this.applyLiveSettings(stagedApplyTrace)
    this.recordWetnessLifecycleTrace('setTuningConfig-applied', {
      sampledRainIntensity: Number(this.tuningConfig?.debug?.runtimeSampledRainIntensity || 0),
      dropletsPerSeconds: Number(this.tuningConfig?.renderer?.dropletsPerSeconds || 0),
      ...(stagedApplyTrace || {}),
    })
  }

  getTuningConfig() {
    return deepClone(this.tuningConfig)
  }

  applyLiveSettings(stagedApplyTrace = null) {
    this.integrationCounters.applyLiveSettingsCalls += 1
    const wetness = this.tuningConfig.surfaceWetness
    this.surfaceWetnessField.applySettings({
      initialWetness: wetness.initialWetness,
      maxWetness: wetness.maxWetness,
      refillRate: wetness.refillRate,
      recoveryRate: wetness.recoveryRate,
      diffusionRate: wetness.diffusionRate,
      trailRecoveryRate: wetness.trailRecoveryRate,
      runnerMemoryRecoveryRate: wetness.runnerMemoryRecoveryRate,
    })

    if (this.raindropRenderer) {
      this.raindropRenderer.setTuningConfig(this.tuningConfig)
    }

    this.applyFreezeStateIfNeeded()

    const nextFogScale = clamp(this.tuningConfig.fogSurface.fogScale, 0.2, 1)
    const fogScaleChanged = Math.abs(nextFogScale - this.lastAppliedFogScale) > 0.0001
    this.lastAppliedFogScale = nextFogScale
    if (fogScaleChanged && this.width && this.height) {
      // Avoid full resize work unless fog resolution actually changed.
      this.resize()
    }

    this.recordWetnessLifecycleTrace('applyLiveSettings', {
      initialWetnessSetting: Number(wetness.initialWetness || 0),
      maxWetnessSetting: Number(wetness.maxWetness || 0),
      ...(stagedApplyTrace && typeof stagedApplyTrace === 'object' ? stagedApplyTrace : {}),
    })
  }

  applyFreezeStateIfNeeded() {
    const shouldFreezeBackground = this.tuningConfig.debug.freezeBackground
    if (!shouldFreezeBackground) {
      this.backgroundFrozen = false
      return
    }

    if (!this.backgroundFrozen) {
      this.captureBackgroundFrame()
      this.backgroundFrozen = true
    }
  }

  start() {
    // Idempotent runtime startup sequence: attach renderer, re-apply current tuning,
    // then enter animation loop so publish-restart and manual refresh converge.
    this.running = true
    this.advanceSessionStartupPhase(ENGINE_SESSION_STARTUP_PHASES.BOOTSTRAP_READY, 'engine-start-invoked')
    this.updateSimulationClockPhaseFromStartup()
    this.resize()
    this.recordWetnessLifecycleTrace('start-after-resize')

    if (this.resizeMode === 'element' && typeof ResizeObserver === 'function') {
      const resizeTarget = this.viewportElement || this.canvas.parentElement || this.canvas
      this.resizeObserver = new ResizeObserver(() => {
        this.resize()
      })
      this.resizeObserver.observe(resizeTarget)
    } else {
      window.addEventListener('resize', this.resize)
    }
    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    this.canvas.addEventListener('pointermove', this.onPointerMove)
    this.canvas.addEventListener('pointerup', this.onPointerUp)
    this.canvas.addEventListener('pointerleave', this.onPointerUp)
    this.canvas.addEventListener('pointercancel', this.onPointerUp)

    const beginAnimationLoop = () => {
      if (!this.running || this.animationFrame) {
        return
      }
      const seedNowMs = performance.now()
      this.lastTime = seedNowMs
      this.sampleSimulationClock(seedNowMs)
      this.recordWetnessLifecycleTrace('animation-loop-seeded', {
        seedNowMs: Number(seedNowMs || 0),
      })
      this.animationFrame = requestAnimationFrame(this.animate)
    }

    const attachBeforeFirstTick = async () => {
      await this.initializeRaindropRenderer()
      // Guard: if a renderer exists but did not attach, retry immediately.
      if (this.raindropRenderer && !this.raindropRendererReady) {
        await this.initializeRaindropRenderer()
      }
      // Rehydration guard: re-apply current tuning config after async init.
      // Handles publish-restart case where weather config (applied via setTuningConfig
      // while the renderer was initializing) must be reflected in the live renderer.
      if (this.raindropRendererReady && this.raindropRenderer) {
        this.raindropRenderer.setTuningConfig(this.tuningConfig)
      }
    }

    attachBeforeFirstTick().finally(() => {
      beginAnimationLoop()
    })
  }

  stop() {
    this.running = false
    this.advanceSessionStartupPhase(ENGINE_SESSION_STARTUP_PHASES.STOPPED, 'engine-stop-invoked')
    this.updateSimulationClockPhaseFromStartup()

    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame)
      this.animationFrame = null
    }

    if (this.resizeObserver) {
      this.resizeObserver.disconnect()
      this.resizeObserver = null
    }
    window.removeEventListener('resize', this.resize)
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.canvas.removeEventListener('pointerleave', this.onPointerUp)
    this.canvas.removeEventListener('pointercancel', this.onPointerUp)

    if (this.raindropRenderer) {
      this.raindropRenderer.destroy()
      this.raindropRenderer = null
      this.raindropRendererReady = false
    }

    this.gpuOverlay = null
    this.disposeGpuWetnessSimulationRuntime()
  }

  setPhase(nextPhase) {
    this.phase = nextPhase
  }

  async initializeRaindropRenderer() {
    if (this.rendererAttachInFlight) {
      return
    }
    this.rendererAttachInFlight = true

    if (this.raindropRenderer) {
      this.raindropRenderer.destroy()
      this.raindropRenderer = null
      this.raindropRendererReady = false
    }

    const adapter = new RaindropFxRendererAdapter({
      width: this.width || 1,
      height: this.height || 1,
      background: this.backgroundSrc,
      tuningConfig: this.tuningConfig,
    })

    this.raindropRenderer = adapter
    this.bootstrapInfo.rendererCreated = true
    if (this._isDevEnv) {
      console.info('[MistyOS][Engine][bootstrap-seq]', {
        step: 'renderer-attach-begin',
        publishRestartPath: this.bootstrapInfo.publishRestartPath,
        refreshPath: this.bootstrapInfo.refreshPath,
        dropletsPerSeconds: Number(this.tuningConfig?.renderer?.dropletsPerSeconds || 0),
      })
    }

    try {
      await adapter.init()
      if (this.raindropRenderer !== adapter) {
        adapter.destroy()
        return
      }
      this.bootstrapInfo.rendererAttached = true
      this.raindropRendererReady = true
      await adapter.setBackground(this.backgroundSrc)
      const scaleX = this.width / this.fogCanvas.width
      const scaleY = this.height / this.fogCanvas.height
      adapter.setInputScale(scaleX, scaleY)
      adapter.setTuningConfig(this.tuningConfig)
      this.bootstrapInfo.adapterInitDropletsPerSeconds = adapter.debug?.proceduralDropletsPerSecond ?? this.tuningConfig?.renderer?.dropletsPerSeconds ?? 0
      if (this._isDevEnv) {
        console.info('[MistyOS][Engine][bootstrap-seq]', {
          step: 'renderer-attached',
          publishRestartPath: this.bootstrapInfo.publishRestartPath,
          refreshPath: this.bootstrapInfo.refreshPath,
          dropletsPerSeconds: Number(this.bootstrapInfo.adapterInitDropletsPerSeconds || 0),
        })
      }
    } catch {
      if (this.raindropRenderer === adapter) {
        this.raindropRendererReady = false
      }
    } finally {
      this.rendererAttachInFlight = false
    }
  }

  resize() {
    const dpr = window.devicePixelRatio || 1
    const resizeTarget = this.viewportElement || this.canvas.parentElement || this.canvas
    const targetRect = this.resizeMode === 'element' && resizeTarget?.getBoundingClientRect
      ? resizeTarget.getBoundingClientRect()
      : null
    const width = Math.max(1, Math.floor(
      this.resizeMode === 'element'
        ? (targetRect?.width || resizeTarget?.clientWidth || this.canvas.clientWidth || window.innerWidth)
        : window.innerWidth,
    ))
    const height = Math.max(1, Math.floor(
      this.resizeMode === 'element'
        ? (targetRect?.height || resizeTarget?.clientHeight || this.canvas.clientHeight || window.innerHeight)
        : window.innerHeight,
    ))

    this.width = width
    this.height = height

    this.canvas.width = Math.floor(width * dpr)
    this.canvas.height = Math.floor(height * dpr)
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`

    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // Fog simulation resolution is now driven by live tuning controls.
    const fogScale = clamp(this.tuningConfig.fogSurface.fogScale, 0.2, 1)
    this.lastAppliedFogScale = fogScale
    this.fogCanvas.width = Math.max(1, Math.floor(width * fogScale))
    this.fogCanvas.height = Math.max(1, Math.floor(height * fogScale))

    this.fogCtx.setTransform(1, 0, 0, 1, 0, 0)
    this.surfaceWetnessField.resize(this.fogCanvas.width, this.fogCanvas.height)
    this.fogImageData = this.fogCtx.createImageData(this.fogCanvas.width, this.fogCanvas.height)
    this.syncFogCanvasFromWetnessField()
    this.recordWetnessLifecycleTrace('resize-surface-reset', {
      fogCanvasWidth: Number(this.fogCanvas.width || 0),
      fogCanvasHeight: Number(this.fogCanvas.height || 0),
    })

    this.backgroundFreezeCanvas.width = this.width
    this.backgroundFreezeCanvas.height = this.height
    if (this.tuningConfig.debug.freezeBackground) {
      this.captureBackgroundFrame()
      this.backgroundFrozen = true
    } else {
      this.backgroundFrozen = false
    }

    this.raindropRenderer?.resize(this.width, this.height)
    if (this.raindropRenderer) {
      const scaleX = this.width / this.fogCanvas.width
      const scaleY = this.height / this.fogCanvas.height
      this.raindropRenderer.setInputScale(scaleX, scaleY)
    }
  }

  onPointerDown(event) {
    if (this.phase < 3) {
      return
    }

    this.pointerActive = true
    this.isWriting = true
    this.lastPointer = this.toFogSpace(event.clientX, event.clientY)
    this.applyFingerWipe(this.lastPointer, this.lastPointer)
  }

  onPointerMove(event) {
    if (!this.pointerActive || this.phase < 3) {
      return
    }

    const next = this.toFogSpace(event.clientX, event.clientY)

    if (!this.lastPointer) {
      this.lastPointer = next
      return
    }

    this.applyFingerWipe(this.lastPointer, next)
    this.lastPointer = next
  }

  onPointerUp() {
    this.pointerActive = false
    this.lastPointer = null
    this.isWriting = false
  }

  toFogSpace(x, y) {
    return {
      x: (x / this.width) * this.fogCanvas.width,
      y: (y / this.height) * this.fogCanvas.height,
    }
  }

  resetRunnerCarveTiming() {
    this.timing.runnerCarveSamples = 0
    this.timing.runnerCarveSegmentSamples = 0
    this.timing.runnerCarvePointSamples = 0
    this.timing.runnerCarveDistanceMean = 0
    this.timing.runnerCarveDistanceMax = 0
    this.timing.runnerCarveLastMode = 'none'
    this.timing.runnerCarveInterpolationActive = false
    this.timing.runnerCarveInterpolationProximityMatches = 0
    this.timing.runnerCarveLastPreviousMatchSource = 'none'
    this.timing.runnerCarveLastDistance = 0
    this.timing.runnerCarveLastSegmentLength = 0
    this.timing.runnerCarveLastRadius = 0
    this.timing.runnerCarveLastStrength = 0
    this.timing.runnerCarveLastPrevX = 0
    this.timing.runnerCarveLastPrevY = 0
    this.timing.runnerCarveLastCurrX = 0
    this.timing.runnerCarveLastCurrY = 0
    this.timing.runnerCarveSpacingRatioMean = 0
    this.timing.runnerCarveSpacingRatioMax = 0
    this.timing.runnerCarveGapFraction = 0
    this.timing.runnerCarveDepthGainMean = 0
    this.timing.runnerCarvePostSmoothRetentionMean = 0
    this.timing.runnerCarveRecoveryRatioMean = 0
    this.timing.runnerCarveRecoveryLossMean = 0
    this.timing.runnerCarveFogAlphaMean = 0
    this.timing.runnerCarveFogResponseRatioMean = 0
    this.timing.runnerCarveFogDecayRatioMean = 0
    this.timing.runnerCarveLastSpacingRatio = 0
    this.timing.runnerCarveLastBeforeDepth = 0
    this.timing.runnerCarveLastAfterDepth = 0
    this.timing.runnerCarveLastPostSmoothDepth = 0
    this.timing.runnerCarveLastRecoveredDepth = 0
    this.timing.runnerCarveLastFogAlpha = 0
    this.timing.runnerCarveLastRecoveredFogAlpha = 0
    this.runnerCarveCurrentFrameProbes = []
    this.runnerCarvePendingRecoveryProbes = []
  }

  smoothTimingMetric(name, value) {
    const next = Number.isFinite(value) ? value : 0
    const previous = Number.isFinite(this.timing[name]) ? this.timing[name] : 0
    this.timing[name] = previous > 0 ? previous * 0.85 + next * 0.15 : next
  }

  sampleRunnerCarveDepthAt(x, y) {
    const { width, height, grid, trailGrid, runnerMemoryGrid } = this.surfaceWetnessField
    if (!width || !height) {
      return 0
    }

    const clampedX = clamp(x, 0, width - 1)
    const clampedY = clamp(y, 0, height - 1)
    const x0 = Math.floor(clampedX)
    const y0 = Math.floor(clampedY)
    const x1 = Math.min(width - 1, x0 + 1)
    const y1 = Math.min(height - 1, y0 + 1)
    const tx = clampedX - x0
    const ty = clampedY - y0

    const sampleAt = (sampleX, sampleY) => {
      const idx = sampleY * width + sampleX
      return -(trailGrid[idx] + runnerMemoryGrid[idx] * 1.02 + grid[idx] * 0.24)
    }

    const top = sampleAt(x0, y0) * (1 - tx) + sampleAt(x1, y0) * tx
    const bottom = sampleAt(x0, y1) * (1 - tx) + sampleAt(x1, y1) * tx
    return Math.max(0, top * (1 - ty) + bottom * ty)
  }

  createRunnerCarveProbe({ previous, current, radius, strength, mode }) {
    const distance = Math.hypot(current.x - previous.x, current.y - previous.y)
    const sampleCount = mode === 'segment'
      ? Math.max(2, Math.min(6, Math.ceil(distance / Math.max(radius * 0.9, 1))))
      : 1
    const points = []

    for (let index = 0; index < sampleCount; index += 1) {
      const t = sampleCount === 1 ? 0 : index / (sampleCount - 1)
      points.push({
        x: previous.x + (current.x - previous.x) * t,
        y: previous.y + (current.y - previous.y) * t,
      })
    }

    return {
      mode,
      previous,
      current,
      radius,
      strength,
      distance,
      points,
    }
  }

  sampleRunnerCarveProbeDepth(probe) {
    if (!probe?.points?.length) {
      return 0
    }

    let depthSum = 0
    for (let index = 0; index < probe.points.length; index += 1) {
      const point = probe.points[index]
      depthSum += this.sampleRunnerCarveDepthAt(point.x, point.y)
    }
    return depthSum / probe.points.length
  }

  sampleFogAlphaAt(x, y) {
    const imageData = this.fogImageData
    const width = this.fogCanvas?.width || 0
    const height = this.fogCanvas?.height || 0
    if (!imageData?.data || width <= 0 || height <= 0) {
      return 0
    }

    const clampedX = clamp(x, 0, width - 1)
    const clampedY = clamp(y, 0, height - 1)
    const x0 = Math.floor(clampedX)
    const y0 = Math.floor(clampedY)
    const x1 = Math.min(width - 1, x0 + 1)
    const y1 = Math.min(height - 1, y0 + 1)
    const tx = clampedX - x0
    const ty = clampedY - y0
    const data = imageData.data

    const alphaAt = (sx, sy) => {
      const idx = (sy * width + sx) * 4 + 3
      return (data[idx] || 0) / 255
    }

    const top = alphaAt(x0, y0) * (1 - tx) + alphaAt(x1, y0) * tx
    const bottom = alphaAt(x0, y1) * (1 - tx) + alphaAt(x1, y1) * tx
    return clamp(top * (1 - ty) + bottom * ty, 0, 1)
  }

  sampleRunnerCarveProbeFogAlpha(probe) {
    if (!probe?.points?.length) {
      return 0
    }

    let alphaSum = 0
    for (let index = 0; index < probe.points.length; index += 1) {
      const point = probe.points[index]
      alphaSum += this.sampleFogAlphaAt(point.x, point.y)
    }
    return alphaSum / probe.points.length
  }

  finalizeRunnerCarvePostSmooth() {
    const probes = this.runnerCarveCurrentFrameProbes || []
    if (!probes.length) {
      this.runnerCarvePendingRecoveryProbes = []
      return
    }

    let retentionSum = 0
    let retentionCount = 0
    let lastPostSmoothDepth = 0
    const recoveryProbes = []

    for (let index = 0; index < probes.length; index += 1) {
      const probe = probes[index]
      const postSmoothDepth = this.sampleRunnerCarveProbeDepth(probe)
      const baselineDepth = probe.depthAfterDeposit || 0

      if (baselineDepth > 0.0001) {
        retentionSum += clamp(postSmoothDepth / baselineDepth, 0, 2.5)
        retentionCount += 1
      }

      lastPostSmoothDepth = postSmoothDepth
      recoveryProbes.push({
        ...probe,
        postSmoothDepth,
      })
    }

    if (retentionCount > 0) {
      this.smoothTimingMetric('runnerCarvePostSmoothRetentionMean', retentionSum / retentionCount)
      this.timing.runnerCarveLastPostSmoothDepth = lastPostSmoothDepth
    }

    this.runnerCarvePendingRecoveryProbes = recoveryProbes
    this.runnerCarveCurrentFrameProbes = []
  }

  finalizeRunnerCarveRecovery() {
    const probes = this.runnerCarvePendingRecoveryProbes || []
    if (!probes.length) {
      return
    }

    let recoveryRatioSum = 0
    let recoveryLossSum = 0
    let fogDecayRatioSum = 0
    let fogDecayCount = 0
    let recoveryCount = 0
    let lastRecoveredDepth = 0
    let lastRecoveredFogAlpha = 0

    for (let index = 0; index < probes.length; index += 1) {
      const probe = probes[index]
      const recoveredDepth = this.sampleRunnerCarveProbeDepth(probe)
      const recoveredFogAlpha = this.sampleRunnerCarveProbeFogAlpha(probe)
      const baselineDepth = probe.postSmoothDepth || probe.depthAfterDeposit || 0
      const baselineFogAlpha = probe.fogAlphaAfterSync || 0

      if (baselineDepth > 0.0001) {
        const recoveryRatio = clamp(recoveredDepth / baselineDepth, 0, 2.5)
        recoveryRatioSum += recoveryRatio
        recoveryLossSum += Math.max(0, 1 - recoveryRatio)
        recoveryCount += 1
      }

      if (baselineFogAlpha > 0.0001) {
        fogDecayRatioSum += clamp(recoveredFogAlpha / baselineFogAlpha, 0, 2.5)
        fogDecayCount += 1
      }

      lastRecoveredDepth = recoveredDepth
      lastRecoveredFogAlpha = recoveredFogAlpha
    }

    if (recoveryCount > 0) {
      this.smoothTimingMetric('runnerCarveRecoveryRatioMean', recoveryRatioSum / recoveryCount)
      this.smoothTimingMetric('runnerCarveRecoveryLossMean', recoveryLossSum / recoveryCount)
      if (fogDecayCount > 0) {
        this.smoothTimingMetric('runnerCarveFogDecayRatioMean', fogDecayRatioSum / fogDecayCount)
      }
      this.timing.runnerCarveLastRecoveredDepth = lastRecoveredDepth
      this.timing.runnerCarveLastRecoveredFogAlpha = lastRecoveredFogAlpha
    }

    this.runnerCarvePendingRecoveryProbes = []
  }

  finalizeRunnerCarveFogCoupling() {
    const probes = this.runnerCarvePendingRecoveryProbes || []
    if (!probes.length || !this.fogImageData?.data) {
      return
    }

    let fogAlphaSum = 0
    let responseRatioSum = 0
    let responseCount = 0
    let lastFogAlpha = 0

    for (let index = 0; index < probes.length; index += 1) {
      const probe = probes[index]
      const fogAlpha = this.sampleRunnerCarveProbeFogAlpha(probe)
      const baselineDepth = probe.postSmoothDepth || probe.depthAfterDeposit || 0

      probe.fogAlphaAfterSync = fogAlpha
      fogAlphaSum += fogAlpha
      lastFogAlpha = fogAlpha

      if (baselineDepth > 0.0001) {
        responseRatioSum += clamp(fogAlpha / baselineDepth, 0, 4)
        responseCount += 1
      }
    }

    if (responseCount > 0) {
      this.smoothTimingMetric('runnerCarveFogAlphaMean', fogAlphaSum / probes.length)
      this.smoothTimingMetric('runnerCarveFogResponseRatioMean', responseRatioSum / responseCount)
      this.timing.runnerCarveLastFogAlpha = lastFogAlpha
    }
  }

  flushRunnerCarveDiagnostics(frameStats) {
    const sampleCount = frameStats.sampleCount || 0
    this.timing.runnerCarveSamples = sampleCount
    this.timing.runnerCarveSegmentSamples = frameStats.segmentCount || 0
    this.timing.runnerCarvePointSamples = frameStats.pointCount || 0
    this.timing.runnerCarveDistanceMean = sampleCount > 0 ? (frameStats.distanceSum || 0) / sampleCount : 0
    this.timing.runnerCarveDistanceMax = frameStats.distanceMax || 0
    const segmentCount = frameStats.segmentCount || 0
    this.timing.runnerCarveSpacingRatioMean = segmentCount > 0 ? (frameStats.spacingRatioSum || 0) / segmentCount : 0
    this.timing.runnerCarveSpacingRatioMax = frameStats.spacingRatioMax || 0
    this.timing.runnerCarveGapFraction = segmentCount > 0 ? (frameStats.gapCount || 0) / segmentCount : 0
    this.timing.runnerCarveDepthGainMean = sampleCount > 0 ? (frameStats.depthGainSum || 0) / sampleCount : 0

    const last = frameStats.lastSample || null
    if (!last) {
      this.timing.runnerCarveLastMode = 'none'
      this.timing.runnerCarveLastDistance = 0
      this.timing.runnerCarveLastRadius = 0
      this.timing.runnerCarveLastStrength = 0
      this.timing.runnerCarveLastPrevX = 0
      this.timing.runnerCarveLastPrevY = 0
      this.timing.runnerCarveLastCurrX = 0
      this.timing.runnerCarveLastCurrY = 0
      this.timing.runnerCarveLastSpacingRatio = 0
      this.timing.runnerCarveLastBeforeDepth = 0
      this.timing.runnerCarveLastAfterDepth = 0
      return
    }

    this.timing.runnerCarveLastMode = last.mode
    this.timing.runnerCarveInterpolationActive = last.mode === 'segment'
    this.timing.runnerCarveInterpolationProximityMatches = frameStats.proximityMatchCount || 0
    this.timing.runnerCarveLastPreviousMatchSource = last.previousMatchSource || 'none'
    this.timing.runnerCarveLastDistance = last.distance
    this.timing.runnerCarveLastSegmentLength = last.distance
    this.timing.runnerCarveLastRadius = last.radius
    this.timing.runnerCarveLastStrength = last.strength
    this.timing.runnerCarveLastPrevX = last.previous.x
    this.timing.runnerCarveLastPrevY = last.previous.y
    this.timing.runnerCarveLastCurrX = last.current.x
    this.timing.runnerCarveLastCurrY = last.current.y
    this.timing.runnerCarveLastSpacingRatio = last.spacingRatio || 0
    this.timing.runnerCarveLastBeforeDepth = last.beforeDepth || 0
    this.timing.runnerCarveLastAfterDepth = last.afterDepth || 0

    if (!this.runnerCarveDiagnosticsEnabled || sampleCount === 0) {
      return
    }

    const now = performance.now()
    if (now - this.runnerCarveDiagnosticsLastLogMs < 420) {
      return
    }

    this.runnerCarveDiagnosticsLastLogMs = now
    console.info('[MistyOS][RunnerCarveDiag]', {
      samples: sampleCount,
      segmentSamples: frameStats.segmentCount || 0,
      pointSamples: frameStats.pointCount || 0,
      distanceMean: this.timing.runnerCarveDistanceMean,
      distanceMax: frameStats.distanceMax || 0,
      spacingRatioMean: this.timing.runnerCarveSpacingRatioMean,
      spacingRatioMax: this.timing.runnerCarveSpacingRatioMax,
      gapFraction: this.timing.runnerCarveGapFraction,
      depthGainMean: this.timing.runnerCarveDepthGainMean,
      postSmoothRetentionMean: this.timing.runnerCarvePostSmoothRetentionMean,
      recoveryRatioMean: this.timing.runnerCarveRecoveryRatioMean,
      recoveryLossMean: this.timing.runnerCarveRecoveryLossMean,
      lastSample: {
        mode: last.mode,
        interpolationActive: last.mode === 'segment',
        previousMatchSource: last.previousMatchSource || 'none',
        previous: { x: last.previous.x, y: last.previous.y },
        current: { x: last.current.x, y: last.current.y },
        distance: last.distance,
        radius: last.radius,
        strength: last.strength,
        spacingRatio: last.spacingRatio || 0,
        beforeDepth: last.beforeDepth || 0,
        afterDepth: last.afterDepth || 0,
      },
    })
  }

  clearFogAt(x, y, radius) {
    this.surfaceWetnessField.clearArea(x, y, radius, 0.8)
  }

  clearFogBlob(x, y, radius, strength = 1, source = 'generic') {
    this.enqueueGpuInteractionWrite({
      type: 'clear-blob',
      x,
      y,
      radius,
      strength,
      source,
    })
    this.surfaceWetnessField.clearArea(x, y, radius, strength)
  }

  disturbFogTrail(fromX, fromY, toX, toY, radius, strength, options, source = 'generic') {
    this.enqueueGpuInteractionWrite({
      type: 'trail-disturbance',
      fromX,
      fromY,
      toX,
      toY,
      radius,
      strength,
      options,
      source,
    })
    this.surfaceWetnessField.disturbTrail(fromX, fromY, toX, toY, radius, strength, options)
  }

  isGpuWritingInteractionEnabled() {
    const requestedMode = this.getRequestedCompatibilityMode()
    if (requestedMode === 'gpu-interaction') {
      return true
    }
    if (requestedMode === 'gpu-sim' || requestedMode === 'cpu-compat') {
      return false
    }
    return Boolean(this.tuningConfig.debug?.useGpuWetnessSimulation) && Boolean(this.tuningConfig.debug?.useGpuWritingInteractionPrototype)
  }

  isGpuWetnessSimulationEnabled() {
    const requestedMode = this.getRequestedCompatibilityMode()
    if (requestedMode === 'gpu-sim' || requestedMode === 'gpu-interaction') {
      return true
    }
    if (requestedMode === 'cpu-compat') {
      return false
    }
    return Boolean(this.tuningConfig.debug?.useGpuWetnessSimulation)
  }

  getRequestedCompatibilityMode() {
    const requested = this.tuningConfig.debug?.compatibilityMode
    if (requested === 'cpu-compat' || requested === 'gpu-sim' || requested === 'gpu-interaction') {
      return requested
    }
    return 'auto'
  }

  getGpuInteractionPressureProfile(queueDepth = this.gpuInteractionWriteQueue.length) {
    const avgFrame = Number(this.timing.avgFrameMs) || 0
    const wetness = Number(this.timing.wetnessMs) || 0
    let score = 0

    if (queueDepth > 3072) {
      score += 2
    } else if (queueDepth > 2048) {
      score += 1
    }

    // Delay pressure escalation so short-lived frame spikes do not thrash write policy.
    if (avgFrame > 285) {
      score += 2
    } else if (avgFrame > 240) {
      score += 1
    }

    if (wetness > 285) {
      score += 2
    } else if (wetness > 235) {
      score += 1
    }

    if (score >= 5) {
      return { level: 'critical', pointerScale: 1.8, dropletBaseStride: 3, maxWritesPerFrame: 80, pointerMergeBias: 0.96 }
    }
    if (score >= 3) {
      return { level: 'high', pointerScale: 1.45, dropletBaseStride: 2, maxWritesPerFrame: 96, pointerMergeBias: 0.88 }
    }
    if (score >= 1) {
      return { level: 'medium', pointerScale: 1.2, dropletBaseStride: 1, maxWritesPerFrame: 112, pointerMergeBias: 0.8 }
    }
    return { level: 'low', pointerScale: 1, dropletBaseStride: 1, maxWritesPerFrame: 128, pointerMergeBias: 0.72 }
  }

  enqueueGpuInteractionWrite(entry) {
    if (!this.isGpuWritingInteractionEnabled()) {
      return
    }

    this.gpuInteractionWriteEnqueueCounter += 1
    const queued = this.gpuInteractionWriteQueue.length
    const profile = this.getGpuInteractionPressureProfile(queued)
    this.timing.gpuInteractionPressure = profile.level
    this.timing.gpuInteractionWriteBudget = profile.maxWritesPerFrame

    if (entry.type === 'clear-blob') {
      let stride = 1
      if (entry.source === 'pointer') {
        stride = Math.max(2, Math.round(2 * profile.pointerScale))
        if (queued > 1024) stride = Math.max(stride, Math.round(4 * profile.pointerScale))
        if (queued > 2048) stride = Math.max(stride, Math.round(6 * profile.pointerScale))
        if (queued > 3072) stride = Math.max(stride, Math.round(8 * profile.pointerScale))
      } else if (entry.source === 'droplet') {
        stride = profile.dropletBaseStride
        if (queued > 3072) {
          stride = Math.max(stride, profile.dropletBaseStride + 1)
        }
      }
      if (stride > 1 && this.gpuInteractionWriteEnqueueCounter % stride !== 0) {
        this.timing.gpuInteractionWritesDropped += 1
        return
      }
    }

    const tail = this.gpuInteractionWriteQueue[this.gpuInteractionWriteQueue.length - 1]
    if (tail && tail.type === entry.type) {
      if (entry.type === 'clear-blob') {
        const dx = Number(entry.x) - Number(tail.x)
        const dy = Number(entry.y) - Number(tail.y)
        const distance = Math.hypot(dx, dy)
        const pointerBias = entry.source === 'pointer' ? profile.pointerMergeBias : 0.45
        const mergeRadius = Math.max(1, Math.min(Number(entry.radius) || 1, Number(tail.radius) || 1) * pointerBias)
        if (distance <= mergeRadius) {
          tail.x = (Number(tail.x) + Number(entry.x)) * 0.5
          tail.y = (Number(tail.y) + Number(entry.y)) * 0.5
          tail.radius = Math.max(Number(tail.radius) || 1, Number(entry.radius) || 1)
          tail.strength = Math.max(Number(tail.strength) || 0, Number(entry.strength) || 0)
          this.timing.gpuInteractionWritesCoalesced += 1
          return
        }
      }

      if (entry.type === 'trail-disturbance') {
        const dx = Number(entry.fromX) - Number(tail.toX)
        const dy = Number(entry.fromY) - Number(tail.toY)
        const handoffDistance = Math.hypot(dx, dy)
        const mergeRadius = Math.max(1, Math.min(Number(entry.radius) || 1, Number(tail.radius) || 1) * 0.6)
        if (handoffDistance <= mergeRadius) {
          tail.toX = Number(entry.toX)
          tail.toY = Number(entry.toY)
          tail.radius = Math.max(Number(tail.radius) || 1, Number(entry.radius) || 1)
          tail.strength = Math.max(Number(tail.strength) || 0, Number(entry.strength) || 0)
          this.timing.gpuInteractionWritesCoalesced += 1
          return
        }
      }
    }

    if (queued >= this.gpuInteractionWriteQueueMax) {
      const pruneCount = Math.max(1, Math.floor(this.gpuInteractionWriteQueueMax * 0.25))
      this.gpuInteractionWriteQueue.splice(0, pruneCount)
      this.timing.gpuInteractionWritesDropped += pruneCount
    }

    this.gpuInteractionWriteQueue.push(entry)
    this.timing.gpuInteractionWritesQueued = this.gpuInteractionWriteQueue.length
  }

  dequeueGpuInteractionWriteBatch(maxCount = 96) {
    const queued = this.gpuInteractionWriteQueue.length
    if (!queued) {
      return []
    }

    const take = Math.max(1, Math.min(maxCount, queued))
    return this.gpuInteractionWriteQueue.splice(0, take)
  }

  applyFingerWipe(start, end) {
    const dx = end.x - start.x
    const dy = end.y - start.y
    const length = Math.hypot(dx, dy)
    const stamps = Math.max(1, Math.ceil(length / 4))

    for (let i = 0; i <= stamps; i += 1) {
      const t = i / stamps
      const x = start.x + dx * t
      const y = start.y + dy * t

      // Layer a few offset blobs so writing reads as a finger pad, not a thin perfect line.
      const phase = this.pointerPhase + performance.now() * 0.008 + t * 9
      const baseRadius = 14.5 + Math.sin(phase) * 2.1
      this.clearFogBlob(x, y, baseRadius, 0.82, 'pointer')

      const lobeA = phase + 1.9
      const lobeB = phase - 1.7
      this.clearFogBlob(x + Math.cos(lobeA) * 3.2, y + Math.sin(lobeA) * 2.2, baseRadius * 0.52, 0.55, 'pointer')
      this.clearFogBlob(x + Math.cos(lobeB) * 2.8, y + Math.sin(lobeB) * 2.6, baseRadius * 0.44, 0.48, 'pointer')
    }
  }

  updateFog(dt) {
    this.surfaceWetnessField.addCondensation(dt)
    this.fogLevel = this.surfaceWetnessField.getDisplayWetness()
  }

  syncFogCanvasFromWetnessField({ fullRefresh = false } = {}) {
    if (!this.fogImageData) {
      return { dirtyRect: null, fullField: false, processedPixels: 0 }
    }

    const convertResult = this.surfaceWetnessField.toImageData(this.fogImageData, [204, 221, 240], {
      fullField: fullRefresh,
    })
    const dirtyRect = convertResult?.dirtyRect
    if (!dirtyRect) {
      return convertResult
    }

    this.fogCtx.putImageData(
      this.fogImageData,
      0,
      0,
      dirtyRect.x,
      dirtyRect.y,
      dirtyRect.width,
      dirtyRect.height,
    )
    return convertResult
  }

  updateDropletsFromRenderer(rendererDrops) {
    const started = performance.now()
    if (!rendererDrops?.length) {
      this.droplets = []
      this.previousRendererDropState.clear()
      this.timing.sampledDropletDiagnostics = []
      this.timing.runnerCarveDepthGainFrame = 0
      this.resetRunnerCarveTiming()
      return performance.now() - started
    }

    const toFogX = this.fogCanvas.width / Math.max(1, this.width)
    const toFogY = this.fogCanvas.height / Math.max(1, this.height)
    const nextState = new Map()
    const motionEpsilon = 0.35
    const runnerCarveFrameStats = {
      sampleCount: 0,
      segmentCount: 0,
      pointCount: 0,
      proximityMatchCount: 0,
      distanceSum: 0,
      distanceMax: 0,
      spacingRatioSum: 0,
      spacingRatioMax: 0,
      gapCount: 0,
      depthGainSum: 0,
      lastSample: null,
    }
    const currentFrameProbes = []
    const unmatchedPreviousState = new Map(this.previousRendererDropState)

    for (let i = 0; i < rendererDrops.length; i += 1) {
      const drop = rendererDrops[i]
      const id = `${drop.id}`
      const fx = drop.x * toFogX
      const fy = drop.y * toFogY
      const headRadius = drop.radius || Math.max(0.8, (drop.size?.x ?? 0) * 0.5)
      const radiusFog = clamp(headRadius * ((toFogX + toFogY) * 0.5), 0.6, 3.7)
      const mass = drop.mass ?? 0
      // Droplet-to-surface coupling now comes from live panel tunables.
      const interaction = this.tuningConfig.dropletInteraction
      const massBias = clamp(0.9 + mass * 0.03, 0.88, 1.08)
      const velocityY = drop.velocity?.y ?? 0

      // Nonlinear gate: small droplets stay almost unchanged, larger runners ramp up quickly.
      const sizeGate = clamp(
        (radiusFog - interaction.largeRunnerSizeGateStart) / Math.max(0.0001, interaction.largeRunnerSizeGateRange),
        0,
        1,
      )
      const massGate = clamp(
        (mass - interaction.largeRunnerMassGateStart) / Math.max(0.0001, interaction.largeRunnerMassGateRange),
        0,
        1,
      )
      const largeRunner = Math.max(sizeGate, massGate)
      const largeRunnerCurve = largeRunner * largeRunner

      const headStrengthBase = clamp(0.06 + mass * 0.012 + velocityY * 0.0001, 0.04, 0.13)
      const headStrength = clamp(
        headStrengthBase * interaction.headClearStrength * (1 + largeRunnerCurve * interaction.largeRunnerBoostStrength),
        0.02,
        0.8,
      )
      const headRadiusScale =
        0.5 * massBias * interaction.headClearRadiusMultiplier * (1 + largeRunnerCurve * interaction.largeRunnerRadiusBoost)
      let previous = this.previousRendererDropState.get(id)
      let previousMatchSource = 'none'
      if (previous) {
        previousMatchSource = 'id'
        unmatchedPreviousState.delete(id)
      } else {
        const proximityFallback = this.findPreviousDropStateByProximity(
          unmatchedPreviousState,
          fx,
          fy,
          Math.max(7.5, radiusFog * 3.8),
        )
        if (proximityFallback) {
          previous = proximityFallback.state
          previousMatchSource = 'proximity'
          unmatchedPreviousState.delete(proximityFallback.id)
          runnerCarveFrameStats.proximityMatchCount += 1
        }
      }
      const headClearRadius = radiusFog * headRadiusScale

      if (previous) {
        const headDx = fx - previous.x
        const headDy = fy - previous.y
        const headDistance = Math.hypot(headDx, headDy)
        const headDistanceGain = clamp(headDistance / Math.max(0.0001, radiusFog * 2.4), 0, 1)
        const headMotionGain = clamp(0.56 + headDistanceGain * 0.44, 0.5, 1)
        const segmentRadius = headClearRadius * 1.12
        const segmentStrength = clamp(headStrength * headMotionGain * 1.3, 0.02, 0.9)
        const segmentProbe = this.createRunnerCarveProbe({
          previous: { x: previous.x, y: previous.y },
          current: { x: fx, y: fy },
          radius: segmentRadius,
          strength: segmentStrength,
          mode: 'segment',
        })
        const beforeDepth = this.sampleRunnerCarveProbeDepth(segmentProbe)

        this.disturbFogTrail(previous.x, previous.y, fx, fy, segmentRadius, segmentStrength, {
          trailMagnitude: 0.19,
          runnerMagnitude: 0.1,
          gridMagnitude: 0.035,
          taperStart: 0.78,
          taperEnd: 1.04,
          accumulationClamp: 0.48,
          runnerRadiusScale: 0.82,
          gridRadiusScale: 0.74,
        }, 'droplet')
        const afterDepth = this.sampleRunnerCarveProbeDepth(segmentProbe)
        const spacingRatio = headDistance / Math.max(0.0001, segmentRadius)
        segmentProbe.depthAfterDeposit = afterDepth
        currentFrameProbes.push(segmentProbe)

        runnerCarveFrameStats.sampleCount += 1
        runnerCarveFrameStats.segmentCount += 1
        runnerCarveFrameStats.distanceSum += headDistance
        runnerCarveFrameStats.distanceMax = Math.max(runnerCarveFrameStats.distanceMax, headDistance)
        runnerCarveFrameStats.spacingRatioSum += spacingRatio
        runnerCarveFrameStats.spacingRatioMax = Math.max(runnerCarveFrameStats.spacingRatioMax, spacingRatio)
        runnerCarveFrameStats.gapCount += spacingRatio > 1 ? 1 : 0
        runnerCarveFrameStats.depthGainSum += Math.max(0, afterDepth - beforeDepth)
        runnerCarveFrameStats.lastSample = {
          mode: 'segment',
          interpolationActive: true,
          previousMatchSource,
          previous: { x: previous.x, y: previous.y },
          current: { x: fx, y: fy },
          distance: headDistance,
          radius: segmentRadius,
          strength: segmentStrength,
          spacingRatio,
          beforeDepth,
          afterDepth,
        }
      } else {
        const pointProbe = this.createRunnerCarveProbe({
          previous: { x: fx, y: fy },
          current: { x: fx, y: fy },
          radius: headClearRadius,
          strength: headStrength,
          mode: 'point',
        })
        const beforeDepth = this.sampleRunnerCarveProbeDepth(pointProbe)
        this.clearFogBlob(fx, fy, headClearRadius, headStrength, 'droplet')
        const afterDepth = this.sampleRunnerCarveProbeDepth(pointProbe)
        runnerCarveFrameStats.sampleCount += 1
        runnerCarveFrameStats.pointCount += 1
        runnerCarveFrameStats.depthGainSum += Math.max(0, afterDepth - beforeDepth)
        runnerCarveFrameStats.lastSample = {
          mode: 'point',
          interpolationActive: false,
          previousMatchSource: 'none',
          previous: { x: fx, y: fy },
          current: { x: fx, y: fy },
          distance: 0,
          radius: headClearRadius,
          strength: headStrength,
          spacingRatio: 0,
          beforeDepth,
          afterDepth,
        }
      }

      if (previous) {
        const dx = fx - previous.x
        const dy = fy - previous.y
        const distance = Math.hypot(dx, dy)
        const isDownward = interaction.downwardOnly ? dy >= 0 : true
        const maxTeleportDistance = Math.max(8, radiusFog * 4.2)
        const lateralRatio = Math.abs(dx) / Math.max(1, Math.abs(dy))
        const plausibleSlope = lateralRatio <= interaction.slopePlausibilityThreshold

        if (distance > motionEpsilon && isDownward && plausibleSlope && distance <= maxTeleportDistance) {
          const trailStrengthBase = clamp(0.2 + mass * 0.018 + velocityY * 0.00016, 0.18, 0.44)
          const distanceGain = clamp(distance / Math.max(0.0001, radiusFog * 2.9), 0, 1)
          const velocityGain = clamp(Math.abs(velocityY) / 210, 0, 1)
          const motionGain = clamp(0.55 + Math.max(distanceGain * 0.35, velocityGain * 0.45), 0.45, 1)
          // Slight boost only for larger runners so the immediate path reads as connected to the head.
          const trailStrength = clamp(
            trailStrengthBase *
              interaction.trailClearStrength *
              (1 + largeRunnerCurve * interaction.largeRunnerTrailBoost) *
              motionGain,
            0.1,
            0.9,
          )
          const trailRadius =
            radiusFog *
            0.3 *
            interaction.trailClearRadiusMultiplier *
            (1 + largeRunnerCurve * interaction.largeRunnerTrailRadiusBoost) *
            (0.86 + motionGain * 0.14)
          this.disturbFogTrail(previous.x, previous.y, fx, fy, trailRadius, trailStrength, {
            trailMagnitude: 0.24,
            runnerMagnitude: 0.16,
            gridMagnitude: 0.045,
            taperStart: 0.68,
            taperEnd: 1,
            accumulationClamp: 0.58,
            runnerRadiusScale: 0.86,
            gridRadiusScale: 0.76,
          }, 'droplet')
        }
      }

      nextState.set(id, { x: fx, y: fy })
    }

    this.flushRunnerCarveDiagnostics(runnerCarveFrameStats)
    const sampledDrops = [...rendererDrops]
      .sort((left, right) => String(left?.id || '').localeCompare(String(right?.id || '')))
      .slice(0, 3)
      .map((drop) => ({
        id: String(drop.id),
        x: Number(drop.x || 0),
        y: Number(drop.y || 0),
        vx: Number(drop.velocity?.x || 0),
        vy: Number(drop.velocity?.y || 0),
      }))
    this.timing.sampledDropletDiagnostics = sampledDrops
    this.timing.runnerCarveDepthGainFrame = Number(runnerCarveFrameStats.depthGainSum || 0)
    this.runnerCarveCurrentFrameProbes = currentFrameProbes
    this.previousRendererDropState = nextState
    this.droplets = rendererDrops
    return performance.now() - started
  }

  findPreviousDropStateByProximity(previousStateMap, currentX, currentY, maxDistance) {
    if (!previousStateMap?.size) {
      return null
    }

    let bestId = null
    let bestState = null
    let bestDistance = Infinity

    for (const [id, state] of previousStateMap.entries()) {
      const distance = Math.hypot(currentX - state.x, currentY - state.y)
      if (distance > maxDistance || distance >= bestDistance) {
        continue
      }

      bestDistance = distance
      bestId = id
      bestState = state
    }

    if (!bestState) {
      return null
    }

    return {
      id: bestId,
      state: bestState,
      distance: bestDistance,
    }
  }

  drawBackground() {
    if (this.tuningConfig.debug.freezeBackground && this.backgroundFrozen) {
      this.ctx.drawImage(this.backgroundFreezeCanvas, 0, 0, this.width, this.height)
      return
    }

    if (this.raindropRendererReady && this.raindropRenderer?.canvas) {
      this.ctx.drawImage(this.raindropRenderer.canvas, 0, 0, this.width, this.height)
      return
    }

    const { width, height } = this
    if (!this.backgroundImage.complete || this.backgroundImage.naturalWidth === 0) {
      const gradient = this.ctx.createLinearGradient(0, 0, 0, height)
      gradient.addColorStop(0, '#1a2329')
      gradient.addColorStop(1, '#06090d')
      this.ctx.fillStyle = gradient
      this.ctx.fillRect(0, 0, width, height)
      return
    }

    const img = this.backgroundImage
    const scale = Math.max(width / img.naturalWidth, height / img.naturalHeight)
    const drawWidth = img.naturalWidth * scale
    const drawHeight = img.naturalHeight * scale
    const drawX = (width - drawWidth) / 2
    const drawY = (height - drawHeight) / 2

    this.ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight)
  }

  drawSurface() {
    const renderedByGpu = this.drawSurfaceGpuRuntime()
    if (renderedByGpu) {
      this.timing.overlayBackend = this.tuningConfig.debug?.useGpuFogCompositing
        ? 'gpu-fog-composite'
        : 'gpu-overlay'
      return
    }

    this.timing.overlayBackend = 'cpu-2d'
    this.drawSurfaceCpu()
  }

  drawSurfaceCpu() {
    const overlayAlpha = clamp(this.tuningConfig.debug.compositeOverlayStrength ?? 1, 0, 1)
    if (overlayAlpha <= 0) {
      return
    }

    this.timing.rendererSamplingSource = 'fog-canvas-alpha-compat'

    // Surface overlay values used to be static constants; now driven by tuning state.
    const tintStrength = clamp(this.tuningConfig.fogSurface.fogTintStrength, 0, 0.5)
    const fillBoost = clamp(this.tuningConfig.fogSurface.fogFillBoost, 0, 0.2)
    const fogTint = this.ctx.createLinearGradient(0, 0, this.width, this.height)
    fogTint.addColorStop(0, `rgba(194, 215, 240, ${tintStrength * 1.08})`)
    fogTint.addColorStop(1, `rgba(136, 166, 200, ${tintStrength * 0.82})`)

    const fogAlpha = clamp(this.tuningConfig.fogSurface.fogAlphaMultiplier, 0, 2)
    this.ctx.save()
    this.ctx.globalAlpha = fogAlpha * overlayAlpha
    this.ctx.drawImage(this.fogCanvas, 0, 0, this.width, this.height)
    this.ctx.restore()

    this.ctx.save()
    this.ctx.globalAlpha = overlayAlpha
    this.ctx.globalCompositeOperation = 'source-atop'
    this.ctx.fillStyle = fogTint
    this.ctx.fillRect(0, 0, this.width, this.height)
    this.ctx.globalCompositeOperation = 'source-over'

    this.ctx.fillStyle = `rgba(236, 245, 255, ${fillBoost})`
    this.ctx.fillRect(0, 0, this.width, this.height)
    this.ctx.restore()

    this.timing.gpuOverlayPresentTarget = '2d-cpu'
    this.timing.gpuOverlayPresentFramebuffer = 'n/a'
    this.timing.gpuOverlayPresentSamples = 'cpu-fog-canvas'
    this.timing.gpuOverlayPresentSceneSource = '2d-main-scene'
    this.timing.gpuOverlayPresentClearRgba = '2d-clearRect'
    this.timing.gpuOverlayPresentBlendEnabled = 'n/a'
    this.timing.gpuOverlayPresentBlendMode = 'n/a'
    this.timing.gpuOverlayPresentAlphaConvention = 'n/a'
    this.timing.gpuOverlayPresentContextAlpha = 'n/a'
    this.timing.gpuOverlayPresentContextPremultiplied = 'n/a'
  }

  initGpuOverlayRuntime() {
    if (this.gpuOverlay) {
      return this.gpuOverlay
    }

    const canvas = document.createElement('canvas')
    canvas.width = this.width
    canvas.height = this.height
    const gl = canvas.getContext('webgl', {
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: false,
      // Keep overlay output in straight-alpha convention so drawImage compositing
      // over the 2D scene does not depend on implicit premultiply conversions.
      premultipliedAlpha: false,
    })
    if (!gl) {
      return null
    }

    const compileShader = (type, source) => {
      const shader = gl.createShader(type)
      if (!shader) {
        return null
      }
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader)
        return null
      }
      return shader
    }

    const vertexShader = compileShader(
      gl.VERTEX_SHADER,
      `
        attribute vec2 a_position;
        varying vec2 v_uv;
        void main() {
          v_uv = (a_position + 1.0) * 0.5;
          gl_Position = vec4(a_position, 0.0, 1.0);
        }
      `,
    )
    const fragmentShader = compileShader(
      gl.FRAGMENT_SHADER,
      `
        precision mediump float;
        varying vec2 v_uv;
        uniform sampler2D u_wetnessTex;
        uniform sampler2D u_trailTex;
        uniform sampler2D u_runnerTex;
        uniform vec2 u_texel;
        uniform float u_alpha;
        uniform float u_baseWetness;
        uniform float u_fogDensityScale;
        uniform float u_softnessScale;
        uniform float u_mistTrailScale;
        uniform float u_channelScale;
        uniform float u_channelThreshold;
        uniform float u_debugContrast;
        uniform float u_overlayAlpha;
        uniform float u_tintStrength;
        uniform float u_fillBoost;
        uniform float u_useFogCompositing;
        uniform float u_debugMode;

        vec3 mixTint(vec2 uv) {
          float t = clamp((uv.x + uv.y) * 0.5, 0.0, 1.0);
          vec3 tintA = vec3(194.0 / 255.0, 215.0 / 255.0, 240.0 / 255.0);
          vec3 tintB = vec3(136.0 / 255.0, 166.0 / 255.0, 200.0 / 255.0);
          return mix(tintA, tintB, t);
        }

        vec3 hsvToRgb(float h, float s, float v) {
          vec3 k = vec3(1.0, 2.0 / 3.0, 1.0 / 3.0);
          vec3 p = abs(fract(vec3(h) + k) * 6.0 - 3.0);
          return v * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), s);
        }

        void main() {
          // Texture uploads use UNPACK_FLIP_Y_WEBGL=true, so v_uv is sampled directly.
          float wetCenter = clamp(texture2D(u_wetnessTex, v_uv).r, 0.0, 1.0);
          float wetLeft = clamp(texture2D(u_wetnessTex, vec2(v_uv.x - u_texel.x, v_uv.y)).r, 0.0, 1.0);
          float wetRight = clamp(texture2D(u_wetnessTex, vec2(v_uv.x + u_texel.x, v_uv.y)).r, 0.0, 1.0);
          float wetUp = clamp(texture2D(u_wetnessTex, vec2(v_uv.x, v_uv.y - u_texel.y)).r, 0.0, 1.0);
          float wetDown = clamp(texture2D(u_wetnessTex, vec2(v_uv.x, v_uv.y + u_texel.y)).r, 0.0, 1.0);
          float wetUL = clamp(texture2D(u_wetnessTex, vec2(v_uv.x - u_texel.x, v_uv.y - u_texel.y)).r, 0.0, 1.0);
          float wetUR = clamp(texture2D(u_wetnessTex, vec2(v_uv.x + u_texel.x, v_uv.y - u_texel.y)).r, 0.0, 1.0);
          float wetDL = clamp(texture2D(u_wetnessTex, vec2(v_uv.x - u_texel.x, v_uv.y + u_texel.y)).r, 0.0, 1.0);
          float wetDR = clamp(texture2D(u_wetnessTex, vec2(v_uv.x + u_texel.x, v_uv.y + u_texel.y)).r, 0.0, 1.0);

          float trail = clamp(texture2D(u_trailTex, v_uv).r, 0.0, 1.0);
          float runner = clamp(texture2D(u_runnerTex, v_uv).r, 0.0, 1.0);

          float localWetness = clamp(
            wetCenter * 0.40 +
            (wetLeft + wetRight + wetUp + wetDown) * 0.10 +
            (wetUL + wetUR + wetDL + wetDR) * 0.05,
            0.0,
            1.0
          );

          float gradX = wetRight - wetLeft;
          float gradY = wetDown - wetUp;
          float gradMag = clamp(length(vec2(gradX, gradY)) * 3.8, 0.0, 1.0);
          float softness = clamp((1.0 - gradMag) * (0.42 + localWetness * 0.58), 0.0, 1.0);

          float contrast = max(0.1, u_debugContrast);
          float wetViz = clamp(pow(wetCenter, 1.0 / contrast), 0.0, 1.0);
          float trailViz = clamp(pow(trail, 1.0 / contrast), 0.0, 1.0);
          float runnerViz = clamp(pow(runner, 1.0 / contrast), 0.0, 1.0);

          float wetField = clamp(mix(u_baseWetness, wetCenter, 0.84), 0.0, 1.0);
          float fogDensity = clamp(
            wetField * (0.68 + u_fogDensityScale * 0.42) +
            trail * u_mistTrailScale * 0.96 +
            softness * u_softnessScale * 0.30,
            0.0,
            1.0
          );
          float runnerMask = smoothstep(u_channelThreshold, min(1.0, u_channelThreshold + 0.35), runner);
          float channelMask = clamp(runnerMask * u_channelScale, 0.0, 1.0);
          float fogFieldAlpha = clamp(fogDensity * (1.0 - channelMask * 0.94), 0.0, 1.0);

          if (u_debugMode > 0.5 && u_debugMode < 1.5) {
            // debug-wetness: direct wetness texture visualization.
            float w = wetViz;
            vec3 wetnessRgb = hsvToRgb(0.56 - w * 0.56, 0.92, 0.10 + w * 0.90);
            gl_FragColor = vec4(wetnessRgb, 1.0);
            return;
          }

          if (u_debugMode > 1.5 && u_debugMode < 2.5) {
            // debug-trail: isolated trail history emphasis.
            float t = trailViz;
            vec3 trailRgb = hsvToRgb(0.17 + t * 0.16, 0.96, 0.06 + t * 0.94);
            gl_FragColor = vec4(trailRgb, 1.0);
            return;
          }

          if (u_debugMode > 2.5 && u_debugMode < 3.5) {
            // debug-runner: isolated runner/channel memory.
            float r = runnerViz;
            vec3 runnerRgb = hsvToRgb(0.0 + r * 0.06, 0.95, 0.08 + r * 0.92);
            gl_FragColor = vec4(runnerRgb, 1.0);
            return;
          }

          if (u_debugMode > 3.5) {
            // debug-combined-surface: false-color composite of wetness/trail/runner.
            vec3 combinedRgb = vec3(wetViz, trailViz, runnerViz);
            float carveEdge = clamp(channelMask * 1.2, 0.0, 1.0);
            combinedRgb = mix(combinedRgb, vec3(1.0, 0.15, 0.05), carveEdge * 0.35);
            gl_FragColor = vec4(combinedRgb, 1.0);
            return;
          }

          float fogA = clamp(fogFieldAlpha * u_alpha, 0.0, 1.0);
          vec3 wetTint = vec3(0.18, 0.22, 0.28) + vec3(0.20, 0.28, 0.36) * fogDensity;
          wetTint *= (1.0 - channelMask * 0.24);

          if (u_useFogCompositing < 0.5) {
            gl_FragColor = vec4(wetTint, fogA);
            return;
          }

          vec3 fogPremul = wetTint * fogA;

          vec3 tintColor = mixTint(v_uv);
          float tintA = mix(u_tintStrength * 1.08, u_tintStrength * 0.82, clamp((v_uv.x + v_uv.y) * 0.5, 0.0, 1.0)) * u_overlayAlpha;
          tintA = clamp(tintA, 0.0, 1.0);
          vec3 tintedPremul = tintColor * (tintA * fogA) + fogPremul * (1.0 - tintA);

          vec3 fillColor = vec3(236.0 / 255.0, 245.0 / 255.0, 1.0);
          float fillA = clamp(u_fillBoost * u_overlayAlpha, 0.0, 1.0) * fogA;
          vec3 outPremul = fillColor * fillA + tintedPremul * (1.0 - fillA);

          float outA = fogA;
          vec3 outRgb = outA > 0.00001 ? outPremul / outA : vec3(0.0);
          gl_FragColor = vec4(outRgb, outA);
        }
      `,
    )
    if (!vertexShader || !fragmentShader) {
      return null
    }

    const program = gl.createProgram()
    if (!program) {
      return null
    }
    gl.attachShader(program, vertexShader)
    gl.attachShader(program, fragmentShader)
    gl.linkProgram(program)
    gl.deleteShader(vertexShader)
    gl.deleteShader(fragmentShader)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program)
      return null
    }

    const positionBuffer = gl.createBuffer()
    if (!positionBuffer) {
      gl.deleteProgram(program)
      return null
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -1, -1,
        1, -1,
        -1, 1,
        -1, 1,
        1, -1,
        1, 1,
      ]),
      gl.STATIC_DRAW,
    )

    const texture = gl.createTexture()
    const trailTexture = gl.createTexture()
    const runnerTexture = gl.createTexture()
    if (!texture || !trailTexture || !runnerTexture) {
      if (texture) gl.deleteTexture(texture)
      if (trailTexture) gl.deleteTexture(trailTexture)
      if (runnerTexture) gl.deleteTexture(runnerTexture)
      gl.deleteBuffer(positionBuffer)
      gl.deleteProgram(program)
      return null
    }

    const initScalarTexture = (tex) => {
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        Math.max(1, this.fogCanvas.width),
        Math.max(1, this.fogCanvas.height),
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      )
    }

    initScalarTexture(texture)
    initScalarTexture(trailTexture)
    initScalarTexture(runnerTexture)

    this.gpuOverlay = {
      canvas,
      gl,
      contextAttributes: gl.getContextAttributes?.() || null,
      program,
      positionBuffer,
      wetnessTexture: texture,
      trailTexture,
      runnerTexture,
      fieldWidth: Math.max(1, this.fogCanvas.width),
      fieldHeight: Math.max(1, this.fogCanvas.height),
      wetnessUploadBuffer: null,
      trailUploadBuffer: null,
      runnerUploadBuffer: null,
      positionLoc: gl.getAttribLocation(program, 'a_position'),
      alphaLoc: gl.getUniformLocation(program, 'u_alpha'),
      texelLoc: gl.getUniformLocation(program, 'u_texel'),
      baseWetnessLoc: gl.getUniformLocation(program, 'u_baseWetness'),
      fogDensityScaleLoc: gl.getUniformLocation(program, 'u_fogDensityScale'),
      softnessScaleLoc: gl.getUniformLocation(program, 'u_softnessScale'),
      mistTrailScaleLoc: gl.getUniformLocation(program, 'u_mistTrailScale'),
      channelScaleLoc: gl.getUniformLocation(program, 'u_channelScale'),
      channelThresholdLoc: gl.getUniformLocation(program, 'u_channelThreshold'),
      debugContrastLoc: gl.getUniformLocation(program, 'u_debugContrast'),
      overlayAlphaLoc: gl.getUniformLocation(program, 'u_overlayAlpha'),
      tintStrengthLoc: gl.getUniformLocation(program, 'u_tintStrength'),
      fillBoostLoc: gl.getUniformLocation(program, 'u_fillBoost'),
      useFogCompositingLoc: gl.getUniformLocation(program, 'u_useFogCompositing'),
      debugModeLoc: gl.getUniformLocation(program, 'u_debugMode'),
      wetnessTexLoc: gl.getUniformLocation(program, 'u_wetnessTex'),
      trailTexLoc: gl.getUniformLocation(program, 'u_trailTex'),
      runnerTexLoc: gl.getUniformLocation(program, 'u_runnerTex'),
    }
    return this.gpuOverlay
  }

  drawSurfaceGpuRuntime() {
    const viewMode = this.tuningConfig.debug?.viewMode
    const debugMode =
      viewMode === 'debug-wetness'
        ? 1
        : viewMode === 'debug-trail' || viewMode === 'debug-flow'
          ? 2
          : viewMode === 'debug-runner' || viewMode === 'debug-disturbance'
            ? 3
            : viewMode === 'debug-combined-surface'
              ? 4
              : 0
    const overlayAlpha = clamp(this.tuningConfig.debug.compositeOverlayStrength ?? 1, 0, 1)
    if (overlayAlpha <= 0 && debugMode === 0) {
      return true
    }

    const fogAlpha = clamp(this.tuningConfig.fogSurface.fogAlphaMultiplier, 0, 2)
    const tintStrength = clamp(this.tuningConfig.fogSurface.fogTintStrength, 0, 0.5)
    const fillBoost = clamp(this.tuningConfig.fogSurface.fogFillBoost, 0, 0.2)
    const useFogCompositing = Boolean(this.tuningConfig.debug?.useGpuFogCompositing)
    const runtime = this.initGpuOverlayRuntime()
    if (!runtime) {
      return false
    }

    const {
      canvas,
      gl,
      program,
      wetnessTexture,
      trailTexture,
      runnerTexture,
      positionBuffer,
      positionLoc,
      alphaLoc,
      texelLoc,
      baseWetnessLoc,
      fogDensityScaleLoc,
      softnessScaleLoc,
      mistTrailScaleLoc,
      channelScaleLoc,
      channelThresholdLoc,
      debugContrastLoc,
      overlayAlphaLoc,
      tintStrengthLoc,
      fillBoostLoc,
      useFogCompositingLoc,
      debugModeLoc,
      wetnessTexLoc,
      trailTexLoc,
      runnerTexLoc,
    } = runtime
    const surfaces = this.surfaceWetnessField.getRenderSurfaces?.()
    if (!surfaces) {
      return false
    }

    const fieldWidth = Math.max(1, surfaces.width | 0)
    const fieldHeight = Math.max(1, surfaces.height | 0)
    const pixelCount = fieldWidth * fieldHeight
    const fogDensityScale = clamp(
      (0.65 + this.tuningConfig.links.mistDensity * 0.7) * clamp(this.tuningConfig.fogSurface.wetnessFogGain ?? 1, 0, 6),
      0,
      8,
    )
    const softnessScale = clamp(
      (0.6 + this.tuningConfig.links.fogSoftness * 0.75) * clamp(this.tuningConfig.fogSurface.wetnessSoftnessGain ?? 1, 0, 6),
      0,
      8,
    )
    const mistTrailScale = clamp(
      (0.45 + this.tuningConfig.dropletInteraction.trailClearStrength * 0.35) * clamp(this.tuningConfig.fogSurface.trailMistGain ?? 1, 0, 8),
      0,
      10,
    )
    const channelScale = clamp(
      (0.45 + this.tuningConfig.links.largeRunnerInfluence * 0.9) * clamp(this.tuningConfig.fogSurface.runnerChannelGain ?? 1, 0, 8),
      0,
      12,
    )
    const channelThreshold = clamp(this.tuningConfig.fogSurface.runnerChannelThreshold ?? 0.08, 0, 0.9)
    const debugContrast = clamp(this.tuningConfig.fogSurface.debugSurfaceContrast ?? 1.8, 0.4, 5)

    if (runtime.fieldWidth !== fieldWidth || runtime.fieldHeight !== fieldHeight) {
      runtime.fieldWidth = fieldWidth
      runtime.fieldHeight = fieldHeight
      gl.bindTexture(gl.TEXTURE_2D, wetnessTexture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, fieldWidth, fieldHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.bindTexture(gl.TEXTURE_2D, trailTexture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, fieldWidth, fieldHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.bindTexture(gl.TEXTURE_2D, runnerTexture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, fieldWidth, fieldHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      runtime.wetnessUploadBuffer = null
      runtime.trailUploadBuffer = null
      runtime.runnerUploadBuffer = null
    }

    if (!runtime.wetnessUploadBuffer || runtime.wetnessUploadBuffer.length !== pixelCount * 4) {
      runtime.wetnessUploadBuffer = new Uint8Array(pixelCount * 4)
    }
    if (!runtime.trailUploadBuffer || runtime.trailUploadBuffer.length !== pixelCount * 4) {
      runtime.trailUploadBuffer = new Uint8Array(pixelCount * 4)
    }
    if (!runtime.runnerUploadBuffer || runtime.runnerUploadBuffer.length !== pixelCount * 4) {
      runtime.runnerUploadBuffer = new Uint8Array(pixelCount * 4)
    }

    const wetnessUpload = runtime.wetnessUploadBuffer
    const trailUpload = runtime.trailUploadBuffer
    const runnerUpload = runtime.runnerUploadBuffer
    const baseWetness = clamp(surfaces.baseWetness, 0, 1)
    const displayGrid = surfaces.displayGrid
    const trailGrid = surfaces.trailGrid
    const runnerGrid = surfaces.runnerMemoryGrid

    let wetnessSum = 0
    let wetnessSqSum = 0
    let trailSum = 0
    let runnerSum = 0
    let channelCoverageCount = 0
    let carveCoverageCount = 0
    let alphaSum = 0
    let alphaSqSum = 0
    let alphaMax = 0

    let wetnessPeak = 0
    let trailPeak = 0
    let runnerPeak = 0

    for (let i = 0; i < pixelCount; i += 1) {
      const wetness = clamp(baseWetness + displayGrid[i], 0, 1)
      const trail = clamp(-trailGrid[i], 0, 1)
      const runner = clamp(-runnerGrid[i], 0, 1)
      if (wetness > wetnessPeak) wetnessPeak = wetness
      if (trail > trailPeak) trailPeak = trail
      if (runner > runnerPeak) runnerPeak = runner
      const fogDensity = clamp(
        wetness * (0.68 + fogDensityScale * 0.42) +
          trail * mistTrailScale * 0.96 +
          wetness * softnessScale * 0.16,
        0,
        1,
      )
      const runnerMask = clamp((runner - channelThreshold) / Math.max(0.0001, 1 - channelThreshold), 0, 1)
      const channelMask = clamp(runnerMask * channelScale, 0, 1)
      const alpha = clamp(fogDensity * (1 - channelMask * 0.94) * fogAlpha * overlayAlpha, 0, 1)

      wetnessSum += wetness
      wetnessSqSum += wetness * wetness
      trailSum += trail
      runnerSum += runner
      alphaSum += alpha
      alphaSqSum += alpha * alpha
      if (alpha > alphaMax) {
        alphaMax = alpha
      }
      if (runner > channelThreshold) {
        channelCoverageCount += 1
      }
      if (channelMask > 0.12 && fogDensity > 0.1) {
        carveCoverageCount += 1
      }

      const pixel = i * 4
      const wetnessByte = Math.round(wetness * 255)
      const trailByte = Math.round(trail * 255)
      const runnerByte = Math.round(runner * 255)

      wetnessUpload[pixel] = wetnessByte
      wetnessUpload[pixel + 1] = wetnessByte
      wetnessUpload[pixel + 2] = wetnessByte
      wetnessUpload[pixel + 3] = 255

      trailUpload[pixel] = trailByte
      trailUpload[pixel + 1] = trailByte
      trailUpload[pixel + 2] = trailByte
      trailUpload[pixel + 3] = 255

      runnerUpload[pixel] = runnerByte
      runnerUpload[pixel + 1] = runnerByte
      runnerUpload[pixel + 2] = runnerByte
      runnerUpload[pixel + 3] = 255
    }

    const invPixels = 1 / Math.max(1, pixelCount)
    const wetnessMean = wetnessSum * invPixels
    const wetnessVariance = Math.max(0, wetnessSqSum * invPixels - wetnessMean * wetnessMean)
    const trailMean = trailSum * invPixels
    const runnerMean = runnerSum * invPixels
    const alphaMean = alphaSum * invPixels
    const alphaVariance = Math.max(0, alphaSqSum * invPixels - alphaMean * alphaMean)

    this.timing.rendererSamplingSource = 'surface-wetness-textures'
    this.timing.rendererWetnessSampleMean = wetnessMean
    this.timing.rendererWetnessSampleVariance = wetnessVariance
    this.timing.rendererTrailSampleMean = trailMean
    this.timing.rendererRunnerSampleMean = runnerMean
    this.timing.rendererChannelCoverage = channelCoverageCount * invPixels
    this.timing.debugWetnessPeak = wetnessPeak
    this.timing.debugTrailPeak = trailPeak
    this.timing.debugRunnerPeak = runnerPeak
    this.timing.rendererCarveCoverage = carveCoverageCount * invPixels
    this.timing.gpuOverlayFogAlphaMean = alphaMean
    this.timing.gpuOverlayFogAlphaMax = alphaMax
    this.timing.gpuFogAlphaMean = alphaMean
    this.timing.gpuFogAlphaVariance = alphaVariance

    if (canvas.width !== this.width || canvas.height !== this.height) {
      canvas.width = this.width
      canvas.height = this.height
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.useProgram(program)
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
    gl.enableVertexAttribArray(positionLoc)
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, wetnessTexture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, fieldWidth, fieldHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, wetnessUpload)
    gl.uniform1i(wetnessTexLoc, 0)

    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, trailTexture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, fieldWidth, fieldHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, trailUpload)
    gl.uniform1i(trailTexLoc, 1)

    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, runnerTexture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, fieldWidth, fieldHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, runnerUpload)
    gl.uniform1i(runnerTexLoc, 2)

    gl.uniform2f(texelLoc, 1 / Math.max(1, fieldWidth), 1 / Math.max(1, fieldHeight))
    gl.uniform1f(alphaLoc, fogAlpha * overlayAlpha)
    gl.uniform1f(baseWetnessLoc, baseWetness)
    gl.uniform1f(fogDensityScaleLoc, fogDensityScale)
    gl.uniform1f(softnessScaleLoc, softnessScale)
    gl.uniform1f(mistTrailScaleLoc, mistTrailScale)
    gl.uniform1f(channelScaleLoc, channelScale)
    gl.uniform1f(channelThresholdLoc, channelThreshold)
    gl.uniform1f(debugContrastLoc, debugContrast)
    gl.uniform1f(overlayAlphaLoc, overlayAlpha)
    gl.uniform1f(tintStrengthLoc, tintStrength)
    gl.uniform1f(fillBoostLoc, fillBoost)
    gl.uniform1f(useFogCompositingLoc, useFogCompositing ? 1 : 0)
    gl.uniform1f(debugModeLoc, debugMode)
    gl.disable(gl.BLEND)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLES, 0, 6)

    // Lightweight diagnostics for parity debugging in HUD/captures.
    this.timing.gpuOverlayUvMode = 'flip-upload'

    const blendEnabled = gl.isEnabled(gl.BLEND)
    const framebufferBound = gl.getParameter(gl.FRAMEBUFFER_BINDING)
    const srcRgb = gl.getParameter(gl.BLEND_SRC_RGB)
    const dstRgb = gl.getParameter(gl.BLEND_DST_RGB)
    const srcAlpha = gl.getParameter(gl.BLEND_SRC_ALPHA)
    const dstAlpha = gl.getParameter(gl.BLEND_DST_ALPHA)
    const enumLabel = (value) => {
      if (value === gl.ZERO) return 'ZERO'
      if (value === gl.ONE) return 'ONE'
      if (value === gl.SRC_ALPHA) return 'SRC_ALPHA'
      if (value === gl.ONE_MINUS_SRC_ALPHA) return 'ONE_MINUS_SRC_ALPHA'
      if (value === gl.DST_ALPHA) return 'DST_ALPHA'
      if (value === gl.ONE_MINUS_DST_ALPHA) return 'ONE_MINUS_DST_ALPHA'
      if (value === gl.SRC_COLOR) return 'SRC_COLOR'
      if (value === gl.ONE_MINUS_SRC_COLOR) return 'ONE_MINUS_SRC_COLOR'
      if (value === gl.DST_COLOR) return 'DST_COLOR'
      if (value === gl.ONE_MINUS_DST_COLOR) return 'ONE_MINUS_DST_COLOR'
      return `${value}`
    }
    this.timing.gpuOverlayPresentTarget = 'webgl-default-fbo'
    this.timing.gpuOverlayPresentFramebuffer = framebufferBound ? 'custom-fbo' : 'default-null'
    this.timing.gpuOverlayPresentSamples = 'surface-wetness/trail/runner-textures'
    this.timing.gpuOverlayPresentSceneSource = '2d-underlay-main-canvas'
    this.timing.gpuOverlayPresentClearRgba = '0,0,0,0'
    this.timing.gpuOverlayPresentBlendEnabled = blendEnabled ? 'yes' : 'no'
    this.timing.gpuOverlayPresentBlendMode = blendEnabled
      ? `${enumLabel(srcRgb)}/${enumLabel(dstRgb)}/${enumLabel(srcAlpha)}/${enumLabel(dstAlpha)}`
      : 'disabled'
    this.timing.gpuOverlayPresentAlphaConvention = 'straight'
    this.timing.gpuOverlayPresentContextAlpha = runtime.contextAttributes?.alpha ? 'true' : 'false'
    this.timing.gpuOverlayPresentContextPremultiplied = runtime.contextAttributes?.premultipliedAlpha ? 'true' : 'false'

    this.ctx.drawImage(canvas, 0, 0, this.width, this.height)

    if (!useFogCompositing) {
      // Phase 2 mode: keep tint/fill logic on CPU for easier parity comparison.
      const fogTint = this.ctx.createLinearGradient(0, 0, this.width, this.height)
      fogTint.addColorStop(0, `rgba(194, 215, 240, ${tintStrength * 1.08})`)
      fogTint.addColorStop(1, `rgba(136, 166, 200, ${tintStrength * 0.82})`)

      this.ctx.save()
      this.ctx.globalAlpha = overlayAlpha
      this.ctx.globalCompositeOperation = 'source-atop'
      this.ctx.fillStyle = fogTint
      this.ctx.fillRect(0, 0, this.width, this.height)
      this.ctx.globalCompositeOperation = 'source-over'
      this.ctx.fillStyle = `rgba(236, 245, 255, ${fillBoost})`
      this.ctx.fillRect(0, 0, this.width, this.height)
      this.ctx.restore()
    }

    return true
  }

  initGpuWetnessSimulationRuntime() {
    const width = this.fogCanvas.width || 1
    const height = this.fogCanvas.height || 1

    if (
      this.gpuWetnessSimulation &&
      this.gpuWetnessSimulation.canvas.width === width &&
      this.gpuWetnessSimulation.canvas.height === height
    ) {
      return this.gpuWetnessSimulation
    }

    this.disposeGpuWetnessSimulationRuntime()

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: false,
      premultipliedAlpha: false,
    })
    if (!gl) {
      return null
    }

    const compileShader = (type, source) => {
      const shader = gl.createShader(type)
      if (!shader) {
        return null
      }
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader)
        return null
      }
      return shader
    }

    const vertexShader = compileShader(
      gl.VERTEX_SHADER,
      `
        attribute vec2 a_position;
        varying vec2 v_uv;
        void main() {
          v_uv = (a_position + 1.0) * 0.5;
          gl_Position = vec4(a_position, 0.0, 1.0);
        }
      `,
    )
    const fragmentShader = compileShader(
      gl.FRAGMENT_SHADER,
      `
        precision mediump float;
        varying vec2 v_uv;
        uniform sampler2D u_state;
        uniform vec2 u_texel;
        uniform float u_diffuseStrength;

        void main() {
          // Phase 4 starter kernel: conservative diffusion/decay approximation for parity calibration.
          vec4 center = texture2D(u_state, v_uv);
          vec4 left = texture2D(u_state, vec2(v_uv.x - u_texel.x, v_uv.y));
          vec4 right = texture2D(u_state, vec2(v_uv.x + u_texel.x, v_uv.y));
          vec4 up = texture2D(u_state, vec2(v_uv.x, v_uv.y - u_texel.y));
          vec4 down = texture2D(u_state, vec2(v_uv.x, v_uv.y + u_texel.y));
          vec4 neighborAvg = (left + right + up + down) * 0.25;
          vec4 diffused = mix(center, neighborAvg, clamp(u_diffuseStrength, 0.0, 0.35));

          // Slight alpha easing toward center value keeps this pass visually stable in scaffold mode.
          float a = mix(center.a, diffused.a, 0.82);
          gl_FragColor = vec4(diffused.rgb, a);
        }
      `,
    )
    if (!vertexShader || !fragmentShader) {
      return null
    }

    const program = gl.createProgram()
    if (!program) {
      return null
    }
    gl.attachShader(program, vertexShader)
    gl.attachShader(program, fragmentShader)
    gl.linkProgram(program)
    gl.deleteShader(vertexShader)
    gl.deleteShader(fragmentShader)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program)
      return null
    }

    const writeVertexShader = compileShader(
      gl.VERTEX_SHADER,
      `
        attribute vec2 a_position;
        varying vec2 v_uv;
        void main() {
          v_uv = (a_position + 1.0) * 0.5;
          gl_Position = vec4(a_position, 0.0, 1.0);
        }
      `,
    )
    const writeFragmentShader = compileShader(
      gl.FRAGMENT_SHADER,
      `
        precision mediump float;
        varying vec2 v_uv;
        uniform sampler2D u_state;
        uniform vec2 u_from;
        uniform vec2 u_to;
        uniform float u_radius;
        uniform float u_strength;
        uniform float u_mode;

        float distToSegment(vec2 p, vec2 a, vec2 b) {
          vec2 ab = b - a;
          float abLenSq = max(dot(ab, ab), 0.000001);
          float t = clamp(dot(p - a, ab) / abLenSq, 0.0, 1.0);
          vec2 closest = a + ab * t;
          return distance(p, closest);
        }

        void main() {
          vec4 base = texture2D(u_state, v_uv);
          vec2 fromUv = vec2(u_from.x, 1.0 - u_from.y);
          vec2 toUv = vec2(u_to.x, 1.0 - u_to.y);

          float d = u_mode > 0.5 ? distToSegment(v_uv, fromUv, toUv) : distance(v_uv, fromUv);
          float edge = max(u_radius, 0.000001);
          float influence = 1.0 - smoothstep(0.0, edge, d);
          float clearAmount = clamp(influence * u_strength, 0.0, 1.0);
          float nextAlpha = max(0.0, base.a * (1.0 - clearAmount));

          gl_FragColor = vec4(base.rgb, nextAlpha);
        }
      `,
    )
    if (!writeVertexShader || !writeFragmentShader) {
      if (writeVertexShader) gl.deleteShader(writeVertexShader)
      if (writeFragmentShader) gl.deleteShader(writeFragmentShader)
      gl.deleteProgram(program)
      return null
    }

    const writeProgram = gl.createProgram()
    if (!writeProgram) {
      gl.deleteShader(writeVertexShader)
      gl.deleteShader(writeFragmentShader)
      gl.deleteProgram(program)
      return null
    }
    gl.attachShader(writeProgram, writeVertexShader)
    gl.attachShader(writeProgram, writeFragmentShader)
    gl.linkProgram(writeProgram)
    gl.deleteShader(writeVertexShader)
    gl.deleteShader(writeFragmentShader)
    if (!gl.getProgramParameter(writeProgram, gl.LINK_STATUS)) {
      gl.deleteProgram(writeProgram)
      gl.deleteProgram(program)
      return null
    }

    const positionBuffer = gl.createBuffer()
    if (!positionBuffer) {
      gl.deleteProgram(writeProgram)
      gl.deleteProgram(program)
      return null
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -1, -1,
        1, -1,
        -1, 1,
        -1, 1,
        1, -1,
        1, 1,
      ]),
      gl.STATIC_DRAW,
    )

    const createTexture = () => {
      const tex = gl.createTexture()
      if (!tex) {
        return null
      }
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      return tex
    }

    const sourceTexture = createTexture()
    const pingTexture = createTexture()
    const pongTexture = createTexture()
    const framebuffer = gl.createFramebuffer()
    if (!sourceTexture || !pingTexture || !pongTexture || !framebuffer) {
      if (sourceTexture) gl.deleteTexture(sourceTexture)
      if (pingTexture) gl.deleteTexture(pingTexture)
      if (pongTexture) gl.deleteTexture(pongTexture)
      if (framebuffer) gl.deleteFramebuffer(framebuffer)
      gl.deleteBuffer(positionBuffer)
      gl.deleteProgram(writeProgram)
      gl.deleteProgram(program)
      return null
    }

    this.gpuWetnessSimulation = {
      canvas,
      gl,
      program,
      writeProgram,
      positionBuffer,
      framebuffer,
      sourceTexture,
      pingTexture,
      pongTexture,
      usePingAsOutput: true,
      readbackBuffer: null,
      positionLoc: gl.getAttribLocation(program, 'a_position'),
      stateLoc: gl.getUniformLocation(program, 'u_state'),
      texelLoc: gl.getUniformLocation(program, 'u_texel'),
      diffuseStrengthLoc: gl.getUniformLocation(program, 'u_diffuseStrength'),
      writePositionLoc: gl.getAttribLocation(writeProgram, 'a_position'),
      writeStateLoc: gl.getUniformLocation(writeProgram, 'u_state'),
      writeFromLoc: gl.getUniformLocation(writeProgram, 'u_from'),
      writeToLoc: gl.getUniformLocation(writeProgram, 'u_to'),
      writeRadiusLoc: gl.getUniformLocation(writeProgram, 'u_radius'),
      writeStrengthLoc: gl.getUniformLocation(writeProgram, 'u_strength'),
      writeModeLoc: gl.getUniformLocation(writeProgram, 'u_mode'),
    }
    return this.gpuWetnessSimulation
  }

  disposeGpuWetnessSimulationRuntime() {
    const runtime = this.gpuWetnessSimulation
    if (!runtime) {
      return
    }

    const {
      gl,
      program,
      writeProgram,
      positionBuffer,
      framebuffer,
      sourceTexture,
      pingTexture,
      pongTexture,
    } = runtime
    if (sourceTexture) gl.deleteTexture(sourceTexture)
    if (pingTexture) gl.deleteTexture(pingTexture)
    if (pongTexture) gl.deleteTexture(pongTexture)
    if (framebuffer) gl.deleteFramebuffer(framebuffer)
    if (positionBuffer) gl.deleteBuffer(positionBuffer)
    if (writeProgram) gl.deleteProgram(writeProgram)
    if (program) gl.deleteProgram(program)
    this.gpuWetnessSimulation = null
  }

  runGpuInteractionWritePass(runtime, inputTexture, outputTexture, writeEvent) {
    if (!writeEvent) {
      return false
    }

    const {
      gl,
      canvas,
      framebuffer,
      positionBuffer,
      writeProgram,
      writePositionLoc,
      writeStateLoc,
      writeFromLoc,
      writeToLoc,
      writeRadiusLoc,
      writeStrengthLoc,
      writeModeLoc,
    } = runtime

    if (!writeProgram || !inputTexture || !outputTexture) {
      return false
    }

    const mode = writeEvent.type === 'trail-disturbance' ? 1 : 0
    const fromX = mode ? writeEvent.fromX : writeEvent.x
    const fromY = mode ? writeEvent.fromY : writeEvent.y
    const toX = mode ? writeEvent.toX : writeEvent.x
    const toY = mode ? writeEvent.toY : writeEvent.y
    const radiusPx = Math.max(0.5, Number(writeEvent.radius) || 1)
    const strength = clamp(Number(writeEvent.strength) || 0, 0, 1)

    const fromUvX = clamp(fromX / Math.max(1, this.fogCanvas.width), 0, 1)
    const fromUvY = clamp(fromY / Math.max(1, this.fogCanvas.height), 0, 1)
    const toUvX = clamp(toX / Math.max(1, this.fogCanvas.width), 0, 1)
    const toUvY = clamp(toY / Math.max(1, this.fogCanvas.height), 0, 1)
    const radiusUv = clamp(radiusPx / Math.max(1, Math.min(this.fogCanvas.width, this.fogCanvas.height)), 0.0006, 0.3)

    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.useProgram(writeProgram)
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
    gl.enableVertexAttribArray(writePositionLoc)
    gl.vertexAttribPointer(writePositionLoc, 2, gl.FLOAT, false, 0, 0)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, inputTexture)
    gl.uniform1i(writeStateLoc, 0)
    gl.uniform2f(writeFromLoc, fromUvX, fromUvY)
    gl.uniform2f(writeToLoc, toUvX, toUvY)
    gl.uniform1f(writeRadiusLoc, radiusUv)
    gl.uniform1f(writeStrengthLoc, strength)
    gl.uniform1f(writeModeLoc, mode)

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outputTexture, 0)
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      return false
    }

    gl.drawArrays(gl.TRIANGLES, 0, 6)
    return true
  }

  runGpuWetnessSimulationScaffoldPass(frameDt) {
    const runtime = this.initGpuWetnessSimulationRuntime()
    if (!runtime) {
      return false
    }

    const {
      gl,
      canvas,
      program,
      positionBuffer,
      framebuffer,
      sourceTexture,
      pingTexture,
      pongTexture,
      usePingAsOutput,
      readbackBuffer,
      positionLoc,
      stateLoc,
      texelLoc,
      diffuseStrengthLoc,
    } = runtime

    if (canvas.width !== this.fogCanvas.width || canvas.height !== this.fogCanvas.height) {
      this.disposeGpuWetnessSimulationRuntime()
      return this.runGpuWetnessSimulationScaffoldPass(frameDt)
    }

    const outTexture = usePingAsOutput ? pingTexture : pongTexture
    runtime.usePingAsOutput = !usePingAsOutput

    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.useProgram(program)
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
    gl.enableVertexAttribArray(positionLoc)
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, sourceTexture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.fogCanvas)
    gl.uniform1i(stateLoc, 0)
    gl.uniform2f(texelLoc, 1 / Math.max(1, canvas.width), 1 / Math.max(1, canvas.height))
    const dt = clamp(frameDt || 0, 0, 0.08)
    const diffuseStrength = clamp(this.tuningConfig.surfaceWetness.diffusionRate * dt * 0.018, 0, 0.35)
    gl.uniform1f(diffuseStrengthLoc, diffuseStrength)

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outTexture, 0)
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      return false
    }

    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLES, 0, 6)

    let currentTexture = outTexture
    let scratchTexture = usePingAsOutput ? pongTexture : pingTexture
    let consumedWrites = 0
    const pressureProfile = this.getGpuInteractionPressureProfile(this.gpuInteractionWriteQueue.length)
    this.timing.gpuInteractionPressure = pressureProfile.level
    this.timing.gpuInteractionWriteBudget = pressureProfile.maxWritesPerFrame
    if (this.isGpuWritingInteractionEnabled()) {
      const maxWritesPerFrame = pressureProfile.maxWritesPerFrame
      const writeBatch = this.dequeueGpuInteractionWriteBatch(maxWritesPerFrame)
      for (let i = 0; i < writeBatch.length; i += 1) {
        const applied = this.runGpuInteractionWritePass(runtime, currentTexture, scratchTexture, writeBatch[i])
        if (!applied) {
          break
        }
        consumedWrites += 1
        const swap = currentTexture
        currentTexture = scratchTexture
        scratchTexture = swap
      }
    }

    this.timing.gpuInteractionWritesConsumed =
      this.timing.gpuInteractionWritesConsumed > 0
        ? this.timing.gpuInteractionWritesConsumed * 0.8 + consumedWrites * 0.2
        : consumedWrites
    this.timing.gpuInteractionWritesQueued = this.gpuInteractionWriteQueue.length

    this.timing.gpuSimKernel = consumedWrites > 0 ? 'diffuse-v1+write-v1' : 'diffuse-v1'
    const shouldSampleParity = Boolean(this.rendererDebugEnabled) && this.wetnessFrameCounter % 18 === 0
    if (shouldSampleParity && this.fogImageData?.data) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, currentTexture, 0)
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        return false
      }

      const pixelCount = canvas.width * canvas.height
      const expectedSize = pixelCount * 4
      if (!readbackBuffer || readbackBuffer.length !== expectedSize) {
        runtime.readbackBuffer = new Uint8Array(expectedSize)
      }

      const readStart = performance.now()
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, runtime.readbackBuffer)
      const readMs = performance.now() - readStart
      this.timing.gpuSimReadbackMs =
        this.timing.gpuSimReadbackMs > 0 ? this.timing.gpuSimReadbackMs * 0.72 + readMs * 0.28 : readMs

      const gpuData = runtime.readbackBuffer
      const cpuData = this.fogImageData.data
      let gpuAlphaSum = 0
      let cpuAlphaSum = 0
      let gpuSqSum = 0
      let cpuSqSum = 0
      let absDeltaSum = 0
      const tileSize = 64
      const tilesX = Math.max(1, Math.ceil(canvas.width / tileSize))
      const tilesY = Math.max(1, Math.ceil(canvas.height / tileSize))
      const tileCount = tilesX * tilesY
      const tileErrorSums = new Float32Array(tileCount)
      const tilePixelCounts = new Uint32Array(tileCount)
      let pixelIndex = 0
      for (let i = 3; i < gpuData.length; i += 4) {
        const gpuA = gpuData[i] / 255
        const cpuA = cpuData[i] / 255
        const absDelta = Math.abs(gpuA - cpuA)
        gpuAlphaSum += gpuA
        cpuAlphaSum += cpuA
        gpuSqSum += gpuA * gpuA
        cpuSqSum += cpuA * cpuA
        absDeltaSum += absDelta

        const x = pixelIndex % canvas.width
        const y = Math.floor(pixelIndex / canvas.width)
        const tileX = Math.min(tilesX - 1, Math.floor(x / tileSize))
        const tileY = Math.min(tilesY - 1, Math.floor(y / tileSize))
        const tileIdx = tileY * tilesX + tileX
        tileErrorSums[tileIdx] += absDelta
        tilePixelCounts[tileIdx] += 1
        pixelIndex += 1
      }

      const invCount = 1 / pixelCount
      const gpuMean = gpuAlphaSum * invCount
      const cpuMean = cpuAlphaSum * invCount
      const delta = Math.abs(gpuMean - cpuMean)
      const gpuVar = Math.max(0, gpuSqSum * invCount - gpuMean * gpuMean)
      const cpuVar = Math.max(0, cpuSqSum * invCount - cpuMean * cpuMean)
      const mae = absDeltaSum * invCount
      let maxTileMae = 0
      let hotspotTile = '0,0'
      for (let t = 0; t < tileCount; t += 1) {
        const count = tilePixelCounts[t]
        if (!count) {
          continue
        }
        const tileMae = tileErrorSums[t] / count
        if (tileMae > maxTileMae) {
          maxTileMae = tileMae
          const hx = t % tilesX
          const hy = Math.floor(t / tilesX)
          hotspotTile = `${hx},${hy}`
        }
      }
      this.timing.gpuFogAlphaMean = gpuMean
      this.timing.cpuFogAlphaMean = cpuMean
      this.timing.gpuCpuAlphaDelta = delta
      this.timing.gpuCpuAlphaMae = mae
      this.timing.gpuFogAlphaVariance = gpuVar
      this.timing.cpuFogAlphaVariance = cpuVar
      this.timing.gpuCpuVarianceDelta = Math.abs(gpuVar - cpuVar)
      this.timing.gpuCpuTileMaxMae = maxTileMae
      this.timing.gpuCpuTileHotspot = hotspotTile

      const gateEnabled = this.tuningConfig.debug?.gpuParityGateEnabled !== false
      if (gateEnabled) {
        const thresholdMean = Math.max(0, this.tuningConfig.debug?.gpuParityThresholdMeanDelta ?? 0.002)
        const thresholdMae = Math.max(0, this.tuningConfig.debug?.gpuParityThresholdMae ?? 0.004)
        const thresholdVarDelta = Math.max(0, this.tuningConfig.debug?.gpuParityThresholdVarianceDelta ?? 0.0002)
        const thresholdTile = Math.max(0, this.tuningConfig.debug?.gpuParityThresholdTileMaxMae ?? 0.012)
        const failures = []
        if (delta > thresholdMean) failures.push('mean')
        if (mae > thresholdMae) failures.push('mae')
        if (Math.abs(gpuVar - cpuVar) > thresholdVarDelta) failures.push('var')
        if (maxTileMae > thresholdTile) failures.push('tile')
        this.timing.gpuParityGateStatus = failures.length ? 'fail' : 'pass'
        this.timing.gpuParityGateFailures = failures.length ? failures.join(',') : 'none'
      } else {
        this.timing.gpuParityGateStatus = 'disabled'
        this.timing.gpuParityGateFailures = 'none'
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return true
  }

  sampleRendererFrameEnergy() {
    if (!this.rendererDebugEnabled || !this.raindropRenderer?.canvas || !this.rendererProbeCtx) {
      return
    }

    this.rendererProbeCtx.clearRect(0, 0, this.rendererProbeCanvas.width, this.rendererProbeCanvas.height)
    this.rendererProbeCtx.drawImage(this.raindropRenderer.canvas, 0, 0, this.rendererProbeCanvas.width, this.rendererProbeCanvas.height)

    const data = this.rendererProbeCtx.getImageData(0, 0, this.rendererProbeCanvas.width, this.rendererProbeCanvas.height).data
    if (!this.previousProbeSample || this.previousProbeSample.length !== data.length) {
      this.previousProbeSample = new Uint8ClampedArray(data)
      this.rendererDebugInfo.frameDeltaEnergy = 0
      this.rendererDebugInfo.frameSampleReady = true
      this.rendererDebugInfo.renderedDropletPixelCoverage = 0
      this.rendererDebugInfo.rendererVisiblePixelCoverage = 0
      this.rendererDebugInfo.rendererAlphaMean = 0
      return
    }

    let delta = 0
    let activePixels = 0
    let alphaSum = 0
    const pixelCount = data.length / 4
    for (let i = 0; i < data.length; i += 16) {
      delta += Math.abs(data[i] - this.previousProbeSample[i])
      delta += Math.abs(data[i + 1] - this.previousProbeSample[i + 1])
      delta += Math.abs(data[i + 2] - this.previousProbeSample[i + 2])
    }

    for (let i = 3; i < data.length; i += 4) {
      alphaSum += data[i]
      if (data[i] > 12) {
        activePixels += 1
      }
    }

    this.rendererDebugInfo.frameDeltaEnergy = delta
    this.rendererDebugInfo.frameSampleReady = true
    this.rendererDebugInfo.renderedDropletPixelCoverage = pixelCount > 0 ? activePixels / pixelCount : 0
    this.rendererDebugInfo.rendererVisiblePixelCoverage = pixelCount > 0 ? activePixels / pixelCount : 0
    this.rendererDebugInfo.rendererAlphaMean = pixelCount > 0 ? (alphaSum / pixelCount) / 255 : 0
    this.previousProbeSample.set(data)
  }

  drawRendererDebugOverlay() {
    if (!(this.rendererDebugEnabled || this.tuningConfig.debug.showRawRendererInset)) {
      return
    }

    const insetWidth = Math.min(340, Math.floor(this.width * 0.32))
    const insetHeight = Math.floor(insetWidth * 9 / 16)
    const x = this.width - insetWidth - 18
    const y = this.height - insetHeight - 18

    this.ctx.save()
    this.ctx.fillStyle = 'rgba(8, 10, 16, 0.88)'
    this.ctx.fillRect(x - 8, y - 28, insetWidth + 16, insetHeight + 36)
    this.ctx.strokeStyle = 'rgba(255, 86, 86, 0.95)'
    this.ctx.lineWidth = 2
    this.ctx.strokeRect(x - 8, y - 28, insetWidth + 16, insetHeight + 36)

    if (this.raindropRenderer?.canvas) {
      this.ctx.drawImage(this.raindropRenderer.canvas, x, y, insetWidth, insetHeight)
      this.ctx.strokeStyle = 'rgba(255, 180, 0, 0.95)'
      this.ctx.strokeRect(x, y, insetWidth, insetHeight)
    }

    this.ctx.fillStyle = '#ffb86b'
    this.ctx.font = '12px "IBM Plex Sans", sans-serif'
    this.ctx.fillText('RaindropFX RAW OUTPUT (debug)', x, y - 10)
    this.ctx.restore()
  }

  drawNativeRawFrame() {
    if (this.raindropRendererReady && this.raindropRenderer?.canvas) {
      this.ctx.drawImage(this.raindropRenderer.canvas, 0, 0, this.width, this.height)
      return
    }

    const { width, height } = this
    if (!this.backgroundImage.complete || this.backgroundImage.naturalWidth === 0) {
      const gradient = this.ctx.createLinearGradient(0, 0, 0, height)
      gradient.addColorStop(0, '#1a2329')
      gradient.addColorStop(1, '#06090d')
      this.ctx.fillStyle = gradient
      this.ctx.fillRect(0, 0, width, height)
      return
    }

    const img = this.backgroundImage
    const scale = Math.max(width / img.naturalWidth, height / img.naturalHeight)
    const drawWidth = img.naturalWidth * scale
    const drawHeight = img.naturalHeight * scale
    const drawX = (width - drawWidth) / 2
    const drawY = (height - drawHeight) / 2
    this.ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight)
  }

  drawOverlayBackendCompareView() {
    const splitX = Math.floor(this.width * 0.5)

    const drawHalf = (left, top, width, height, drawFn) => {
      this.ctx.save()
      this.ctx.beginPath()
      this.ctx.rect(left, top, width, height)
      this.ctx.clip()
      drawFn()
      this.ctx.restore()
    }

    const drawCpuComposite = () => {
      this.drawNativeRawFrame()
      this.drawSurfaceCpu()
    }

    const drawGpuComposite = () => {
      this.drawNativeRawFrame()
      const rendered = this.drawSurfaceGpuRuntime()
      if (!rendered) {
        this.drawSurfaceCpu()
      }
    }

    drawHalf(0, 0, splitX, this.height, drawCpuComposite)
    drawHalf(splitX, 0, this.width - splitX, this.height, drawGpuComposite)

    this.ctx.save()
    this.ctx.strokeStyle = 'rgba(240, 245, 255, 0.85)'
    this.ctx.lineWidth = 2
    this.ctx.beginPath()
    this.ctx.moveTo(splitX + 0.5, 0)
    this.ctx.lineTo(splitX + 0.5, this.height)
    this.ctx.stroke()

    this.ctx.font = '12px "IBM Plex Sans", sans-serif'
    this.ctx.textBaseline = 'top'
    this.ctx.fillStyle = 'rgba(8, 12, 18, 0.58)'
    this.ctx.fillRect(12, 10, Math.max(178, splitX - 24), 36)
    this.ctx.fillRect(splitX + 12, 10, Math.max(178, this.width - splitX - 24), 36)
    this.ctx.fillStyle = 'rgba(236, 244, 255, 0.96)'
    this.ctx.fillText('CPU OVERLAY', 20, 14)
    this.ctx.fillText('BG + RDFX + WETNESS (2D)', 20, 28)
    this.ctx.fillText('GPU OVERLAY', splitX + 20, 14)
    this.ctx.fillText('BG + RDFX + WETNESS (WebGL)', splitX + 20, 28)
    this.ctx.restore()
  }

  drawSplitCompareView() {
    const rawOnRight = Boolean(this.tuningConfig.debug.splitRawOnRight)
    const splitX = Math.floor(this.width * 0.5)

    const drawHalf = (left, top, width, height, drawFn) => {
      this.ctx.save()
      this.ctx.beginPath()
      this.ctx.rect(left, top, width, height)
      this.ctx.clip()
      drawFn()
      this.ctx.restore()
    }

    const drawRaw = () => {
      // RAW = background + native RaindropFX renderer output only.
      this.drawNativeRawFrame()
    }

    const drawComposite = () => {
      // COMPOSITE = RAW native frame + wetness/fog interaction overlay.
      this.drawNativeRawFrame()
      this.drawSurface()
    }

    if (rawOnRight) {
      drawHalf(0, 0, splitX, this.height, drawComposite)
      drawHalf(splitX, 0, this.width - splitX, this.height, drawRaw)
    } else {
      drawHalf(0, 0, splitX, this.height, drawRaw)
      drawHalf(splitX, 0, this.width - splitX, this.height, drawComposite)
    }

    this.ctx.save()
    this.ctx.strokeStyle = 'rgba(240, 245, 255, 0.85)'
    this.ctx.lineWidth = 2
    this.ctx.beginPath()
    this.ctx.moveTo(splitX + 0.5, 0)
    this.ctx.lineTo(splitX + 0.5, this.height)
    this.ctx.stroke()

    const leftTitle = rawOnRight ? 'COMPOSITE' : 'RAW'
    const rightTitle = rawOnRight ? 'RAW' : 'COMPOSITE'
    const leftStack = rawOnRight ? 'BG + RDFX + WETNESS' : 'BG + RDFX'
    const rightStack = rawOnRight ? 'BG + RDFX' : 'BG + RDFX + WETNESS'

    this.ctx.font = '12px "IBM Plex Sans", sans-serif'
    this.ctx.textBaseline = 'top'

    this.ctx.fillStyle = 'rgba(8, 12, 18, 0.58)'
    this.ctx.fillRect(12, 10, Math.max(158, splitX - 24), 36)
    this.ctx.fillRect(splitX + 12, 10, Math.max(158, this.width - splitX - 24), 36)

    this.ctx.fillStyle = 'rgba(236, 244, 255, 0.96)'
    this.ctx.fillText(leftTitle, 20, 14)
    this.ctx.fillText(leftStack, 20, 28)
    this.ctx.fillText(rightTitle, splitX + 20, 14)
    this.ctx.fillText(rightStack, splitX + 20, 28)
    this.ctx.restore()
  }

  animate(now) {
    if (!this.running) {
      return
    }

    // Bootstrap tracking: record first render frame time after renderer attached
    if (this.bootstrapInfo.rendererAttached && this.bootstrapInfo.firstRenderFrameTime === 0) {
      this.bootstrapInfo.firstRenderFrameTime = performance.now()
    }

    const lastTimeBeforeAnimateMs = Number(this.lastTime || 0)
    const rawDtSec = (now - lastTimeBeforeAnimateMs) / 1000
    const isFirstStartupFrame = this.wetnessFrameCounter === 0
    const dt = isFirstStartupFrame ? 0 : clamp(rawDtSec, 0, 0.08)
    this.noteSimulationFrameAdvance(dt, now)
    this.timing.wetnessBackend = 'cpu-grid'
    this.timing.interactionBackend = 'cpu-direct'
    this.timing.gpuInteractionWritesQueued = this.gpuInteractionWriteQueue.length
    this.sceneAgeSec += dt
    const frameStart = performance.now()
    const frameDeltaMs = this.lastFrameTimestamp > 0 ? now - this.lastFrameTimestamp : 16.7
    this.lastFrameTimestamp = now
    this.lastTime = now

    let rendererMs = 0
    let wetnessMs = 0
    let overlayMs = 0
    let dropletTotalMs = 0
    let fieldStats = null

    const wetnessStart = performance.now()
    if (this.wetnessFrameCounter <= 1) {
      this.recordWetnessLifecycleTrace('frame-pre-beginFrame', {
        frameIndex: Number(this.wetnessFrameCounter || 0),
        animationNowMs: Number(now || 0),
        lastTimeBeforeAnimateMs,
        rawDtSec: Number(rawDtSec || 0),
        engineDtSec: Number(dt || 0),
        isFirstStartupFrame,
      })
    }
    this.surfaceWetnessField.beginFrame()
    if (this.wetnessFrameCounter <= 1) {
      this.recordWetnessLifecycleTrace('frame-post-beginFrame', {
        frameIndex: Number(this.wetnessFrameCounter || 0),
        engineDtSec: Number(dt || 0),
        isFirstStartupFrame,
      })
    }
    const wetnessFieldFrameId = Number(this.surfaceWetnessField.frameId || 0)
    const baseWetnessBeforeCondensation = Number(this.surfaceWetnessField.getDisplayWetness() || 0)
    const baseDrift = Math.abs(this.fogLevel - this.lastBaseWetnessSynced)
    const fullRefreshIntervalFrames = Math.max(
      30,
      Math.round(this.tuningConfig.debug?.wetnessFullRefreshIntervalFrames ?? 120),
    )
    const fullRefresh =
      baseDrift >= this.baseWetnessSyncThreshold || this.wetnessFrameCounter % fullRefreshIntervalFrames === 0
    this.surfaceWetnessField.addCondensation(dt, { fullField: fullRefresh })
    if (this.wetnessFrameCounter <= 1) {
      this.recordWetnessLifecycleTrace('frame-post-condensation', {
        frameIndex: Number(this.wetnessFrameCounter || 0),
        rawDtSec: Number(rawDtSec || 0),
        engineDtSec: Number(dt || 0),
        isFirstStartupFrame,
        fullRefresh,
      })
    }
    const baseWetnessAfterCondensation = Number(this.surfaceWetnessField.getDisplayWetness() || 0)
    this.fogLevel = this.surfaceWetnessField.getDisplayWetness()
    this.finalizeRunnerCarveRecovery()
    let simulatorSnapshot = []

    if (this.phase >= 2 && !this.tuningConfig.debug.freezeRain) {
      const rendererStart = performance.now()
      this.rendererDebugInfo.renderCalled = true
      this.rendererDebugInfo.renderSucceeded = this.raindropRenderer?.update({ dt, total: now / 1000 }) ?? false
      simulatorSnapshot = this.raindropRenderer?.getSimulatorSnapshot?.() ?? []
      this.sampleRendererFrameEnergy()
      rendererMs = performance.now() - rendererStart
    } else if (this.phase >= 2 && this.tuningConfig.debug.freezeRain) {
      this.rendererDebugInfo.renderCalled = false
      this.rendererDebugInfo.renderSucceeded = true
      simulatorSnapshot = this.raindropRenderer?.getSimulatorSnapshot?.() ?? []
    } else {
      this.rendererDebugInfo.renderCalled = false
      this.rendererDebugInfo.renderSucceeded = false
    }

    dropletTotalMs = this.updateDropletsFromRenderer(simulatorSnapshot)
    this.timing.simulatedDropletCount = simulatorSnapshot.length
    this.timing.surfaceDropletCount = this.droplets.length

    const schedulerRainActive = Boolean(this.tuningConfig?.debug?.runtimeSchedulerRainActive)
    const sampledRainIntensity = Number(this.tuningConfig?.debug?.runtimeSampledRainIntensity || 0)
    const resolvedDropletsPerSeconds = Number(this.tuningConfig?.renderer?.dropletsPerSeconds || 0)
    if (
      schedulerRainActive &&
      resolvedDropletsPerSeconds <= 0 &&
      this.running &&
      !this.runtimeRainContractViolationLogged
    ) {
      this.runtimeRainContractViolationLogged = true
      console.error('[MistyOS][Engine][ContractViolation]', {
        event: 'active-rain-with-zero-droplets-after-start',
        schedulerRainActive,
        sampledRainIntensity,
        resolvedDropletsPerSeconds,
        adapterInitDropletsPerSeconds: Number(this.bootstrapInfo.adapterInitDropletsPerSeconds || 0),
        firstVisibleRainFrame: this.bootstrapInfo.firstVisibleRainFrame,
        simulatedDropletCount: simulatorSnapshot.length,
      })
    }

    // DIAGNOSTIC POINT 3: first simulation tick — log rain activation state.
    if (!this.firstTickLogged && this._isDevEnv) {
      this.firstTickLogged = true
      const dps = this.tuningConfig?.renderer?.dropletsPerSeconds || 0
      console.info('[MistyOS][Engine][first-tick]', {
        event: 'engine-first-tick',
        dropletsPerSeconds: dps,
        rendererReady: Boolean(this.raindropRendererReady),
        rainEmissionActive: Boolean(this.raindropRendererReady) && dps > 90,
        emissionAboveBaseline: dps > 90,
        simulatorRaindropCount: simulatorSnapshot.length,
        initialRainApplied: this.bootstrapInfo.initialRainApplied,
        initialWeatherApplied: this.bootstrapInfo.initialWeatherApplied,
        setTuningConfigCalls: this.integrationCounters.setTuningConfigCalls,
        applyLiveSettingsCalls: this.integrationCounters.applyLiveSettingsCalls,
        publishRestartPath: this.bootstrapInfo.publishRestartPath,
      })
    }

    // Bootstrap tracking: record first frame with visible rain
    if (this.bootstrapInfo.initialRainApplied && this.bootstrapInfo.firstVisibleRainFrame < 0) {
      const coverageRatio = this.rendererDebugInfo.rendererVisiblePixelCoverage || 0
      if (coverageRatio > 0.0001) {
        this.bootstrapInfo.firstVisibleRainFrame = this.wetnessFrameCounter
      }
    }
    
    // Bootstrap tracking: record seeded droplet count at first rain frame
    if (this.bootstrapInfo.firstVisibleRainFrame >= 0 && this.bootstrapInfo.seededDropletCount === 0) {
      this.bootstrapInfo.seededDropletCount = simulatorSnapshot.length
    }

    let initialFrameDiag = null
    if (this.bootstrapInfo.initialFrameDiagnostics.length < 20) {
      initialFrameDiag = {
        frameIndex: this.wetnessFrameCounter,
        packetId: this.wetnessFrameCounter,
        engineDtSec: Number(dt || 0),
        frameDeltaMs: Number(frameDeltaMs || 0),
        wetnessFieldFrameId,
        baseWetnessBeforeCondensation,
        baseWetnessAfterCondensation,
        condensationDelta: Number(baseWetnessAfterCondensation - baseWetnessBeforeCondensation),
        wetnessBaseline: Number(this.fogLevel || 0),
        rainIntensity: sampledRainIntensity,
        dropletsPerSeconds: resolvedDropletsPerSeconds,
        linkedMistDensity: Number(this.tuningConfig?.links?.mistDensity || 0),
        linkedFogSoftness: Number(this.tuningConfig?.links?.fogSoftness || 0),
        linkedRunnerInfluence: Number(this.tuningConfig?.links?.largeRunnerInfluence || 0),
        simulatedDropletCount: simulatorSnapshot.length,
        sampledDrops: Array.isArray(this.timing.sampledDropletDiagnostics)
          ? this.timing.sampledDropletDiagnostics.map((entry) => ({ ...entry }))
          : [],
        depositionDepthGain: Number(this.timing.runnerCarveDepthGainFrame || 0),
        fullRefresh,
      }
      this.bootstrapInfo.initialFrameDiagnostics.push(initialFrameDiag)
    }

    const smoothPasses = Math.max(1, Math.round(this.tuningConfig.fogSurface.smoothingPassCount))
    const smoothingStride = Math.max(1, Math.round(this.tuningConfig.debug?.wetnessSmoothingStride ?? 1))
    const regionOnlySmoothing = this.tuningConfig.debug?.wetnessRegionOnlySmoothing !== false
    this.surfaceWetnessField.smooth(dt, smoothPasses, {
      stride: smoothingStride,
      regionOnly: regionOnlySmoothing,
    })
    this.finalizeRunnerCarvePostSmooth()
    const imageResult = this.syncFogCanvasFromWetnessField({ fullRefresh })
    this.finalizeRunnerCarveFogCoupling()
    // Diagnostics-only packet marker for deterministic capture alignment.
    this.timing.runnerCarveDiagnosticsPacketId = this.wetnessFrameCounter
    this.timing.wetnessFrameCounter = this.wetnessFrameCounter
    const requestedMode = this.getRequestedCompatibilityMode()
    const wantsGpuWetnessSimulation = this.isGpuWetnessSimulationEnabled()
    const wantsGpuWritingInteraction = this.isGpuWritingInteractionEnabled()
    let compatibilityMode = 'cpu-compat'
    if (wantsGpuWetnessSimulation) {
      compatibilityMode = wantsGpuWritingInteraction ? 'gpu-interaction' : 'gpu-sim'
    }
    if (requestedMode === 'cpu-compat') {
      compatibilityMode = 'cpu-compat'
    }
    this.timing.interactionBackend = wantsGpuWritingInteraction ? 'gpu-write-queue' : 'cpu-direct'
    if (wantsGpuWetnessSimulation) {
      const gpuPassOk = this.runGpuWetnessSimulationScaffoldPass(dt)
      this.timing.wetnessBackend = gpuPassOk ? 'gpu-sim' : 'cpu-grid-fallback'
      if (!gpuPassOk) {
        compatibilityMode = 'cpu-fallback'
        this.timing.gpuSimKernel = 'off'
      }
    } else {
      this.gpuInteractionWriteQueue.length = 0
      this.timing.gpuInteractionWritesQueued = 0
      this.timing.gpuInteractionWritesConsumed = 0
      this.timing.gpuInteractionWritesDropped = 0
      this.timing.gpuInteractionWritesCoalesced = 0
      this.timing.gpuInteractionPressure = 'low'
      this.timing.gpuInteractionWriteBudget = 128
      this.timing.gpuSimKernel = 'off'
    }
    this.timing.compatibilityMode = compatibilityMode
    if (imageResult?.fullField) {
      this.lastBaseWetnessSynced = this.fogLevel
    }
    fieldStats = this.surfaceWetnessField.getLastStats()
    if (imageResult?.fullField) {
      fieldStats.imageFullField = true
    }
    if (initialFrameDiag) {
      initialFrameDiag.postSmoothWetness = Number(this.surfaceWetnessField.getDisplayWetness() || 0)
      initialFrameDiag.smoothingPasses = fieldStats?.smoothingPasses || smoothPasses
      initialFrameDiag.smoothingStride = fieldStats?.smoothingStride || smoothingStride
      initialFrameDiag.smoothingSkippedByStride = Boolean(fieldStats?.smoothingSkippedByStride)
      initialFrameDiag.diffusionMs = Number(fieldStats?.diffusionMs || 0)
      initialFrameDiag.imageConvertMs = Number(fieldStats?.imageMs || 0)
      initialFrameDiag.runnerContinuityGapFraction = Number(this.timing.runnerCarveGapFraction || 0)
      initialFrameDiag.runnerContinuitySpacingRatioMean = Number(this.timing.runnerCarveSpacingRatioMean || 0)
      initialFrameDiag.runnerContinuitySpacingRatioMax = Number(this.timing.runnerCarveSpacingRatioMax || 0)
    }
    wetnessMs = performance.now() - wetnessStart
    this.wetnessFrameCounter += 1

    const overlayStart = performance.now()
    this.ctx.clearRect(0, 0, this.width, this.height)
    const viewMode = this.tuningConfig.debug.viewMode
    const splitCompareActive = viewMode === 'split-compare' || this.tuningConfig.debug.splitCompareEnabled
    const overlayBackendCompareActive = Boolean(this.tuningConfig.debug.overlayBackendCompareEnabled)

    if (overlayBackendCompareActive) {
      this.timing.overlayBackend = 'cpu-gpu-compare'
      this.drawOverlayBackendCompareView()
    } else if (splitCompareActive) {
      this.drawSplitCompareView()
    } else {
      if (viewMode !== 'fog-only') {
        this.drawBackground()
      }
      if (viewMode !== 'renderer-only' && !this.rendererOnlyDebug) {
        this.drawSurface()
      }
    }
    this.drawRendererDebugOverlay()

    if (this.tuningConfig.debug.freezeBackground && !this.backgroundFrozen) {
      this.captureBackgroundFrame()
      this.backgroundFrozen = true
    }
    overlayMs = performance.now() - overlayStart

    const engineMs = performance.now() - frameStart
    this.timing.avgFrameMs = this.timing.avgFrameMs > 0 ? this.timing.avgFrameMs * 0.92 + frameDeltaMs * 0.08 : frameDeltaMs
    this.timing.engineMs = this.timing.engineMs > 0 ? this.timing.engineMs * 0.85 + engineMs * 0.15 : engineMs
    this.timing.rendererMs = this.timing.rendererMs > 0 ? this.timing.rendererMs * 0.85 + rendererMs * 0.15 : rendererMs
    this.timing.wetnessMs = this.timing.wetnessMs > 0 ? this.timing.wetnessMs * 0.85 + wetnessMs * 0.15 : wetnessMs
    this.timing.overlayMs = this.timing.overlayMs > 0 ? this.timing.overlayMs * 0.85 + overlayMs * 0.15 : overlayMs
    const clearingMs = fieldStats?.clearingMs || 0
    const dropletProcessingMs = Math.max(0, dropletTotalMs - clearingMs)
    this.timing.dropletProcessingMs =
      this.timing.dropletProcessingMs > 0
        ? this.timing.dropletProcessingMs * 0.85 + dropletProcessingMs * 0.15
        : dropletProcessingMs
    this.timing.clearingMs = this.timing.clearingMs > 0 ? this.timing.clearingMs * 0.85 + clearingMs * 0.15 : clearingMs
    this.timing.diffusionMs =
      this.timing.diffusionMs > 0
        ? this.timing.diffusionMs * 0.85 + (fieldStats?.diffusionMs || 0) * 0.15
        : fieldStats?.diffusionMs || 0
    this.timing.imageConvertMs =
      this.timing.imageConvertMs > 0
        ? this.timing.imageConvertMs * 0.85 + (fieldStats?.imageMs || 0) * 0.15
        : fieldStats?.imageMs || 0

    if (this.sceneAgeSec - this.lastWetnessTrendSampleSec >= 1) {
      this.lastWetnessTrendSampleSec = this.sceneAgeSec
      this.wetnessTrendHistory.push({
        ageSec: this.sceneAgeSec,
        droplets: this.droplets.length,
        wetnessMs,
        activeRegionPixels: fieldStats?.activeRegionPixels || 0,
      })
      if (this.wetnessTrendHistory.length > 120) {
        this.wetnessTrendHistory.shift()
      }

      if (this.perfLogEnabled) {
        const latest = this.wetnessTrendHistory[this.wetnessTrendHistory.length - 1]
        console.log(
          `[wetness] age=${latest.ageSec.toFixed(1)}s droplets=${latest.droplets} wet=${latest.wetnessMs.toFixed(2)}ms active=${latest.activeRegionPixels}`,
        )
      }
    }

    const trendStart = this.wetnessTrendHistory[0]
    const trendEnd = this.wetnessTrendHistory[this.wetnessTrendHistory.length - 1]
    let wetnessTrendMsPerMin = 0
    if (trendStart && trendEnd && trendEnd.ageSec > trendStart.ageSec) {
      wetnessTrendMsPerMin = ((trendEnd.wetnessMs - trendStart.wetnessMs) / (trendEnd.ageSec - trendStart.ageSec)) * 60
    }

    const rendererState = this.raindropRenderer?.getDebugState?.() ?? null

    this.onStats?.({
      fog: this.fogLevel,
      droplets: this.droplets.length,
      writing: this.isWriting,
      renderer: {
        debugEnabled: this.rendererDebugEnabled,
        onlyRendererPass: this.rendererOnlyDebug,
        ready: this.raindropRendererReady,
        renderCalled: this.rendererDebugInfo.renderCalled,
        renderSucceeded: this.rendererDebugInfo.renderSucceeded,
        frameDeltaEnergy: this.rendererDebugInfo.frameDeltaEnergy,
        frameSampleReady: this.rendererDebugInfo.frameSampleReady,
        renderedDropletPixelCoverage: this.rendererDebugInfo.renderedDropletPixelCoverage,
        rendererVisiblePixelCoverage: this.rendererDebugInfo.rendererVisiblePixelCoverage,
        rendererAlphaMean: this.rendererDebugInfo.rendererAlphaMean,
        ...(rendererState || {}),
      },
      effective: {
        linkedMistDensity: this.tuningConfig.links.mistDensity,
        linkedFogSoftness: this.tuningConfig.links.fogSoftness,
        linkedRunnerInfluence: this.tuningConfig.links.largeRunnerInfluence,
        freezeRain: this.tuningConfig.debug.freezeRain,
        freezeBackground: this.tuningConfig.debug.freezeBackground,
        nativeSimulatorPath: true,
      },
      timing: {
        avgFrameMs: this.timing.avgFrameMs,
        engineMs: this.timing.engineMs,
        rendererMs: this.timing.rendererMs,
        wetnessMs: this.timing.wetnessMs,
        simulatedDropletCount: this.timing.simulatedDropletCount,
        surfaceDropletCount: this.timing.surfaceDropletCount,
        rendererSamplingSource: this.timing.rendererSamplingSource,
        rendererWetnessSampleMean: this.timing.rendererWetnessSampleMean,
        rendererWetnessSampleVariance: this.timing.rendererWetnessSampleVariance,
        rendererTrailSampleMean: this.timing.rendererTrailSampleMean,
        rendererRunnerSampleMean: this.timing.rendererRunnerSampleMean,
        rendererChannelCoverage: this.timing.rendererChannelCoverage,
        debugWetnessPeak: this.timing.debugWetnessPeak,
        debugTrailPeak: this.timing.debugTrailPeak,
        debugRunnerPeak: this.timing.debugRunnerPeak,
        rendererCarveCoverage: this.timing.rendererCarveCoverage,
        wetnessBackend: this.timing.wetnessBackend,
        interactionBackend: this.timing.interactionBackend,
        compatibilityMode: this.timing.compatibilityMode,
        gpuInteractionWritesQueued: this.timing.gpuInteractionWritesQueued,
        gpuInteractionWritesConsumed: this.timing.gpuInteractionWritesConsumed,
        gpuInteractionWritesDropped: this.timing.gpuInteractionWritesDropped,
        gpuInteractionWritesCoalesced: this.timing.gpuInteractionWritesCoalesced,
        gpuInteractionPressure: this.timing.gpuInteractionPressure,
        gpuInteractionWriteBudget: this.timing.gpuInteractionWriteBudget,
        runnerCarveSamples: this.timing.runnerCarveSamples,
        runnerCarveSegmentSamples: this.timing.runnerCarveSegmentSamples,
        runnerCarvePointSamples: this.timing.runnerCarvePointSamples,
        runnerCarveDistanceMean: this.timing.runnerCarveDistanceMean,
        runnerCarveDistanceMax: this.timing.runnerCarveDistanceMax,
        runnerCarveLastMode: this.timing.runnerCarveLastMode,
        runnerCarveLastDistance: this.timing.runnerCarveLastDistance,
        runnerCarveLastRadius: this.timing.runnerCarveLastRadius,
        runnerCarveLastStrength: this.timing.runnerCarveLastStrength,
        runnerCarveLastPrevX: this.timing.runnerCarveLastPrevX,
        runnerCarveLastPrevY: this.timing.runnerCarveLastPrevY,
        runnerCarveLastCurrX: this.timing.runnerCarveLastCurrX,
        runnerCarveLastCurrY: this.timing.runnerCarveLastCurrY,
        runnerCarveSpacingRatioMean: this.timing.runnerCarveSpacingRatioMean,
        runnerCarveSpacingRatioMax: this.timing.runnerCarveSpacingRatioMax,
        runnerCarveGapFraction: this.timing.runnerCarveGapFraction,
        runnerCarveDepthGainMean: this.timing.runnerCarveDepthGainMean,
        runnerCarvePostSmoothRetentionMean: this.timing.runnerCarvePostSmoothRetentionMean,
        runnerCarveRecoveryRatioMean: this.timing.runnerCarveRecoveryRatioMean,
        runnerCarveRecoveryLossMean: this.timing.runnerCarveRecoveryLossMean,
        runnerCarveFogAlphaMean: this.timing.runnerCarveFogAlphaMean,
        runnerCarveFogResponseRatioMean: this.timing.runnerCarveFogResponseRatioMean,
        runnerCarveFogDecayRatioMean: this.timing.runnerCarveFogDecayRatioMean,
        runnerCarveDiagnosticsPacketId: this.timing.runnerCarveDiagnosticsPacketId,
        wetnessFrameCounter: this.timing.wetnessFrameCounter,
        runnerCarveLastSpacingRatio: this.timing.runnerCarveLastSpacingRatio,
        runnerCarveLastBeforeDepth: this.timing.runnerCarveLastBeforeDepth,
        runnerCarveLastAfterDepth: this.timing.runnerCarveLastAfterDepth,
        runnerCarveLastPostSmoothDepth: this.timing.runnerCarveLastPostSmoothDepth,
        runnerCarveLastRecoveredDepth: this.timing.runnerCarveLastRecoveredDepth,
        runnerCarveLastFogAlpha: this.timing.runnerCarveLastFogAlpha,
        runnerCarveLastRecoveredFogAlpha: this.timing.runnerCarveLastRecoveredFogAlpha,
        gpuSimKernel: this.timing.gpuSimKernel,
        gpuSimReadbackMs: this.timing.gpuSimReadbackMs,
        cpuFogAlphaMean: this.timing.cpuFogAlphaMean,
        gpuFogAlphaMean: this.timing.gpuFogAlphaMean,
        gpuCpuAlphaDelta: this.timing.gpuCpuAlphaDelta,
        gpuCpuAlphaMae: this.timing.gpuCpuAlphaMae,
        cpuFogAlphaVariance: this.timing.cpuFogAlphaVariance,
        gpuFogAlphaVariance: this.timing.gpuFogAlphaVariance,
        gpuCpuVarianceDelta: this.timing.gpuCpuVarianceDelta,
        gpuCpuTileMaxMae: this.timing.gpuCpuTileMaxMae,
        gpuCpuTileHotspot: this.timing.gpuCpuTileHotspot,
        gpuParityGateStatus: this.timing.gpuParityGateStatus,
        gpuParityGateFailures: this.timing.gpuParityGateFailures,
        gpuOverlayUvMode: this.timing.gpuOverlayUvMode,
        gpuOverlayFogAlphaMean: this.timing.gpuOverlayFogAlphaMean,
        gpuOverlayFogAlphaMax: this.timing.gpuOverlayFogAlphaMax,
        gpuOverlayPresentTarget: this.timing.gpuOverlayPresentTarget,
        gpuOverlayPresentFramebuffer: this.timing.gpuOverlayPresentFramebuffer,
        gpuOverlayPresentSamples: this.timing.gpuOverlayPresentSamples,
        gpuOverlayPresentSceneSource: this.timing.gpuOverlayPresentSceneSource,
        gpuOverlayPresentClearRgba: this.timing.gpuOverlayPresentClearRgba,
        gpuOverlayPresentBlendEnabled: this.timing.gpuOverlayPresentBlendEnabled,
        gpuOverlayPresentBlendMode: this.timing.gpuOverlayPresentBlendMode,
        gpuOverlayPresentAlphaConvention: this.timing.gpuOverlayPresentAlphaConvention,
        gpuOverlayPresentContextAlpha: this.timing.gpuOverlayPresentContextAlpha,
        gpuOverlayPresentContextPremultiplied: this.timing.gpuOverlayPresentContextPremultiplied,
        overlayMs: this.timing.overlayMs,
        overlayBackend: this.timing.overlayBackend,
        dropletProcessingMs: this.timing.dropletProcessingMs,
        clearingMs: this.timing.clearingMs,
        diffusionMs: this.timing.diffusionMs,
        imageConvertMs: this.timing.imageConvertMs,
        sceneAgeSec: this.sceneAgeSec,
        wetnessTrendMsPerMin,
        wetnessResolutionPixels: this.fogCanvas.width * this.fogCanvas.height,
        wetnessResolutionLabel: `${this.fogCanvas.width}x${this.fogCanvas.height}`,
        activeRegionPixels: fieldStats?.activeRegionPixels || 0,
        activeRegionRect: fieldStats?.activeRegionRect || null,
        recoveryPixels: fieldStats?.recoveryPixels || 0,
        diffusionPixels: fieldStats?.diffusionPixels || 0,
        imagePixels: fieldStats?.imagePixels || 0,
        totalWetnessPixels: fieldStats?.totalPixels || this.fogCanvas.width * this.fogCanvas.height,
        recoveryFullField: Boolean(fieldStats?.recoveryFullField),
        diffusionFullField: Boolean(fieldStats?.diffusionFullField),
        imageFullField: Boolean(fieldStats?.imageFullField),
        smoothingStride: fieldStats?.smoothingStride || smoothingStride,
        fullRefreshIntervalFrames,
        smoothingSkippedByStride: Boolean(fieldStats?.smoothingSkippedByStride),
        smoothingPasses: fieldStats?.smoothingPasses || smoothPasses,
        trailOps: fieldStats?.trailOps || 0,
        clearAreaOps: fieldStats?.clearAreaOps || 0,
        setTuningConfigCalls: this.integrationCounters.setTuningConfigCalls,
        applyLiveSettingsCalls: this.integrationCounters.applyLiveSettingsCalls,
        simulationClockPhase: this.simulationClockAuthority.phase,
        simulationClockCurrentTimeSec: this.simulationClockAuthority.currentTimeSec,
        simulationClockLoopTimeSec: this.simulationClockAuthority.loopTimeSec,
        simulationClockFrameStepCount: this.simulationClockAuthority.frameStepCount,
        runtimeInputQueueDepth: Array.isArray(this.runtimeInputQueue) ? this.runtimeInputQueue.length : 0,
        runtimeInputEnqueuedCount: Number(this.runtimeInputAuthority.enqueuedCount || 0),
        runtimeInputConsumedCount: Number(this.runtimeInputAuthority.consumedCount || 0),
      },
      bootstrap: {
        rendererCreated: this.bootstrapInfo.rendererCreated,
        rendererAttached: this.bootstrapInfo.rendererAttached,
        initialWeatherApplied: this.bootstrapInfo.initialWeatherApplied,
        initialRainApplied: this.bootstrapInfo.initialRainApplied,
        initialFogApplied: this.bootstrapInfo.initialFogApplied,
        seededDropletCount: this.bootstrapInfo.seededDropletCount,
        firstVisibleRainFrame: this.bootstrapInfo.firstVisibleRainFrame,
        firstRenderFrameTime: this.bootstrapInfo.firstRenderFrameTime,
        refreshPath: this.bootstrapInfo.refreshPath,
        publishRestartPath: this.bootstrapInfo.publishRestartPath,
        adapterInitDropletsPerSeconds: this.bootstrapInfo.adapterInitDropletsPerSeconds ?? 0,
        wetnessLifecycleTrace: Array.isArray(this.bootstrapInfo.wetnessLifecycleTrace)
          ? this.bootstrapInfo.wetnessLifecycleTrace.map((entry) => ({ ...entry }))
          : [],
        setTuningLineageTrace: Array.isArray(this.bootstrapInfo.setTuningLineageTrace)
          ? this.bootstrapInfo.setTuningLineageTrace.map((entry) => ({ ...entry }))
          : [],
        canonicalPreStartBootstrap: this.bootstrapInfo.canonicalPreStartBootstrap
          ? { ...this.bootstrapInfo.canonicalPreStartBootstrap }
          : null,
        initialFrameDiagnostics: Array.isArray(this.bootstrapInfo.initialFrameDiagnostics)
          ? this.bootstrapInfo.initialFrameDiagnostics.map((entry) => ({ ...entry, sampledDrops: Array.isArray(entry.sampledDrops) ? entry.sampledDrops.map((drop) => ({ ...drop })) : [] }))
          : [],
        startupAuthority: this.getSessionStartupAuthoritySnapshot(),
        simulationClockAuthority: this.getSimulationClockSnapshot(),
        runtimeInputAuthority: this.getRuntimeInputAuthoritySnapshot(),
      },
    })

    this.animationFrame = requestAnimationFrame(this.animate)
  }

  captureBackgroundFrame() {
    if (!this.backgroundFreezeCtx) {
      return
    }

    this.backgroundFreezeCtx.clearRect(0, 0, this.width, this.height)
    if (this.raindropRendererReady && this.raindropRenderer?.canvas) {
      this.backgroundFreezeCtx.drawImage(this.raindropRenderer.canvas, 0, 0, this.width, this.height)
      return
    }

    if (!this.backgroundImage.complete || this.backgroundImage.naturalWidth === 0) {
      const gradient = this.backgroundFreezeCtx.createLinearGradient(0, 0, 0, this.height)
      gradient.addColorStop(0, '#1a2329')
      gradient.addColorStop(1, '#06090d')
      this.backgroundFreezeCtx.fillStyle = gradient
      this.backgroundFreezeCtx.fillRect(0, 0, this.width, this.height)
      return
    }

    const img = this.backgroundImage
    const scale = Math.max(this.width / img.naturalWidth, this.height / img.naturalHeight)
    const drawWidth = img.naturalWidth * scale
    const drawHeight = img.naturalHeight * scale
    const drawX = (this.width - drawWidth) / 2
    const drawY = (this.height - drawHeight) / 2
    this.backgroundFreezeCtx.drawImage(img, drawX, drawY, drawWidth, drawHeight)
  }

  getCanvasSnapshotDataUrl() {
    return this.canvas.toDataURL('image/png')
  }
}
