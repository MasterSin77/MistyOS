const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
import { RaindropFxRendererAdapter } from './RaindropFxRendererAdapter'
import { SurfaceWetnessField } from './SurfaceWetnessField'
import { DEFAULT_TUNING_CONFIG, deepClone, mergeDeep } from '../tuning/tuningConfig'

export class WetSurfaceEngine {
  constructor(canvas, { backgroundSrc, phase = 3, onStats, tuningConfig }) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.backgroundSrc = backgroundSrc
    this.phase = phase
    this.onStats = onStats

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

    this.isWriting = false
    this.pointerActive = false
    this.lastPointer = null
    this.pointerPhase = Math.random() * Math.PI * 2

    const query = new URLSearchParams(window.location.search)
    this.rendererDebugEnabled = query.get('rdfxDebug') === '1'
    this.rendererOnlyDebug = query.get('rdfxOnly') === '1'
    this.rendererDebugInfo = {
      renderCalled: false,
      renderSucceeded: false,
      frameDeltaEnergy: 0,
      frameSampleReady: false,
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
      wetnessBackend: 'cpu-grid',
      interactionBackend: 'cpu-direct',
      compatibilityMode: 'cpu-compat',
      gpuInteractionWritesQueued: 0,
      gpuInteractionWritesConsumed: 0,
      gpuInteractionWritesDropped: 0,
      gpuInteractionWritesCoalesced: 0,
      gpuInteractionPressure: 'low',
      gpuInteractionWriteBudget: 128,
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

    this.resize = this.resize.bind(this)
    this.animate = this.animate.bind(this)
    this.onPointerDown = this.onPointerDown.bind(this)
    this.onPointerMove = this.onPointerMove.bind(this)
    this.onPointerUp = this.onPointerUp.bind(this)
  }

  setTuningConfig(nextConfig) {
    this.integrationCounters.setTuningConfigCalls += 1
    const merged = mergeDeep(DEFAULT_TUNING_CONFIG, nextConfig || {})
    const signature = JSON.stringify(merged)
    if (signature === this.tuningSignature) {
      return
    }

    this.tuningSignature = signature
    this.tuningConfig = merged
    this.applyLiveSettings()
  }

  getTuningConfig() {
    return deepClone(this.tuningConfig)
  }

  applyLiveSettings() {
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
    this.running = true
    this.resize()
    this.initializeRaindropRenderer()

    window.addEventListener('resize', this.resize)
    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    this.canvas.addEventListener('pointermove', this.onPointerMove)
    this.canvas.addEventListener('pointerup', this.onPointerUp)
    this.canvas.addEventListener('pointerleave', this.onPointerUp)
    this.canvas.addEventListener('pointercancel', this.onPointerUp)

    this.lastTime = performance.now()
    this.animationFrame = requestAnimationFrame(this.animate)
  }

  stop() {
    this.running = false

    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame)
      this.animationFrame = null
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
    const adapter = new RaindropFxRendererAdapter({
      width: this.width || 1,
      height: this.height || 1,
      background: this.backgroundSrc,
      tuningConfig: this.tuningConfig,
    })

    this.raindropRenderer = adapter

