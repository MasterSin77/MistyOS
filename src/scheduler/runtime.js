import { createZeroWeatherState, WEATHER_KINDS } from './model'
import { compileIntentEvents } from './intent-compiler'
import { createFourQuadrantRegionModel } from './region-model'
import { recordRuntimeSample } from '../verification/runtimeSampleStore'

const WIND_SAFE_MIN = -1
const WIND_SAFE_MAX = 1

export function createSchedulerRuntime(timeline, options = {}) {
  const regionModel = options.regionModel || createFourQuadrantRegionModel()
  const timelineDurationSec = resolveDurationSec(timeline)
  const includeDiagnostics = options.includeDiagnostics === true
  const clipCounts = deriveCompiledClipCounts(timeline.weatherTracks || [])
  assertCompiledWeatherTracks(timeline.weatherTracks || [], timeline.id)

  return {
    timelineId: timeline.id,
    durationSec: timelineDurationSec,
    loop: timeline.loop !== false,
    regionModel,
    // Sole temporal authority for runtime weather sampling.
    // Presentation/engine loops can change cadence, but not weather truth.
    sample(sampleInfo) {
      const sampleSec = normalizeSampleTime(sampleInfo, timelineDurationSec, timeline.loop !== false)
      const sampleUv = sampleInfo?.uv || null
      const collectDiagnostics = includeDiagnostics || sampleInfo?.includeDiagnostics === true
      const baseResult = evaluateWeatherTracks(
        timeline.weatherTracks || [],
        sampleSec,
        regionModel,
        sampleUv,
        collectDiagnostics,
      )
      const intent = compileIntentEvents(timeline.intentEvents || [], sampleSec, {
        regionModel,
        uv: sampleUv,
        includeDiagnostics: collectDiagnostics,
      })
      const weather = mergeWeather(baseResult.weather, intent.weatherBias)
      const activeIntentsByType = deriveActiveIntentCounts(intent.active)
      const activeWeather = deriveActiveWeatherLineage(baseResult.activeTracks)

      const result = {
        sampleSec,
        weather,
        activeIntentEvents: intent.active,
        clipCounts,
        activeIntentsByType,
        activeWeatherCounts: activeWeather.counts,
        activeWeatherClipIds: activeWeather.clipIds,
      }

      // Verification capture path only; does not feed back into scheduler state.
      if (sampleInfo?.captureVerification === true) {
        recordRuntimeSample({
          time: sampleSec,
          wind: weather.wind,
          rain: weather.rain,
          mist: weather.mist,
          fog: clamp((weather.fogBuildup || 0) - (weather.fogClearing || 0), 0, 1),
          activeIntentIds: intent.active.map((event) => event.id),
          clipCounts,
          activeIntentsByType,
          activeWeatherCounts: activeWeather.counts,
          activeWeatherClipIds: activeWeather.clipIds,
        })
      }

      if (collectDiagnostics) {
        result.diagnostics = {
          sampleInput: {
            rawElapsedSec: Number.isFinite(sampleInfo?.elapsedSec) ? sampleInfo.elapsedSec : null,
            frame: Number.isFinite(sampleInfo?.frame) ? sampleInfo.frame : null,
            fps: Number.isFinite(sampleInfo?.fps) ? sampleInfo.fps : null,
            normalizedSampleSec: sampleSec,
          },
          sampleUv: sampleUv || { x: 0.5, y: 0.5 },
          weatherTrackContributions: baseResult.diagnostics,
          intentContributions: intent.diagnostics || [],
          weatherBeforeIntent: baseResult.weather,
          weatherAfterIntent: weather,
        }
      }

      return result
    },
  }
}

function deriveCompiledClipCounts(tracks) {
  const rainClipIds = new Set()
  const fogClipIds = new Set()

  tracks.forEach((track) => {
    const sourceClipIds = Array.isArray(track?.sourceClipIds) ? track.sourceClipIds : []
    if (track?.kind === 'rain') {
      sourceClipIds.forEach((clipId) => rainClipIds.add(clipId))
      return
    }

    if (track?.kind === 'fogBuildup' || track?.kind === 'fogClearing' || track?.kind === 'mist') {
      sourceClipIds.forEach((clipId) => fogClipIds.add(clipId))
    }
  })

  return {
    rainClips: rainClipIds.size,
    fogClips: fogClipIds.size,
  }
}

