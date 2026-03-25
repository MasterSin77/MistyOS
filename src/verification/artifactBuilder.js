const DEFAULT_BOUNDED_SAMPLE_LIMIT = 240

function createArtifactId() {
  return `verify-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function toSafeInteger(value, fallback = 0) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback
}

function normalizeOptionalObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const normalized = {}
  Object.entries(value).forEach(([key, raw]) => {
    if (raw == null) {
      return
    }
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      normalized[key] = raw
      return
    }
    if (Array.isArray(raw)) {
      normalized[key] = raw.map((entry) => (typeof entry === 'object' && entry != null ? { ...entry } : entry))
      return
    }
    if (typeof raw === 'object') {
      normalized[key] = { ...raw }
    }
  })

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function normalizeSample(sample) {
  const clipCounts = normalizeOptionalObject(sample?.clipCounts)
  const activeIntentsByType = normalizeOptionalObject(sample?.activeIntentsByType)
  const activeWeatherCounts = normalizeOptionalObject(sample?.activeWeatherCounts)
  const activeWeatherClipIds = normalizeOptionalObject(sample?.activeWeatherClipIds)
  const metadata = normalizeOptionalObject(sample?.metadata)
  const render = normalizeOptionalObject(sample?.render)
  const bootstrap = normalizeOptionalObject(sample?.bootstrap)

  return {
    time: Number(sample?.time || 0),
    wind: Number(sample?.wind || 0),
    rain: Number(sample?.rain || 0),
    mist: Number(sample?.mist || 0),
    fog: Number(sample?.fog || 0),
    activeIntentIds: Array.isArray(sample?.activeIntentIds) ? [...sample.activeIntentIds] : [],
    ...(clipCounts ? { clipCounts } : {}),
    ...(activeIntentsByType ? { activeIntentsByType } : {}),
    ...(activeWeatherCounts ? { activeWeatherCounts } : {}),
    ...(activeWeatherClipIds ? { activeWeatherClipIds } : {}),
    ...(metadata ? { metadata } : {}),
    ...(render ? { render } : {}),
    ...(bootstrap ? { bootstrap } : {}),
  }
}

function buildBoundedSamples(runtimeSamples, sampleLimit) {
  const safeSamples = Array.isArray(runtimeSamples)
    ? runtimeSamples.map(normalizeSample)
    : []

  const totalSamples = safeSamples.length
  const safeLimit = Math.max(20, toSafeInteger(sampleLimit, DEFAULT_BOUNDED_SAMPLE_LIMIT))
  if (totalSamples <= safeLimit) {
    return {
      runtimeSamples: safeSamples,
      samplePayload: {
        strategy: 'full',
        totalSamples,
        includedSamples: totalSamples,
        truncated: false,
      },
    }
  }

  const headCount = Math.max(1, Math.floor(safeLimit / 2))
  const tailCount = Math.max(1, safeLimit - headCount)
  const bounded = [
    ...safeSamples.slice(0, headCount),
    ...safeSamples.slice(-tailCount),
  ]

  return {
    runtimeSamples: bounded,
    samplePayload: {
      strategy: 'head-tail-bounded',
      totalSamples,
      includedSamples: bounded.length,
      truncated: true,
      headCount,
      tailCount,
    },
  }
}

function clipToSerializableShape(clip) {
  return {
    id: clip?.id || null,
    trackKind: clip?.trackKind || null,
    region: clip?.region || 'global',
    startSec: Number(clip?.startSec || 0),
    endSec: Number(clip?.endSec || 0),
    intensity: Number(clip?.intensity || 0),
    blendInSec: Number(clip?.blendInSec || 0),
    blendOutSec: Number(clip?.blendOutSec || 0),
    intentKind: clip?.intentKind || null,
  }
}

function trackToSerializableShape(track) {
  return {
    id: track?.id || null,
    kind: track?.kind || null,
    region: track?.region || 'global',
    envelope: Array.isArray(track?.envelope)
      ? track.envelope.map((point) => ({
        timeSec: Number(point?.timeSec || 0),
        value: Number(point?.value || 0),
      }))
      : [],
  }
}

function buildScenarioSubsets({ authoredClips, authoredTimeline, scenarioKind, scenarioField, scenarioRegion }) {
  if (scenarioKind !== 'runtime-sample') {
    return {
      authoredClipSubset: [],
      compiledRuntimeTrackSubset: [],
    }
  }

  const safeRegion = scenarioRegion || 'global'
  const clipSubset = Array.isArray(authoredClips)
    ? authoredClips
      .filter((clip) => {
        if (clip?.trackKind !== scenarioField) {
          return false
        }

        const clipRegion = clip?.region || 'global'
        return safeRegion === 'global' || clipRegion === safeRegion
      })
      .map(clipToSerializableShape)
    : []

  const trackSubset = Array.isArray(authoredTimeline?.weatherTracks)
    ? authoredTimeline.weatherTracks
      .filter((track) => {
        if (track?.kind !== scenarioField) {
          return false
        }

        const trackRegion = track?.region || 'global'
        return safeRegion === 'global' || trackRegion === safeRegion
      })
      .map(trackToSerializableShape)
    : []

  return {
    authoredClipSubset: clipSubset,
    compiledRuntimeTrackSubset: trackSubset,
  }
}

export function buildVerificationArtifactReport({
  projectId,
  projectName,
  saveRevision,
  publishRevision,
  restartToken,
  sceneId,
  timelineId,
  publishedAt,
  runtimePayloadFingerprint,
  scenario,
  pass,
  assertionResults,
  runtimeSamples,
  authoredClips,
  authoredTimeline,
  sampleLimit,
}) {
  const artifactId = createArtifactId()
  const createdAt = new Date().toISOString()
  const safeAssertionResults = Array.isArray(assertionResults)
    ? assertionResults.map((result) => ({ ...result }))
    : []

  const scenarioName = scenario?.scenarioName || scenario?.runtimeScenario?.name || 'Unnamed Verification Scenario'
  const scenarioId = scenario?.id || null
  const scenarioKind = scenario?.kind || null
  const scenarioField = scenario?.runtimeScenario?.field || null
  const scenarioRegion = scenario?.runtimeScenario?.region || null

  const boundedSamples = buildBoundedSamples(runtimeSamples, sampleLimit)
  const sampleCount = boundedSamples.samplePayload.totalSamples
  const scenarioSubsets = buildScenarioSubsets({
    authoredClips,
    authoredTimeline,
    scenarioKind,
    scenarioField,
    scenarioRegion,
  })

  const assertionFieldsUsed = [...new Set(
    safeAssertionResults.flatMap((result) => [result.field, result.fieldA, result.fieldB].filter(Boolean)),
  )]
  const fieldCoverage = assertionFieldsUsed.length > 0 ? assertionFieldsUsed : (scenarioField ? [scenarioField] : [])
  const scenarioWindows = Array.isArray(scenario?.runtimeScenario?.windows)
    ? scenario.runtimeScenario.windows.map((win) => ({
      id: win.id || null,
      label: win.label || null,
      startSec: Number(win.startSec || 0),
      endSec: Number(win.endSec || 0),
    }))
    : []

  return {
    artifactType: 'mistyos-runtime-verification-report',
    schemaVersion: 2,
    artifactId,
    createdAt,
    projectId: projectId ?? null,
    projectName: projectName ?? null,
    saveRevision: toSafeInteger(saveRevision, 0),
    publishRevision: toSafeInteger(publishRevision, 0),
    restartToken: restartToken ?? null,
    sceneId: sceneId ?? null,
    timelineId: timelineId ?? null,
    scenarioName,
    scenarioId,
    scenarioKind,
    pass: Boolean(pass),
    overall: {
      pass: Boolean(pass),
      assertionCount: safeAssertionResults.length,
      failedAssertionCount: safeAssertionResults.filter((item) => !item?.pass).length,
    },
    summary: {
      scenarioName,
      passFail: Boolean(pass) ? 'pass' : 'fail',
      assertionCount: safeAssertionResults.length,
      sampleCount,
      projectId: projectId ?? null,
      projectName: projectName ?? null,
      publishRevision: toSafeInteger(publishRevision, 0),
      restartToken: restartToken ?? null,
      sceneId: sceneId ?? null,
      timelineId: timelineId ?? null,
      createdAt,
    },
    lineage: {
      projectId: projectId ?? null,
      projectName: projectName ?? null,
      saveRevision: toSafeInteger(saveRevision, 0),
      publishRevision: toSafeInteger(publishRevision, 0),
      restartToken: restartToken ?? null,
      sceneId: sceneId ?? null,
      timelineId: timelineId ?? null,
      publishedAt: publishedAt ?? null,
      runtimePayloadFingerprint: runtimePayloadFingerprint ?? null,
    },
    assertionResults: safeAssertionResults,
    sampleCount,
    runtimeSamples: boundedSamples.runtimeSamples,
    runtimeSamplePayload: boundedSamples.samplePayload,
    fieldCoverage,
    scenarioWindows,
    authoredClipSubset: scenarioSubsets.authoredClipSubset,
    compiledRuntimeTrackSubset: scenarioSubsets.compiledRuntimeTrackSubset,

    // Backward-compatible legacy keys used by older readouts/scripts.
    field: scenarioField,
    samples: boundedSamples.runtimeSamples,
  }
}

export function buildFullSuiteArtifactReport({
  projectId,
  projectName,
  saveRevision,
  publishRevision,
  restartToken,
  sceneId,
  timelineId,
  publishedAt,
  runtimePayloadFingerprint,
  scenarioArtifacts,
}) {
  const artifactId = createArtifactId()
  const createdAt = new Date().toISOString()
  const safeArtifacts = Array.isArray(scenarioArtifacts) ? scenarioArtifacts : []
  const scenarios = safeArtifacts.map((artifact) => {
    const samples = Array.isArray(artifact.samples)
      ? artifact.samples.map(normalizeSample)
      : Array.isArray(artifact.runtimeSamples)
      ? artifact.runtimeSamples.map(normalizeSample)
      : []

    return {
      scenarioId: artifact.scenarioId || null,
      scenarioName: artifact.scenarioName || null,
      scenarioKind: artifact.scenarioKind || null,
      pass: Boolean(artifact.pass),
      assertionResults: Array.isArray(artifact.assertionResults)
        ? artifact.assertionResults.map((result) => ({ ...result }))
        : [],
      samples,
      sampleCount: Number.isFinite(Number(artifact.sampleCount))
        ? Number(artifact.sampleCount)
        : samples.length,
      fieldCoverage: Array.isArray(artifact.fieldCoverage) ? [...artifact.fieldCoverage] : [],
      scenarioWindows: Array.isArray(artifact.scenarioWindows)
        ? artifact.scenarioWindows.map((win) => ({ ...win }))
        : [],
      runtimeSamplePayload: artifact.runtimeSamplePayload ? { ...artifact.runtimeSamplePayload } : null,
      authoredClipSubset: Array.isArray(artifact.authoredClipSubset)
        ? artifact.authoredClipSubset.map((clip) => ({ ...clip }))
        : [],
      compiledRuntimeTrackSubset: Array.isArray(artifact.compiledRuntimeTrackSubset)
        ? artifact.compiledRuntimeTrackSubset.map((track) => ({ ...track }))
        : [],
      field: artifact.field || null,
    }
  })

  const overallPass = scenarios.every((scenario) => scenario.pass)

  const fieldCoverageSet = new Set()
  for (const scenario of scenarios) {
    if (Array.isArray(scenario.fieldCoverage)) {
      for (const field of scenario.fieldCoverage) {
        if (field) {
          fieldCoverageSet.add(field)
        }
      }
    } else if (scenario.field) {
      fieldCoverageSet.add(scenario.field)
    }
  }
  const fieldCoverage = [...fieldCoverageSet].filter(Boolean)

  const scenarioWindows = scenarios.flatMap((scenario) =>
    (Array.isArray(scenario.scenarioWindows) ? scenario.scenarioWindows : []).map((win) => ({
      ...win,
      scenarioId: scenario.scenarioId || null,
    })),
  )

  const totalAssertionCount = scenarios.reduce((sum, scenario) => sum + scenario.assertionResults.length, 0)
  const failedAssertionCount = scenarios.reduce(
    (sum, scenario) => sum + scenario.assertionResults.filter((result) => !result?.pass).length,
    0,
  )
  const totalSampleCount = scenarios.reduce((sum, scenario) => sum + scenario.sampleCount, 0)

  return {
    artifactType: 'mistyos-runtime-verification-report',
    schemaVersion: 2,
    artifactId,
    createdAt,
    projectId: projectId ?? null,
    projectName: projectName ?? null,
    saveRevision: toSafeInteger(saveRevision, 0),
    publishRevision: toSafeInteger(publishRevision, 0),
    restartToken: restartToken ?? null,
    sceneId: sceneId ?? null,
    timelineId: timelineId ?? null,
    scenarioName: 'Full Verification Suite',
    scenarioId: 'builtin.full-suite',
    scenarioKind: 'full-suite',
    pass: overallPass,
    overall: {
      pass: overallPass,
      scenarioCount: scenarios.length,
      passedScenarioCount: scenarios.filter((scenario) => scenario.pass).length,
      failedScenarioCount: scenarios.filter((scenario) => !scenario.pass).length,
      assertionCount: totalAssertionCount,
      failedAssertionCount,
    },
    summary: {
      scenarioName: 'Full Verification Suite',
      passFail: overallPass ? 'pass' : 'fail',
      scenarioCount: scenarios.length,
      projectId: projectId ?? null,
      projectName: projectName ?? null,
      publishRevision: toSafeInteger(publishRevision, 0),
      restartToken: restartToken ?? null,
      sceneId: sceneId ?? null,
      timelineId: timelineId ?? null,
      createdAt,
    },
    lineage: {
      projectId: projectId ?? null,
      projectName: projectName ?? null,
      saveRevision: toSafeInteger(saveRevision, 0),
      publishRevision: toSafeInteger(publishRevision, 0),
      restartToken: restartToken ?? null,
      sceneId: sceneId ?? null,
      timelineId: timelineId ?? null,
      publishedAt: publishedAt ?? null,
      runtimePayloadFingerprint: runtimePayloadFingerprint ?? null,
    },
    fieldCoverage,
    scenarioWindows,
    scenarios,
    assertionResults: scenarios.flatMap((scenario) =>
      scenario.assertionResults.map((result) => ({
        ...result,
        scenarioId: scenario.scenarioId || null,
      })),
    ),
    sampleCount: totalSampleCount,
    runtimeSamples: [],
    runtimeSamplePayload: {
      strategy: 'full-suite',
      totalSamples: totalSampleCount,
      includedSamples: 0,
      truncated: false,
    },

    // Backward-compatible legacy keys.
    field: null,
    samples: [],
  }
}
