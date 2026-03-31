const scriptState = {
  promise: null,
}

const loadRaindropFxScript = () => {
  if (window.RaindropFX) {
    return Promise.resolve()
  }

  if (scriptState.promise) {
    return scriptState.promise
  }

  scriptState.promise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-raindropfx="true"]')
    if (existing) {
      if (window.RaindropFX) {
        resolve()
        return
      }

      // Existing tag may already be in a completed but failed state; avoid hanging forever.
      const settledByState = () => {
        if (window.RaindropFX) {
          resolve()
        } else {
          reject(new Error('RaindropFX script tag exists but global constructor is unavailable.'))
        }
      }

      const readyState = existing.readyState
      if (readyState === 'loaded' || readyState === 'complete') {
        settledByState()
        return
      }

      existing.addEventListener('load', settledByState, { once: true })
      existing.addEventListener('error', () => reject(new Error('Failed to load RaindropFX bundle.')), { once: true })
      return
    }

    const script = document.createElement('script')
    script.src = '/vendor/raindropfx-bundle.js'
    script.async = true
    script.dataset.raindropfx = 'true'
    script.onload = () => {
      if (window.RaindropFX) {
        resolve()
        return
      }
      reject(new Error('RaindropFX bundle loaded but did not define window.RaindropFX.'))
    }
    script.onerror = () => reject(new Error('Failed to load RaindropFX bundle.'))
    document.body.appendChild(script)
  })

  return scriptState.promise
}

