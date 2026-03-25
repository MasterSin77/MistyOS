import {
  getPresetById,
  getStudioSettings,
  getTimelineById,
  resolveSceneForPresentation,
  sceneCatalog,
} from '../config'
import { DEFAULT_TUNING_CONFIG, mergeDeep } from '../tuning/tuningConfig'
import { runtimePayloadFingerprint } from './authoringRuntimeBridge'

/**
 * Presentation runtime contract:
 * - Published runtime payload is the only input authority for Presentation startup.
 * - This module resolves payload shape and deterministic weather-driven tuning mapping.
 * - Scheduler runtime sampling remains the sole temporal authority for weather state.
 */

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function shortHashFromString(input) {
  const source = String(input || '')
  let hash = 2166136261

  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function shortRuntimePayloadHash(runtimePayload) {
  return shortHashFromString(runtimePayloadFingerprint(runtimePayload || null))
}

export function resolveRuntimeExecutionFromPayload(runtimePayload, options = {}) {
  const fallbackSettings = options.fallbackSettings || getStudioSettings()
  const snapshot = runtimePayload?.settingsSnapshot

  const settings = {
    ...fallbackSettings,
    startupMode: snapshot?.startupMode || fallbackSettings.startupMode,
    staticStartup: snapshot?.staticStartup || fallbackSettings.staticStartup,
    scenePerVisit: snapshot?.scenePerVisit || fallbackSettings.scenePerVisit,
    presentation: {
      ...(fallbackSettings.presentation || {}),
      ...(snapshot?.presentation || {}),
    },
  }

  const selectedSceneId = runtimePayload?.selectedSceneId
  const scene = selectedSceneId
    ? sceneCatalog.find((entry) => entry.id === selectedSceneId) || resolveSceneForPresentation(settings)
    : resolveSceneForPresentation(settings)

  const selectedTimelineId = runtimePayload?.selectedTimelineId || null
  const publishedTimeline = runtimePayload?.authoredTimeline
  let timeline = null

  // If the payload carries an authored compiled timeline, it is the canonical runtime source.
  if (publishedTimeline && typeof publishedTimeline === 'object') {
    timeline = {
      ...publishedTimeline,
      id: publishedTimeline.id || selectedTimelineId || 'authored',
      duration: publishedTimeline.duration || { seconds: runtimePayload?.timelineDurationSec || 180 },
    }
  } else if (selectedTimelineId) {
    // Resolve the exact payload timeline id first. If it is unknown,
    // fall back to a concrete catalog timeline instead of an empty timeline.
    const matched = getTimelineById(selectedTimelineId)
    timeline = matched && matched.id === selectedTimelineId
      ? matched
      : getTimelineById(settings.defaultTimelineId || scene.timelineId)
  } else {
    timeline = getTimelineById(settings.defaultTimelineId || scene.timelineId)
  }

  const preset = getPresetById(runtimePayload?.selectedPresetId || scene.presetId)
  const basePreset = mergeDeep(DEFAULT_TUNING_CONFIG, preset?.tuning || {})

  return {
    settings,
    scene,
    timeline,
    basePreset,
    sceneId: runtimePayload?.selectedSceneId || scene?.id || 'unknown',
    timelineId: selectedTimelineId || timeline?.id || 'unknown',
  }
}

export function buildRuntimeWeatherDrivenConfig(basePreset, weather) {
  // Deterministic projection from scheduler-sampled weather into engine tuning inputs.
  return mergeDeep(basePreset, {
    fogSurface: {
      baseFogLevel: clamp(0.02 + weather.fogBuildup * 0.38 - weather.fogClearing * 0.26, 0, 0.45),
      fogAlphaMultiplier: clamp(0.34 + weather.mist * 0.95 + weather.fogBuildup * 0.55, 0, 1.4),
      fogFillBoost: clamp(0.004 + weather.fogBuildup * 0.04, 0, 0.2),
    },
    renderer: {
      mistEnabled: weather.mist > 0.06,
      mistColorA: clamp(0.008 + weather.mist * 0.11, 0, 0.22),
      dropletsPerSeconds: Math.round(clamp(70 + weather.rain * 460 + weather.washdown * 140, 0, 1200)),
    },
    surfaceWetness: {
      refillRate: clamp(0.002 + weather.rain * 0.012 + weather.washdown * 0.008, 0, 0.03),
    },
  })
}