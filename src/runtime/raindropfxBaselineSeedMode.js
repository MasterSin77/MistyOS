const DEFAULT_BASELINE_SEED_PATH = '/baseline-seeds/baseline-seed.raindropfx.v0.json'

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

function parseNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function hasBehaviorGroups(seed) {
  const groups = seed?.behaviorParameters
  return Boolean(
    groups
      && groups.spawnModel
      && groups.sizeModel
      && groups.mergeModel
      && groups.velocityModel
      && groups.trailModel
      && groups.runnerModel,
  )
}

export function isRaindropFxBaselineSeedModeEnabledFromUrl() {
  const params = new URLSearchParams(window.location.search)
  return params.get('rdfxBaselineSeedMode') === '1'
}

export function resolveRaindropFxBaselineSeedPathFromUrl() {
  const params = new URLSearchParams(window.location.search)
  const value = params.get('rdfxBaselineSeedPath')
  return value && value.trim() ? value.trim() : DEFAULT_BASELINE_SEED_PATH
}

export async function loadRaindropFxBaselineSeedArtifact(seedPath = DEFAULT_BASELINE_SEED_PATH) {
  const response = await fetch(seedPath, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`Baseline seed fetch failed (${response.status}) for ${seedPath}`)
  }

  const seed = await response.json()
  if (!seed || typeof seed !== 'object') {
    throw new Error('Baseline seed payload is not an object.')
  }
  if (!seed.identity || !seed.determinism || !hasBehaviorGroups(seed)) {
    throw new Error('Baseline seed payload is missing required contract fields.')
  }

  return seed
}

