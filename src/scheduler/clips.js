/**
 * Clip data utilities: parse existing timeline JSON into editable clips,
 * and compile a clips array back into a timeline object for the runtime.
 */

const DEFAULT_WEATHER_CLIP = {
  intensity: 0.5,
  blendInSec: 1,
  blendOutSec: 1,
  region: 'global',
}

const PRIMARY_WEATHER_TYPES = ['wind', 'rain', 'mist']

const PRIMARY_WEATHER_REQUIRED_FIELDS = [
  'type',
  'intensity',
  'duration',
  'blendInSec',
  'blendOutSec',
  'region',
]

const WEATHER_TYPE_DEFAULTS = {
  wind: {
    intensity: 0.65,
    blendInSec: 3,
    blendOutSec: 3,
  },
  rain: {
    intensity: 0.55,
    blendInSec: 1.5,
    blendOutSec: 2,
  },
  mist: {
    intensity: 0.4,
    blendInSec: 4,
    blendOutSec: 4,
  },
}

const PRIMARY_WEATHER_SCHEMAS = {
  wind: {
    type: 'wind',
    defaults: WEATHER_TYPE_DEFAULTS.wind,
  },
  rain: {
    type: 'rain',
    defaults: WEATHER_TYPE_DEFAULTS.rain,
  },
  mist: {
    type: 'mist',
    defaults: WEATHER_TYPE_DEFAULTS.mist,
  },
}

export const WEATHER_CLIP_SCHEMAS = {
  wind: {
    required: PRIMARY_WEATHER_REQUIRED_FIELDS,
    defaults: { ...DEFAULT_WEATHER_CLIP, ...WEATHER_TYPE_DEFAULTS.wind },
  },
  rain: {
    required: PRIMARY_WEATHER_REQUIRED_FIELDS,
    defaults: { ...DEFAULT_WEATHER_CLIP, ...WEATHER_TYPE_DEFAULTS.rain },
  },
  mist: {
    required: PRIMARY_WEATHER_REQUIRED_FIELDS,
    defaults: { ...DEFAULT_WEATHER_CLIP, ...WEATHER_TYPE_DEFAULTS.mist },
  },
}

const DEFAULT_INTENT_PAYLOAD = {
  leadInSec: 2,
  revealStyle: 'soft-lift',
  recoveryStyle: 'gentle-settle',
}

