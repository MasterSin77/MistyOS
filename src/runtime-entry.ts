import { createHarnessController } from "./harness/controller";
import { createDefaultScenario } from "./harness/scenarios/default-scenario";
import type { ScenarioManifest, ScenarioTuning } from "./engine/types";

export async function bootstrapApplication(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) {
    throw new Error("Expected #app root element.");
  }

  const scenario = createDefaultScenario();
  applyScenarioOverridesFromUrl(scenario);
  try {
    const controller = await createHarnessController({
      container: root,
      initialMode: "realtime",
      initialScenario: scenario
    });

    root.innerHTML = "";
    root.appendChild(controller.view);
    controller.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    root.innerHTML = "";
    const panel = document.createElement("section");
    panel.style.padding = "1rem";
    panel.style.fontFamily = "'Segoe UI', Tahoma, sans-serif";
    panel.style.color = "#d7e7ff";
    panel.style.background = "linear-gradient(160deg, #07111e 0%, #0f1f35 100%)";
    panel.style.minHeight = "100vh";

    const heading = document.createElement("h1");
    heading.textContent = "Successor Harness Unavailable";
    heading.style.margin = "0 0 0.5rem 0";

    const detail = document.createElement("p");
    detail.textContent = `Harness startup failed: ${message}`;

    const hint = document.createElement("p");
    hint.textContent = "Baseline validation remains available at /reference-baseline.html.";

    panel.appendChild(heading);
    panel.appendChild(detail);
    panel.appendChild(hint);
    root.appendChild(panel);
  }
}

function applyScenarioOverridesFromUrl(scenario: ScenarioManifest): void {
  const params = new URLSearchParams(window.location.search);
  const maybeRainRate = parseParam(params, "rainRate");
  if (Number.isFinite(maybeRainRate)) {
    scenario.rain.ratePerSecond = Math.max(0.1, maybeRainRate);
  }

  const tuning = ensureTuning(scenario);
  maybeAssign(tuning, "depositionChanceScale", parseParam(params, "depChance"));
  maybeAssign(tuning, "depositionAmountScale", parseParam(params, "depAmount"));
  maybeAssign(tuning, "depositionTopBias", parseParam(params, "depTopBias"));
  maybeAssign(tuning, "decayRateScale", parseParam(params, "decayScale"));
  maybeAssign(tuning, "runoffScale", parseParam(params, "runoffScale"));
  maybeAssign(tuning, "retentionScale", parseParam(params, "retentionScale"));
  maybeAssign(tuning, "overlaySpotScale", parseParam(params, "overlaySpot"));
  maybeAssign(tuning, "dropletSpawnRate", parseParam(params, "dropSpawn"));
  maybeAssign(tuning, "dropletMass", parseParam(params, "dropMass"));
  maybeAssign(tuning, "dropletSlipThreshold", parseParam(params, "dropSlip"));
  maybeAssign(tuning, "dropletMergeRadius", parseParam(params, "dropMerge"));
  maybeAssign(tuning, "dropletDepositionRate", parseParam(params, "dropDeposit"));
  maybeAssign(tuning, "anisotropicTransport", parseParam(params, "mechAniso"));
  maybeAssign(tuning, "trailMemory", parseParam(params, "mechTrail"));
  maybeAssign(tuning, "slipRelease", parseParam(params, "mechSlipRelease"));
  maybeAssign(tuning, "channelAttraction", parseParam(params, "mechChannel"));
  maybeAssign(tuning, "mergeToRunnel", parseParam(params, "mechRunnel"));
}

function parseParam(params: URLSearchParams, key: string): number {
  const raw = params.get(key);
  if (!raw) {
    return Number.NaN;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : Number.NaN;
}

function ensureTuning(scenario: ScenarioManifest): ScenarioTuning {
  if (scenario.tuning) {
    return scenario.tuning;
  }

  scenario.tuning = {
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
  };
  return scenario.tuning;
}

function maybeAssign(tuning: ScenarioTuning, key: keyof ScenarioTuning, value: number): void {
  if (Number.isFinite(value)) {
    tuning[key] = value;
  }
}
