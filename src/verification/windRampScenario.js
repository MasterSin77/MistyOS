function getOrderedEnvelope(track) {
  return [...(track?.envelope || [])]
    .filter((point) => Number.isFinite(point?.timeSec) && Number.isFinite(point?.value))
    .sort((left, right) => left.timeSec - right.timeSec)
}

function hasIncreasingSegment(envelope) {
  for (let index = 1; index < envelope.length; index += 1) {
    if (envelope[index].value > envelope[index - 1].value + 0.001) {
      return true
    }
  }

  return false
}

function getWindTrack(compiledTimeline) {
  const weatherTracks = compiledTimeline?.weatherTracks || []
  const windTracks = weatherTracks
    .filter((track) => track?.kind === 'wind' && Array.isArray(track.envelope) && track.envelope.length >= 2)
    .map((track) => ({
      track,
      envelope: getOrderedEnvelope(track),
      region: track?.region || 'global',
    }))
    .filter(({ envelope }) => envelope.length >= 2 && hasIncreasingSegment(envelope))

  if (!windTracks.length) {
    return null
  }

  return windTracks.find(({ region }) => region === 'global') || windTracks[0]
}

function findFirstRampSegment(envelope) {
  let rampStartSec = null
  let rampEndSec = null

  for (let index = 1; index < envelope.length; index += 1) {
    if (envelope[index].value > envelope[index - 1].value + 0.001) {
      rampStartSec = envelope[index - 1].timeSec
      rampEndSec = envelope[index].timeSec

      for (let rampIndex = index + 1; rampIndex < envelope.length; rampIndex += 1) {
        if (envelope[rampIndex].value < envelope[rampIndex - 1].value - 0.001) {
          rampEndSec = envelope[rampIndex - 1].timeSec
          break
        }

        rampEndSec = envelope[rampIndex].timeSec
      }
      break
    }
  }

  if (!Number.isFinite(rampStartSec) || !Number.isFinite(rampEndSec)) {
    return null
  }

  return {
    rampStartSec,
    rampEndSec,
  }
}

export function createCurrentTimelineWindRampScenario(compiledTimeline) {
  const windTrackMatch = getWindTrack(compiledTimeline)
  if (!windTrackMatch) {
    return null
  }

  const { track: windTrack, envelope, region } = windTrackMatch

  if (envelope.length < 2) {
    return null
  }

  const rampSegment = findFirstRampSegment(envelope)
  if (!rampSegment) {
    return null
  }

  const { rampStartSec, rampEndSec } = rampSegment
  const rampWindowEndSec = Number((rampEndSec + 0.001).toFixed(3))
  const rampSegmentMaxValue = envelope.reduce((maxValue, point) => {
    if (point.timeSec < rampStartSec || point.timeSec > rampWindowEndSec) {
      return maxValue
    }

    return Math.max(maxValue, point.value)
  }, 0)

  const thresholdMin = Math.max(0.05, Number((rampSegmentMaxValue * 0.5).toFixed(3)))
  const captureStartTimeSec = Math.max(0, rampStartSec - 0.05)
  const captureDurationSec = Math.max(1.5, Math.min(rampEndSec + 0.5, rampStartSec + 2))
  const rampMidpointSec = Number(((rampStartSec + rampEndSec) * 0.5).toFixed(3))
  const probeTimesSec = [...new Set([
    Number(captureStartTimeSec.toFixed(3)),
    Number(rampStartSec.toFixed(3)),
    rampMidpointSec,
    Number(rampEndSec.toFixed(3)),
  ])]

  return {
    captureStartTimeSec,
    captureDurationMs: Math.round(captureDurationSec * 1000),
    probeTimesSec,
    scenario: {
      name: region === 'global' ? 'Global Wind Ramp' : `Wind Ramp (${region})`,
      field: 'wind',
      region,
      trackId: windTrack?.id || null,
      assertions: [
        {
          id: 'wind-threshold-min',
          type: 'threshold_min',
          min: thresholdMin,
          startTime: rampStartSec,
          endTime: rampWindowEndSec,
        },
        {
          id: 'wind-monotonic-increase',
          type: 'monotonic_increase',
          startTime: rampStartSec,
          endTime: rampWindowEndSec,
          tolerance: 0.025,
        },
      ],
    },
  }
}

export function createTrackRampScenario(compiledTimeline, trackKind) {
  const weatherTracks = compiledTimeline?.weatherTracks || []
  const candidates = weatherTracks
    .filter((track) => track?.kind === trackKind && Array.isArray(track.envelope) && track.envelope.length >= 2)
    .map((track) => ({
      track,
      envelope: getOrderedEnvelope(track),
      region: track?.region || 'global',
    }))
    .filter(({ envelope }) => envelope.length >= 2 && hasIncreasingSegment(envelope))

  if (!candidates.length) {
    return null
  }

  const selected = candidates.find(({ region }) => region === 'global') || candidates[0]
  const { track, envelope, region } = selected

  const rampSegment = findFirstRampSegment(envelope)
  if (!rampSegment) {
    return null
  }

  const { rampStartSec, rampEndSec } = rampSegment
  const rampWindowEndSec = Number((rampEndSec + 0.001).toFixed(3))
  const rampSegmentMaxValue = envelope.reduce((maxValue, point) => {
    if (point.timeSec < rampStartSec || point.timeSec > rampWindowEndSec) {
      return maxValue
    }

    return Math.max(maxValue, point.value)
  }, 0)

  const thresholdMin = Math.max(0.05, Number((rampSegmentMaxValue * 0.5).toFixed(3)))
  const captureStartTimeSec = Math.max(0, rampStartSec - 0.05)
  const captureDurationSec = Math.max(1.5, Math.min(rampEndSec + 0.5, rampStartSec + 2))
  const rampMidpointSec = Number(((rampStartSec + rampEndSec) * 0.5).toFixed(3))
  const probeTimesSec = [...new Set([
    Number(captureStartTimeSec.toFixed(3)),
    Number(rampStartSec.toFixed(3)),
    rampMidpointSec,
    Number(rampEndSec.toFixed(3)),
  ])]

  return {
    captureStartTimeSec,
    captureDurationMs: Math.round(captureDurationSec * 1000),
    probeTimesSec,
    region,
    trackId: track?.id || null,
    scenario: {
      name: region === 'global'
        ? `Global ${trackKind.charAt(0).toUpperCase() + trackKind.slice(1)} Ramp`
        : `${trackKind.charAt(0).toUpperCase() + trackKind.slice(1)} Ramp (${region})`,
      field: trackKind,
      region,
      trackId: track?.id || null,
      assertions: [
        {
          id: `${trackKind}-threshold-min`,
          type: 'threshold_min',
          min: thresholdMin,
          startTime: rampStartSec,
          endTime: rampWindowEndSec,
        },
        {
          id: `${trackKind}-monotonic-increase`,
          type: 'monotonic_increase',
          startTime: rampStartSec,
          endTime: rampWindowEndSec,
          tolerance: 0.025,
        },
      ],
    },
  }
}
