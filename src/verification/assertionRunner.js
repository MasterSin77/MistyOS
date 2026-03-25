/**
 * Assertion Runner
 *
 * Evaluates a verification scenario's assertions against recorded runtime
 * samples. Produces pass/fail results with machine-readable evidence.
 *
 * Does not simulate, predict, or infer — only reads the recorded samples.
 */

import { ASSERTION_TYPES } from './verificationScenarios'

// ---------------------------------------------------------------------------
// Field extraction helpers
// ---------------------------------------------------------------------------

function getWeatherField(sample, fieldPath) {
  const parts = fieldPath.split('.')
  if (parts[0] === 'weather' && parts.length === 2) {
    return sample.weather?.[parts[1]] ?? 0
  }
  return 0
}

function getRegionalWeatherField(sample, fieldPath, regionId) {
  const parts = fieldPath.split('.')
  if (parts[0] === 'weather' && parts.length === 2 && sample.regionWeather?.[regionId]) {
    return sample.regionWeather[regionId][parts[1]] ?? 0
  }
  return getWeatherField(sample, fieldPath)
}

// ---------------------------------------------------------------------------
// Window helpers
// ---------------------------------------------------------------------------

function getSamplesInWindow(samples, assertion, durationSec) {
  const startSec = assertion.windowStartSec ?? 0
  const endSec = assertion.windowEndSec ?? durationSec
  return samples.filter((s) => s.sampleSec >= startSec && s.sampleSec <= endSec)
}

// ---------------------------------------------------------------------------
// Assertion type implementations
// ---------------------------------------------------------------------------

function evalThreshold(samples, assertion, durationSec) {
  const windowSamples = getSamplesInWindow(samples, assertion, durationSec)
  const fields = assertion.anyOf ?? (assertion.field ? [assertion.field] : [])
  if (fields.length === 0) {
    return { pass: false, evidence: { error: 'No field or anyOf specified.' } }
  }

  const mode = assertion.mode || 'any-point'
  const min = assertion.min !== undefined ? assertion.min : -Infinity
  const max = assertion.max !== undefined ? assertion.max : Infinity
  // Support absolute-value check for wind (can be negative)
  const useAbsMin = assertion.absMin !== undefined

  const fieldValues = windowSamples.flatMap((s) =>
    fields.map((f) => {
      const raw = getWeatherField(s, f)
      return { sec: s.sampleSec, field: f, raw, value: useAbsMin ? Math.abs(raw) : raw }
    }),
  )

  if (assertion.skipIfAllZero) {
    const anyNonZero = fieldValues.some((fv) => Math.abs(fv.raw) > 0.001)
    if (!anyNonZero) {
      return {
        pass: true,
        skipped: true,
        skipReason: 'all-zero — track not authored, assertion skipped',
        evidence: { windowSec: [assertion.windowStartSec ?? 0, assertion.windowEndSec ?? durationSec], sampleCount: windowSamples.length },
      }
    }
  }

  const effectiveMin = useAbsMin ? assertion.absMin : min

  if (mode === 'any-point') {
    const passing = fieldValues.filter((fv) => fv.value >= effectiveMin && fv.value <= max)
    const pass = passing.length > 0
    const maxObserved = fieldValues.reduce((acc, fv) => Math.max(acc, fv.value), 0)
    return {
      pass,
      evidence: {
        windowSec: [assertion.windowStartSec ?? 0, assertion.windowEndSec ?? durationSec],
        sampleCount: windowSamples.length,
        passingCount: passing.length,
        maxObserved: Number(maxObserved.toFixed(4)),
        failReason: pass ? null : `No sample exceeded ${useAbsMin ? '|value|' : 'value'} >= ${effectiveMin}`,
      },
    }
  }

  if (mode === 'all-points') {
    const failing = fieldValues.filter((fv) => !(fv.value >= effectiveMin && fv.value <= max))
    const pass = failing.length === 0
    return {
      pass,
      evidence: {
        windowSec: [assertion.windowStartSec ?? 0, assertion.windowEndSec ?? durationSec],
        sampleCount: windowSamples.length,
        failingCount: failing.length,
        failingAt: failing.slice(0, 5).map((fv) => ({ sec: Number(fv.sec.toFixed(2)), value: Number(fv.value.toFixed(4)) })),
        failReason: pass ? null : `${failing.length} samples outside bounds`,
      },
    }
  }

  return { pass: false, evidence: { error: `Unknown threshold mode: ${mode}` } }
}

function evalMonotonic(samples, assertion, durationSec, direction) {
  const windowSamples = getSamplesInWindow(samples, assertion, durationSec)
  const field = assertion.field
  if (!field) {
    return { pass: false, evidence: { error: 'No field specified for monotonic assertion.' } }
  }

  const values = windowSamples.map((s) => ({ sec: s.sampleSec, value: getWeatherField(s, field) }))

  if (values.length < 2) {
    return {
      pass: true,
      skipped: true,
      skipReason: 'fewer than 2 samples in window — cannot evaluate monotonicity',
      evidence: { windowSec: [assertion.windowStartSec ?? 0, assertion.windowEndSec ?? durationSec], sampleCount: values.length },
    }
  }

  const epsilon = assertion.epsilon ?? 0.01
  const violations = []
  for (let i = 1; i < values.length; i++) {
    const delta = values[i].value - values[i - 1].value
    if (direction === 'increase' && delta < -epsilon) {
      violations.push({ fromSec: values[i - 1].sec, toSec: values[i].sec, delta: Number(delta.toFixed(5)) })
    } else if (direction === 'decrease' && delta > epsilon) {
      violations.push({ fromSec: values[i - 1].sec, toSec: values[i].sec, delta: Number(delta.toFixed(5)) })
    }
  }

  return {
    pass: violations.length === 0,
    evidence: {
      windowSec: [assertion.windowStartSec ?? 0, assertion.windowEndSec ?? durationSec],
      sampleCount: windowSamples.length,
      direction,
      epsilon,
      violationCount: violations.length,
      violations: violations.slice(0, 5),
      failReason: violations.length > 0 ? `${violations.length} monotonicity violations detected` : null,
    },
  }
}

