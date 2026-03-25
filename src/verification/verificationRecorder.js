/**
 * Verification Recorder
 *
 * Observes the real scheduler runtime by sampling it at fixed timesteps.
 * Does NOT implement parallel simulation logic — calls createSchedulerRuntime
 * exactly as Presentation does, then steps through elapsed time deterministically.
 *
 * The resulting sample array is the machine-checkable evidence of what the
 * authored timeline actually produces.
 */

import { createSchedulerRuntime } from '../scheduler/runtime'
import { createFourQuadrantRegionModel } from '../scheduler/region-model'

// UV centers for each supported region
const REGION_UV = {
  q1: { x: 0.25, y: 0.25 },
  q2: { x: 0.75, y: 0.25 },
  q3: { x: 0.25, y: 0.75 },
  q4: { x: 0.75, y: 0.75 },
}

/**
 * Sample the compiled timeline at regular intervals using the real scheduler runtime.
 *
 * @param {object} compiledTimeline - The timeline produced by compileClipsToTimeline().
 * @param {object} options
 * @param {number}   options.stepSec       - Sampling interval in seconds (default: 0.5).
 * @param {string[]} options.regions       - Additional region ids to record per tick (default: [] = global only).
 * @param {object}   options.regionModel   - Optional override region model (uses Presentation defaults if omitted).
 * @returns {{ timelineId, durationSec, stepSec, samples }}
 */
export function recordRuntimeSamples(compiledTimeline, options = {}) {
  const {
    stepSec = 0.5,
    regions = [],
    regionModel = createFourQuadrantRegionModel({ softness: 0.45 }),
  } = options

  // Create the runtime exactly as Presentation does
  const runtime = createSchedulerRuntime(compiledTimeline, { regionModel })
  const durationSec = runtime.durationSec

  const samples = []
  let t = 0

  while (t <= durationSec + stepSec / 2) {
    const clampedT = Math.min(t, durationSec)

    // Global sample — the base observation
    const base = runtime.sample({ elapsedSec: clampedT, fps: 1 / stepSec })

    const entry = {
      sampleSec: base.sampleSec,
      weather: { ...base.weather },
      activeIntentEvents: base.activeIntentEvents.map((e) => ({
        id: e.id,
        kind: e.kind,
      })),
    }

    // Regional samples — only collected for requested region ids
    if (regions.length > 0) {
      entry.regionWeather = {}
      for (const regionId of regions) {
        const uv = REGION_UV[regionId]
        if (!uv) {
          continue
        }
        const regional = runtime.sample({ elapsedSec: clampedT, fps: 1 / stepSec, uv })
        entry.regionWeather[regionId] = { ...regional.weather }
      }
    }

    samples.push(entry)
    t += stepSec
  }

  return {
    timelineId: runtime.timelineId,
    durationSec,
    stepSec,
    samples,
  }
}