export function mapRaindropFxBaselineSeedToEngineConfig(seed, viewport = {}) {
  const behavior = seed.behaviorParameters

  const spawnRate = clamp(parseNumber(behavior.spawnModel?.spatial?.globalRatePerSecond, 62), 1, 1200)
  const sizeClampMin = parseNumber(behavior.sizeModel?.diameterPxAt1080p?.hardClamp?.min, 1.4)
  const sizeClampMax = parseNumber(behavior.sizeModel?.diameterPxAt1080p?.hardClamp?.max, 9.5)

  const velocityBands = Array.isArray(behavior.velocityModel?.verticalSpeedPxPerSecondAt1080p?.piecewiseBands)
    ? behavior.velocityModel.verticalSpeedPxPerSecondAt1080p.piecewiseBands
    : []
  const velocityBandMaxDiameter = velocityBands.reduce((max, band) => {
    const value = parseNumber(band?.maxDiameter, max)
    return value > max ? value : max
  }, sizeClampMax)

  const minVelocityY = clamp(
    parseNumber(behavior.velocityModel?.verticalSpeedPxPerSecondAt1080p?.base, 38) * 0.65,
    1,
    500,
  )
  const maxVelocityY = clamp(
    parseNumber(behavior.velocityModel?.verticalSpeedPxPerSecondAt1080p?.maxClamp, 168),
    minVelocityY + 1,
    1200,
  )

  const trailPersistenceMin = parseNumber(behavior.trailModel?.decay?.fastHalfLifeSeconds, 0.95)
  const trailPersistenceMax = parseNumber(behavior.trailModel?.decay?.slowHalfLifeSeconds, 4.6)

  const runnerMassThreshold = clamp(parseNumber(behavior.runnerModel?.emergence?.massThreshold, 0.67), 0.01, 10)
  const runnerProbability = clamp(parseNumber(behavior.runnerModel?.emergence?.probabilityWhenEligible, 0.36), 0, 1)
  const runnerSpeedMultiplier = clamp(parseNumber(behavior.runnerModel?.runnerDynamics?.speedMultiplier, 1.58), 0.5, 4)

  const baselineTuning = {
    surfaceWetness: {
      initialWetness: 0,
      maxWetness: 0.1,
      refillRate: 0,
      recoveryRate: 0,
      diffusionRate: 0,
      trailRecoveryRate: 0,
      runnerMemoryRecoveryRate: 0,
    },
    fogSurface: {
      baseFogLevel: 0,
      fogScale: 0.26,
      fogTintStrength: 0,
      fogAlphaMultiplier: 0,
      smoothingPassCount: 1,
      fogFillBoost: 0,
      wetnessFogGain: 0,
      wetnessSoftnessGain: 0,
      trailMistGain: 0,
      runnerChannelGain: 0,
      runnerChannelThreshold: 1,
      debugSurfaceContrast: 1,
    },
    dropletInteraction: {
      headClearStrength: 0,
      headClearRadiusMultiplier: 1,
      trailClearStrength: 0,
      trailClearRadiusMultiplier: 1,
      largeRunnerSizeGateStart: clamp(parseNumber(velocityBandMaxDiameter, sizeClampMax), 0.1, 100),
      largeRunnerSizeGateRange: clamp(parseNumber(behavior.runnerModel?.emergence?.minContinuousTrailPxAt1080p, 18) / 10, 0.1, 20),
      largeRunnerMassGateStart: runnerMassThreshold,
      largeRunnerMassGateRange: clamp(parseNumber(behavior.mergeModel?.sizeRatioLimitForMerge, 4.5), 0.1, 30),
      largeRunnerBoostStrength: runnerSpeedMultiplier,
      largeRunnerRadiusBoost: clamp(parseNumber(behavior.mergeModel?.postMerge?.energyLossFactor, 0.08), 0, 2),
      largeRunnerTrailBoost: clamp(parseNumber(behavior.trailModel?.reactivation?.freshDropTrailPickup, 0.12), 0, 2),
      largeRunnerTrailRadiusBoost: clamp(parseNumber(behavior.mergeModel?.growthAssist?.nearbyTrailWetnessGain, 0.06), 0, 2),
      slopePlausibilityThreshold: 1,
      downwardOnly: true,
    },
    renderer: {
      mistEnabled: false,
      mistTime: 0,
      mistColorR: 0,
      mistColorG: 0,
      mistColorB: 0,
      mistColorA: 0,
      dropletsPerSeconds: Math.round(spawnRate),
      dropletSizeMin: clamp(sizeClampMin, 0.1, 100),
      dropletSizeMax: clamp(sizeClampMax, Math.max(0.2, sizeClampMin), 200),
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
      viewMode: 'renderer-only',
      compositeOverlayStrength: 0,
      showRawRendererInset: false,
      freezeRain: false,
      freezeBackground: false,
      splitCompareEnabled: false,
      overlayBackendCompareEnabled: false,
      splitRawOnRight: false,
      compatibilityMode: 'cpu-compat',
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
      mistDensity: 0,
      fogSoftness: 0.34,
      largeRunnerInfluence: clamp(runnerProbability * 2, 0, 2),
    },
    raindropFxBaselineBehavior: {
      mode: 'raindropfx-baseline-seed',
      identity: {
        seedId: String(seed.identity?.seedId || 'unknown-seed'),
        semanticVersion: String(seed.identity?.semanticVersion || '0.0.0'),
      },
      determinism: {
        fixedStepDtSeconds: parseNumber(seed.determinism?.fixedStep?.dtSeconds, 1 / 60),
        rngFamily: String(seed.determinism?.rng?.family || 'unknown'),
        masterSeed: parseNumber(seed.determinism?.rng?.masterSeed, 0),
        referenceResolution: {
          width: parseNumber(seed.determinism?.normalization?.referenceResolution?.width, viewport.width || 1920),
          height: parseNumber(seed.determinism?.normalization?.referenceResolution?.height, viewport.height || 1080),
        },
      },
      behaviorParameters: behavior,
      mapping: {
        spawnRatePerSecond: spawnRate,
        spawnIntervalSeconds: spawnRate > 0 ? 1 / spawnRate : 0,
        dropletSizeClampPx: [sizeClampMin, sizeClampMax],
        velocityRangePxPerSecond: [minVelocityY, maxVelocityY],
        trailPersistenceHalfLifeSeconds: [trailPersistenceMin, trailPersistenceMax],
        runnerMassThreshold,
        runnerProbability,
        runnerSpeedMultiplier,
      },
    },
  }

  return baselineTuning
}
