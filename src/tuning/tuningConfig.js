const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

export const DEFAULT_TUNING_CONFIG = {
  surfaceWetness: {
    initialWetness: 0.1,
    maxWetness: 0.5,
    refillRate: 0.0065,
    recoveryRate: 1.4,
    diffusionRate: 5.4,
    trailRecoveryRate: 0.52,
    runnerMemoryRecoveryRate: 0.34,
  },
  fogSurface: {
    baseFogLevel: 0.1,
    fogScale: 0.72,
    fogTintStrength: 0.12,
    fogAlphaMultiplier: 1,
    smoothingPassCount: 3,
    fogFillBoost: 0.012,
  },
  dropletInteraction: {
    headClearStrength: 1,
    headClearRadiusMultiplier: 1,
    trailClearStrength: 0.9,
    trailClearRadiusMultiplier: 0.93,
    largeRunnerSizeGateStart: 1.45,
    largeRunnerSizeGateRange: 1.55,
    largeRunnerMassGateStart: 2.2,
    largeRunnerMassGateRange: 7.8,
    largeRunnerBoostStrength: 0.92,
    largeRunnerRadiusBoost: 0.18,
    largeRunnerTrailBoost: 0.24,
    largeRunnerTrailRadiusBoost: 0.09,
    slopePlausibilityThreshold: 0.7,
    downwardOnly: true,
  },
  renderer: {
    mistEnabled: true,
    mistTime: 16,
    mistColorR: 0.58,
    mistColorG: 0.68,
    mistColorB: 0.78,
    mistColorA: 0.055,
    dropletsPerSeconds: 320,
    dropletSizeMin: 8,
    dropletSizeMax: 22,
    raindropCompose: 'smoother',
    raindropLightPosX: -0.6,
    raindropLightPosY: 1.2,
    raindropLightPosZ: 2,
    raindropDiffuseLightR: 0.34,
    raindropDiffuseLightG: 0.36,
    raindropDiffuseLightB: 0.4,
    raindropSpecularLightR: 1,
    raindropSpecularLightG: 1,
    raindropSpecularLightB: 1,
    raindropSpecularShininess: 190,
    raindropLightBump: 1.6,
  },
  debug: {
    viewMode: 'combined',
    compositeOverlayStrength: 1,
    showRawRendererInset: false,
    freezeRain: false,
    freezeBackground: false,
    splitCompareEnabled: false,
    overlayBackendCompareEnabled: false,
    splitRawOnRight: false,
    compatibilityMode: 'auto',
    useGpuOverlayPrototype: false,
    useGpuFogCompositing: false,
    useGpuWetnessSimulation: false,
    useGpuWritingInteractionPrototype: false,
    gpuParityGateEnabled: true,
    gpuParityThresholdMeanDelta: 0.002,
    gpuParityThresholdMae: 0.004,
    gpuParityThresholdVarianceDelta: 0.0002,
    gpuParityThresholdTileMaxMae: 0.012,
    wetnessFullRefreshIntervalFrames: 120,
    wetnessSmoothingStride: 1,
    wetnessRegionOnlySmoothing: true,
  },
  links: {
    mistDensity: 1,
    fogSoftness: 1,
    largeRunnerInfluence: 1,
  },
}

export const STORAGE_KEYS = {
  tuning: 'mistyos.tuning.current.v1',
  presets: 'mistyos.tuning.presets.v1',
  ab: 'mistyos.tuning.ab.v1',
  favorites: 'mistyos.tuning.favorites.v1',
}

export const deepClone = (value) => JSON.parse(JSON.stringify(value))

export const mergeDeep = (base, override) => {
  if (!override || typeof override !== 'object') {
    return deepClone(base)
  }

  const walk = (lhs, rhs) => {
    if (Array.isArray(lhs)) {
      return Array.isArray(rhs) ? rhs.slice() : lhs.slice()
    }
    if (lhs && typeof lhs === 'object') {
      const out = {}
      const keys = new Set([...Object.keys(lhs), ...Object.keys(rhs || {})])
      for (const key of keys) {
        out[key] = walk(lhs[key], rhs?.[key])
      }
      return out
    }
    return rhs === undefined ? lhs : rhs
  }

  return walk(base, override)
}

