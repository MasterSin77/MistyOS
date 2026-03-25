import studioDefaults from './studio/defaults.json'
import defaultTimeline from './timelines/default-atmosphere.json'
import runnerCarveDiagnosisTimeline from './timelines/runner-carve-diagnosis.json'
import corePreset from './presets/core-wet-surface.json'
import sceneAtrium from './scenes/atrium-still.json'
import sceneStreet from './scenes/street-gif.json'
import sceneCity from './scenes/city-video.json'

const STORAGE_KEYS = {
  studio: 'mistyos.config.studio.v1',
}

export const STARTUP_MODES = {
  ALWAYS_ATMOSPHERIC: 'always-atmospheric',
  STATIC_THEN_FADE: 'static-then-fade-in',
  SCENE_PER_VISIT: 'scene-selected-per-visit',
}

export const sceneCatalog = [sceneAtrium, sceneStreet, sceneCity]
export const timelineCatalog = [defaultTimeline, runnerCarveDiagnosisTimeline]
export const presetCatalog = [corePreset]

function deepClone(value) {
  return JSON.parse(JSON.stringify(value))
}

function mergeDeep(base, override) {
  if (!override || typeof override !== 'object') {
    return deepClone(base)
  }

  const walk = (left, right) => {
    if (Array.isArray(left)) {
      return Array.isArray(right) ? right.slice() : left.slice()
    }
    if (left && typeof left === 'object') {
      const out = {}
      const keys = new Set([...Object.keys(left), ...Object.keys(right || {})])
      for (const key of keys) {
        out[key] = walk(left[key], right?.[key])
      }
      return out
    }
    return right === undefined ? left : right
  }

  return walk(base, override)
}

export function getStudioSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.studio)
    if (!raw) {
      return deepClone(studioDefaults)
    }
    const parsed = JSON.parse(raw)
    return mergeDeep(studioDefaults, parsed)
  } catch {
    return deepClone(studioDefaults)
  }
}

export function saveStudioSettings(nextSettings) {
  const merged = mergeDeep(studioDefaults, nextSettings)
  localStorage.setItem(STORAGE_KEYS.studio, JSON.stringify(merged))
  return merged
}

export function getPresetById(id) {
  return presetCatalog.find((item) => item.id === id) || corePreset
}

export function getTimelineById(id) {
  return timelineCatalog.find((item) => item.id === id) || defaultTimeline
}

export function resolveSceneForPresentation(settings, rng = Math.random) {
  if (settings.startupMode === STARTUP_MODES.SCENE_PER_VISIT) {
    const pool = settings.scenePerVisit?.pool || []
    const available = sceneCatalog.filter((scene) => pool.includes(scene.id))
    const source = available.length ? available : sceneCatalog
    const index = Math.floor(rng() * source.length)
    return source[index]
  }

  return sceneCatalog[0]
}

export function getStudioDefaultSettings() {
  return deepClone(studioDefaults)
}
