import type { CaptureCheckpoint } from "../harness/capture/checkpoint-bridge";

export interface PerformanceSummary {
  avgMs: number;
  p95Ms: number;
  p99Ms: number;
}

export function summarizeFrameTimes(checkpoints: CaptureCheckpoint[]): PerformanceSummary {
  if (checkpoints.length === 0) {
    return {
      avgMs: 0,
      p95Ms: 0,
      p99Ms: 0
    };
  }

  const values = checkpoints
    .map((entry) => entry.frameStats.frameMs)
    .sort((left, right) => left - right);

  const avgMs = values.reduce((sum, value) => sum + value, 0) / values.length;

  return {
    avgMs,
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99)
  };
}

function percentile(values: number[], ratio: number): number {
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1));
  return values[index] ?? 0;
}
