function clampWindow(assertion, samples) {
  const startTime = Number.isFinite(assertion?.startTime) ? assertion.startTime : 0
  const lastTime = samples.length > 0 ? samples[samples.length - 1].time : 0
  const endTime = Number.isFinite(assertion?.endTime) ? assertion.endTime : lastTime

  return {
    startTime,
    endTime,
  }
}

function getWindowSamples(samples, assertion) {
  const { startTime, endTime } = clampWindow(assertion, samples)
  return samples.filter((sample) => sample.time >= startTime && sample.time <= endTime)
}

function readField(sample, field) {
  return Number(sample?.[field] || 0)
}

function evaluateThresholdMin(samples, field, assertion) {
  const windowSamples = getWindowSamples(samples, assertion)
  const min = Number(assertion?.min || 0)
  const maxObserved = windowSamples.reduce((currentMax, sample) => Math.max(currentMax, readField(sample, field)), Number.NEGATIVE_INFINITY)
  const pass = windowSamples.some((sample) => readField(sample, field) >= min)

  return {
    id: assertion.id,
    type: assertion.type,
    field,
    pass,
    sampleCount: windowSamples.length,
    min,
    maxObserved: Number.isFinite(maxObserved) ? Number(maxObserved.toFixed(4)) : null,
    window: clampWindow(assertion, samples),
    reason: pass ? null : `No ${field} sample reached ${min}`,
  }
}

function evaluateThresholdMax(samples, field, assertion) {
  const windowSamples = getWindowSamples(samples, assertion)
  const max = Number(assertion?.max ?? 1)
  const maxObserved = windowSamples.reduce((currentMax, sample) => Math.max(currentMax, readField(sample, field)), Number.NEGATIVE_INFINITY)
  const pass = windowSamples.every((sample) => readField(sample, field) <= max)

  return {
    id: assertion.id,
    type: assertion.type,
    field,
    pass,
    sampleCount: windowSamples.length,
    max,
    maxObserved: Number.isFinite(maxObserved) ? Number(maxObserved.toFixed(4)) : null,
    window: clampWindow(assertion, samples),
    reason: pass ? null : `${field} exceeded max threshold of ${max}`,
  }
}

function evaluateRangeBetween(samples, field, assertion) {
  const windowSamples = getWindowSamples(samples, assertion)
  const min = Number(assertion?.min ?? 0)
  const max = Number(assertion?.max ?? 1)
  const violations = windowSamples.filter((sample) => {
    const value = readField(sample, field)
    return value < min || value > max
  })

  return {
    id: assertion.id,
    type: assertion.type,
    field,
    pass: violations.length === 0,
    sampleCount: windowSamples.length,
    min,
    max,
    window: clampWindow(assertion, samples),
    violationCount: violations.length,
    reason: violations.length === 0 ? null : `${violations.length} sample(s) of ${field} outside range [${min}, ${max}]`,
  }
}

function evaluateCorrelationPositive(samples, assertion) {
  const fieldA = assertion?.fieldA || 'rain'
  const fieldB = assertion?.fieldB || 'mist'
  const windowSamples = getWindowSamples(samples, assertion)

  if (windowSamples.length < 2) {
    return {
      id: assertion.id,
      type: assertion.type,
      fieldA,
      fieldB,
      pass: false,
      sampleCount: windowSamples.length,
      window: clampWindow(assertion, samples),
      reason: 'Insufficient samples for correlation check',
    }
  }

  let coDirectional = 0
  let total = 0
  for (let index = 1; index < windowSamples.length; index += 1) {
    const dA = readField(windowSamples[index], fieldA) - readField(windowSamples[index - 1], fieldA)
    const dB = readField(windowSamples[index], fieldB) - readField(windowSamples[index - 1], fieldB)
    const bothMoved = Math.abs(dA) > 0.001 || Math.abs(dB) > 0.001
    if (bothMoved) {
      total += 1
      if ((dA >= 0 && dB >= 0) || (dA <= 0 && dB <= 0)) {
        coDirectional += 1
      }
    }
  }

  const minCorrelation = Number.isFinite(assertion?.minCorrelation) ? assertion.minCorrelation : 0.6
  const correlationScore = total > 0 ? coDirectional / total : 0
  const pass = correlationScore >= minCorrelation

  return {
    id: assertion.id,
    type: assertion.type,
    fieldA,
    fieldB,
    pass,
    sampleCount: windowSamples.length,
    correlationScore: Number(correlationScore.toFixed(4)),
    minCorrelation,
    window: clampWindow(assertion, samples),
    reason: pass ? null : `Correlation score ${correlationScore.toFixed(3)} below min ${minCorrelation} for ${fieldA}↑ when ${fieldB}↑`,
  }
}