export const getLinkedEffectiveConfig = (inputConfig) => {
  const cfg = deepClone(inputConfig)
  const mistDensity = clamp(cfg.links?.mistDensity ?? 1, 0, 2)
  const fogSoftness = clamp(cfg.links?.fogSoftness ?? 1, 0.4, 2)
  const largeRunnerInfluence = clamp(cfg.links?.largeRunnerInfluence ?? 1, 0, 2)

  cfg.surfaceWetness.initialWetness = clamp(cfg.fogSurface.baseFogLevel * (0.7 + mistDensity * 0.5), 0, 0.95)
  cfg.surfaceWetness.refillRate = clamp(cfg.surfaceWetness.refillRate * (0.55 + mistDensity * 0.85), 0, 0.08)
  cfg.renderer.mistColorA = clamp(cfg.renderer.mistColorA * (0.45 + mistDensity * 0.85), 0, 1)

  cfg.surfaceWetness.diffusionRate = clamp(cfg.surfaceWetness.diffusionRate * (0.55 + fogSoftness * 0.9), 0, 20)
  cfg.fogSurface.smoothingPassCount = Math.round(clamp(cfg.fogSurface.smoothingPassCount * (0.65 + fogSoftness * 0.85), 1, 8))

  cfg.dropletInteraction.headClearStrength = clamp(cfg.dropletInteraction.headClearStrength * (0.65 + largeRunnerInfluence * 0.7), 0, 4)
  cfg.dropletInteraction.trailClearStrength = clamp(cfg.dropletInteraction.trailClearStrength * (0.65 + largeRunnerInfluence * 0.7), 0, 4)
  cfg.dropletInteraction.largeRunnerBoostStrength = clamp(cfg.dropletInteraction.largeRunnerBoostStrength * (0.4 + largeRunnerInfluence * 0.8), 0, 3)

  return cfg
}

export const formatValue = (value) => {
  if (typeof value === 'boolean') {
    return value ? 'on' : 'off'
  }
  if (typeof value === 'string') {
    return value
  }
  if (Number.isInteger(value)) {
    return `${value}`
  }
  return Number(value).toFixed(3)
}

