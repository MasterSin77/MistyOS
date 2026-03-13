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

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

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
      lastError: null,
    }
    this.canvas = document.createElement('canvas')
    this.canvas.width = width
    this.canvas.height = height
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

      const options = this.instance.options || {}
      this.debug.simulatorSpawnInterval = options.spawnInterval ?? null
      this.debug.simulatorSpawnLimit = options.spawnLimit ?? null
      this.debug.proceduralDropletsPerSecond = options.dropletsPerSeconds ?? null
      this.debug.proceduralMistEnabled = options.mist ?? null

      // Use only the original rendering pipeline and keep simulation external.
      await this.instance.renderer.loadAssets()
      this.ready = true
      this.debug.initCompleted = true
      this.debug.lastError = null
      this.applyRuntimeSettings()
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

    if (this.instance) {
      this.instance.resize(this.width, this.height)
    }
  }

  async setBackground(background) {
    this.background = background
    if (this.instance) {
      await this.instance.setBackground(background)
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
    }

    this.debug.proceduralDropletsPerSecond = options.dropletsPerSeconds ?? null
    this.debug.proceduralMistEnabled = options.mist ?? null
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

      const updateResult = simulator.update(normalizedFrame)
      const updateResultList = collectEntityList(updateResult)
      const simulatorRaindrops = collectEntityList(simulator.raindrops)

      renderer.render(simulatorRaindrops, normalizedFrame)

      this.lastSimulatorSnapshot = simulatorRaindrops.map((drop, index) => this.normalizeSimulatorDrop(drop, index))
      this.debug.renderCalls += 1
      this.debug.lastInputCount = this.lastSimulatorSnapshot.length
      this.debug.simulatorRaindropCount = this.lastSimulatorSnapshot.length
      this.debug.simulatorUpdateReturnedCount = updateResultList.length
      this.debug.simulatorUpdateReturnType = updateResult == null ? 'void' : Array.isArray(updateResult) ? 'array' : typeof updateResult
      this.debug.frameDt = normalizedFrame.dt
      this.debug.lastFrameTotal = normalizedFrame.total
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
    return {
      ready: this.ready,
      ...this.debug,
      inputScale: { ...this.inputScale },
      flipYAxis: this.flipYAxis,
    }
  }

  destroy() {
    if (this.instance) {
      this.instance.destroy()
      this.instance = null
    }
    this.lastSimulatorSnapshot = []
    this.entityIdByRef = new WeakMap()
    this.ready = false
  }
}
