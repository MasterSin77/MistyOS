import { createZeroWeatherState } from './model'

export function compileIntentEvents(intentEvents = [], sampleSec, options = {}) {
  const intentState = {
    active: [],
    weatherBias: createZeroWeatherState(),
    diagnostics: [],
  }

  const regionModel = options.regionModel || null
  const uv = options.uv || { x: 0.5, y: 0.5 }
  const includeDiagnostics = options.includeDiagnostics === true

  for (const event of intentEvents) {
    const start = event.startSec || 0
    const duration = Math.max(0.001, event.durationSec || 1)
    if (sampleSec < start || sampleSec > start + duration) {
      continue
    }

    const progress = (sampleSec - start) / duration
    const payload = event.payload || {}
    const leadInSec = clamp(Number(payload.leadInSec), 0, duration)
    const regionWeight = regionModel
      ? regionModel.sampleInfluence(event.region || 'global', uv)
      : 1

    const normalizedProgress = clamp(progress, 0, 1)
    const leadInNormalized = leadInSec > 0
      ? clamp((sampleSec - start) / leadInSec, 0, 1)
      : 1

    intentState.active.push({
      id: event.id,
      kind: event.kind,
      region: event.region || 'global',
      progress: normalizedProgress,
      leadInProgress: leadInNormalized,
      payload,
    })

    // Intent events are semantic requests that compile to weather pressure.
    if (event.kind === 'clock-reveal') {
      const revealStyle = payload.revealStyle || 'soft-lift'
      const recoveryStyle = payload.recoveryStyle || 'gentle-settle'
      const revealGain = resolveRevealGain(revealStyle)
      const recoveryGain = resolveRecoveryGain(recoveryStyle)

      const fogBuildup = 0.36 * (1 - normalizedProgress) * revealGain * leadInNormalized * regionWeight
      const fogClearing = 0.22 * normalizedProgress * recoveryGain * regionWeight
      const mist = 0.12 * (0.4 + 0.6 * leadInNormalized) * revealGain * regionWeight

      intentState.weatherBias.fogBuildup += fogBuildup
      intentState.weatherBias.fogClearing += fogClearing
      intentState.weatherBias.mist += mist

      if (includeDiagnostics) {
        intentState.diagnostics.push({
          id: event.id,
          kind: event.kind,
          region: event.region || 'global',
          regionWeight,
          leadInSec,
          revealStyle,
          recoveryStyle,
          contribution: {
            fogBuildup,
            fogClearing,
            mist,
          },
        })
      }
      continue
    }

    if (event.kind === 'social-icon-reveal') {
      intentState.weatherBias.fogBuildup += 0.28 * (1 - normalizedProgress) * regionWeight
      intentState.weatherBias.fogClearing += 0.16 * normalizedProgress * regionWeight
      intentState.weatherBias.mist += 0.12 * regionWeight
      continue
    }

    if (event.kind === 'message-draw' || event.kind === 'reminder-draw') {
      intentState.weatherBias.mist += 0.2 * regionWeight
      intentState.weatherBias.rain += 0.14 * normalizedProgress * regionWeight
      intentState.weatherBias.washdown += 0.08 * normalizedProgress * regionWeight
    }
  }

  return intentState
}

function resolveRevealGain(style) {
  if (style === 'snap') {
    return 0.82
  }
  if (style === 'surge') {
    return 1.2
  }
  return 1
}

function resolveRecoveryGain(style) {
  if (style === 'linger') {
    return 0.72
  }
  if (style === 'washout') {
    return 1.2
  }
  return 1
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min
  }
  return Math.max(min, Math.min(max, value))
}
