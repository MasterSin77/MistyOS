// Runtime verification buffer lives on window for deterministic diagnostics capture.
// It is never used as authority for live weather, startup, or scheduler state.
function getVerificationHost() {
  if (typeof window === 'undefined') {
    return null
  }

  if (!Array.isArray(window.MISTY_RUNTIME_SAMPLES)) {
    window.MISTY_RUNTIME_SAMPLES = []
  }

  if (typeof window.MISTY_VERIFICATION_ACTIVE !== 'boolean') {
    window.MISTY_VERIFICATION_ACTIVE = false
  }

  return window
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
      normalized[key] = raw
        .filter((entry) => entry != null)
        .map((entry) => (typeof entry === 'object' ? { ...entry } : entry))
      return
    }
    if (typeof raw === 'object') {
      normalized[key] = { ...raw }
    }
  })

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function normalizeRuntimeSample(sample) {
  const metadata = normalizeOptionalObject(sample?.metadata)
  const render = normalizeOptionalObject(sample?.render)
  const clipCounts = normalizeOptionalObject(sample?.clipCounts)
  const activeIntentsByType = normalizeOptionalObject(sample?.activeIntentsByType)
  const activeWeatherCounts = normalizeOptionalObject(sample?.activeWeatherCounts)
  const activeWeatherClipIds = normalizeOptionalObject(sample?.activeWeatherClipIds)
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

export function setVerificationActive(active) {
  const host = getVerificationHost()
  if (!host) {
    return false
  }

  host.MISTY_VERIFICATION_ACTIVE = Boolean(active)
  return host.MISTY_VERIFICATION_ACTIVE
}

export function resetRuntimeSamples() {
  const host = getVerificationHost()
  if (!host) {
    return []
  }

  host.MISTY_RUNTIME_SAMPLES = []
  return host.MISTY_RUNTIME_SAMPLES
}

export function getRuntimeSamples() {
  const host = getVerificationHost()
  if (!host) {
    return []
  }

  return Array.isArray(host.MISTY_RUNTIME_SAMPLES)
    ? host.MISTY_RUNTIME_SAMPLES.map((sample) => normalizeRuntimeSample(sample))
    : []
}

export function recordRuntimeSample(sample) {
  const host = getVerificationHost()
  if (!host || host.MISTY_VERIFICATION_ACTIVE !== true) {
    return
  }

  host.MISTY_RUNTIME_SAMPLES.push(normalizeRuntimeSample(sample))
}