const resetRaindropFxScriptState = () => {
  scriptState.promise = null
  const existing = document.querySelector('script[data-raindropfx="true"]')
  if (existing) {
    existing.remove()
  }
  try {
    delete window.RaindropFX
  } catch {
    window.RaindropFX = undefined
  }
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const rangeTuple = (minValue, maxValue, lowerBound, upperBound) => {
  const min = clamp(toNumber(minValue, lowerBound), lowerBound, upperBound)
  const max = clamp(toNumber(maxValue, min), min, upperBound)
  return [min, max]
}

const collectEntityList = (value) => {
  if (!value) {
    return []
  }
  if (Array.isArray(value)) {
    return value
  }
  if (typeof value.length === 'number') {
    return Array.from(value)
  }
  if (value instanceof Set) {
    return Array.from(value.values())
  }
  if (value instanceof Map) {
    return Array.from(value.values())
  }
  if (typeof value.values === 'function') {
    try {
      return Array.from(value.values())
    } catch {
      return []
    }
  }
  return []
}

// Lazy-load diagnostics to avoid circular dependencies
let BaselineSeedBehaviorDiagnostics = null
async function getBaselineSeedBehaviorDiagnosticsClass() {
  if (BaselineSeedBehaviorDiagnostics) return BaselineSeedBehaviorDiagnostics
  try {
    const mod = await import('./baselineSeedBehaviorDiagnostics.js')
    BaselineSeedBehaviorDiagnostics = mod.BaselineSeedBehaviorDiagnostics
    return BaselineSeedBehaviorDiagnostics
  } catch (e) {
    console.warn('[RaindropFxRendererAdapter] Could not load diagnostics module:', e.message)
    return null
  }
}

export class RaindropFxRendererAdapter {
  constructor({ width, height, background, tuningConfig }) {
    this.width = width
    this.height = height
    this.background = background
    this.ready = false
    this.instance = null
    this.inputScale = { x: 1, y: 1 }
    this.flipYAxis = true
    this.lastSimulatorSnapshot = []
    this.tuningConfig = tuningConfig || null
    this.entityIdByRef = new WeakMap()
    this.nextEntityId = 1
    const query = new URLSearchParams(window.location.search)
    this.nativeEntitiesOnlyDebug = query.get('rdfxNativeOnly') === '1'
    this.baselineSeedDebugEnabled = query.get('rdfxBaselineSeedDebug') === '1'
    this.sizePipelineProofEnabled = query.get('rdfxSizeProof') === '1' || this.baselineSeedDebugEnabled
    this.spawnSizeOverrideMin = Number.isFinite(Number(query.get('rdfxSpawnSizeMin'))) ? Number(query.get('rdfxSpawnSizeMin')) : null
    this.spawnSizeOverrideMax = Number.isFinite(Number(query.get('rdfxSpawnSizeMax'))) ? Number(query.get('rdfxSpawnSizeMax')) : null
    this.diagnostics = null
    this.sizePipelineProof = {
      enabled: this.sizePipelineProofEnabled,
      hooksInstalled: false,
      spawnSamples: [],
      renderSamples: [],
      droppedSpawnSamples: 0,
      droppedRenderSamples: 0,
      spawnSampleLimit: 160,
      renderSampleLimit: 160,
      maxSamplesPerFrame: 6,
      firstSeenByRef: new WeakMap(),
      patchState: {
        spawnPatched: false,
        drawPatched: false,
      },
    }
    this.debug = {
      scriptLoaded: false,
      initStarted: false,
      initCompleted: false,
      renderCalls: 0,
      lastInputCount: 0,
      simulatorRaindropCount: 0,
      simulatorEntityField: 'simulator.raindrops',
      simulatorUpdateReturnType: 'unknown',
      simulatorUpdateReturnedCount: 0,
      rendererInputSource: 'simulator.raindrops',
      nativeEntitiesOnlyDebug: this.nativeEntitiesOnlyDebug,
      simulatorSpawnInterval: null,
      simulatorSpawnLimit: null,
      proceduralDropletsPerSecond: null,
      proceduralMistEnabled: null,
      frameDt: 0,
      lastFrameTotal: 0,
      adapterSimulationTimeMs: 0,
      adapterGlStateResetTimeMs: 0,
      adapterRendererDrawTimeMs: 0,
      adapterFrameTimeMs: 0,
      baselineSeedGroupsApplied: null,
      baselineSeedSimulatorOptionSnapshot: null,
      baselineSeedUnsupportedControls: null,
      baselineSeedDiagnosticsEnabled: this.baselineSeedDebugEnabled,
      sizePipelineProofEnabled: this.sizePipelineProofEnabled,
      lastError: null,
      glState: {
        viewport: [0, 0, width, height],
        canvasWidth: width,
        canvasHeight: height,
        scissorTestEnabled: null,
        lastResetReason: 'constructor',
      },
    }
    this.glStateLogCount = 0
    this.canvas = document.createElement('canvas')
    this.canvas.width = width
    this.canvas.height = height
  }

  getWebGLContext() {
    const candidates = [
      this.instance?.renderer?.renderer?.gl,
      this.instance?.renderer?.gl,
      this.instance?.renderer?.renderer?.ctx?.gl,
      this.instance?.renderer?.ctx?.gl,
    ]

    for (const candidate of candidates) {
      if (candidate && typeof candidate.viewport === 'function') {
        return candidate
      }
    }

    const fallback = this.canvas?.getContext?.('webgl2') || this.canvas?.getContext?.('webgl')
    return fallback && typeof fallback.viewport === 'function' ? fallback : null
  }

  getCompositeSourceCanvas() {
    const expectedWidth = Math.max(1, Math.floor(this.width || this.canvas?.width || 1))
    const expectedHeight = Math.max(1, Math.floor(this.height || this.canvas?.height || 1))
    const isUsableCanvas = (canvas) => {
      return Boolean(
        canvas
        && typeof canvas.width === 'number'
        && typeof canvas.height === 'number'
        && canvas.width > 0
        && canvas.height > 0
      )
    }

    // Keep the adapter-owned canvas authoritative for 2D compositing.
    // Internal renderer canvases can survive remounts in stale states and leak wedge artifacts.
    if (isUsableCanvas(this.canvas)) {
      const widthMatches = Math.abs(this.canvas.width - expectedWidth) <= 1
      const heightMatches = Math.abs(this.canvas.height - expectedHeight) <= 1
      if (widthMatches && heightMatches) {
        return {
          source: 'adapter.canvas',
          canvas: this.canvas,
        }
      }
    }

    const candidates = [
      {
        source: 'renderer.renderer.gl.canvas',
        canvas: this.instance?.renderer?.renderer?.gl?.canvas,
      },
      {
        source: 'renderer.gl.canvas',
        canvas: this.instance?.renderer?.gl?.canvas,
      },
      {
        source: 'renderer.renderer.ctx.canvas',
        canvas: this.instance?.renderer?.renderer?.ctx?.canvas,
      },
      {
        source: 'renderer.ctx.canvas',
        canvas: this.instance?.renderer?.ctx?.canvas,
      },
      {
        source: 'adapter.canvas',
        canvas: this.canvas,
      },
    ]

    for (const candidate of candidates) {
      const canvas = candidate.canvas
      if (isUsableCanvas(canvas)) {
        return {
          source: candidate.source,
          canvas,
        }
      }
    }

    return {
      source: 'none',
      canvas: null,
    }
  }

  resetRenderState(reason = 'unknown') {
    const gl = this.getWebGLContext()
    const compositeSource = this.getCompositeSourceCanvas()
    const activeCanvas = compositeSource.canvas || this.canvas
    const width = Math.max(1, Math.floor(activeCanvas?.width || this.width || 1))
    const height = Math.max(1, Math.floor(activeCanvas?.height || this.height || 1))

    if (!gl) {
      this.debug.glState = {
        viewport: [0, 0, width, height],
        canvasWidth: width,
        canvasHeight: height,
        drawingBufferWidth: width,
        drawingBufferHeight: height,
        scissorTestEnabled: null,
        framebufferBinding: 'unavailable',
        compositeSource: compositeSource.source,
        compositeCanvasMatchesAdapter: activeCanvas === this.canvas,
        lastResetReason: reason,
      }
      return false
    }

    this.instance?.renderer?.renderer?.use?.()

    if (typeof gl.bindFramebuffer === 'function') {
      if (typeof gl.DRAW_FRAMEBUFFER === 'number') {
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
      }
      if (typeof gl.READ_FRAMEBUFFER === 'number') {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    }
    if (typeof gl.bindRenderbuffer === 'function') {
      gl.bindRenderbuffer(gl.RENDERBUFFER, null)
    }
    if (typeof gl.bindVertexArray === 'function') {
      gl.bindVertexArray(null)
    }
    if (typeof gl.useProgram === 'function') {
      gl.useProgram(null)
    }

    gl.viewport(0, 0, width, height)
    if (typeof gl.disable === 'function' && typeof gl.CULL_FACE === 'number') {
      gl.disable(gl.CULL_FACE)
    }
    if (typeof gl.disable === 'function' && typeof gl.SCISSOR_TEST === 'number') {
      gl.disable(gl.SCISSOR_TEST)
    }
    if (typeof gl.scissor === 'function') {
      gl.scissor(0, 0, width, height)
    }
    if (typeof gl.colorMask === 'function') {
      gl.colorMask(true, true, true, true)
    }
    if (typeof gl.depthMask === 'function') {
      gl.depthMask(true)
    }
    if (typeof gl.clearDepth === 'function') {
      gl.clearDepth(1)
    }
    gl.clearColor(0, 0, 0, 0)
    let clearMask = gl.COLOR_BUFFER_BIT
    if (typeof gl.DEPTH_BUFFER_BIT === 'number') {
      clearMask |= gl.DEPTH_BUFFER_BIT
    }
    gl.clear(clearMask)

    const viewport = typeof gl.getParameter === 'function'
      ? Array.from(gl.getParameter(gl.VIEWPORT) || [0, 0, width, height])
      : [0, 0, width, height]
    const scissorTestEnabled = typeof gl.isEnabled === 'function' && typeof gl.SCISSOR_TEST === 'number'
      ? gl.isEnabled(gl.SCISSOR_TEST)
      : null
    const framebufferBinding = typeof gl.getParameter === 'function' && typeof gl.FRAMEBUFFER_BINDING === 'number'
      ? (gl.getParameter(gl.FRAMEBUFFER_BINDING) ? 'custom' : 'default')
      : 'unknown'

    this.debug.glState = {
      viewport,
      canvasWidth: width,
      canvasHeight: height,
      drawingBufferWidth: Number(gl.drawingBufferWidth || width),
      drawingBufferHeight: Number(gl.drawingBufferHeight || height),
      scissorTestEnabled,
      framebufferBinding,
      compositeSource: compositeSource.source,
      compositeCanvasMatchesAdapter: activeCanvas === this.canvas,
      lastResetReason: reason,
    }

    if (this.glStateLogCount < 8 || reason.includes('destroy')) {
      console.info('[RaindropFxRendererAdapter][render-reset]', {
        reason,
        viewport,
        canvasWidth: width,
        canvasHeight: height,
        drawingBufferWidth: Number(gl.drawingBufferWidth || width),
        drawingBufferHeight: Number(gl.drawingBufferHeight || height),
        scissorTestEnabled,
        framebufferBinding,
        compositeSource: compositeSource.source,
        compositeCanvasMatchesAdapter: activeCanvas === this.canvas,
      })
      this.glStateLogCount += 1
    }

    return true
  }

  async init() {
    this.debug.initStarted = true
    try {
      await loadRaindropFxScript()
      this.debug.scriptLoaded = true

      const rendererSettings = this.tuningConfig?.renderer || {}
      this.instance = new window.RaindropFX({
        canvas: this.canvas,
        width: this.width,
        height: this.height,
        background: this.background,
        mist: this.nativeEntitiesOnlyDebug ? false : rendererSettings.mistEnabled ?? true,
        mistColor: [
          rendererSettings.mistColorR ?? 0.58,
          rendererSettings.mistColorG ?? 0.68,
          rendererSettings.mistColorB ?? 0.78,
          rendererSettings.mistColorA ?? 0.055,
        ],
        mistTime: rendererSettings.mistTime ?? 16,
        dropletsPerSeconds: this.nativeEntitiesOnlyDebug ? 0 : rendererSettings.dropletsPerSeconds ?? 320,
        dropletSize: this.nativeEntitiesOnlyDebug
          ? [0, 0]
          : [rendererSettings.dropletSizeMin ?? 8, rendererSettings.dropletSizeMax ?? 22],
        raindropCompose: rendererSettings.raindropCompose ?? 'smoother',
        raindropLightPos: [
          rendererSettings.raindropLightPosX ?? -0.6,
          rendererSettings.raindropLightPosY ?? 1.2,
          rendererSettings.raindropLightPosZ ?? 2.0,
          0,
        ],
        raindropDiffuseLight: [
          rendererSettings.raindropDiffuseLightR ?? 0.34,
          rendererSettings.raindropDiffuseLightG ?? 0.36,
          rendererSettings.raindropDiffuseLightB ?? 0.4,
        ],
        raindropSpecularLight: [
          rendererSettings.raindropSpecularLightR ?? 1,
          rendererSettings.raindropSpecularLightG ?? 1,
          rendererSettings.raindropSpecularLightB ?? 1,
        ],
        raindropSpecularShininess: rendererSettings.raindropSpecularShininess ?? 190,
        raindropLightBump: rendererSettings.raindropLightBump ?? 1.6,
      })

      // The bundle relies on a global GL context registry (Wt/L); bind it explicitly
      // before any asset init to avoid "without global gl context" failures.
      this.instance.renderer?.renderer?.use?.()
  this.resetRenderState('init:post-use')

      const options = this.instance.options || {}
      this.debug.simulatorSpawnInterval = options.spawnInterval ?? null
      this.debug.simulatorSpawnLimit = options.spawnLimit ?? null
      this.debug.proceduralDropletsPerSecond = options.dropletsPerSeconds ?? null
      this.debug.proceduralMistEnabled = options.mist ?? null

      // Use only the original rendering pipeline and keep simulation external.
      try {
        await this.instance.renderer.loadAssets()
      } catch (error) {
        // Optional media (for example, ambient audio/background assets) can fail in
        // local dev without preventing the rain simulation from running.
        this.debug.assetLoadWarning = error instanceof Error ? error.message : String(error)
      }
      this.ready = true
      this.debug.initCompleted = true
      this.debug.lastError = null
      // Apply latest canvas size after async init so resize callbacks that fired
      // during boot do not call into a half-initialized bundle state.
      this.instance.resize(this.width, this.height)
      this.resetRenderState('init:post-resize')
      this.applyRuntimeSettings()
      this.installSizePipelineProofHooks()
    } catch (error) {
      this.ready = false
      this.debug.initCompleted = false
      this.debug.lastError = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  resize(width, height) {
    this.width = Math.max(1, Math.floor(width))
    this.height = Math.max(1, Math.floor(height))
    this.canvas.width = this.width
    this.canvas.height = this.height

    if (this.instance && this.ready) {
      this.instance.resize(this.width, this.height)
      this.resetRenderState('resize')
    }
  }

  primeDisplaySurface(reason = 'unknown') {
    if (!this.instance || !this.ready) {
      return false
    }

    const renderer = this.instance.renderer
    const simulatorRaindrops = collectEntityList(this.instance.simulator?.raindrops)
    if (!renderer || typeof renderer.render !== 'function') {
      return false
    }

    try {
      this.resetRenderState(`prime:${reason}:pre`)
      renderer.render(simulatorRaindrops, { dt: 1 / 60, total: 0 })
      this.debug.lastPrimeReason = reason
      return true
    } catch (error) {
      this.debug.lastPrimeReason = `${reason}:failed`
      this.debug.lastError = error instanceof Error ? error.message : String(error)
      return false
    }
  }

  async setBackground(background) {
    this.background = background
    if (this.instance) {
      await this.instance.setBackground(background)
      this.resetRenderState('background')
      this.primeDisplaySurface('background')
    }
  }

  setInputScale(scaleX, scaleY) {
    this.inputScale.x = clamp(scaleX || 1, 0.001, 1000)
    this.inputScale.y = clamp(scaleY || 1, 0.001, 1000)
  }

  setTuningConfig(nextConfig) {
    this.tuningConfig = nextConfig || this.tuningConfig
    this.applyRuntimeSettings()
  }

  applyRuntimeSettings() {
    if (!this.instance) {
      return
    }

    const settings = this.tuningConfig?.renderer || {}
    const options = this.instance.options || {}
    const mistEnabled = this.nativeEntitiesOnlyDebug ? false : settings.mistEnabled ?? true
    const dropletsPerSeconds = this.nativeEntitiesOnlyDebug ? 0 : settings.dropletsPerSeconds ?? options.dropletsPerSeconds ?? 320

    options.mist = mistEnabled
    options.mistTime = settings.mistTime ?? options.mistTime ?? 16
    options.mistColor = [
      settings.mistColorR ?? options.mistColor?.[0] ?? 0.58,
      settings.mistColorG ?? options.mistColor?.[1] ?? 0.68,
      settings.mistColorB ?? options.mistColor?.[2] ?? 0.78,
      settings.mistColorA ?? options.mistColor?.[3] ?? 0.055,
    ]
    options.dropletsPerSeconds = dropletsPerSeconds
    options.dropletSize = [
      settings.dropletSizeMin ?? options.dropletSize?.[0] ?? 8,
      settings.dropletSizeMax ?? options.dropletSize?.[1] ?? 22,
    ]
    options.raindropCompose = settings.raindropCompose ?? options.raindropCompose ?? 'smoother'
    options.raindropLightPos = [
      settings.raindropLightPosX ?? options.raindropLightPos?.[0] ?? -0.6,
      settings.raindropLightPosY ?? options.raindropLightPos?.[1] ?? 1.2,
      settings.raindropLightPosZ ?? options.raindropLightPos?.[2] ?? 2,
      0,
    ]
    options.raindropDiffuseLight = [
      settings.raindropDiffuseLightR ?? options.raindropDiffuseLight?.[0] ?? 0.34,
      settings.raindropDiffuseLightG ?? options.raindropDiffuseLight?.[1] ?? 0.36,
      settings.raindropDiffuseLightB ?? options.raindropDiffuseLight?.[2] ?? 0.4,
    ]
    options.raindropSpecularLight = [
      settings.raindropSpecularLightR ?? options.raindropSpecularLight?.[0] ?? 1,
      settings.raindropSpecularLightG ?? options.raindropSpecularLight?.[1] ?? 1,
      settings.raindropSpecularLightB ?? options.raindropSpecularLight?.[2] ?? 1,
    ]
    options.raindropSpecularShininess = settings.raindropSpecularShininess ?? options.raindropSpecularShininess ?? 190
    options.raindropLightBump = settings.raindropLightBump ?? options.raindropLightBump ?? 1.6

    this.instance.options = options
    if (this.instance.simulator?.options) {
      this.instance.simulator.options = {
        ...this.instance.simulator.options,
        mist: options.mist,
        mistTime: options.mistTime,
        mistColor: [...options.mistColor],
        dropletsPerSeconds: options.dropletsPerSeconds,
        dropletSize: [...options.dropletSize],
      }

      this.applyBaselineSeedBehaviorToSimulatorOptions(this.instance.simulator.options)

      // Record startup snapshot for baseline-seed debug mode if enabled
      if (this.baselineSeedDebugEnabled) {
        this._recordBaselineSeedDiagnosticsStartupSnapshot(this.instance.simulator.options)
      }
    }

    this.debug.proceduralDropletsPerSecond = options.dropletsPerSeconds ?? null
    this.debug.proceduralMistEnabled = options.mist ?? null
  }

  applyBaselineSeedBehaviorToSimulatorOptions(simOptions) {
    const baselineBehavior = this.tuningConfig?.raindropFxBaselineBehavior?.behaviorParameters
    if (!baselineBehavior || !simOptions || typeof simOptions !== 'object') {
      return
    }

    const spawnRate = clamp(toNumber(baselineBehavior.spawnModel?.spatial?.globalRatePerSecond, 62), 1, 1200)
    const burstAmplitude = clamp(toNumber(baselineBehavior.spawnModel?.temporal?.burstiness?.amplitude, 0.23), 0, 1)
    const minInterArrivalMs = clamp(toNumber(baselineBehavior.spawnModel?.temporal?.interArrivalClampMs?.min, 6), 1, 1000)
    const maxInterArrivalMs = clamp(toNumber(baselineBehavior.spawnModel?.temporal?.interArrivalClampMs?.max, 140), minInterArrivalMs, 2000)
    const baseInterArrivalSec = 1 / spawnRate
    const burstScale = 1 + burstAmplitude * 0.5
    const spawnIntervalMinSec = Math.max(minInterArrivalMs / 1000, baseInterArrivalSec / burstScale)
    const spawnIntervalMaxSec = Math.min(maxInterArrivalMs / 1000, baseInterArrivalSec * burstScale)
    const spawnIntervalTuple = rangeTuple(spawnIntervalMinSec, spawnIntervalMaxSec, 0.001, 5)

    const sizeMinFromSeed = clamp(toNumber(baselineBehavior.sizeModel?.diameterPxAt1080p?.hardClamp?.min, 1.4), 0.1, 100)
    const sizeMaxFromSeed = clamp(toNumber(baselineBehavior.sizeModel?.diameterPxAt1080p?.hardClamp?.max, 9.5), sizeMinFromSeed, 200)
    const sizeMin = this.spawnSizeOverrideMin == null ? sizeMinFromSeed : clamp(this.spawnSizeOverrideMin, 0.1, 100)
    const sizeMax = this.spawnSizeOverrideMax == null ? sizeMaxFromSeed : clamp(this.spawnSizeOverrideMax, sizeMin, 200)

    const mergeNeighborhood = clamp(toNumber(baselineBehavior.mergeModel?.neighborhoodRadiusPxAt1080p, 2.4), 0.2, 20)
    const mergeRatioLimit = clamp(toNumber(baselineBehavior.mergeModel?.sizeRatioLimitForMerge, 4.5), 0.5, 20)
    const mergeEnergyLossFactor = clamp(toNumber(baselineBehavior.mergeModel?.postMerge?.energyLossFactor, 0.08), 0, 1)

    const velocityBase = clamp(toNumber(baselineBehavior.velocityModel?.verticalSpeedPxPerSecondAt1080p?.base, 38), 1, 1200)
    const velocityMax = clamp(toNumber(baselineBehavior.velocityModel?.verticalSpeedPxPerSecondAt1080p?.maxClamp, 168), velocityBase + 1, 2400)
    const lateralDriftStrength = clamp(toNumber(baselineBehavior.velocityModel?.lateral?.driftStrength, 0.11), 0, 2)
    const velocitySizeExponent = clamp(toNumber(baselineBehavior.velocityModel?.verticalSpeedPxPerSecondAt1080p?.sizeExponent, 1.27), 0.1, 4)

    const trailDeposit = clamp(toNumber(baselineBehavior.trailModel?.deposition?.depositFactor, 0.34), 0, 2)
    const fastHalfLife = clamp(toNumber(baselineBehavior.trailModel?.decay?.fastHalfLifeSeconds, 0.95), 0.05, 30)
    const slowHalfLife = clamp(toNumber(baselineBehavior.trailModel?.decay?.slowHalfLifeSeconds, 4.6), fastHalfLife, 60)
    const trailPickup = clamp(toNumber(baselineBehavior.trailModel?.reactivation?.freshDropTrailPickup, 0.12), 0, 1)

    const runnerMassThreshold0to1 = clamp(toNumber(baselineBehavior.runnerModel?.emergence?.massThreshold, 0.67), 0, 1)
    const runnerProbability = clamp(toNumber(baselineBehavior.runnerModel?.emergence?.probabilityWhenEligible, 0.36), 0, 1)
    const runnerSpeedMultiplier = clamp(toNumber(baselineBehavior.runnerModel?.runnerDynamics?.speedMultiplier, 1.58), 0.1, 10)
    const runnerTrailPx = clamp(toNumber(baselineBehavior.runnerModel?.emergence?.minContinuousTrailPxAt1080p, 18), 2, 120)
    const runnerPersistenceMin = clamp(toNumber(baselineBehavior.runnerModel?.runnerDynamics?.persistenceSeconds?.min, 0.8), 0, 60)
    const runnerPersistenceMax = clamp(toNumber(baselineBehavior.runnerModel?.runnerDynamics?.persistenceSeconds?.max, 3.1), 0, 60)
    const mergeCooldown = Math.round(clamp(toNumber(baselineBehavior.mergeModel?.cooldownFrames, 3), 0, 120))
    const piecewiseBands = baselineBehavior.velocityModel?.verticalSpeedPxPerSecondAt1080p?.piecewiseBands

    // Loud validation for required seed fields that now have direct runtime mappings
    if (baselineBehavior.runnerModel?.runnerDynamics?.persistenceSeconds == null) {
      console.error('[RaindropFxRendererAdapter] Baseline seed missing runnerModel.runnerDynamics.persistenceSeconds — using defaults [0.8, 3.1]')
    }
    if (baselineBehavior.mergeModel?.cooldownFrames == null) {
      console.error('[RaindropFxRendererAdapter] Baseline seed missing mergeModel.cooldownFrames — using default 3')
    }
    if (!Array.isArray(piecewiseBands) || piecewiseBands.length === 0) {
      console.error('[RaindropFxRendererAdapter] Baseline seed missing/empty velocityModel.verticalSpeedPxPerSecondAt1080p.piecewiseBands — piecewise gravity disabled')
    }
    if (!baselineBehavior.mergeModel?.growthAssist) {
      console.warn('[RaindropFxRendererAdapter] Baseline seed missing mergeModel.growthAssist — post-merge growth assist disabled')
    }
    if (!baselineBehavior.runnerModel?.runnerDynamics?.termination) {
      console.warn('[RaindropFxRendererAdapter] Baseline seed missing runnerModel.runnerDynamics.termination — runner mass-based termination disabled')
    }

    simOptions.spawnInterval = spawnIntervalTuple
    // Surface 1: hardClamp min/max are the direct spawn-size authority in baseline-seed mode.
    simOptions.spawnSize = Array.isArray(simOptions.spawnSize) ? simOptions.spawnSize : [sizeMin, sizeMax]
    simOptions.spawnSize[0] = sizeMin
    simOptions.spawnSize[1] = sizeMax
    // Multiplier 6.0 ≈ expected drop lifetime budget at steady state (2–10 s per drop at 62/s).
    // The prior 2.4× was too low; drops with merging and trail persistence accumulate beyond
    // that headroom, so new spawns were being gated before steady-state density was reached.
    simOptions.spawnLimit = Math.round(clamp(spawnRate * 6.0, 12, 512))

    // Merge behavior in frozen runtime is controlled by colliderSize.
    simOptions.colliderSize = clamp((mergeNeighborhood / 2.4) * (mergeRatioLimit / 4.5), 0.45, 2.2)

    // Velocity behavior maps to gravity + lateral shifting in frozen runtime.
    simOptions.gravity = clamp((velocityMax / 168) * 2400, 400, 6000)
    simOptions.xShifting = rangeTuple(0, lateralDriftStrength * velocitySizeExponent, 0, 1.2)
    simOptions.motionInterval = rangeTuple(0.08, 0.5 / Math.max(0.05, toNumber(baselineBehavior.velocityModel?.lateral?.noiseFrequencyHz, 0.35)), 0.03, 1.2)

    // Trail behavior maps to trail split density/size/distance in frozen runtime.
    simOptions.trailDropDensity = clamp(trailDeposit * 0.6 + mergeEnergyLossFactor * 0.5, 0.05, 0.7)
    simOptions.trailDropSize = rangeTuple(Math.max(0.12, trailPickup * 1.8), Math.max(0.2, trailPickup * 3.4), 0.12, 1.2)
    const distanceScale = clamp((fastHalfLife + slowHalfLife) / 5.55, 0.25, 4)
    simOptions.trailDistance = rangeTuple((runnerTrailPx * 0.9) / distanceScale, (runnerTrailPx * 1.4) / distanceScale, 8, 90)
    simOptions.trailSpread = clamp(0.35 + trailDeposit * 0.8, 0.2, 2.5)
    simOptions.velocitySpread = clamp(0.22 + (velocityBase / velocityMax) * 0.55, 0.1, 1.4)
    // Active frozen runtime consumes global shrinkRate/evaporate directly.
    // Keep rates in the runtime's native range so long runners do not linger syrupy.
    simOptions.shrinkRate = clamp(0.05 / Math.max(0.08, slowHalfLife), 0.005, 0.08)
    simOptions.evaporate = clamp(96 / Math.max(0.08, slowHalfLife), 10, 120)

    // Base slip rate for all drops. Runner speed is now directly controlled via runnerSpeedMultiplier.
    simOptions.slipRate = clamp(0.08, 0, 0.95)

    // Direct 1:1 runner option mappings — runtime now exposes these gates natively.
  const minMass = simOptions.spawnSize[0] ** 2
  const maxMass = simOptions.spawnSize[1] ** 2
    simOptions.runnerSplitMassThreshold = clamp(minMass + runnerMassThreshold0to1 * (maxMass - minMass), 1, 1e6)
    simOptions.runnerSplitProbability = runnerProbability
    simOptions.runnerSpeedMultiplier = runnerSpeedMultiplier
    simOptions.runnerPersistenceMin = runnerPersistenceMin
    simOptions.runnerPersistenceMax = Math.max(runnerPersistenceMin, runnerPersistenceMax)

    // Direct 1:1 merge option mappings.
    simOptions.mergeSizeRatioLimit = mergeRatioLimit
    simOptions.mergeCooldownFrames = mergeCooldown

    // Trail-drop-specific decay (fast half-life path) for trail drops.
    simOptions.trailEvaporate = clamp(96 / Math.max(0.08, fastHalfLife), 10, 120)
    simOptions.trailShrinkRate = clamp(0.05 / Math.max(0.08, fastHalfLife), 0.005, 0.08)

    // Piecewise gravity bands: convert seed px-diameter bands to simulator size units (×10).
    if (Array.isArray(piecewiseBands) && piecewiseBands.length > 0) {
      simOptions.velocityGravityBands = piecewiseBands.map(band => ({
        maxSize: clamp((band.maxDiameter ?? 10) * 10, 1, 2400),
        multiplier: clamp(band.multiplier ?? 1, 0.01, 10),
      }))
    }

    // Post-merge growth assist: optional velocity boost after merge
    const growthAssistCollisionGain = clamp(toNumber(baselineBehavior.mergeModel?.growthAssist?.collisionGain, 0), 0, 2)
    if (growthAssistCollisionGain > 0) {
      simOptions.postMergeGrowthMultiplier = clamp(1 + growthAssistCollisionGain * 0.15, 1, 3)
    }

    // Runner termination: early exit from runner state when mass drops below threshold
    const terminationDrynessCutoff = clamp(toNumber(baselineBehavior.runnerModel?.runnerDynamics?.termination?.drynessCutoff, 0), 0, 1)
    if (terminationDrynessCutoff > 0) {
      // Map dryness cutoff to mass threshold: high dryness = low mass threshold
        // Termination threshold must stay BELOW runnerSplitMassThreshold so that runners
        // formed via accumulation (merging near the split floor) actually persist.
        // Previously anchored to spawn maxMass, placing the threshold above the creation floor
        // and immediately killing every newly formed runner — accumulation pathway was broken.
        // Fix: scale as (1 - drynessCutoff) of the creation threshold so runners survive until
        // they lose ~drynessCutoff fraction of their mass post-formation.
        simOptions.runnerTerminationMassThreshold = clamp(
          simOptions.runnerSplitMassThreshold * (1 - terminationDrynessCutoff),
          1,
          simOptions.runnerSplitMassThreshold * 0.99
        )
    }

    simOptions.__baselineSeedBehavior = baselineBehavior
    this.debug.baselineSeedGroupsApplied = {
      spawnModel: true,
      sizeModel: true,
      mergeModel: true,
      velocityModel: true,
      trailModel: true,
      runnerModel: true,
    }
    this.debug.baselineSeedSimulatorOptionSnapshot = {
      spawnInterval: simOptions.spawnInterval,
      spawnSize: simOptions.spawnSize,
      spawnLimit: simOptions.spawnLimit,
      colliderSize: simOptions.colliderSize,
      gravity: simOptions.gravity,
      xShifting: simOptions.xShifting,
      motionInterval: simOptions.motionInterval,
      trailDropDensity: simOptions.trailDropDensity,
      trailDropSize: simOptions.trailDropSize,
      trailDistance: simOptions.trailDistance,
      trailSpread: simOptions.trailSpread,
      velocitySpread: simOptions.velocitySpread,
      shrinkRate: simOptions.shrinkRate,
      evaporate: simOptions.evaporate,
      slipRate: simOptions.slipRate,
      runnerSplitMassThreshold: simOptions.runnerSplitMassThreshold,
      runnerSplitProbability: simOptions.runnerSplitProbability,
      runnerSpeedMultiplier: simOptions.runnerSpeedMultiplier,
      runnerPersistenceMin: simOptions.runnerPersistenceMin,
      runnerPersistenceMax: simOptions.runnerPersistenceMax,
      mergeSizeRatioLimit: simOptions.mergeSizeRatioLimit,
      mergeCooldownFrames: simOptions.mergeCooldownFrames,
      trailEvaporate: simOptions.trailEvaporate,
      trailShrinkRate: simOptions.trailShrinkRate,
      velocityGravityBands: simOptions.velocityGravityBands,
      postMergeGrowthMultiplier: simOptions.postMergeGrowthMultiplier,
      runnerTerminationMassThreshold: simOptions.runnerTerminationMassThreshold,
    }
    this.debug.baselineSeedUnsupportedControls = {
      trailModel: ['decay.bi-exponential shape details'],
      mergeModel: [],
      runnerModel: [],
    }
  }

  installSizePipelineProofHooks() {
    if (!this.sizePipelineProofEnabled || !this.instance || this.sizePipelineProof.hooksInstalled) {
      return
    }

    const simulator = this.instance.simulator
    const renderer = this.instance.renderer
    if (!simulator || !renderer) {
      return
    }

    // Hook spawn path to sample initial simulator size and mass from freshly emitted drops.
    const spawner = simulator.spawner
    const originalTrySpawn = spawner?.trySpawn
    if (spawner && typeof originalTrySpawn === 'function') {
      const adapter = this
      spawner.trySpawn = function* patchedTrySpawn(...args) {
        const generator = originalTrySpawn.apply(this, args)
        for (const drop of generator) {
          adapter.recordSpawnProofSample(drop)
          yield drop
        }
      }
      this.sizePipelineProof.patchState.spawnPatched = true
    }

    // Hook renderer draw path to sample final draw scale values sent to the GPU.
    const originalDrawRaindrops = renderer.drawRaindrops
    if (typeof originalDrawRaindrops === 'function') {
      const adapter = this
      renderer.drawRaindrops = function patchedDrawRaindrops(...args) {
        const result = originalDrawRaindrops.apply(this, args)
        adapter.recordRenderProofSample(this, args[0])
        return result
      }
      this.sizePipelineProof.patchState.drawPatched = true
    }

    this.sizePipelineProof.hooksInstalled = true
  }

  recordSpawnProofSample(drop) {
    if (!this.sizePipelineProofEnabled || !drop || drop.destroied) {
      return
    }

    const samples = this.sizePipelineProof.spawnSamples
    if (samples.length >= this.sizePipelineProof.spawnSampleLimit) {
      this.sizePipelineProof.droppedSpawnSamples += 1
      return
    }

    const sizeX = toNumber(drop.size?.x, 0)
    const sizeY = toNumber(drop.size?.y, sizeX)
    const mass = toNumber(drop.mass ?? drop._mass, 0)
    const density = toNumber(drop.density, 1)
    samples.push({
      ts: performance.now(),
      sizeX,
      sizeY,
      mass,
      density,
      inferredRadiusPx: sizeX * 0.5,
      inferredDiameterPx: sizeX,
      spawnSizeRange: Array.isArray(this.instance?.simulator?.options?.spawnSize)
        ? [...this.instance.simulator.options.spawnSize]
        : null,
    })
  }

  recordRenderProofSample(renderer, raindrops) {
    if (!this.sizePipelineProofEnabled || !renderer || !Array.isArray(raindrops)) {
      return
    }

    const samples = this.sizePipelineProof.renderSamples
    const maxToSample = Math.min(this.sizePipelineProof.maxSamplesPerFrame, raindrops.length)
    for (let i = 0; i < maxToSample; i += 1) {
      const drop = raindrops[i]
      if (!drop || drop.destroied) {
        continue
      }

      const seen = this.sizePipelineProof.firstSeenByRef.get(drop)
      if (seen) {
        continue
      }

      if (samples.length >= this.sizePipelineProof.renderSampleLimit) {
        this.sizePipelineProof.droppedRenderSamples += 1
        return
      }

      this.sizePipelineProof.firstSeenByRef.set(drop, true)

      const sizeX = toNumber(drop.size?.x, 0)
      const sizeY = toNumber(drop.size?.y, sizeX)
      const mass = toNumber(drop.mass ?? drop._mass, 0)
      const sizeAttr = toNumber(renderer.raindropBuffer?.[i]?.size?.[0], 0)
      const modelMatrix = renderer.raindropBuffer?.[i]?.modelMatrix
      const m00 = modelMatrix ? toNumber(modelMatrix[0], 0) : 0
      const m11 = modelMatrix ? toNumber(modelMatrix[5], 0) : 0

      samples.push({
        ts: performance.now(),
        sizeX,
        sizeY,
        mass,
        drawScaleInputX: sizeX,
        drawScaleInputY: sizeY,
        shaderSizeAttr: sizeAttr,
        shaderSizeAttrTimes100: sizeAttr * 100,
        modelMatrixScaleX: m00,
        modelMatrixScaleY: m11,
      })
    }
  }

  getSizePipelineProofReport() {
    const simulatorOptions = this.instance?.simulator?.options
    return {
      enabled: this.sizePipelineProof.enabled,
      hooksInstalled: this.sizePipelineProof.hooksInstalled,
      patchState: { ...this.sizePipelineProof.patchState },
      droppedSpawnSamples: this.sizePipelineProof.droppedSpawnSamples,
      droppedRenderSamples: this.sizePipelineProof.droppedRenderSamples,
      activeSpawnSizeRange: Array.isArray(simulatorOptions?.spawnSize) ? [...simulatorOptions.spawnSize] : null,
      spawnSamples: this.sizePipelineProof.spawnSamples.map((sample) => ({ ...sample })),
      renderSamples: this.sizePipelineProof.renderSamples.map((sample) => ({ ...sample })),
    }
  }

  getStableEntityId(drop, fallbackIndex) {
    if (drop?.id !== undefined && drop?.id !== null) {
      return drop.id
    }
    if (drop?.uid !== undefined && drop?.uid !== null) {
      return drop.uid
    }
    if (drop?._id !== undefined && drop?._id !== null) {
      return drop._id
    }

    if (drop && typeof drop === 'object') {
      const existingId = this.entityIdByRef.get(drop)
      if (existingId !== undefined) {
        return existingId
      }
      const generatedId = `native-${this.nextEntityId++}`
      this.entityIdByRef.set(drop, generatedId)
      return generatedId
    }

    return `native-fallback-${fallbackIndex}`
  }

  normalizeSimulatorDrop(drop, index) {
    const posX = drop?.pos?.x ?? drop?.x ?? 0
    const posYRaw = drop?.pos?.y ?? drop?.y ?? 0
    const sizeX = drop?.size?.x ?? drop?.size ?? 0
    const sizeY = drop?.size?.y ?? drop?.size ?? sizeX
    const velocityX = drop?.velocity?.x ?? drop?.vx ?? 0
    const velocityYRaw = drop?.velocity?.y ?? drop?.vy ?? 0
    const posY = this.flipYAxis ? this.height - posYRaw : posYRaw
    const velocityY = this.flipYAxis ? -velocityYRaw : velocityYRaw
    // Use head width (smaller axis), not stretched runner height, to avoid
    // oversized disturbance channels in condensation mapping.
    const headDiameter = Math.max(0, Math.min(sizeX || 0, sizeY || sizeX || 0))
    const radius = clamp(headDiameter * 0.5, 1, 72)

    return {
      id: this.getStableEntityId(drop, index),
      x: posX,
      y: posY,
      mass: drop?.mass ?? 0,
      spread: drop?.spread ?? 0,
      age: drop?.age ?? 0,
      radius,
      velocity: { x: velocityX, y: velocityY },
      size: { x: sizeX, y: sizeY },
    }
  }

  // Runs the original bundle simulator and renderer together.
  update(frame) {
    if (!this.instance || !this.ready) {
      return false
    }

    try {
      const simulator = this.instance.simulator
      const renderer = this.instance.renderer
      if (!simulator || !renderer) {
        return false
      }

      const normalizedFrame = {
        dt: clamp(frame?.dt ?? 0.03, 0.001, 0.08),
        total: Math.max(0, frame?.total ?? 0),
      }

      const adapterFrameStart = performance.now()
      const simulationStart = adapterFrameStart
      const updateResult = simulator.update(normalizedFrame)
      const adapterSimulationTimeMs = performance.now() - simulationStart
      const updateResultList = collectEntityList(updateResult)
      const simulatorRaindrops = collectEntityList(simulator.raindrops)

      const glStateResetStart = performance.now()
      this.resetRenderState('render:pre')
      const adapterGlStateResetTimeMs = performance.now() - glStateResetStart

      const rendererDrawStart = performance.now()
      renderer.render(simulatorRaindrops, normalizedFrame)
      const adapterRendererDrawTimeMs = performance.now() - rendererDrawStart
      const adapterFrameTimeMs = adapterSimulationTimeMs + adapterGlStateResetTimeMs + adapterRendererDrawTimeMs

      this.lastSimulatorSnapshot = simulatorRaindrops.map((drop, index) => this.normalizeSimulatorDrop(drop, index))
      this.debug.renderCalls += 1
      this.debug.lastInputCount = this.lastSimulatorSnapshot.length
      this.debug.simulatorRaindropCount = this.lastSimulatorSnapshot.length
      this.debug.simulatorUpdateReturnedCount = updateResultList.length
      this.debug.simulatorUpdateReturnType = updateResult == null ? 'void' : Array.isArray(updateResult) ? 'array' : typeof updateResult
      this.debug.frameDt = normalizedFrame.dt
      this.debug.lastFrameTotal = normalizedFrame.total
      this.debug.adapterSimulationTimeMs = adapterSimulationTimeMs
      this.debug.adapterGlStateResetTimeMs = adapterGlStateResetTimeMs
      this.debug.adapterRendererDrawTimeMs = adapterRendererDrawTimeMs
      this.debug.adapterFrameTimeMs = adapterFrameTimeMs
      this.debug.lastError = null
      return true
    } catch (error) {
      this.debug.lastError = error instanceof Error ? error.message : String(error)
      return false
    }
  }

  getSimulatorSnapshot() {
    return this.lastSimulatorSnapshot.map((drop) => ({
      ...drop,
      velocity: { ...drop.velocity },
      size: { ...drop.size },
    }))
  }

  render(droplets, frame) {
    // Backward-compatible entry point; custom droplet arrays are intentionally
    // ignored so the original RaindropFX simulator remains the source of truth.
    return this.update(frame)
  }

  getDebugState() {
    const compositeSource = this.getCompositeSourceCanvas()
    return {
      ready: this.ready,
      ...this.debug,
      inputScale: { ...this.inputScale },
      flipYAxis: this.flipYAxis,
      compositeSource: {
        source: compositeSource.source,
        canvasWidth: Number(compositeSource.canvas?.width || 0),
        canvasHeight: Number(compositeSource.canvas?.height || 0),
        matchesAdapterCanvas: compositeSource.canvas === this.canvas,
      },
      sizePipelineProof: this.getSizePipelineProofReport(),
    }
  }

  getLastFrameTiming() {
    return {
      adapterSimulationTimeMs: Number(this.debug.adapterSimulationTimeMs || 0),
      adapterGlStateResetTimeMs: Number(this.debug.adapterGlStateResetTimeMs || 0),
      adapterRendererDrawTimeMs: Number(this.debug.adapterRendererDrawTimeMs || 0),
      adapterFrameTimeMs: Number(this.debug.adapterFrameTimeMs || 0),
    }
  }

  destroy() {
    if (this.instance) {
      this.resetRenderState('destroy:pre')
      if (typeof this.instance.destroy === 'function') {
        this.instance.destroy()
      } else if (typeof this.instance.stop === 'function') {
        this.instance.stop()
      }
      this.instance = null
    }
    resetRaindropFxScriptState()
    this.canvas.width = Math.max(1, Math.floor(this.width || this.canvas.width || 1))
    this.canvas.height = Math.max(1, Math.floor(this.height || this.canvas.height || 1))
    this.lastSimulatorSnapshot = []
    this.entityIdByRef = new WeakMap()
    this.ready = false
  }

  async _recordBaselineSeedDiagnosticsStartupSnapshot(simOptions) {
    if (!this.baselineSeedDebugEnabled) return
    
    try {
      if (!BaselineSeedBehaviorDiagnostics) {
        await getBaselineSeedBehaviorDiagnosticsClass()
      }
      
      if (!BaselineSeedBehaviorDiagnostics) {
        console.warn('[RaindropFxRendererAdapter] Diagnostics class not available')
        return
      }

      if (!this.diagnostics) {
        this.diagnostics = new BaselineSeedBehaviorDiagnostics(true)
      }

      this.diagnostics.recordStartupSnapshot(simOptions)
    } catch (e) {
      console.warn('[RaindropFxRendererAdapter] Error recording startup snapshot:', e.message)
    }
  }

  recordBaselineSeedFrameSample(frameIndex, elapsedSeconds) {
    if (!this.baselineSeedDebugEnabled || !this.diagnostics) return
    
    const simulator = this.instance?.simulator
    if (simulator) {
      this.diagnostics.recordFrameSample(frameIndex, elapsedSeconds, simulator)
    }
  }

  getBaselineSeedDiagnosticsReport() {
    if (!this.diagnostics) return null
    return this.diagnostics.getReport()
  }
}