export const TUNING_SCHEMA = [
  {
    key: 'surfaceWetness',
    title: 'Surface Wetness',
    controls: [
      { path: 'surfaceWetness.initialWetness', label: 'Initial Wetness', min: 0, max: 0.8, step: 0.005, tooltip: 'Base condensation level before local clearing.' },
      { path: 'surfaceWetness.maxWetness', label: 'Max Wetness', min: 0.1, max: 1, step: 0.01, tooltip: 'Upper cap for condensation opacity.' },
      { path: 'surfaceWetness.refillRate', label: 'Refill Rate', min: 0, max: 0.03, step: 0.0005, tooltip: 'How quickly condensation rebuilds globally.' },
      { path: 'surfaceWetness.recoveryRate', label: 'Recovery Rate', min: 0, max: 4, step: 0.05, tooltip: 'How quickly disturbed clear zones relax back.' },
      { path: 'surfaceWetness.diffusionRate', label: 'Diffusion Rate', min: 0, max: 12, step: 0.1, tooltip: 'How quickly cleared regions spread into neighbors.' },
      { path: 'surfaceWetness.trailRecoveryRate', label: 'Trail Recovery', min: 0, max: 2, step: 0.02, tooltip: 'Fade speed for trail field history.' },
      { path: 'surfaceWetness.runnerMemoryRecoveryRate', label: 'Runner Memory Recovery', min: 0, max: 2, step: 0.02, tooltip: 'Fade speed for runner memory contribution.' },
    ],
  },
  {
    key: 'fogSurface',
    title: 'Fog / Surface Rendering',
    controls: [
      { path: 'fogSurface.baseFogLevel', label: 'Base Fog', min: 0, max: 0.5, step: 0.01, tooltip: 'Baseline fog amount used when field resets.' },
      { path: 'fogSurface.fogScale', label: 'Fog Scale', min: 0.3, max: 1, step: 0.01, tooltip: 'Resolution scale for fog simulation canvas.' },
      { path: 'fogSurface.fogTintStrength', label: 'Fog Tint', min: 0, max: 0.35, step: 0.005, tooltip: 'Strength of overlay tint over the fog map.' },
      { path: 'fogSurface.fogAlphaMultiplier', label: 'Fog Alpha', min: 0, max: 2, step: 0.02, tooltip: 'Multiplier for final fog compositing alpha.' },
      { path: 'fogSurface.fogFillBoost', label: 'Fog Fill Boost', min: 0, max: 0.2, step: 0.001, tooltip: 'Uniform bright fog fill layered on top of the wetness map.' },
      { path: 'fogSurface.smoothingPassCount', label: 'Smoothing Passes', min: 1, max: 8, step: 1, tooltip: 'Number of wetness smoothing passes each frame.' },
      { path: 'links.fogSoftness', label: 'Fog Softness Link', min: 0.4, max: 2, step: 0.02, tooltip: 'Linked control driving diffusion and smoothing together.' },
      { path: 'links.mistDensity', label: 'Mist Density Link', min: 0, max: 2, step: 0.02, tooltip: 'Linked control driving refill, base wetness, and renderer mist alpha.' },
    ],
  },
  {
    key: 'dropletInteraction',
    title: 'Droplet-to-Surface Interaction',
    controls: [
      { path: 'dropletInteraction.headClearStrength', label: 'Head Clear Strength', min: 0, max: 3, step: 0.02, tooltip: 'Strength of local clearing at droplet head.' },
      { path: 'dropletInteraction.headClearRadiusMultiplier', label: 'Head Radius Mult', min: 0.3, max: 2.5, step: 0.01, tooltip: 'Multiplier for head clearing radius.' },
      { path: 'dropletInteraction.trailClearStrength', label: 'Trail Clear Strength', min: 0, max: 3, step: 0.02, tooltip: 'Strength of immediate path clearing.' },
      { path: 'dropletInteraction.trailClearRadiusMultiplier', label: 'Trail Radius Mult', min: 0.3, max: 2.5, step: 0.01, tooltip: 'Multiplier for near-head trail radius.' },
      { path: 'dropletInteraction.largeRunnerSizeGateStart', label: 'Size Gate Start', min: 0.2, max: 4, step: 0.02, tooltip: 'Radius where large-runner boost begins.' },
      { path: 'dropletInteraction.largeRunnerSizeGateRange', label: 'Size Gate Range', min: 0.1, max: 4, step: 0.02, tooltip: 'Radius range over which large-runner boost ramps.' },
      { path: 'dropletInteraction.largeRunnerMassGateStart', label: 'Mass Gate Start', min: 0, max: 16, step: 0.1, tooltip: 'Mass where large-runner boost begins.' },
      { path: 'dropletInteraction.largeRunnerMassGateRange', label: 'Mass Gate Range', min: 0.1, max: 20, step: 0.1, tooltip: 'Mass range over which large-runner boost ramps.' },
      { path: 'dropletInteraction.largeRunnerBoostStrength', label: 'Large Runner Boost', min: 0, max: 2.5, step: 0.02, tooltip: 'Head-strength boost multiplier for large runners.' },
      { path: 'dropletInteraction.largeRunnerRadiusBoost', label: 'Large Runner Radius Boost', min: 0, max: 1.5, step: 0.01, tooltip: 'Extra head radius scaling applied to larger runners.' },
      { path: 'dropletInteraction.largeRunnerTrailBoost', label: 'Large Runner Trail Boost', min: 0, max: 1.5, step: 0.01, tooltip: 'Extra trail strength scaling applied to larger runners.' },
      { path: 'dropletInteraction.largeRunnerTrailRadiusBoost', label: 'Large Runner Trail Radius Boost', min: 0, max: 1.5, step: 0.01, tooltip: 'Extra trail radius scaling applied to larger runners.' },
      { path: 'dropletInteraction.slopePlausibilityThreshold', label: 'Slope Threshold', min: 0.05, max: 2.5, step: 0.01, tooltip: 'Reject trails with too much lateral motion.' },
      { path: 'links.largeRunnerInfluence', label: 'Large Runner Influence', min: 0, max: 2, step: 0.02, tooltip: 'Linked control driving both head and trail influence.' },
    ],
    toggles: [
      { path: 'dropletInteraction.downwardOnly', label: 'Downward Only', tooltip: 'Only write trail disturbance when droplet moves downward.' },
    ],
  },
  {
    key: 'renderer',
    title: 'Native RaindropFX Renderer',
    controls: [
      { path: 'renderer.mistTime', label: 'Mist Time', min: 0, max: 40, step: 0.5, tooltip: 'Temporal scale for procedural mist motion.' },
      { path: 'renderer.dropletsPerSeconds', label: 'Droplets / s', min: 0, max: 1200, step: 5, tooltip: 'Procedural spawn rate inside native renderer.' },
      { path: 'renderer.dropletSizeMin', label: 'Drop Size Min', min: 0, max: 60, step: 0.5, tooltip: 'Minimum procedural droplet size in renderer.' },
      { path: 'renderer.dropletSizeMax', label: 'Drop Size Max', min: 0, max: 100, step: 0.5, tooltip: 'Maximum procedural droplet size in renderer.' },
      { path: 'renderer.raindropLightPosX', label: 'Light Pos X', min: -4, max: 4, step: 0.05, tooltip: 'Raindrop light vector x.' },
      { path: 'renderer.raindropLightPosY', label: 'Light Pos Y', min: -4, max: 4, step: 0.05, tooltip: 'Raindrop light vector y.' },
      { path: 'renderer.raindropLightPosZ', label: 'Light Pos Z', min: -1, max: 5, step: 0.05, tooltip: 'Raindrop light vector z.' },
      { path: 'renderer.raindropDiffuseLightR', label: 'Diffuse R', min: 0, max: 2, step: 0.01, tooltip: 'Diffuse light red channel.' },
      { path: 'renderer.raindropDiffuseLightG', label: 'Diffuse G', min: 0, max: 2, step: 0.01, tooltip: 'Diffuse light green channel.' },
      { path: 'renderer.raindropDiffuseLightB', label: 'Diffuse B', min: 0, max: 2, step: 0.01, tooltip: 'Diffuse light blue channel.' },
      { path: 'renderer.raindropSpecularShininess', label: 'Spec Shininess', min: 1, max: 400, step: 1, tooltip: 'Specular exponent for droplets.' },
      { path: 'renderer.raindropSpecularLightR', label: 'Specular R', min: 0, max: 2, step: 0.01, tooltip: 'Specular light red channel.' },
      { path: 'renderer.raindropSpecularLightG', label: 'Specular G', min: 0, max: 2, step: 0.01, tooltip: 'Specular light green channel.' },
      { path: 'renderer.raindropSpecularLightB', label: 'Specular B', min: 0, max: 2, step: 0.01, tooltip: 'Specular light blue channel.' },
      { path: 'renderer.raindropLightBump', label: 'Light Bump', min: 0, max: 4, step: 0.05, tooltip: 'Normal bump strength for raindrop highlights.' },
      { path: 'renderer.mistColorR', label: 'Mist Color R', min: 0, max: 1, step: 0.01, tooltip: 'Mist color red channel.' },
      { path: 'renderer.mistColorG', label: 'Mist Color G', min: 0, max: 1, step: 0.01, tooltip: 'Mist color green channel.' },
      { path: 'renderer.mistColorB', label: 'Mist Color B', min: 0, max: 1, step: 0.01, tooltip: 'Mist color blue channel.' },
      { path: 'renderer.mistColorA', label: 'Mist Color A', min: 0, max: 0.5, step: 0.002, tooltip: 'Mist opacity alpha.' },
    ],
    toggles: [
      { path: 'renderer.mistEnabled', label: 'Mist On', tooltip: 'Enable native renderer procedural mist pass.' },
    ],
    selects: [
      { path: 'renderer.raindropCompose', label: 'Compose Mode', tooltip: 'Renderer compose mode if supported.', options: ['smoother', 'normal', 'hard-light'] },
    ],
  },
  {
    key: 'debug',
    title: 'Debug / Comparison',
    controls: [
      {
        path: 'debug.compositeOverlayStrength',
        label: 'Composite Overlay Strength',
        min: 0,
        max: 1,
        step: 0.01,
        tooltip: 'Scales wetness overlay contribution in composite rendering (0 = renderer only, 1 = full wetness).',
      },
      {
        path: 'debug.wetnessFullRefreshIntervalFrames',
        label: 'Full Refresh Interval (frames)',
        min: 30,
        max: 600,
        step: 1,
        tooltip: 'How often a forced full wetness/image refresh runs to resync low-drift global fog changes.',
      },
      {
        path: 'debug.gpuParityThresholdMeanDelta',
        label: 'GPU Parity Mean Delta Max',
        min: 0,
        max: 0.02,
        step: 0.0005,
        tooltip: 'Pass threshold for abs(mean alpha CPU-GPU delta).',
      },
      {
        path: 'debug.gpuParityThresholdMae',
        label: 'GPU Parity MAE Max',
        min: 0,
        max: 0.03,
        step: 0.0005,
        tooltip: 'Pass threshold for global alpha MAE between CPU and GPU parity samples.',
      },
      {
        path: 'debug.gpuParityThresholdVarianceDelta',
        label: 'GPU Parity Var Delta Max',
        min: 0,
        max: 0.01,
        step: 0.0001,
        tooltip: 'Pass threshold for abs(alpha variance CPU-GPU delta).',
      },
      {
        path: 'debug.gpuParityThresholdTileMaxMae',
        label: 'GPU Parity Tile MAE Max',
        min: 0,
        max: 0.05,
        step: 0.0005,
        tooltip: 'Pass threshold for worst tile MAE across spatial parity grid.',
      },
    ],
    toggles: [
      { path: 'debug.showRawRendererInset', label: 'Show Renderer Inset', tooltip: 'Show raw native renderer output inset.' },
      { path: 'debug.freezeRain', label: 'Freeze Rain', tooltip: 'Pause native simulator updates for comparison.' },
      { path: 'debug.freezeBackground', label: 'Freeze Background', tooltip: 'Freeze the currently composed background frame.' },
      { path: 'debug.splitCompareEnabled', label: 'Split Compare', tooltip: 'Render RAW and COMPOSITE side-by-side using the same live simulation.' },
      { path: 'debug.overlayBackendCompareEnabled', label: 'Overlay CPU/GPU Compare', tooltip: 'Render CPU-overlay and GPU-overlay side-by-side for parity checks.' },
      { path: 'debug.splitRawOnRight', label: 'RAW On Right', tooltip: 'Flip split sides so RAW appears on the right half.' },
      { path: 'debug.useGpuOverlayPrototype', label: 'GPU Overlay (WebGL)', tooltip: 'Render fog overlay via WebGL runtime path; CPU path remains fallback.' },
      { path: 'debug.useGpuFogCompositing', label: 'GPU Fog Compositing', tooltip: 'Composite fog, tint, and fill fully in the GPU shader path.' },
      { path: 'debug.useGpuWetnessSimulation', label: 'GPU Wetness Simulation', tooltip: 'Enable the GPU wetness simulation backend; CPU fallback remains available.' },
      { path: 'debug.useGpuWritingInteractionPrototype', label: 'GPU Writing Interaction', tooltip: 'Queue writing/trail clears for GPU interaction passes while preserving CPU compatibility fallback.' },
      { path: 'debug.gpuParityGateEnabled', label: 'GPU Parity Gate Enabled', tooltip: 'Enable threshold-based pass/fail evaluation for GPU parity metrics.' },
    ],
    selects: [
      {
        path: 'debug.compatibilityMode',
        label: 'Compatibility Mode',
        tooltip: 'Request runtime mode directly: auto follows flags, cpu-compat forces CPU path, gpu-sim enables GPU simulation only, gpu-interaction enables GPU simulation + interaction.',
        options: ['auto', 'cpu-compat', 'gpu-sim', 'gpu-interaction'],
      },
      { path: 'debug.viewMode', label: 'View Mode', tooltip: 'Choose renderer only, fog only, combined compositing, or split compare.', options: ['combined', 'renderer-only', 'fog-only', 'split-compare'] },
    ],
  },
]

export const getByPath = (obj, path) => path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj)

export const setByPath = (obj, path, value) => {
  const keys = path.split('.')
  const out = deepClone(obj)
  let cursor = out
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i]
    cursor[key] = deepClone(cursor[key])
    cursor = cursor[key]
  }
  cursor[keys[keys.length - 1]] = value
  return out
}
