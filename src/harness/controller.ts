import { createCandidateEngine } from "../engine/runtime/candidate-engine";
import type { FrameStats, HarnessController, HarnessMode, ScenarioManifest } from "../engine/types";
import { createComparisonReport } from "../analysis/comparison-report";
import {
  assertReferenceApproved,
  hasHumanApprovedBaseline,
  REFERENCE_INTEGRATION,
  setHumanApprovedBaseline
} from "../reference/integration";
import { createCaptureBridge } from "./capture/checkpoint-bridge";
import { createDeterministicModeLoop } from "./modes/deterministic-mode";
import { createRealtimeModeLoop } from "./modes/realtime-mode";
import { createPresetDataUrl, STAGE_ASPECT, type PresetName } from "../reference/background-presets";

interface HarnessControllerOptions {
  container: HTMLElement;
  initialMode: HarnessMode;
  initialScenario: ScenarioManifest;
}

export async function createHarnessController(options: HarnessControllerOptions): Promise<HarnessController> {
  const { initialMode, initialScenario } = options;

  const root = document.createElement("section");
  root.style.display = "grid";
  root.style.gap = "0.75rem";
  root.style.padding = "1rem";
  root.style.color = "#d7e7ff";
  root.style.background = "linear-gradient(160deg, #07111e 0%, #0f1f35 100%)";
  root.style.minHeight = "100vh";
  root.style.fontFamily = "'Segoe UI', Tahoma, sans-serif";

  const heading = document.createElement("h1");
  heading.textContent = "Rain Engine Replication Harness";
  heading.style.margin = "0";
  heading.style.fontSize = "1.25rem";

  const status = document.createElement("p");
  status.id = "harness-status-line";
  status.style.margin = "0";

  const comparisonHealth = document.createElement("p");
  comparisonHealth.id = "harness-comparison-line";
  comparisonHealth.style.margin = "0";
  comparisonHealth.style.color = "#9fc9eb";

  const controls = document.createElement("div");
  controls.style.display = "flex";
  controls.style.flexWrap = "wrap";
  controls.style.gap = "0.5rem";

  const modeButton = document.createElement("button");
  modeButton.type = "button";
  modeButton.id = "harness-mode-button";
  modeButton.style.cursor = "pointer";

  const openReferenceButton = document.createElement("button");
  openReferenceButton.type = "button";
  openReferenceButton.id = "harness-open-reference-button";
  openReferenceButton.textContent = "Open behavioral baseline";
  openReferenceButton.style.cursor = "pointer";

  const approveButton = document.createElement("button");
  approveButton.type = "button";
  approveButton.id = "harness-approve-button";
  approveButton.textContent = "I approve baseline";
  approveButton.style.cursor = "pointer";

  const flushButton = document.createElement("button");
  flushButton.type = "button";
  flushButton.id = "harness-export-button";
  flushButton.textContent = "Export deterministic packet";
  flushButton.style.cursor = "pointer";

  const presetSelect = document.createElement("select");
  presetSelect.id = "harness-preset-select";
  presetSelect.innerHTML = [
    '<option value="night-boulevard">Preset: Night Boulevard</option>',
    '<option value="sunset-hills">Preset: Sunset Hills</option>',
    '<option value="neon-alley">Preset: Neon Alley</option>'
  ].join("");

  const applyPresetButton = document.createElement("button");
  applyPresetButton.type = "button";
  applyPresetButton.id = "harness-apply-preset-button";
  applyPresetButton.textContent = "Apply comparison preset";
  applyPresetButton.style.cursor = "pointer";

  const renderModeButton = document.createElement("button");
  renderModeButton.type = "button";
  renderModeButton.id = "harness-render-mode-button";
  renderModeButton.style.cursor = "pointer";

  const report = document.createElement("pre");
  report.style.margin = "0";
  report.style.padding = "0.75rem";
  report.style.border = "1px solid #274266";
  report.style.borderRadius = "8px";
  report.style.background = "#081321";
  report.style.overflowX = "auto";

  const motionHealth = document.createElement("pre");
  motionHealth.id = "harness-motion-line";
  motionHealth.style.margin = "0";
  motionHealth.style.padding = "0.75rem";
  motionHealth.style.border = "1px solid #274266";
  motionHealth.style.borderRadius = "8px";
  motionHealth.style.background = "#081321";
  motionHealth.style.overflowX = "auto";

  const captureBridge = createCaptureBridge(initialScenario);
  const engine = await createCandidateEngine(initialScenario.resolution.width, initialScenario.resolution.height, initialScenario.seed);
  let comparisonPreset: PresetName = "night-boulevard";
  let renderMode: "comparison" | "debug-wetness" = "comparison";

  await engine.setBackgroundDataUrl?.(createPresetDataUrl(comparisonPreset));
  engine.setRenderMode?.(renderMode);

  const stage = document.createElement("div");
  stage.style.width = "min(100%, 1280px)";
  stage.style.maxWidth = "1280px";
  stage.style.aspectRatio = STAGE_ASPECT;
  stage.style.borderRadius = "8px";
  stage.style.overflow = "hidden";
  stage.style.margin = "0";
  stage.style.background = "#0f1d30";
  engine.view.id = "harness-candidate-canvas";
  engine.view.style.width = "100%";
  engine.view.style.height = "100%";
  stage.appendChild(engine.view);

  let latestStats: FrameStats | null = null;

  const onFrameStats = (stats: FrameStats): void => {
    latestStats = stats;
    updateMotionHealth();
    updateStatus();
  };

  let mode: HarnessMode = initialMode;
  let loop = mode === "deterministic"
    ? createDeterministicModeLoop(engine, initialScenario, captureBridge, onFrameStats)
    : createRealtimeModeLoop(engine, initialScenario, captureBridge, onFrameStats);
  let baselineApproved = hasHumanApprovedBaseline();

  const updateStatus = (): void => {
    status.textContent = `Mode: ${mode} | Scenario: ${initialScenario.id} | Fixed dt: ${initialScenario.fixedDeltaMs.toFixed(4)} ms | Baseline approved: ${baselineApproved ? "yes" : "no"} | View: ${renderMode} | Background: preset ${comparisonPreset}`;
    modeButton.textContent = mode === "realtime" ? "Switch to deterministic" : "Switch to realtime";
    renderModeButton.textContent = renderMode === "comparison" ? "Switch to debug wetness" : "Switch to comparison view";

    const readiness = latestStats?.comparisonReadiness;
    const simClock = latestStats?.simulationClock;
    const backgroundApplied = readiness?.backgroundApplied ?? false;
    const backgroundMeanLuma = readiness?.backgroundMeanLuma ?? 0;
    const activeRenderMode = readiness?.renderMode ?? renderMode;
    const simWallRatio = simClock?.simToWallRatio ?? 0;
    const simWallMs = simClock?.wallTimeMs ?? 0;
    const simTimeMs = simClock?.simulatedTimeMs ?? 0;
    const simThrottled = simClock?.throttled ?? false;
    comparisonHealth.textContent = `comparison | renderMode=${activeRenderMode} | backgroundPreset=${comparisonPreset} | backgroundApplied=${backgroundApplied} | backgroundMeanLuma=${backgroundMeanLuma.toFixed(3)} | simWallRatio=${simWallRatio.toFixed(3)} | simWallMs=${simWallMs.toFixed(1)} | simTimeMs=${simTimeMs.toFixed(1)} | simThrottled=${simThrottled} | stageDisplay=1280x720 | canvasPixels=${initialScenario.resolution.width}x${initialScenario.resolution.height} | baselineApprovalGate=${baselineApproved}`;
  };

  const updateMotionHealth = (): void => {
    if (latestStats?.motionSanityError) {
      motionHealth.textContent = [
        "Runtime motion sanity",
        `frame: ${latestStats.frame}`,
        "classification: unavailable",
        `error: ${latestStats.motionSanityError}`
      ].join("\n");
      return;
    }

    if (!latestStats || !latestStats.motionSanity) {
      motionHealth.textContent = "Runtime motion sanity\nNo motion sample available yet.";
      return;
    }

    const motion = latestStats.motionSanity;
    const simClock = latestStats.simulationClock;
    const warning = motion.classification === "structured-motion"
      ? "none"
      : "state appears under-structured (possible moving-static behavior)";
    const simRatio = simClock?.simToWallRatio ?? 0;
    const simThrottled = simClock?.throttled ?? false;

    motionHealth.textContent = [
      "Runtime motion sanity",
      `frame: ${latestStats.frame}`,
      `classification: ${motion.classification}`,
      `simToWallRatio: ${simRatio.toFixed(3)}`,
      `simClockState: ${simThrottled ? "simulation-throttled" : "stable"}`,
      `warning: ${warning}`,
      `meanWetness: ${motion.meanWetness.toFixed(5)}`,
      `variance: ${motion.variance.toExponential(3)}`,
      `activeRatio: ${(motion.activeRatio * 100).toFixed(2)}%`,
      `temporalDelta: ${motion.temporalDelta.toExponential(3)}`,
      `sampledTexels: ${motion.sampledTexels} every ${motion.sampleIntervalFrames} frames`
    ].join("\n");
  };

  const startIfApproved = (): void => {
    try {
      assertReferenceApproved(REFERENCE_INTEGRATION);
      baselineApproved = true;
      modeButton.disabled = false;
      flushButton.disabled = false;
      loop.start();
    } catch (error) {
      baselineApproved = false;
      modeButton.disabled = true;
      flushButton.disabled = true;
      report.textContent = String(error);
    }
    updateStatus();
  };

  modeButton.addEventListener("click", () => {
    loop.stop();
    mode = mode === "realtime" ? "deterministic" : "realtime";
    loop = mode === "deterministic"
      ? createDeterministicModeLoop(engine, initialScenario, captureBridge, onFrameStats)
      : createRealtimeModeLoop(engine, initialScenario, captureBridge, onFrameStats);
    updateStatus();
    loop.start();
  });

  openReferenceButton.addEventListener("click", () => {
    window.open("/reference-baseline.html", "_blank", "noopener,noreferrer");
  });

  approveButton.addEventListener("click", () => {
    setHumanApprovedBaseline(true);
    startIfApproved();
  });

  flushButton.addEventListener("click", () => {
    const packet = captureBridge.exportDeterministicPacket();
    const reportPayload = createComparisonReport(packet);
    const blob = new Blob([JSON.stringify(packet, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `deterministic-packet-${packet.scenarioId}-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);

    report.textContent = JSON.stringify({
      packetSummary: {
        packetVersion: packet.packetVersion,
        generatedAt: packet.generatedAt,
        frameCount: packet.frameCount
      },
      comparisonReport: reportPayload
    }, null, 2);
  });

  applyPresetButton.addEventListener("click", async () => {
    const preset = (presetSelect.value as PresetName) || "night-boulevard";
    comparisonPreset = preset;
    await engine.setBackgroundDataUrl?.(createPresetDataUrl(preset));
    updateStatus();
  });

  renderModeButton.addEventListener("click", () => {
    renderMode = renderMode === "comparison" ? "debug-wetness" : "comparison";
    engine.setRenderMode?.(renderMode);
    updateStatus();
  });

  controls.appendChild(openReferenceButton);
  controls.appendChild(approveButton);
  controls.appendChild(modeButton);
  controls.appendChild(flushButton);
  controls.appendChild(presetSelect);
  controls.appendChild(applyPresetButton);
  controls.appendChild(renderModeButton);

  root.appendChild(heading);
  root.appendChild(status);
  root.appendChild(comparisonHealth);
  root.appendChild(controls);
  root.appendChild(stage);
  root.appendChild(motionHealth);
  root.appendChild(report);

  updateStatus();
  updateMotionHealth();
  startIfApproved();

  return {
    view: root,
    start(): void {
      startIfApproved();
    },
    stop(): void {
      loop.stop();
    }
  };
}
