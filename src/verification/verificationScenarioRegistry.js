import { createCurrentTimelineWindRampScenario, createTrackRampScenario } from './windRampScenario'

function getOrderedEnvelope(track) {
  return [...(track?.envelope || [])]
    .filter((point) => Number.isFinite(point?.timeSec) && Number.isFinite(point?.value))
    .sort((left, right) => left.timeSec - right.timeSec)
}

function findFirstThresholdCrossing(envelope, threshold) {
  return envelope.find((point) => point.value >= threshold)?.timeSec ?? null
}

function getStrongestMistTrack(compiledTimeline) {
  const weatherTracks = compiledTimeline?.weatherTracks || []

  const candidates = weatherTracks
    .filter((track) => track?.kind === 'mist' && Array.isArray(track.envelope) && track.envelope.length >= 2)
    .map((track) => {
      const envelope = getOrderedEnvelope(track)
      const peakValue = envelope.reduce((maxValue, point) => Math.max(maxValue, point.value), 0)
      return {
        track,
        envelope,
        region: track?.region || 'global',
        peakValue,
      }
    })
    .filter(({ envelope, peakValue }) => envelope.length >= 2 && peakValue > 0.05)

  if (!candidates.length) {
    return null
  }

  const globalCandidate = candidates.find((candidate) => candidate.region === 'global')
  if (globalCandidate) {
    return globalCandidate
  }

  return candidates.reduce((best, candidate) => (
    candidate.peakValue > best.peakValue ? candidate : best
  ), candidates[0])
}

function createRegionalMistThresholdScenario(compiledTimeline) {
  const mistTrack = getStrongestMistTrack(compiledTimeline)
  if (!mistTrack) {
    return null
  }

  const thresholdMin = Math.max(0.05, Number((mistTrack.peakValue * 0.45).toFixed(3)))
  const thresholdCrossingSec = findFirstThresholdCrossing(mistTrack.envelope, thresholdMin)
  if (!Number.isFinite(thresholdCrossingSec)) {
    return null
  }

  const captureStartTimeSec = Math.max(0, thresholdCrossingSec - 0.1)
  const assertionEndSec = Number((thresholdCrossingSec + 1.2).toFixed(3))
  const captureDurationMs = Math.max(1200, Math.round((assertionEndSec - captureStartTimeSec + 0.4) * 1000))

  return {
    id: 'builtin.regional-mist-threshold',
    scenarioName: mistTrack.region === 'global'
      ? 'Regional Mist Threshold (Global)'
      : `Regional Mist Threshold (${mistTrack.region})`,
    kind: 'runtime-sample',
    captureStartTimeSec,
    captureDurationMs,
    probeTimesSec: [
      Number(captureStartTimeSec.toFixed(3)),
      Number(thresholdCrossingSec.toFixed(3)),
      assertionEndSec,
    ],
    runtimeScenario: {
      name: mistTrack.region === 'global'
        ? 'Regional Mist Threshold (Global)'
        : `Regional Mist Threshold (${mistTrack.region})`,
      field: 'mist',
      region: mistTrack.region,
      trackId: mistTrack.track?.id || null,
      assertions: [
        {
          id: 'mist-threshold-min',
          type: 'threshold_min',
          min: thresholdMin,
          startTime: thresholdCrossingSec,
          endTime: assertionEndSec,
        },
      ],
    },
  }
}

function createSavePublishRestartLineageScenario(context) {
  const publishRevision = Number(context?.publishedDocument?.publishRevision || 0)
  const restartToken = context?.publishedDocument?.restartToken || null

  return {
    id: 'builtin.save-publish-restart-lineage-check',
    scenarioName: 'Save/Publish/Restart Lineage Check',
    kind: 'lineage-check',
    captureStartTimeSec: 0,
    captureDurationMs: 0,
    probeTimesSec: [],
    lineageExpectations: {
      hasPublishRevision: publishRevision > 0,
      hasRestartToken: Boolean(restartToken),
      selectedSceneId: context?.publishedDocument?.runtimePayload?.selectedSceneId || null,
      selectedTimelineId: context?.publishedDocument?.runtimePayload?.selectedTimelineId || null,
      activeSceneId: context?.activeSceneId || null,
      activeTimelineId: context?.activeTimelineId || null,
    },
  }
}

