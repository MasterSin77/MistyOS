import type { ScenarioManifest } from "../../engine/types";

export function createDefaultScenario(): ScenarioManifest {
  return {
    id: "baseline-seed-001",
    description: "Starter seeded scenario for harness wiring.",
    resolution: {
      width: 1600,
      height: 900
    },
    fixedDeltaMs: 16.6667,
    totalFrames: 600,
    seed: 1337,
    background: {
      style: "solid",
      color: "#0f1a2b"
    },
    rain: {
      ratePerSecond: 6
    },
    tuning: {
      depositionChanceScale: 1,
      depositionAmountScale: 1,
      depositionTopBias: 1,
      decayRateScale: 1,
      runoffScale: 1,
      retentionScale: 1,
      overlaySpotScale: 1,
      dropletSpawnRate: 1,
      dropletMass: 1,
      dropletSlipThreshold: 1,
      dropletMergeRadius: 1,
      dropletDepositionRate: 1,
      anisotropicTransport: 0,
      trailMemory: 0,
      slipRelease: 0,
      channelAttraction: 0,
      mergeToRunnel: 0
    }
  };
}