    try {
      await adapter.init()
      if (this.raindropRenderer !== adapter) {
        adapter.destroy()
        return
      }
      this.raindropRendererReady = true
      await adapter.setBackground(this.backgroundSrc)
      const scaleX = this.width / this.fogCanvas.width
      const scaleY = this.height / this.fogCanvas.height
      adapter.setInputScale(scaleX, scaleY)
      adapter.setTuningConfig(this.tuningConfig)
    } catch {
      if (this.raindropRenderer === adapter) {
        this.raindropRendererReady = false
      }
    }
  }

  resize() {
    const dpr = window.devicePixelRatio || 1
    const width = Math.max(1, Math.floor(window.innerWidth))
    const height = Math.max(1, Math.floor(window.innerHeight))

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
      return performance.now() - started
    }

    const toFogX = this.fogCanvas.width / Math.max(1, this.width)
    const toFogY = this.fogCanvas.height / Math.max(1, this.height)
    const nextState = new Map()
    const motionEpsilon = 0.35

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
      const previous = this.previousRendererDropState.get(id)
      const headClearRadius = radiusFog * headRadiusScale

      if (previous) {
        const headDx = fx - previous.x
        const headDy = fy - previous.y
        const headDistance = Math.hypot(headDx, headDy)

        // Continuous capsule clearing between frame samples removes beaded runner artifacts.
        if (headDistance > motionEpsilon) {
          const headDistanceGain = clamp(headDistance / Math.max(0.0001, radiusFog * 2.4), 0, 1)
          const headMotionGain = clamp(0.56 + headDistanceGain * 0.44, 0.5, 1)
          this.disturbFogTrail(previous.x, previous.y, fx, fy, headClearRadius * 0.94, headStrength * headMotionGain, {
            trailMagnitude: 0.19,
            runnerMagnitude: 0.08,
            gridMagnitude: 0.035,
            taperStart: 0.78,
            taperEnd: 1.04,
            accumulationClamp: 0.48,
            runnerRadiusScale: 0.82,
            gridRadiusScale: 0.74,
          }, 'droplet')
        } else {
          this.clearFogBlob(fx, fy, headClearRadius, headStrength, 'droplet')
        }
      } else {
        this.clearFogBlob(fx, fy, headClearRadius, headStrength, 'droplet')
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
            runnerMagnitude: 0.14,
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

    this.previousRendererDropState = nextState
    this.droplets = rendererDrops
    return performance.now() - started
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
    if (this.tuningConfig.debug?.useGpuOverlayPrototype) {
      const renderedByGpu = this.drawSurfaceGpuRuntime()
      if (renderedByGpu) {
        this.timing.overlayBackend = this.tuningConfig.debug?.useGpuFogCompositing
          ? 'gpu-fog-composite'
          : 'gpu-overlay'
        return
      }
    }

    this.timing.overlayBackend = 'cpu-2d'
    this.drawSurfaceCpu()
  }

  drawSurfaceCpu() {
    const overlayAlpha = clamp(this.tuningConfig.debug.compositeOverlayStrength ?? 1, 0, 1)
    if (overlayAlpha <= 0) {
      return
    }

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
        uniform sampler2D u_texture;
        uniform vec2 u_texel;
        uniform float u_alpha;
        uniform float u_overlayAlpha;
        uniform float u_tintStrength;
        uniform float u_fillBoost;
        uniform float u_useFogCompositing;

        vec3 mixTint(vec2 uv) {
          float t = clamp((uv.x + uv.y) * 0.5, 0.0, 1.0);
          vec3 tintA = vec3(194.0 / 255.0, 215.0 / 255.0, 240.0 / 255.0);
          vec3 tintB = vec3(136.0 / 255.0, 166.0 / 255.0, 200.0 / 255.0);
          return mix(tintA, tintB, t);
        }

        void main() {
          // Upload path uses UNPACK_FLIP_Y_WEBGL=true, so sampling stays in straight v_uv space.
          // Sampling with an extra Y flip here would invert presentation and pointer-written strokes.
          vec4 texCenter = texture2D(u_texture, v_uv);
          // Reconstruct softer edge falloff from the fog alpha field without extra blur passes.
          float fogFieldAlpha = smoothstep(0.02, 0.98, clamp(texCenter.a, 0.0, 1.0));
          float fogA = clamp(fogFieldAlpha * u_alpha, 0.0, 1.0);
          if (u_useFogCompositing < 0.5) {
            gl_FragColor = vec4(texCenter.rgb, fogA);
            return;
          }

          // Fog compositing path is alpha-masked so non-fog pixels remain unchanged.
          // 1) fog contribution is masked by fog alpha
          // 2) tint is applied only inside the fog mask
          // 3) fill boost is also applied only inside the fog mask
          vec3 fogPremul = texCenter.rgb * fogA;

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
    if (!texture) {
      gl.deleteBuffer(positionBuffer)
      gl.deleteProgram(program)
      return null
    }
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    this.gpuOverlay = {
      canvas,
      gl,
      contextAttributes: gl.getContextAttributes?.() || null,
      program,
      positionBuffer,
      texture,
      positionLoc: gl.getAttribLocation(program, 'a_position'),
      alphaLoc: gl.getUniformLocation(program, 'u_alpha'),
      texelLoc: gl.getUniformLocation(program, 'u_texel'),
      overlayAlphaLoc: gl.getUniformLocation(program, 'u_overlayAlpha'),
      tintStrengthLoc: gl.getUniformLocation(program, 'u_tintStrength'),
      fillBoostLoc: gl.getUniformLocation(program, 'u_fillBoost'),
      useFogCompositingLoc: gl.getUniformLocation(program, 'u_useFogCompositing'),
      texLoc: gl.getUniformLocation(program, 'u_texture'),
    }
    return this.gpuOverlay
  }

  drawSurfaceGpuRuntime() {
    const overlayAlpha = clamp(this.tuningConfig.debug.compositeOverlayStrength ?? 1, 0, 1)
    if (overlayAlpha <= 0) {
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
      texture,
      positionBuffer,
      positionLoc,
      alphaLoc,
      texelLoc,
      overlayAlphaLoc,
      tintStrengthLoc,
      fillBoostLoc,
      useFogCompositingLoc,
      texLoc,
    } = runtime
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
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.fogCanvas)
    gl.uniform1i(texLoc, 0)
    gl.uniform2f(texelLoc, 1 / Math.max(1, this.fogCanvas.width), 1 / Math.max(1, this.fogCanvas.height))
    gl.uniform1f(alphaLoc, fogAlpha * overlayAlpha)
    gl.uniform1f(overlayAlphaLoc, overlayAlpha)
    gl.uniform1f(tintStrengthLoc, tintStrength)
    gl.uniform1f(fillBoostLoc, fillBoost)
    gl.uniform1f(useFogCompositingLoc, useFogCompositing ? 1 : 0)
    gl.disable(gl.BLEND)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLES, 0, 6)

    // Lightweight diagnostics for parity debugging in HUD/captures.
    this.timing.gpuOverlayUvMode = 'flip-upload'
    if (this.fogImageData?.data) {
      const data = this.fogImageData.data
      let alphaSum = 0
      let alphaMax = 0
      const pixelCount = Math.max(1, data.length / 4)
      for (let i = 3; i < data.length; i += 4) {
        const a = data[i] / 255
        alphaSum += a
        if (a > alphaMax) alphaMax = a
      }
      this.timing.gpuOverlayFogAlphaMean = alphaSum / pixelCount
      this.timing.gpuOverlayFogAlphaMax = alphaMax
    }

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
    this.timing.gpuOverlayPresentSamples = 'fog-texture-only'
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
      return
    }

    let delta = 0
    for (let i = 0; i < data.length; i += 16) {
      delta += Math.abs(data[i] - this.previousProbeSample[i])
      delta += Math.abs(data[i + 1] - this.previousProbeSample[i + 1])
      delta += Math.abs(data[i + 2] - this.previousProbeSample[i + 2])
    }

    this.rendererDebugInfo.frameDeltaEnergy = delta
    this.rendererDebugInfo.frameSampleReady = true
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

    const dt = clamp((now - this.lastTime) / 1000, 0, 0.08)
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
    this.surfaceWetnessField.beginFrame()
    const baseDrift = Math.abs(this.fogLevel - this.lastBaseWetnessSynced)
    const fullRefreshIntervalFrames = Math.max(
      30,
      Math.round(this.tuningConfig.debug?.wetnessFullRefreshIntervalFrames ?? 120),
    )
    const fullRefresh =
      baseDrift >= this.baseWetnessSyncThreshold || this.wetnessFrameCounter % fullRefreshIntervalFrames === 0
    this.surfaceWetnessField.addCondensation(dt, { fullField: fullRefresh })
    this.fogLevel = this.surfaceWetnessField.getDisplayWetness()
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

    const smoothPasses = Math.max(1, Math.round(this.tuningConfig.fogSurface.smoothingPassCount))
    const smoothingStride = Math.max(1, Math.round(this.tuningConfig.debug?.wetnessSmoothingStride ?? 1))
    const regionOnlySmoothing = this.tuningConfig.debug?.wetnessRegionOnlySmoothing !== false
    this.surfaceWetnessField.smooth(dt, smoothPasses, {
      stride: smoothingStride,
      regionOnly: regionOnlySmoothing,
    })
    const imageResult = this.syncFogCanvasFromWetnessField({ fullRefresh })
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
        wetnessBackend: this.timing.wetnessBackend,
        interactionBackend: this.timing.interactionBackend,
        compatibilityMode: this.timing.compatibilityMode,
        gpuInteractionWritesQueued: this.timing.gpuInteractionWritesQueued,
        gpuInteractionWritesConsumed: this.timing.gpuInteractionWritesConsumed,
        gpuInteractionWritesDropped: this.timing.gpuInteractionWritesDropped,
        gpuInteractionWritesCoalesced: this.timing.gpuInteractionWritesCoalesced,
        gpuInteractionPressure: this.timing.gpuInteractionPressure,
        gpuInteractionWriteBudget: this.timing.gpuInteractionWriteBudget,
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