function evaluateMonotonicIncrease(samples, field, assertion) {
  const windowSamples = getWindowSamples(samples, assertion)
  const tolerance = Number.isFinite(assertion?.tolerance) ? assertion.tolerance : 0.01
  const violations = []

  for (let index = 1; index < windowSamples.length; index += 1) {
    const previous = readField(windowSamples[index - 1], field)
    const current = readField(windowSamples[index], field)
    if (current + tolerance < previous) {
      violations.push({
        fromTime: Number(windowSamples[index - 1].time.toFixed(4)),
        toTime: Number(windowSamples[index].time.toFixed(4)),
        previous: Number(previous.toFixed(4)),
        current: Number(current.toFixed(4)),
      })
    }
  }

  return {
    id: assertion.id,
    type: assertion.type,
    field,
    pass: violations.length === 0,
    sampleCount: windowSamples.length,
    tolerance,
    window: clampWindow(assertion, samples),
    violations,
    reason: violations.length === 0 ? null : `${violations.length} monotonic decrease violation(s) found`,
  }
}

function resolveAssertionWindow(assertion, windows) {
  if (!assertion.windowId || !windows.length) {
    return assertion
  }
  const win = windows.find((w) => w.id === assertion.windowId)
  if (!win) {
    return assertion
  }
  return { ...assertion, startTime: win.startSec, endTime: win.endSec }
}

export function runVerificationEngine(samples, scenario) {
  const safeSamples = Array.isArray(samples)
    ? samples
      .map((sample) => ({ ...sample, time: Number(sample?.time || 0) }))
      .sort((left, right) => left.time - right.time)
    : []

  const safeScenario = {
    name: scenario?.name || 'Unnamed Verification Scenario',
    field: scenario?.field || 'wind',
    windows: Array.isArray(scenario?.windows) ? scenario.windows : [],
    assertions: Array.isArray(scenario?.assertions) ? scenario.assertions : [],
  }

  const assertions = safeScenario.assertions.map((rawAssertion) => {
    const assertion = resolveAssertionWindow(rawAssertion, safeScenario.windows)
    const field = assertion.field || safeScenario.field

    if (assertion.type === 'threshold_min') {
      return evaluateThresholdMin(safeSamples, field, assertion)
    }

    if (assertion.type === 'threshold_max') {
      return evaluateThresholdMax(safeSamples, field, assertion)
    }

    if (assertion.type === 'range_between') {
      return evaluateRangeBetween(safeSamples, field, assertion)
    }

    if (assertion.type === 'monotonic_increase') {
      return evaluateMonotonicIncrease(safeSamples, field, assertion)
    }

    if (assertion.type === 'correlation_positive') {
      return evaluateCorrelationPositive(safeSamples, assertion)
    }

    return {
      id: assertion.id,
      type: assertion.type,
      field,
      pass: false,
      sampleCount: 0,
      reason: `Unsupported assertion type: ${assertion.type}`,
    }
  })

  const fieldsUsed = [...new Set(
    assertions.flatMap((assertion) => [assertion.field, assertion.fieldA, assertion.fieldB].filter(Boolean)),
  )]

  return {
    scenarioName: safeScenario.name,
    field: safeScenario.field,
    fields: fieldsUsed,
    pass: assertions.every((assertion) => assertion.pass),
    assertionResults: assertions,
  }
}