function createRainRampScenario(compiledTimeline) {
  const rampResult = createTrackRampScenario(compiledTimeline, 'rain')
  if (!rampResult) {
    return null
  }

  return {
    id: 'builtin.rain-ramp',
    scenarioName: rampResult.scenario.name,
    kind: 'runtime-sample',
    captureStartTimeSec: rampResult.captureStartTimeSec,
    captureDurationMs: rampResult.captureDurationMs,
    probeTimesSec: rampResult.probeTimesSec,
    runtimeScenario: rampResult.scenario,
  }
}

function createFogBuildupScenario(compiledTimeline) {
  const weatherTracks = compiledTimeline?.weatherTracks || []
  const fogTracks = weatherTracks.filter(
    (track) => track?.kind === 'fogBuildup' && Array.isArray(track.envelope) && track.envelope.length >= 2,
  )

  if (!fogTracks.length) {
    return null
  }

  const selected = fogTracks.find((track) => (track?.region || 'global') === 'global') || fogTracks[0]
  const envelope = [...(selected.envelope || [])]
    .filter((point) => Number.isFinite(point?.timeSec) && Number.isFinite(point?.value))
    .sort((left, right) => left.timeSec - right.timeSec)

  if (envelope.length < 2) {
    return null
  }

  const peakPoint = envelope.reduce((best, point) => (point.value > best.value ? point : best), envelope[0])
  if (peakPoint.value <= 0.05) {
    return null
  }

  const captureStartTimeSec = Math.max(0, envelope[0].timeSec)
  const captureEndSec = peakPoint.timeSec + 0.5
  const captureDurationMs = Math.max(1500, Math.round((captureEndSec - captureStartTimeSec + 0.3) * 1000))
  const thresholdMin = Math.max(0.05, Number((peakPoint.value * 0.4).toFixed(3)))
  const probeTimesSec = [...new Set([
    Number(captureStartTimeSec.toFixed(3)),
    Number((captureStartTimeSec + (peakPoint.timeSec - captureStartTimeSec) * 0.5).toFixed(3)),
    Number(peakPoint.timeSec.toFixed(3)),
  ])]

  const region = selected?.region || 'global'

  return {
    id: 'builtin.fog-buildup',
    scenarioName: region === 'global' ? 'Fog Buildup Accumulation' : `Fog Buildup Accumulation (${region})`,
    kind: 'runtime-sample',
    captureStartTimeSec,
    captureDurationMs,
    probeTimesSec,
    runtimeScenario: {
      name: region === 'global' ? 'Fog Buildup Accumulation' : `Fog Buildup Accumulation (${region})`,
      field: 'fog',
      region,
      trackId: selected?.id || null,
      windows: [
        {
          id: 'fog-rise',
          label: 'Fog Rise Window',
          startSec: captureStartTimeSec,
          endSec: peakPoint.timeSec,
        },
      ],
      assertions: [
        {
          id: 'fog-threshold-min',
          type: 'threshold_min',
          field: 'fog',
          windowId: 'fog-rise',
          min: thresholdMin,
        },
        {
          id: 'fog-monotonic-increase',
          type: 'monotonic_increase',
          field: 'fog',
          windowId: 'fog-rise',
          tolerance: 0.025,
        },
      ],
    },
  }
}

