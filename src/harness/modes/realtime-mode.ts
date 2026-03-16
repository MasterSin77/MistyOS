import type { EngineInterface, FrameStats, ScenarioManifest } from "../../engine/types";
import type { CaptureBridge } from "../capture/checkpoint-bridge";

export interface RuntimeLoop {
  start(): void;
  stop(): void;
}

export function createRealtimeModeLoop(
  engine: EngineInterface,
  scenario: ScenarioManifest,
  _captureBridge: CaptureBridge,
  onFrameStats?: (stats: FrameStats) => void
): RuntimeLoop {
  const SIM_THROTTLE_RATIO_THRESHOLD = 0.8;
  const SIM_CATCH_UP_CAP_STEPS = 240;

  let frame = 0;
  let renderRafId: number | null = null;
  let simulationTimerId: number | null = null;
  let running = false;
  let wallClockStartMs = 0;
  let lastSimulationTickMs = 0;
  let simulatedTimeMs = 0;
  let accumulatorMs = 0;
  let latestSimulationContext: {
    frame: number;
    deltaMs: number;
    scenario: ScenarioManifest;
  } | null = null;

  const simulationClockStats = (nowMs: number): FrameStats["simulationClock"] => {
    const wallTimeMs = wallClockStartMs > 0 ? Math.max(0, nowMs - wallClockStartMs) : 0;
    const simToWallRatio = wallTimeMs > 1e-3 ? simulatedTimeMs / wallTimeMs : 1;
    return {
      simulatedTimeMs,
      wallTimeMs,
      simToWallRatio,
      throttled: wallTimeMs >= 1000 && simToWallRatio < SIM_THROTTLE_RATIO_THRESHOLD,
      threshold: SIM_THROTTLE_RATIO_THRESHOLD
    };
  };

  const publishStats = (context: {
    frame: number;
    deltaMs: number;
    scenario: ScenarioManifest;
  }, nowMs: number): void => {
    const stats = engine.collectStats(context);
    onFrameStats?.({
      ...stats,
      simulationClock: simulationClockStats(nowMs)
    });
  };

  const simulationTick = (): void => {
    if (!running) {
      return;
    }

    const now = performance.now();
    if (wallClockStartMs <= 0) {
      wallClockStartMs = now;
      lastSimulationTickMs = now;
      return;
    }

    const elapsedMs = Math.max(0, now - lastSimulationTickMs);
    lastSimulationTickMs = now;
    accumulatorMs += elapsedMs;

    let steps = 0;
    while (accumulatorMs >= scenario.fixedDeltaMs && steps < SIM_CATCH_UP_CAP_STEPS) {
      const context = {
        frame,
        deltaMs: scenario.fixedDeltaMs,
        scenario
      };

      engine.update(context);
      latestSimulationContext = context;
      frame += 1;
      simulatedTimeMs += scenario.fixedDeltaMs;
      accumulatorMs -= scenario.fixedDeltaMs;
      steps += 1;
    }

    if (accumulatorMs >= scenario.fixedDeltaMs) {
      // Keep accumulator bounded so browser stalls don't trigger unbounded catch-up loops.
      accumulatorMs = scenario.fixedDeltaMs;
    }

    if (latestSimulationContext && steps > 0) {
      publishStats(latestSimulationContext, now);
    }
  };

  const renderTick = (): void => {
    if (!running) {
      return;
    }

    if (latestSimulationContext) {
      const now = performance.now();
      engine.render(latestSimulationContext);
      publishStats(latestSimulationContext, now);
    }

    renderRafId = window.requestAnimationFrame(renderTick);
  };

  return {
    start(): void {
      if (running) {
        return;
      }

      running = true;
      frame = 0;
      wallClockStartMs = 0;
      lastSimulationTickMs = 0;
      simulatedTimeMs = 0;
      accumulatorMs = 0;
      latestSimulationContext = null;

      simulationTimerId = window.setInterval(simulationTick, 4);
      renderRafId = window.requestAnimationFrame(renderTick);
    },
    stop(): void {
      running = false;
      if (simulationTimerId !== null) {
        window.clearInterval(simulationTimerId);
        simulationTimerId = null;
      }
      if (renderRafId !== null) {
        window.cancelAnimationFrame(renderRafId);
        renderRafId = null;
      }
    }
  };
}