function evalRegionThreshold(samples, assertion, durationSec) {
  const windowSamples = getSamplesInWindow(samples, assertion, durationSec)
  const field = assertion.field
  const regionId = assertion.region || 'global'
  if (!field) {
    return { pass: false, evidence: { error: 'No field specified for region-threshold assertion.' } }
  }

  const min = assertion.min !== undefined ? assertion.min : -Infinity
  const max = assertion.max !== undefined ? assertion.max : Infinity
  const mode = assertion.mode || 'any-point'

  const fieldValues = windowSamples.map((s) => ({
    sec: s.sampleSec,
    value: getRegionalWeatherField(s, field, regionId),
  }))

  if (assertion.skipIfAllZero) {
    const anyNonZero = fieldValues.some((fv) => Math.abs(fv.value) > 0.001)
    if (!anyNonZero) {
      return {
        pass: true,
        skipped: true,
        skipReason: 'all-zero in region — track not authored, assertion skipped',
        evidence: { region: regionId, windowSec: [assertion.windowStartSec ?? 0, assertion.windowEndSec ?? durationSec], sampleCount: windowSamples.length },
      }
    }
  }

  if (mode === 'any-point') {
    const passing = fieldValues.filter((fv) => fv.value >= min && fv.value <= max)
    const maxObserved = fieldValues.reduce((acc, fv) => Math.max(acc, fv.value), 0)
    const pass = passing.length > 0
    return {
      pass,
      evidence: {
        region: regionId,
        field,
        windowSec: [assertion.windowStartSec ?? 0, assertion.windowEndSec ?? durationSec],
        sampleCount: windowSamples.length,
        passingCount: passing.length,
        maxObserved: Number(maxObserved.toFixed(4)),
        failReason: pass ? null : `No regional sample exceeded min=${min} for region=${regionId}`,
      },
    }
  }

  const failing = fieldValues.filter((fv) => !(fv.value >= min && fv.value <= max))
  const pass = failing.length === 0
  return {
    pass,
    evidence: {
      region: regionId,
      field,
      windowSec: [assertion.windowStartSec ?? 0, assertion.windowEndSec ?? durationSec],
      sampleCount: windowSamples.length,
      failingCount: failing.length,
      failingAt: failing.slice(0, 5).map((fv) => ({ sec: Number(fv.sec.toFixed(2)), value: Number(fv.value.toFixed(4)) })),
      failReason: failing.length > 0 ? `${failing.length} samples outside bounds in region ${regionId}` : null,
    },
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run all assertions in a scenario against the recorded sample set.
 *
 * @param {object} recordingResult - Output of recordRuntimeSamples().
 * @param {object} scenario        - A scenario object (see verificationScenarios.js).
 * @returns {{ scenarioId, scenarioLabel, passed, assertions[] }}
 */
export function runAssertions(recordingResult, scenario) {
  const { samples, durationSec } = recordingResult
  const assertionResults = []

  for (const assertion of scenario.assertions) {
    let result = {
      id: assertion.id,
      label: assertion.label || assertion.id,
      type: assertion.type,
      pass: false,
      skipped: false,
      evidence: {},
    }

    try {
      let evalResult
      if (assertion.type === ASSERTION_TYPES.THRESHOLD) {
        evalResult = evalThreshold(samples, assertion, durationSec)
      } else if (assertion.type === ASSERTION_TYPES.MONOTONIC_INCREASE) {
        evalResult = evalMonotonic(samples, assertion, durationSec, 'increase')
      } else if (assertion.type === ASSERTION_TYPES.MONOTONIC_DECREASE) {
        evalResult = evalMonotonic(samples, assertion, durationSec, 'decrease')
      } else if (assertion.type === ASSERTION_TYPES.REGION_THRESHOLD) {
        evalResult = evalRegionThreshold(samples, assertion, durationSec)
      } else {
        evalResult = { pass: false, evidence: { error: `Unknown assertion type: ${assertion.type}` } }
      }

      result = {
        ...result,
        pass: Boolean(evalResult.pass),
        skipped: Boolean(evalResult.skipped),
        skipReason: evalResult.skipReason || null,
        evidence: evalResult.evidence || {},
      }
    } catch (error) {
      result.evidence = { error: String(error) }
    }

    assertionResults.push(result)
  }

  const passed = assertionResults.every((r) => r.pass || r.skipped)

  return {
    scenarioId: scenario.id,
    scenarioLabel: scenario.label,
    passed,
    assertions: assertionResults,
  }
}