function createMistDuringRainScenario(compiledTimeline) {
  const weatherTracks = compiledTimeline?.weatherTracks || []
  const rainTracks = weatherTracks.filter(
    (track) => track?.kind === 'rain' && Array.isArray(track.envelope) && track.envelope.length >= 2,
  )
  const mistTracks = weatherTracks.filter(
    (track) => track?.kind === 'mist' && Array.isArray(track.envelope) && track.envelope.length >= 2,
  )

  if (!rainTracks.length || !mistTracks.length) {
    return null
  }

  const rainTrack = rainTracks.find((track) => (track?.region || 'global') === 'global') || rainTracks[0]
  const rainEnvelope = [...(rainTrack.envelope || [])]
    .filter((point) => Number.isFinite(point?.timeSec) && Number.isFinite(point?.value))
    .sort((left, right) => left.timeSec - right.timeSec)

  const rainPeak = rainEnvelope.reduce((best, point) => (point.value > best.value ? point : best), rainEnvelope[0])
  if (rainPeak.value <= 0.1) {
    return null
  }

  const mistTrack = mistTracks.find((track) => (track?.region || 'global') === 'global') || mistTracks[0]
  const mistEnvelope = [...(mistTrack.envelope || [])]
    .filter((point) => Number.isFinite(point?.timeSec) && Number.isFinite(point?.value))
    .sort((left, right) => left.timeSec - right.timeSec)

  const mistPeak = mistEnvelope.reduce((best, point) => (point.value > best.value ? point : best), mistEnvelope[0])
  if (mistPeak.value <= 0.05) {
    return null
  }

  const windowStart = Math.max(0, Math.min(rainPeak.timeSec - 0.5, mistPeak.timeSec - 0.5))
  const windowEnd = Math.max(rainPeak.timeSec, mistPeak.timeSec) + 0.3
  const captureDurationMs = Math.max(1500, Math.round((windowEnd - windowStart + 0.3) * 1000))
  const mistThresholdMin = Math.max(0.05, Number((mistPeak.value * 0.35).toFixed(3)))
  const probeTimesSec = [...new Set([
    Number(windowStart.toFixed(3)),
    Number(rainPeak.timeSec.toFixed(3)),
    Number(mistPeak.timeSec.toFixed(3)),
    Number(windowEnd.toFixed(3)),
  ])]

  return {
    id: 'builtin.mist-during-rain',
    scenarioName: 'Mist Presence During Rain',
    kind: 'runtime-sample',
    captureStartTimeSec: windowStart,
    captureDurationMs,
    probeTimesSec,
    runtimeScenario: {
      name: 'Mist Presence During Rain',
      field: 'mist',
      region: 'global',
      windows: [
        {
          id: 'rain-peak-window',
          label: 'Rain Peak Window',
          startSec: Math.max(0, rainPeak.timeSec - 0.2),
          endSec: rainPeak.timeSec + 0.2,
        },
        {
          id: 'mist-peak-window',
          label: 'Mist Peak Window',
          startSec: Math.max(0, mistPeak.timeSec - 0.2),
          endSec: mistPeak.timeSec + 0.3,
        },
      ],
      assertions: [
        {
          id: 'mist-present-during-rain',
          type: 'threshold_min',
          field: 'mist',
          windowId: 'mist-peak-window',
          min: mistThresholdMin,
        },
        {
          id: 'rain-active-during-capture',
          type: 'threshold_min',
          field: 'rain',
          windowId: 'rain-peak-window',
          min: Math.max(0.05, Number((rainPeak.value * 0.35).toFixed(3))),
        },
      ],
    },
  }
}

function createRainMistCorrelationScenario(compiledTimeline) {
  const weatherTracks = compiledTimeline?.weatherTracks || []
  const rainTracks = weatherTracks.filter(
    (track) => track?.kind === 'rain' && Array.isArray(track.envelope) && track.envelope.length >= 2,
  )
  const mistTracks = weatherTracks.filter(
    (track) => track?.kind === 'mist' && Array.isArray(track.envelope) && track.envelope.length >= 2,
  )

  if (!rainTracks.length || !mistTracks.length) {
    return null
  }

  const rainTrack = rainTracks.find((track) => (track?.region || 'global') === 'global') || rainTracks[0]
  const mistTrack = mistTracks.find((track) => (track?.region || 'global') === 'global') || mistTracks[0]

  const rainEnvelope = [...(rainTrack.envelope || [])]
    .filter((point) => Number.isFinite(point?.timeSec) && Number.isFinite(point?.value))
    .sort((left, right) => left.timeSec - right.timeSec)
  const mistEnvelope = [...(mistTrack.envelope || [])]
    .filter((point) => Number.isFinite(point?.timeSec) && Number.isFinite(point?.value))
    .sort((left, right) => left.timeSec - right.timeSec)

  const rainMax = rainEnvelope.reduce((m, p) => Math.max(m, p.value), 0)
  const mistMax = mistEnvelope.reduce((m, p) => Math.max(m, p.value), 0)

  if (rainMax <= 0.1 || mistMax <= 0.05) {
    return null
  }

  const allPoints = [...rainEnvelope, ...mistEnvelope].sort((left, right) => left.timeSec - right.timeSec)
  const windowStart = Math.max(0, allPoints[0].timeSec - 0.1)
  const windowEnd = allPoints[allPoints.length - 1].timeSec + 0.2
  const captureDurationMs = Math.max(2000, Math.round((windowEnd - windowStart + 0.4) * 1000))
  const probeTimesSec = [...new Set([
    Number(windowStart.toFixed(3)),
    ...rainEnvelope.map((p) => Number(p.timeSec.toFixed(3))),
    ...mistEnvelope.map((p) => Number(p.timeSec.toFixed(3))),
    Number(windowEnd.toFixed(3)),
  ])].sort((left, right) => left - right)

  return {
    id: 'builtin.rain-mist-correlation',
    scenarioName: 'Rain → Mist Coupling (Cross-Field Correlation)',
    kind: 'runtime-sample',
    captureStartTimeSec: windowStart,
    captureDurationMs,
    probeTimesSec,
    runtimeScenario: {
      name: 'Rain → Mist Coupling (Cross-Field Correlation)',
      field: 'rain',
      region: 'global',
      windows: [
        {
          id: 'correlation-window',
          label: 'Rain/Mist Overlap Window',
          startSec: windowStart,
          endSec: windowEnd,
        },
      ],
      assertions: [
        {
          id: 'rain-mist-correlation-positive',
          type: 'correlation_positive',
          fieldA: 'rain',
          fieldB: 'mist',
          windowId: 'correlation-window',
          minCorrelation: 0.55,
        },
      ],
    },
  }
}