function deriveActiveIntentCounts(activeIntentEvents) {
  const counts = {
    rain: 0,
    fog: 0,
  }

  ;(Array.isArray(activeIntentEvents) ? activeIntentEvents : []).forEach((event) => {
    if (event?.kind === 'message-draw' || event?.kind === 'reminder-draw') {
      counts.rain += 1
      counts.fog += 1
      return
    }

    if (event?.kind === 'clock-reveal' || event?.kind === 'social-icon-reveal') {
      counts.fog += 1
    }
  })

  return counts
}

function assertCompiledWeatherTracks(tracks, timelineId) {
  if (!import.meta.env.DEV) {
    return
  }

  tracks.forEach((track, index) => {
    if (!WEATHER_KINDS.includes(track?.kind)) {
      console.warn('[MistyOS][SchedulerRuntime] Unknown weather track kind in compiled timeline.', {
        timelineId,
        trackIndex: index,
        kind: track?.kind,
      })
      return
    }

    if (!Array.isArray(track?.envelope) || track.envelope.length === 0) {
      console.warn('[MistyOS][SchedulerRuntime] Missing envelope on compiled weather track.', {
        timelineId,
        trackIndex: index,
        kind: track.kind,
      })
      return
    }

    if (typeof track?.region !== 'string' || track.region.trim().length === 0) {
      console.warn('[MistyOS][SchedulerRuntime] Compiled weather track has invalid region id.', {
        timelineId,
        trackIndex: index,
        kind: track.kind,
        region: track?.region,
      })
    }

    if (!Array.isArray(track?.sourceClipIds) || track.sourceClipIds.length === 0) {
      console.warn('[MistyOS][SchedulerRuntime] Compiled weather track is missing source clip lineage ids.', {
        timelineId,
        trackIndex: index,
        kind: track.kind,
        region: track.region,
        sourceClipIds: track?.sourceClipIds,
      })
    }

    let previousTimeSec = -Infinity

    track.envelope.forEach((point, pointIndex) => {
      if (!Number.isFinite(point?.timeSec) || !Number.isFinite(point?.value)) {
        console.warn('[MistyOS][SchedulerRuntime] Invalid envelope point in compiled weather track.', {
          timelineId,
          trackIndex: index,
          pointIndex,
          kind: track.kind,
          point,
        })
        return
      }

      if (point.timeSec < previousTimeSec) {
        console.warn('[MistyOS][SchedulerRuntime] Envelope time ordering is invalid on compiled weather track.', {
          timelineId,
          trackIndex: index,
          pointIndex,
          kind: track.kind,
          previousTimeSec,
          timeSec: point.timeSec,
        })
      }
      previousTimeSec = point.timeSec

      if (track.kind === 'rain' || track.kind === 'mist') {
        if (point.value < 0 || point.value > 1) {
          console.warn('[MistyOS][SchedulerRuntime] Envelope intensity out of bounds (0-1) for weather track.', {
            timelineId,
            trackIndex: index,
            pointIndex,
            kind: track.kind,
            value: point.value,
          })
        }
      } else if (track.kind === 'wind') {
        if (point.value < WIND_SAFE_MIN || point.value > WIND_SAFE_MAX) {
          console.warn('[MistyOS][SchedulerRuntime] Wind envelope value outside safe numeric range.', {
            timelineId,
            trackIndex: index,
            pointIndex,
            kind: track.kind,
            value: point.value,
            safeMin: WIND_SAFE_MIN,
            safeMax: WIND_SAFE_MAX,
          })
        }
      }
    })
  })
}

function resolveDurationSec(timeline) {
  const seconds = timeline?.duration?.seconds
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds
  }
  const frames = timeline?.duration?.frames
  if (Number.isFinite(frames) && frames > 0) {
    return frames / 60
  }
  return 120
}

function normalizeSampleTime(sampleInfo, durationSec, loop) {
  if (Number.isFinite(sampleInfo?.elapsedSec)) {
    if (!loop) {
      return Math.max(0, Math.min(durationSec, sampleInfo.elapsedSec))
    }
    return mod(sampleInfo.elapsedSec, durationSec)
  }

  const frame = Number.isFinite(sampleInfo?.frame) ? sampleInfo.frame : 0
  const fps = Number.isFinite(sampleInfo?.fps) && sampleInfo.fps > 0 ? sampleInfo.fps : 60
  const sec = frame / fps
  return loop ? mod(sec, durationSec) : Math.max(0, Math.min(durationSec, sec))
}

