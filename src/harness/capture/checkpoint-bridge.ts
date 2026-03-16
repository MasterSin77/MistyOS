import type { FrameStats, ScenarioManifest } from "../../engine/types";

export type CaptureMode = "realtime" | "deterministic";

export interface CaptureCheckpoint {
  frame: number;
  scenarioId: string;
  seed: number;
  frameStats: FrameStats;
  hash: string;
  mode: CaptureMode;
  capturedAt: string;
}

export interface CaptureBridge {
  append(checkpoint: CaptureCheckpoint): void;
  flush(): CaptureCheckpoint[];
  exportDeterministicPacket(): DeterministicArtifactPacket;
}

export interface DeterministicArtifactPacket {
  packetVersion: "v1";
  scenarioId: string;
  seed: number;
  generatedAt: string;
  frameCount: number;
  checkpoints: CaptureCheckpoint[];
}

export function createCaptureBridge(scenario: ScenarioManifest): CaptureBridge {
  const checkpoints: CaptureCheckpoint[] = [];

  return {
    append(checkpoint: CaptureCheckpoint): void {
      checkpoints.push(checkpoint);
    },
    flush(): CaptureCheckpoint[] {
      const payload = [...checkpoints];
      checkpoints.length = 0;
      return payload;
    },
    exportDeterministicPacket(): DeterministicArtifactPacket {
      const deterministic = checkpoints.filter((entry) => entry.mode === "deterministic");
      return {
        packetVersion: "v1",
        scenarioId: scenario.id,
        seed: scenario.seed,
        generatedAt: new Date().toISOString(),
        frameCount: deterministic.length,
        checkpoints: deterministic
      };
    }
  };
}

export function createCheckpointHash(frame: number, frameMs: number): string {
  return `${frame.toString(16)}-${Math.round(frameMs * 1000).toString(16)}`;
}
