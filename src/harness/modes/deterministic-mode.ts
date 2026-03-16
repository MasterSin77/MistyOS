import type { EngineInterface, FrameStats, ScenarioManifest } from "../../engine/types";
import type { CaptureBridge } from "../capture/checkpoint-bridge";
import { createCheckpointHash } from "../capture/checkpoint-bridge";

export interface DeterministicLoop {
  start(): void;
  stop(): void;
}

export function createDeterministicModeLoop(
  engine: EngineInterface,
  scenario: ScenarioManifest,
  captureBridge: CaptureBridge,
  onFrameStats?: (stats: FrameStats) => void
): DeterministicLoop {
  let frame = 0;
  let running = false;

  const runStep = async (): Promise<void> => {
    if (!running) {
      return;
    }

    if (frame >= scenario.totalFrames) {
      running = false;
      return;
    }

    const context = {
      frame,
      deltaMs: scenario.fixedDeltaMs,
      scenario
    };

    engine.update(context);
    engine.render(context);
    const stats = engine.collectStats(context);
    onFrameStats?.(stats);
    const stateHash = engine.captureStateHash ? await engine.captureStateHash() : createCheckpointHash(frame, stats.frameMs);

    captureBridge.append({
      frame,
      scenarioId: scenario.id,
      seed: scenario.seed,
      frameStats: stats,
      hash: stateHash,
      mode: "deterministic",
      capturedAt: new Date().toISOString()
    });

    frame += 1;
    window.queueMicrotask(() => {
      void runStep();
    });
  };

  return {
    start(): void {
      if (running) {
        return;
      }
      running = true;
      frame = 0;
      void runStep();
    },
    stop(): void {
      running = false;
    }
  };
}