function evaluateWeatherTracks(tracks, sampleSec, regionModel, sampleUv, includeDiagnostics = false) {
  const output = createZeroWeatherState()
  const diagnostics = []
  const uv = sampleUv || { x: 0.5, y: 0.5 }

  for (const track of tracks) {
    if (!WEATHER_KINDS.includes(track.kind)) {
      continue
    }
    const envelopeDetails = sampleEnvelopeDetails(track.envelope || [], sampleSec)
    const value = envelopeDetails.value
    if (value === 0) {
      continue
    }
    const regionWeight = regionModel
      ? regionModel.sampleInfluence(track.region || 'global', uv)
      : 1
    const contribution = value * regionWeight
    output[track.kind] = Math.min(1, (output[track.kind] || 0) + contribution)

    if (includeDiagnostics) {
      diagnostics.push({
        kind: track.kind,
        region: track.region || 'global',
        trackKey: track.trackKey || `${track.kind}:${track.region || 'global'}`,
        sourceClipIds: Array.isArray(track.sourceClipIds) ? track.sourceClipIds : [],
        envelopeValue: value,
        envelopeSampleSec: sampleSec,
        interpolationT: envelopeDetails.interpolationT,
        previousPoint: envelopeDetails.previousPoint,
        nextPoint: envelopeDetails.nextPoint,
        regionWeight,
        contribution,
      })
    }
  }

  return {
    weather: output,
    diagnostics,
    activeTracks: diagnostics.map((entry) => ({
      kind: entry.kind,
      sourceClipIds: Array.isArray(entry.sourceClipIds) ? [...entry.sourceClipIds] : [],
      contribution: entry.contribution,
    })),
  }
}

function deriveActiveWeatherLineage(activeTracks) {
  const counts = {
    rain: 0,
    fog: 0,
  }
  const rainClipIds = new Set()
  const fogClipIds = new Set()

  ;(Array.isArray(activeTracks) ? activeTracks : []).forEach((track) => {
    const contribution = Number(track?.contribution || 0)
    if (!(contribution > 0)) {
      return
    }

    const sourceClipIds = Array.isArray(track?.sourceClipIds) ? track.sourceClipIds : []
    if (track?.kind === 'rain') {
      counts.rain += 1
      sourceClipIds.forEach((clipId) => rainClipIds.add(clipId))
      return
    }

    if (track?.kind === 'fogBuildup' || track?.kind === 'fogClearing' || track?.kind === 'mist') {
      counts.fog += 1
      sourceClipIds.forEach((clipId) => fogClipIds.add(clipId))
    }
  })

  return {
    counts,
    clipIds: {
      rain: Array.from(rainClipIds),
      fog: Array.from(fogClipIds),
    },
  }
}

function sampleEnvelope(envelope, sampleSec) {
  return sampleEnvelopeDetails(envelope, sampleSec).value
}

function sampleEnvelopeDetails(envelope, sampleSec) {
  if (!envelope.length) {
    return {
      value: 0,
      interpolationT: 0,
      previousPoint: null,
      nextPoint: null,
    }
  }

  if (sampleSec <= envelope[0].timeSec) {
    return {
      value: envelope[0].value || 0,
      interpolationT: 0,
      previousPoint: {
        timeSec: envelope[0].timeSec,
        value: envelope[0].value || 0,
      },
      nextPoint: {
        timeSec: envelope[0].timeSec,
        value: envelope[0].value || 0,
      },
    }
  }

  for (let i = 1; i < envelope.length; i += 1) {
    const prev = envelope[i - 1]
    const next = envelope[i]
    if (sampleSec <= next.timeSec) {
      const span = Math.max(0.0001, next.timeSec - prev.timeSec)
      const t = (sampleSec - prev.timeSec) / span
      return {
        value: lerp(prev.value || 0, next.value || 0, t),
        interpolationT: t,
        previousPoint: {
          timeSec: prev.timeSec,
          value: prev.value || 0,
        },
        nextPoint: {
          timeSec: next.timeSec,
          value: next.value || 0,
        },
      }
    }
  }

  return {
    value: envelope[envelope.length - 1].value || 0,
    interpolationT: 1,
    previousPoint: {
      timeSec: envelope[envelope.length - 1].timeSec,
      value: envelope[envelope.length - 1].value || 0,
    },
    nextPoint: {
      timeSec: envelope[envelope.length - 1].timeSec,
      value: envelope[envelope.length - 1].value || 0,
    },
  }
}

function mergeWeather(primary, bias) {
  const merged = createZeroWeatherState()
  for (const key of WEATHER_KINDS) {
    merged[key] = clamp((primary[key] || 0) + (bias[key] || 0), 0, 1)
  }
  return merged
}

function lerp(a, b, t) {
  return a + (b - a) * clamp(t, 0, 1)
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function mod(value, max) {
  return ((value % max) + max) % max
}
