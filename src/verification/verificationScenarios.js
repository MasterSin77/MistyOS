/**
 * Verification Scenario Model
 *
 * Defines the schema for verification scenarios and the built-in default
 * scenarios that ship with MistyOS. A scenario is a named set of time-windowed
 * assertions that verify produced runtime behaviour matches expectations.
 */

// Assertion type identifiers
export const ASSERTION_TYPES = {
  /** At least one (or all) sample(s) in the time window satisfy min/max bounds. */
  THRESHOLD: 'threshold',
  /** Values consistently increase across the time window (with epsilon tolerance). */
  MONOTONIC_INCREASE: 'monotonic-increase',
  /** Values consistently decrease across the time window (with epsilon tolerance). */
  MONOTONIC_DECREASE: 'monotonic-decrease',
  /** Region-specific weather value satisfies min/max bounds in the time window. */
  REGION_THRESHOLD: 'region-threshold',
}

/**
 * Create a normalised scenario object from a partial definition.
 * @param {object} partial
 * @returns {object} scenario
 */
export function createScenario(partial) {
  return {
    id: partial.id || `scenario-${Date.now()}`,
    label: partial.label || 'Unnamed Scenario',
    description: partial.description || '',
    assertions: Array.isArray(partial.assertions) ? partial.assertions : [],
  }
}

/**
 * Built-in scenarios.
 *
 * These are conservative checks that should pass for any non-trivial
 * authored timeline. They skip assertions automatically when the
 * relevant tracks carry no non-zero authored values.
 */
export const BUILTIN_SCENARIOS = [
  createScenario({
    id: 'builtin.timeline-has-weather-activity',
    label: 'Timeline has weather activity',
    description:
      'Verifies that at least one weather parameter exceeds baseline '
      + 'at some point in the published timeline.',
    assertions: [
      {
        id: 'assert.any-weather-above-threshold',
        label: 'Some weather field exceeds 0.05 in the timeline',
        type: ASSERTION_TYPES.THRESHOLD,
        anyOf: [
          'weather.wind',
          'weather.rain',
          'weather.mist',
          'weather.fogBuildup',
          'weather.fogClearing',
          'weather.washdown',
        ],
        min: 0.05,
        windowStartSec: 0,
        windowEndSec: null,
        mode: 'any-point',
      },
    ],
  }),

  createScenario({
    id: 'builtin.fog-buildup-positive-if-authored',
    label: 'Fog builds up when authored',
    description:
      'If fogBuildup clips are present in the timeline, verifies the '
      + 'produced value exceeds 0.05 at some point.',
    assertions: [
      {
        id: 'assert.fog-buildup-positive',
        label: 'fogBuildup exceeds 0.05 at some point',
        type: ASSERTION_TYPES.THRESHOLD,
        anyOf: ['weather.fogBuildup'],
        min: 0.05,
        windowStartSec: 0,
        windowEndSec: null,
        mode: 'any-point',
        skipIfAllZero: true,
      },
    ],
  }),

  createScenario({
    id: 'builtin.fog-clearing-positive-if-authored',
    label: 'Fog clears when authored',
    description:
      'If fogClearing clips are present, verifies fogClearing exceeds 0.05.',
    assertions: [
      {
        id: 'assert.fog-clearing-positive',
        label: 'fogClearing exceeds 0.05 at some point',
        type: ASSERTION_TYPES.THRESHOLD,
        anyOf: ['weather.fogClearing'],
        min: 0.05,
        windowStartSec: 0,
        windowEndSec: null,
        mode: 'any-point',
        skipIfAllZero: true,
      },
    ],
  }),

  createScenario({
    id: 'builtin.rain-positive-if-authored',
    label: 'Rain is active when authored',
    description:
      'If rain clips are present, verifies weather.rain exceeds 0.05.',
    assertions: [
      {
        id: 'assert.rain-positive',
        label: 'weather.rain exceeds 0.05 at some point',
        type: ASSERTION_TYPES.THRESHOLD,
        anyOf: ['weather.rain'],
        min: 0.05,
        windowStartSec: 0,
        windowEndSec: null,
        mode: 'any-point',
        skipIfAllZero: true,
      },
    ],
  }),

  createScenario({
    id: 'builtin.mist-positive-if-authored',
    label: 'Mist is present when authored',
    description:
      'If mist clips are present, verifies weather.mist exceeds 0.05.',
    assertions: [
      {
        id: 'assert.mist-positive',
        label: 'weather.mist exceeds 0.05 at some point',
        type: ASSERTION_TYPES.THRESHOLD,
        anyOf: ['weather.mist'],
        min: 0.05,
        windowStartSec: 0,
        windowEndSec: null,
        mode: 'any-point',
        skipIfAllZero: true,
      },
    ],
  }),

  createScenario({
    id: 'builtin.wind-positive-if-authored',
    label: 'Wind is active when authored',
    description:
      'If wind clips are present, verifies |weather.wind| exceeds 0.05.',
    assertions: [
      {
        id: 'assert.wind-positive',
        label: '|weather.wind| exceeds 0.05 at some point',
        type: ASSERTION_TYPES.THRESHOLD,
        anyOf: ['weather.wind'],
        absMin: 0.05,
        windowStartSec: 0,
        windowEndSec: null,
        mode: 'any-point',
        skipIfAllZero: true,
      },
    ],
  }),
]

/** Return the default scenario to run when none is specified. */
export function getDefaultScenario() {
  return BUILTIN_SCENARIOS[0]
}

/** Return the full suite of built-in scenarios (used for batch runs). */
export function getAllBuiltinScenarios() {
  return BUILTIN_SCENARIOS
}
