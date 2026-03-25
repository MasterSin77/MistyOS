import fs from 'node:fs'

const timelineIds = ['default-atmosphere', 'runner-carve-diagnosis']

function loadTimeline(timelineId) {
  const filePath = `./src/config/timelines/${timelineId}.json`
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function sampleEnvelope(envelope, sampleSec) {
  if (!Array.isArray(envelope) || envelope.length === 0) {
    return 0
  }

  if (sampleSec <= envelope[0].timeSec) {
    return envelope[0].value || 0
  }

  for (let index = 1; index < envelope.length; index += 1) {
    const previous = envelope[index - 1]
    const next = envelope[index]
    if (sampleSec <= next.timeSec) {
      const span = Math.max(0.0001, next.timeSec - previous.timeSec)
      const t = (sampleSec - previous.timeSec) / span
      return (previous.value || 0) + ((next.value || 0) - (previous.value || 0)) * t
    }
  }

  return envelope[envelope.length - 1].value || 0
}

function sampleRainState(timeline, sampleSec) {
  const rainTracks = (timeline.weatherTracks || []).filter((track) => track.kind === 'rain')
  const activeTracks = rainTracks
    .map((track, index) => ({
      track,
      trackIndex: index,
      value: sampleEnvelope(track.envelope || [], sampleSec),
    }))
    .filter((entry) => entry.value > 0.001)

  const maxRainValue = activeTracks.reduce((max, entry) => Math.max(max, entry.value), 0)
  const activeRainClipIds = activeTracks.flatMap((entry) => {
    if (Array.isArray(entry.track.sourceClipIds) && entry.track.sourceClipIds.length > 0) {
      return entry.track.sourceClipIds
    }
    return [`rain-track-${entry.trackIndex}`]
  })

  return {
    rainIntensity: maxRainValue,
    activeRainClipCount: activeRainClipIds.length,
    activeRainClipIds,
  }
}

function findFirstActiveRainWindow(timeline, durationSec) {
  const stepSec = 0.25
  let firstRainByEnvelope = null

  for (let sampleSec = 0; sampleSec <= durationSec; sampleSec += stepSec) {
    const rainState = sampleRainState(timeline, sampleSec)
    if (firstRainByEnvelope === null && rainState.rainIntensity > 0.001) {
      firstRainByEnvelope = sampleSec
    }

    if (rainState.rainIntensity > 0.001 && rainState.activeRainClipCount > 0) {
      return {
        timeSec: sampleSec,
        rainIntensity: rainState.rainIntensity,
        activeRainClipCount: rainState.activeRainClipCount,
        activeRainClipIds: rainState.activeRainClipIds,
      }
    }
  }

  if (firstRainByEnvelope === null) {
    return null
  }

  return {
    timeSec: firstRainByEnvelope,
    rainIntensity: null,
    activeRainClipCount: 0,
    activeRainClipIds: [],
  }
}

function sampleTimeline(timelineId) {
  const timeline = loadTimeline(timelineId)
  const durationSec = timeline?.duration?.seconds || 180
  const atTimeZero = sampleRainState(timeline, 0)

  return {
    timelineId,
    durationSec,
    time0: {
      rainIntensity: atTimeZero.rainIntensity,
      activeRainClipCount: atTimeZero.activeRainClipCount,
      activeRainClipIds: atTimeZero.activeRainClipIds,
    },
    firstActiveRainWindow: findFirstActiveRainWindow(timeline, durationSec),
  }
}

for (const timelineId of timelineIds) {
  const report = sampleTimeline(timelineId)
  console.log(JSON.stringify(report, null, 2))
}
