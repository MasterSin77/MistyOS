import { compareCheckpointHashes } from "./diff-compute";
import { summarizeFrameTimes } from "./metrics";
import type { DeterministicArtifactPacket } from "../harness/capture/checkpoint-bridge";

export interface ComparisonReport {
  reportVersion: "v1";
  createdAt: string;
  scenarioId: string;
  seed: number;
  referenceAvailable: boolean;
  metrics: {
    candidatePerformance: {
      avgMs: number;
      p95Ms: number;
      p99Ms: number;
    };
    hashComparison: {
      comparedFrames: number;
      hashMismatches: number;
      mismatchRatio: number;
    };
  };
  notes: string[];
}

export function createComparisonReport(candidate: DeterministicArtifactPacket, reference?: DeterministicArtifactPacket): ComparisonReport {
  const candidatePerformance = summarizeFrameTimes(candidate.checkpoints);
  const hashComparison = reference
    ? compareCheckpointHashes(reference.checkpoints, candidate.checkpoints)
    : {
      comparedFrames: 0,
      hashMismatches: 0,
      mismatchRatio: 0
    };

  const notes = reference
    ? ["Reference packet provided. Hash mismatch ratio is preliminary and expected to evolve with richer metrics."]
    : ["Reference packet missing. Report structure generated with candidate-only metrics."];

  return {
    reportVersion: "v1",
    createdAt: new Date().toISOString(),
    scenarioId: candidate.scenarioId,
    seed: candidate.seed,
    referenceAvailable: Boolean(reference),
    metrics: {
      candidatePerformance,
      hashComparison
    },
    notes
  };
}