const DEFAULT_INTENT_CLIP = {
  intentKind: 'clock-reveal',
  region: 'global',
  leadInBehavior: 'soft-ramp',
  payload: DEFAULT_INTENT_PAYLOAD,
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function toFiniteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

function isPrimaryWeatherType(type) {
  return PRIMARY_WEATHER_TYPES.includes(type)
}

function getPrimaryType(clip) {
  const explicitType = typeof clip?.type === 'string' ? clip.type : null
  const trackKindType = typeof clip?.trackKind === 'string' ? clip.trackKind : null
  return isPrimaryWeatherType(explicitType) ? explicitType : trackKindType
}

function warnSchemaViolation(message, details) {
  if (!import.meta.env.DEV) {
    return
  }
  console.warn(`[MistyOS][ClipSchema] ${message}`, details)
}

function assertPrimaryWeatherClipSchema(clip, context) {
  const isValid = Boolean(
    clip
    && isPrimaryWeatherType(clip.type)
    && clip.trackKind === clip.type
    && Number.isFinite(clip.intensity)
    && Number.isFinite(clip.duration)
    && Number.isFinite(clip.blendInSec)
    && Number.isFinite(clip.blendOutSec)
    && typeof clip.region === 'string'
    && clip.region.length > 0,
  )

  if (!isValid) {
    warnSchemaViolation(`Primary weather clip failed schema assertion in ${context}.`, clip)
  }
}

function normalizePrimaryWeatherClip(clip, timelineDurationSec) {
  const type = getPrimaryType(clip)
  const schema = PRIMARY_WEATHER_SCHEMAS[type]
  if (!schema) {
    return null
  }

  const defaults = {
    ...DEFAULT_WEATHER_CLIP,
    ...schema.defaults,
  }

  const startSec = clamp(toFiniteNumber(Number(clip.startSec), 0), 0, timelineDurationSec)
  const rawDurationSec = toFiniteNumber(
    Number(clip.duration),
    toFiniteNumber(Number(clip.endSec) - startSec, 10),
  )
  const duration = clamp(rawDurationSec, 0.1, Math.max(0.1, timelineDurationSec - startSec))
  const endSec = clamp(startSec + duration, startSec + 0.1, timelineDurationSec)
  const normalizedDuration = Math.max(0.1, endSec - startSec)

  const normalized = {
    id: clip.id || `clip-${Date.now()}`,
    trackKind: type,
    type,
    startSec,
    endSec,
    duration: normalizedDuration,
    intensity: clamp(toFiniteNumber(Number(clip.intensity), defaults.intensity), 0, 1),
    blendInSec: clamp(toFiniteNumber(Number(clip.blendInSec), defaults.blendInSec), 0, normalizedDuration * 0.45),
    blendOutSec: clamp(toFiniteNumber(Number(clip.blendOutSec), defaults.blendOutSec), 0, normalizedDuration * 0.45),
    region: clip.region || defaults.region,
  }

  assertPrimaryWeatherClipSchema(normalized, 'normalizePrimaryWeatherClip')
  return normalized
}

function normalizeWeatherClip(clip, timelineDurationSec) {
  const primary = normalizePrimaryWeatherClip(clip, timelineDurationSec)
  if (primary) {
    return primary
  }

  const typeDefaults = WEATHER_TYPE_DEFAULTS[clip.trackKind] || {}
  const defaults = {
    ...DEFAULT_WEATHER_CLIP,
    ...typeDefaults,
  }

  const startSec = clamp(toFiniteNumber(Number(clip.startSec), 0), 0, timelineDurationSec)
  const endSec = clamp(
    toFiniteNumber(Number(clip.endSec), startSec + 10),
    startSec + 0.1,
    timelineDurationSec,
  )
  const durationSec = Math.max(0.1, endSec - startSec)

  return {
    ...clip,
    type: clip.trackKind,
    startSec,
    endSec,
    duration: durationSec,
    intensity: clamp(toFiniteNumber(Number(clip.intensity), defaults.intensity), 0, 1),
    blendInSec: clamp(toFiniteNumber(Number(clip.blendInSec), defaults.blendInSec), 0, durationSec * 0.45),
    blendOutSec: clamp(toFiniteNumber(Number(clip.blendOutSec), defaults.blendOutSec), 0, durationSec * 0.45),
    region: clip.region || defaults.region,
  }
}

function normalizeIntentClip(clip, timelineDurationSec) {
  const startSec = clamp(toFiniteNumber(Number(clip.startSec), 0), 0, timelineDurationSec)
  const endSec = clamp(
    toFiniteNumber(Number(clip.endSec), startSec + 5),
    startSec + 0.1,
    timelineDurationSec,
  )

  return {
    ...DEFAULT_INTENT_CLIP,
    ...clip,
    startSec,
    endSec,
    region: clip.region || 'global',
    payload: {
      ...DEFAULT_INTENT_PAYLOAD,
      ...(clip.payload || {}),
    },
  }
}

export function normalizeClip(clip, timelineDurationSec = 180) {
  if (!clip) {
    return null
  }

  if (clip.trackKind === 'intent') {
    return normalizeIntentClip(clip, timelineDurationSec)
  }

  return normalizeWeatherClip(clip, timelineDurationSec)
}

export function createDefaultClip(trackKind, partial = {}, timelineDurationSec = 180) {
  const base = {
    id: partial.id || `clip-${Date.now()}`,
    trackKind,
    type: partial.type || trackKind,
    startSec: toFiniteNumber(Number(partial.startSec), 0),
    endSec: toFiniteNumber(Number(partial.endSec), 10),
  }

  if (trackKind === 'intent') {
    return normalizeIntentClip({
      ...base,
      ...DEFAULT_INTENT_CLIP,
      ...partial,
    }, timelineDurationSec)
  }

  if (isPrimaryWeatherType(trackKind)) {
    const normalized = normalizePrimaryWeatherClip({
      ...base,
      ...DEFAULT_WEATHER_CLIP,
      ...(WEATHER_TYPE_DEFAULTS[trackKind] || {}),
      ...partial,
      type: trackKind,
      trackKind,
    }, timelineDurationSec)
    assertPrimaryWeatherClipSchema(normalized, 'createDefaultClip')
    return normalized
  }

  return normalizeWeatherClip({
    ...base,
    ...DEFAULT_WEATHER_CLIP,
    ...(WEATHER_TYPE_DEFAULTS[trackKind] || {}),
    ...partial,
  }, timelineDurationSec)
}

export function createWindClip(partial = {}, timelineDurationSec = 180) {
  return createDefaultClip('wind', { ...partial, type: 'wind' }, timelineDurationSec)
}

export function createRainClip(partial = {}, timelineDurationSec = 180) {
  return createDefaultClip('rain', { ...partial, type: 'rain' }, timelineDurationSec)
}

export function createMistClip(partial = {}, timelineDurationSec = 180) {
  return createDefaultClip('mist', { ...partial, type: 'mist' }, timelineDurationSec)
}

/**
 * Convert a timeline's weatherTracks + intentEvents into an editable clips array.
 * One clip is produced per contiguous active segment on each weather track.
 * Intent events become intent clips 1:1.
 */
export function parseTimelineToClips(timeline) {
  const clips = []
  const durationSec = timeline?.duration?.seconds || 180

  for (const track of timeline.weatherTracks || []) {
    const env = track.envelope || []
    if (!env.length) continue

    const THRESHOLD = 0.05
    const GAP_SEC = 20 // gap between points that splits a track into separate clips

    // Walk envelope points and collect contiguous groups above threshold
    const groups = []
    let current = null

    for (const pt of env) {
      const val = pt.value || 0
      if (val > THRESHOLD) {
        if (!current) {
          current = { startSec: pt.timeSec, endSec: pt.timeSec, maxVal: val }
        } else if (pt.timeSec - current.endSec > GAP_SEC) {
          groups.push(current)
          current = { startSec: pt.timeSec, endSec: pt.timeSec, maxVal: val }
        } else {
          current.endSec = pt.timeSec
          current.maxVal = Math.max(current.maxVal, val)
        }
      }
    }
    if (current) groups.push(current)

    if (!groups.length) {
      // All-zero track: create a placeholder clip
      clips.push(createDefaultClip(track.kind, {
        id: `init-${track.kind}-0`,
        startSec: 0,
        endSec: durationSec,
        intensity: 0,
      }, durationSec))
    } else {
      groups.forEach((group, idx) => {
        clips.push(createDefaultClip(track.kind, {
          id: `init-${track.kind}-${idx}`,
          startSec: group.startSec,
          endSec: group.endSec,
          intensity: Math.round(group.maxVal * 100) / 100,
          region: track.region || 'global',
        }, durationSec))
      })
    }
  }

  for (const event of timeline.intentEvents || []) {
    clips.push(createDefaultClip('intent', {
      id: event.id || `init-intent-${clips.length}`,
      startSec: event.startSec || 0,
      endSec: (event.startSec || 0) + (event.durationSec || 5),
      intentKind: event.kind || 'clock-reveal',
      region: event.region || 'global',
      payload: event.payload || {},
      leadInBehavior: event.leadInBehavior || 'soft-ramp',
    }, durationSec))
  }

  return clips
}

/**
 * Build an envelope array from a sorted array of weather clips on one track.
 * Each clip produces a fade-in / sustain / fade-out shape.
 */
function buildEnvelopeFromClips(sortedClips, totalDurationSec) {
  if (!sortedClips.length) {
    return [
      { timeSec: 0, value: 0 },
      { timeSec: totalDurationSec, value: 0 },
    ]
  }

  const points = [{ timeSec: 0, value: 0 }]

  for (const clip of sortedClips) {
    const intensity = Number.isFinite(clip.intensity) ? clip.intensity : 0.5
    const dur = Math.max(0.1, Number.isFinite(clip.duration) ? clip.duration : (clip.endSec - clip.startSec))
    const clipEndSec = clamp(clip.startSec + dur, clip.startSec + 0.1, totalDurationSec)
    // Use clip-level blend values; cap at 45% of duration each so they never overlap
    const blendIn = clip.blendInSec != null
      ? Math.min(Number(clip.blendInSec), dur * 0.45)
      : Math.min(2, dur * 0.2)
    const blendOut = clip.blendOutSec != null
      ? Math.min(Number(clip.blendOutSec), dur * 0.45)
      : Math.min(2, dur * 0.2)

    // Ensure zero just before clip starts
    points.push({ timeSec: Math.max(0, clip.startSec - 0.001), value: 0 })
    // Ramp up
    points.push({ timeSec: clip.startSec, value: 0 })
    points.push({ timeSec: clip.startSec + blendIn, value: intensity })
    // Sustain until ramp-down
    const sustainEnd = clipEndSec - blendOut
    if (sustainEnd > clip.startSec + blendIn) {
      points.push({ timeSec: sustainEnd, value: intensity })
    }
    // Ramp down
    points.push({ timeSec: clipEndSec, value: 0 })
    points.push({ timeSec: Math.min(totalDurationSec, clipEndSec + 0.001), value: 0 })
  }

  points.push({ timeSec: totalDurationSec, value: 0 })

  // Sort by time then deduplicate adjacent same-time points (keep last)
  points.sort((a, b) => a.timeSec - b.timeSec || 0)

  return points
}

/**
 * Compile a clips array into a timeline object ready for createSchedulerRuntime.
 */
export function compileClipsToTimeline(clips, totalDurationSec, baseId) {
  const normalizedClips = (clips || [])
    .map((clip) => normalizeClip(clip, totalDurationSec))
    .filter(Boolean)

  normalizedClips.forEach((clip) => {
    if (isPrimaryWeatherType(clip.type || clip.trackKind)) {
      assertPrimaryWeatherClipSchema(clip, 'compileClipsToTimeline')
    }
  })

  // Group weather clips by kind + region so per-region tracks compile separately.
  // Keep insertion order deterministic for stable track keys within a compile pass.
  const weatherClipsByKey = new Map()
  const intentEvents = []

  for (const clip of normalizedClips) {
    if (clip.trackKind === 'intent') {
      intentEvents.push({
        id: clip.id,
        kind: clip.intentKind || 'clock-reveal',
        startSec: clip.startSec,
        durationSec: Math.max(0.1, clip.endSec - clip.startSec),
        region: clip.region || 'global',
        payload: clip.payload || {},
        leadInBehavior: clip.leadInBehavior || 'soft-ramp',
      })
    } else {
      const kind = clip.type || clip.trackKind
      const region = clip.region || 'global'
      const key = `${kind}:${region}`
      if (!weatherClipsByKey.has(key)) {
        weatherClipsByKey.set(key, {
          kind,
          region,
          clips: [],
          sourceClipIds: [],
        })
      }
      const bucket = weatherClipsByKey.get(key)
      const sourceClipId = typeof clip.id === 'string' && clip.id.length > 0
        ? clip.id
        : `${kind}:${region}:clip-${bucket.clips.length}`
      const normalizedWeatherClip = {
        id: sourceClipId,
        type: kind,
        trackKind: kind,
        startSec: clip.startSec,
        duration: clip.duration,
        endSec: clip.endSec,
        intensity: clip.intensity,
        blendInSec: clip.blendInSec,
        blendOutSec: clip.blendOutSec,
        region,
      }
      bucket.clips.push(normalizedWeatherClip)
      bucket.sourceClipIds.push(sourceClipId)
    }
  }

  const weatherTracks = Array.from(weatherClipsByKey.values()).map(({
    kind,
    region,
    clips: trackClips,
    sourceClipIds,
  }, trackIndex) => {
    const sorted = [...trackClips].sort((a, b) => a.startSec - b.startSec)
    return {
      kind,
      region,
      trackKey: `${kind}:${region}:${trackIndex}`,
      sourceClipIds: Array.from(new Set(sourceClipIds)),
      envelope: buildEnvelopeFromClips(sorted, totalDurationSec),
    }
  })

  return {
    id: baseId || 'authored',
    name: 'Authored',
    loop: true,
    duration: { seconds: totalDurationSec },
    weatherTracks,
    intentEvents,
  }
}