const BUILTIN_SCENARIOS = [
  {
    id: 'builtin.wind-ramp',
    label: 'Wind Ramp',
    description: 'Verifies a current-timeline wind ramp using runtime samples from the scheduler tap.',
    resolve: (context) => {
      const windScenario = createCurrentTimelineWindRampScenario(context?.authoredTimeline)
      if (!windScenario) {
        return null
      }

      return {
        id: 'builtin.wind-ramp',
        scenarioName: windScenario?.scenario?.name || 'Wind Ramp',
        kind: 'runtime-sample',
        captureStartTimeSec: windScenario.captureStartTimeSec,
        captureDurationMs: windScenario.captureDurationMs,
        probeTimesSec: windScenario.probeTimesSec,
        runtimeScenario: windScenario.scenario,
      }
    },
  },
  {
    id: 'builtin.regional-mist-threshold',
    label: 'Regional Mist Threshold',
    description: 'Verifies that authored mist crosses a threshold in the strongest authored region.',
    resolve: (context) => createRegionalMistThresholdScenario(context?.authoredTimeline),
  },
  {
    id: 'builtin.save-publish-restart-lineage-check',
    label: 'Save/Publish/Restart Lineage Check',
    description: 'Verifies publish lineage metadata consistency for the current authored runtime.',
    resolve: (context) => createSavePublishRestartLineageScenario(context),
  },
  {
    id: 'builtin.rain-ramp',
    label: 'Rain Intensity Ramp',
    description: 'Verifies a current-timeline rain intensity ramp using scheduler runtime samples.',
    resolve: (context) => createRainRampScenario(context?.authoredTimeline),
  },
  {
    id: 'builtin.fog-buildup',
    label: 'Fog Buildup Accumulation',
    description: 'Verifies fog accumulates during fogBuildup tracks in the authored timeline.',
    resolve: (context) => createFogBuildupScenario(context?.authoredTimeline),
  },
  {
    id: 'builtin.mist-during-rain',
    label: 'Mist Presence During Rain',
    description: 'Verifies mist is present at threshold while rain events are active.',
    resolve: (context) => createMistDuringRainScenario(context?.authoredTimeline),
  },
  {
    id: 'builtin.rain-mist-correlation',
    label: 'Rain → Mist Coupling',
    description: 'Verifies positive correlation between rain and mist across authored timeline events.',
    resolve: (context) => createRainMistCorrelationScenario(context?.authoredTimeline),
  },
]

export function getVerificationScenarioRegistry() {
  return BUILTIN_SCENARIOS.map((entry) => ({
    id: entry.id,
    label: entry.label,
    description: entry.description,
  }))
}

export function getDefaultVerificationScenarioId() {
  return BUILTIN_SCENARIOS[0].id
}

export function resolveVerificationScenario(scenarioId, context) {
  const fallbackScenarioId = getDefaultVerificationScenarioId()
  const wantedId = scenarioId || fallbackScenarioId
  const definition = BUILTIN_SCENARIOS.find((entry) => entry.id === wantedId)
    || BUILTIN_SCENARIOS.find((entry) => entry.id === fallbackScenarioId)

  if (!definition) {
    return null
  }

  return definition.resolve(context)
}
