import type { CaptureCheckpoint } from "../harness/capture/checkpoint-bridge";

export interface DiffResult {
  comparedFrames: number;
  hashMismatches: number;
  mismatchRatio: number;
}

export function compareCheckpointHashes(reference: CaptureCheckpoint[], candidate: CaptureCheckpoint[]): DiffResult {
  const limit = Math.min(reference.length, candidate.length);
  let mismatches = 0;

  for (let index = 0; index < limit; index += 1) {
    if (reference[index]?.hash !== candidate[index]?.hash) {
      mismatches += 1;
    }
  }

  const comparedFrames = limit;
  const mismatchRatio = comparedFrames === 0 ? 0 : mismatches / comparedFrames;

  return {
    comparedFrames,
    hashMismatches: mismatches,
    mismatchRatio
  };
}
