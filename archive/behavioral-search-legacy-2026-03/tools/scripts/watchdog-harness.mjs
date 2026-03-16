import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { PNG } from "pngjs";

const HOST = process.env.WATCHDOG_HOST ?? "127.0.0.1";
const PORT = Number(process.env.WATCHDOG_PORT ?? "4173");
const BASE_URL = `http://${HOST}:${PORT}`;
const WATCHDOG_PARAM_QUERY = process.env.WATCHDOG_PARAM_QUERY ?? "";
const HARNESS_URL = WATCHDOG_PARAM_QUERY
  ? `${BASE_URL}/?${WATCHDOG_PARAM_QUERY.startsWith("?") ? WATCHDOG_PARAM_QUERY.slice(1) : WATCHDOG_PARAM_QUERY}`
  : `${BASE_URL}/`;
const STARTUP_TIMEOUT_MS = 25000;
const BASELINE_APPROVAL_KEY = "rain-engine-behavioral-reference-approved-v1";
const LOOP_INTERVAL_MS = Number(process.env.WATCHDOG_INTERVAL_MS ?? "5000");
const MAX_ITERATIONS = Number(process.env.WATCHDOG_ITERATIONS ?? "0");
const LOG_PATH = path.join(process.cwd(), "tools", "logs", "harness-watchdog.log");
const ARTIFACT_DIR = path.join(process.cwd(), "tools", "logs", "watchdog-artifacts");
const HISTORY_SIZE = 8;
const DEGRADED_STREAK_ESCALATE = 3;

async function stopProcessTree(child) {
  if (!child || child.killed || child.exitCode !== null || child.pid == null) {
    return;
  }

  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        shell: false
      });
      killer.on("exit", () => resolve());
      killer.on("error", () => resolve());
    });
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // Ignore cleanup errors.
    }
  }
}

function startDevServer() {
  const child = spawn(
    "npm",
    ["run", "dev", "--", `--host=${HOST}`, `--port=${String(PORT)}`, "--strictPort"],
    {
      cwd: process.cwd(),
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  return {
    child,
    logs: () => ({ stdout, stderr })
  };
}

async function waitForServer(url, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) {
        return;
      }
    } catch {
      // Server may still be starting.
    }
    await delay(250);
  }
  throw new Error(`Dev server did not become ready within ${timeoutMs} ms.`);
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true, channel: "msedge" });
  } catch {
    return await chromium.launch({ headless: true });
  }
}

async function textContent(page, selector) {
  const handle = await page.$(selector);
  if (!handle) {
    return null;
  }
  const text = await handle.textContent();
  return text?.trim() ?? null;
}

async function sampleCanvas(page) {
  const target = page.locator("#harness-candidate-canvas");
  if ((await target.count()) === 0) {
    return null;
  }

  const buffer = await target.screenshot({ type: "png" });
  const png = PNG.sync.read(buffer);
  const { width, height, data } = png;
  const step = 6;
  const grid = [];
  const rowMeans = [];
  const colMeans = [];
  let count = 0;
  let sum = 0;
  let sumSq = 0;
  let gridHeight = 0;
  let gridWidth = 0;

  for (let y = 0; y < height; y += step) {
    let rowSum = 0;
    let rowCount = 0;
    gridWidth = 0;
    for (let x = 0; x < width; x += step) {
      const idx = (y * width + x) * 4;
      const r = data[idx] ?? 0;
      const g = data[idx + 1] ?? 0;
      const b = data[idx + 2] ?? 0;
      const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      grid.push(luma);
      rowSum += luma;
      rowCount += 1;
      colMeans[gridWidth] = (colMeans[gridWidth] ?? 0) + luma;
      sum += luma;
      sumSq += luma * luma;
      count += 1;
      gridWidth += 1;
    }

    rowMeans.push(rowCount > 0 ? rowSum / rowCount : 0);
    gridHeight += 1;
  }

  if (gridHeight > 0) {
    for (let i = 0; i < colMeans.length; i += 1) {
      colMeans[i] = (colMeans[i] ?? 0) / gridHeight;
    }
  }

  const meanLuma = count > 0 ? sum / count : 0;
  const variance = count > 0 ? Math.max(0, sumSq / count - meanLuma * meanLuma) : 0;
  return {
    screenshotBuffer: buffer,
    width,
    height,
    meanLuma,
    stdLuma: Math.sqrt(variance),
    grid,
    gridWidth,
    gridHeight,
    rowMeans,
    colMeans
  };
}

function gridDelta(a, b) {
  if (!a || !b || !Array.isArray(a.grid) || !Array.isArray(b.grid) || a.grid.length !== b.grid.length) {
    return Number.NaN;
  }

  let total = 0;
  for (let i = 0; i < a.grid.length; i += 1) {
    total += Math.abs((a.grid[i] ?? 0) - (b.grid[i] ?? 0));
  }
  return a.grid.length > 0 ? total / a.grid.length : Number.NaN;
}

function parseBooleanField(line, fieldName) {
  if (!line) {
    return false;
  }
  const match = line.match(new RegExp(`${fieldName}=([^|]+)`));
  if (!match) {
    return false;
  }
  return (match[1] ?? "").trim().toLowerCase() === "true";
}

function parseNumberField(line, fieldName) {
  if (!line) {
    return Number.NaN;
  }
  const match = line.match(new RegExp(`${fieldName}=([^|]+)`));
  if (!match) {
    return Number.NaN;
  }
  return Number((match[1] ?? "").trim());
}

function parseFrameNumber(motionLine) {
  if (!motionLine) {
    return Number.NaN;
  }
  const match = motionLine.match(/frame:\s*(\d+)/i);
  if (!match) {
    return Number.NaN;
  }
  return Number(match[1]);
}

function parseMotionMetric(motionLine, metric) {
  if (!motionLine) {
    return Number.NaN;
  }
  const match = motionLine.match(new RegExp(`${metric}:\\s*([0-9.eE+-]+)`));
  if (!match) {
    return Number.NaN;
  }
  return Number(match[1]);
}

function pearsonCorrelation(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) {
    return Number.NaN;
  }

  let sumA = 0;
  let sumB = 0;
  let sumAA = 0;
  let sumBB = 0;
  let sumAB = 0;

  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    sumA += av;
    sumB += bv;
    sumAA += av * av;
    sumBB += bv * bv;
    sumAB += av * bv;
  }

  const n = a.length;
  const numerator = n * sumAB - sumA * sumB;
  const denomLeft = n * sumAA - sumA * sumA;
  const denomRight = n * sumBB - sumB * sumB;
  const denominator = Math.sqrt(Math.max(0, denomLeft * denomRight));
  if (denominator <= 1e-9) {
    return Number.NaN;
  }
  return numerator / denominator;
}

function computeActivityCentroidY(sampleA, sampleB) {
  if (!sampleA || !sampleB || sampleA.gridWidth !== sampleB.gridWidth || sampleA.gridHeight !== sampleB.gridHeight) {
    return Number.NaN;
  }

  const width = sampleA.gridWidth;
  const height = sampleA.gridHeight;
  let weightedY = 0;
  let weightSum = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      const delta = Math.abs((sampleB.grid[idx] ?? 0) - (sampleA.grid[idx] ?? 0));
      weightedY += y * delta;
      weightSum += delta;
    }
  }

  if (weightSum <= 1e-9) {
    return Number.NaN;
  }
  return weightedY / weightSum;
}

function computeDirectionalContinuity(sample) {
  if (!sample || sample.gridWidth < 2 || sample.gridHeight < 2) {
    return {
      verticalContinuity: Number.NaN,
      horizontalContinuity: Number.NaN,
      streakBias: Number.NaN
    };
  }

  const width = sample.gridWidth;
  const height = sample.gridHeight;
  let verticalDiffSum = 0;
  let verticalCount = 0;
  let horizontalDiffSum = 0;
  let horizontalCount = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      const v = sample.grid[idx] ?? 0;
      if (y + 1 < height) {
        const down = sample.grid[idx + width] ?? 0;
        verticalDiffSum += Math.abs(v - down);
        verticalCount += 1;
      }
      if (x + 1 < width) {
        const right = sample.grid[idx + 1] ?? 0;
        horizontalDiffSum += Math.abs(v - right);
        horizontalCount += 1;
      }
    }
  }

  const verticalDiff = verticalCount > 0 ? verticalDiffSum / verticalCount : Number.NaN;
  const horizontalDiff = horizontalCount > 0 ? horizontalDiffSum / horizontalCount : Number.NaN;
  const verticalContinuity = Number.isFinite(verticalDiff) ? 1 - Math.min(1, verticalDiff / 0.25) : Number.NaN;
  const horizontalContinuity = Number.isFinite(horizontalDiff) ? 1 - Math.min(1, horizontalDiff / 0.25) : Number.NaN;
  const streakBias = Number.isFinite(verticalContinuity) && Number.isFinite(horizontalContinuity)
    ? verticalContinuity - horizontalContinuity
    : Number.NaN;

  return { verticalContinuity, horizontalContinuity, streakBias };
}

function computeColumnAutocorrPeak(columns) {
  if (!Array.isArray(columns) || columns.length < 16) {
    return Number.NaN;
  }

  const mean = columns.reduce((acc, v) => acc + (v ?? 0), 0) / columns.length;
  const centered = columns.map((v) => (v ?? 0) - mean);
  let baseEnergy = 0;
  for (let i = 0; i < centered.length; i += 1) {
    baseEnergy += centered[i] * centered[i];
  }
  if (baseEnergy <= 1e-9) {
    return Number.NaN;
  }

  let peak = -1;
  const maxLag = Math.min(48, Math.floor(columns.length / 2));
  for (let lag = 4; lag <= maxLag; lag += 1) {
    let corr = 0;
    for (let i = 0; i + lag < centered.length; i += 1) {
      corr += centered[i] * centered[i + lag];
    }
    peak = Math.max(peak, corr / baseEnergy);
  }

  return peak;
}

function buildBehavioralHeuristics(snapshot, history) {
  const framePersistence = pearsonCorrelation(snapshot.sampleA?.grid ?? [], snapshot.canvas?.grid ?? []);
  const activityCentroidY = computeActivityCentroidY(snapshot.sampleA, snapshot.canvas);
  const dir = computeDirectionalContinuity(snapshot.canvas);
  const columnPatternPeak = computeColumnAutocorrPeak(snapshot.canvas?.colMeans ?? []);

  const recentCentroids = history
    .map((entry) => entry.behavioral.activityCentroidY)
    .filter((value) => Number.isFinite(value));
  const downwardTrend = recentCentroids.length >= 2
    ? recentCentroids[recentCentroids.length - 1] - recentCentroids[0]
    : Number.NaN;

  const recentDeltas = history
    .map((entry) => entry.visual.canvasDelta)
    .filter((value) => Number.isFinite(value));
  const meanRecentDelta = recentDeltas.length > 0
    ? recentDeltas.reduce((acc, value) => acc + value, 0) / recentDeltas.length
    : Number.NaN;

  const persistenceGood = Number.isFinite(framePersistence) && framePersistence > 0.80;
  const notRandomized = Number.isFinite(framePersistence) && framePersistence < 0.995;
  const downwardBias = Number.isFinite(downwardTrend) ? downwardTrend > 0.35 : false;
  const organizationEmerging = Number.isFinite(snapshot.canvas?.stdLuma) && snapshot.canvas.stdLuma > 0.015;
  const streakTendency = Number.isFinite(dir.streakBias) && dir.streakBias > 0.03;
  const hazeCollapse = Number.isFinite(snapshot.canvas?.stdLuma) && snapshot.canvas.stdLuma < 0.010;
  const debugPatternDominance = Number.isFinite(columnPatternPeak) && columnPatternPeak > 0.86 && Number.isFinite(meanRecentDelta) && meanRecentDelta < 0.001;

  const issues = [];
  if (!persistenceGood) issues.push("low frame persistence (possible noisy overlay)");
  if (!notRandomized) issues.push("near-identical frames (stagnation)");
  if (!downwardBias) issues.push("downward-biased motion trend not evident yet");
  if (!organizationEmerging) issues.push("non-uniform wetness organization too weak");
  if (!streakTendency) issues.push("streak/runnel tendency not evident yet");
  if (hazeCollapse) issues.push("output collapsing toward uniform haze");
  if (debugPatternDominance) issues.push("synthetic repeated structure still dominant");

  return {
    framePersistence,
    activityCentroidY,
    downwardTrend,
    verticalContinuity: dir.verticalContinuity,
    horizontalContinuity: dir.horizontalContinuity,
    streakBias: dir.streakBias,
    columnPatternPeak,
    issues
  };
}

function evaluateCycle(snapshot, history) {
  const baselineApproved = /Baseline approved:\s*yes/i.test(snapshot.status ?? "");
  const comparisonMode = /renderMode=comparison/i.test(snapshot.comparison ?? "");
  const renderViewComparison = /View:\s*comparison/i.test(snapshot.status ?? "");
  const backgroundApplied = parseBooleanField(snapshot.comparison, "backgroundApplied");
  const baselineGate = parseBooleanField(snapshot.comparison, "baselineApprovalGate");
  const backgroundMeanLuma = parseNumberField(snapshot.comparison, "backgroundMeanLuma");
  const motionClassification = /classification:\s*(structured-motion|low-motion|dry)/i.test(snapshot.motion ?? "");
  const motionError = /classification:\s*unavailable/i.test(snapshot.motion ?? "");
  const simWallRatio = parseNumberField(snapshot.comparison, "simWallRatio");
  const simThrottled = parseBooleanField(snapshot.comparison, "simThrottled");
  const simClockHealthy = Number.isFinite(simWallRatio) && simWallRatio >= 0.8 && !simThrottled;

  const canvasMeanLuma = snapshot.canvas?.meanLuma ?? Number.NaN;
  const canvasStdLuma = snapshot.canvas?.stdLuma ?? Number.NaN;
  const canvasNotBlack = Number.isFinite(canvasMeanLuma) && canvasMeanLuma > 0.05;
  const canvasVisibleRange = Number.isFinite(canvasMeanLuma) && canvasMeanLuma < 0.95;
  const canvasNonUniform = Number.isFinite(canvasStdLuma) && canvasStdLuma > 0.01;
  const canvasEvolving = Number.isFinite(snapshot.canvasDelta) && snapshot.canvasDelta > 0.0002;

  const frameCurrent = parseFrameNumber(snapshot.motion);
  const framePrevious = Number.isFinite(snapshot.prevFrame) ? snapshot.prevFrame : Number.NaN;
  const frameAdvancing = Number.isFinite(frameCurrent) && Number.isFinite(framePrevious) ? frameCurrent > framePrevious : Number.isFinite(frameCurrent);

  const temporalDelta = parseMotionMetric(snapshot.motion, "temporalDelta");
  const activeRatioMatch = (snapshot.motion ?? "").match(/activeRatio:\s*([0-9.]+)%/i);
  const activeRatioPercent = activeRatioMatch ? Number(activeRatioMatch[1]) : Number.NaN;
  const motionMetricsActive = Number.isFinite(temporalDelta) && temporalDelta > 0.0005 && Number.isFinite(activeRatioPercent) && activeRatioPercent > 0.1;

  const integrityIssues = [];
  if (!baselineApproved) integrityIssues.push("baseline approval inactive");
  if (!renderViewComparison || !comparisonMode) integrityIssues.push("comparison mode inactive");
  if (!backgroundApplied) integrityIssues.push("background preset not applied");
  if (!(Number.isFinite(backgroundMeanLuma) && backgroundMeanLuma > 0.02)) integrityIssues.push("background luma invalid");
  if (!frameAdvancing) integrityIssues.push("frame telemetry not advancing");
  if (!motionClassification || motionError) integrityIssues.push("motion classification invalid");
  if (!motionMetricsActive) integrityIssues.push("motion metrics inactive");
  if (!simClockHealthy) integrityIssues.push("simulation clock throttled (sim/wall ratio below threshold)");

  const visualIssues = [];
  if (!canvasNotBlack) visualIssues.push("canvas black or blank");
  if (!canvasVisibleRange) visualIssues.push("canvas luminance out of range");
  if (!canvasNonUniform) visualIssues.push("canvas collapsed to near-uniform field");
  if (!canvasEvolving) visualIssues.push("canvas static over time");

  const behavioral = buildBehavioralHeuristics(snapshot, history);
  const behavioralIssues = [...behavioral.issues];

  const integrityStatus = integrityIssues.length === 0 ? "HEALTHY" : "FAILED";
  const visualStatus = visualIssues.length === 0 ? "HEALTHY" : (visualIssues.includes("canvas black or blank") ? "FAILED" : "DEGRADED");
  const behavioralStatus = behavioralIssues.length === 0 ? "HEALTHY" : "DEGRADED";

  let state = "HEALTHY";
  if (integrityStatus === "FAILED" || visualStatus === "FAILED") {
    state = "FAILED";
  } else if (visualStatus === "DEGRADED" || behavioralStatus === "DEGRADED") {
    state = "DEGRADED";
  }

  const trend = history.length >= 2
    ? (state === "HEALTHY" ? "improving-or-stable" : "degraded-or-stalled")
    : "insufficient-history";

  return {
    state,
    integrityStatus,
    visualStatus,
    behavioralStatus,
    integrityIssues,
    visualIssues,
    behavioralIssues,
    trend,
    metrics: {
      backgroundMeanLuma,
      canvasMeanLuma,
      canvasStdLuma,
      canvasDelta: snapshot.canvasDelta,
      frame: frameCurrent,
      temporalDelta,
      activeRatioPercent,
      simWallRatio,
      simThrottled,
      comparisonMode,
      baselineApproved,
      ...behavioral
    }
  };
}

async function applyBoundedRepair(page, evaluation) {
  const actions = [];

  const issues = [...evaluation.integrityIssues, ...evaluation.visualIssues];

  if (issues.includes("baseline approval inactive")) {
    const btn = page.locator("#harness-approve-button");
    if ((await btn.count()) > 0) {
      await btn.click();
      actions.push("clicked baseline approve button");
    }
  }

  if (issues.includes("comparison mode inactive")) {
    const btn = page.locator("#harness-render-mode-button");
    if ((await btn.count()) > 0) {
      await btn.click();
      actions.push("toggled render mode to comparison");
    }
  }

  if (
    issues.includes("background preset not applied") ||
    issues.includes("background luma invalid") ||
    issues.includes("canvas black or blank")
  ) {
    const select = page.locator("#harness-preset-select");
    const applyButton = page.locator("#harness-apply-preset-button");
    if ((await select.count()) > 0 && (await applyButton.count()) > 0) {
      await select.selectOption("night-boulevard");
      await applyButton.click();
      actions.push("reapplied comparison preset night-boulevard");
    }
  }

  // If the frame is static but telemetry advances, force a mode roundtrip to nudge stale renderer state.
  if (issues.includes("canvas static over time")) {
    const btn = page.locator("#harness-render-mode-button");
    if ((await btn.count()) > 0) {
      await btn.click();
      await delay(150);
      await btn.click();
      actions.push("render mode roundtrip debug->comparison");
    }
  }

  await delay(600);
  return actions;
}

function appendWatchdogLog(line) {
  const dir = path.dirname(LOG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(LOG_PATH, `${line}\n`, "utf8");
}

function saveCycleArtifacts(iteration, snapshot, cycleSummary) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const baseName = `iter-${String(iteration).padStart(4, "0")}`;

  if (snapshot.canvas?.screenshotBuffer) {
    fs.writeFileSync(path.join(ARTIFACT_DIR, `${baseName}.png`), snapshot.canvas.screenshotBuffer);
  }

  const artifact = {
    generatedAt: new Date().toISOString(),
    iteration,
    status: snapshot.status,
    comparison: snapshot.comparison,
    motion: snapshot.motion,
    summary: cycleSummary
  };
  fs.writeFileSync(path.join(ARTIFACT_DIR, `${baseName}.json`), JSON.stringify(artifact, null, 2), "utf8");
}

function buildFocusedDiagnosis(evaluation) {
  const all = [...evaluation.behavioralIssues, ...evaluation.visualIssues];
  if (all.some((issue) => issue.includes("uniform haze"))) {
    return "output reads as haze/fog wash rather than droplet/streak behavior";
  }
  if (all.some((issue) => issue.includes("downward-biased motion"))) {
    return "motion lacks clear downward organization over time";
  }
  if (all.some((issue) => issue.includes("repeated structure"))) {
    return "synthetic repeated structures remain visually dominant";
  }
  if (all.some((issue) => issue.includes("streak/runnel tendency"))) {
    return "wetness evolves but does not yet form coherent streak/runnel tendencies";
  }
  return "behavior remains visually off-target despite live harness integrity";
}

async function collectSnapshot(page, previousSample, previousFrame) {
  const sampleA = await sampleCanvas(page);
  await delay(700);
  const sampleB = await sampleCanvas(page);
  const canvasDelta = gridDelta(sampleA, sampleB);
  const motionLine = await textContent(page, "#harness-motion-line");
  const frame = parseFrameNumber(motionLine);

  return {
    status: await textContent(page, "#harness-status-line"),
    comparison: await textContent(page, "#harness-comparison-line"),
    motion: motionLine,
    sampleA,
    canvas: sampleB,
    canvasDelta: Number.isFinite(canvasDelta) ? canvasDelta : gridDelta(previousSample, sampleB),
    prevFrame: previousFrame,
    frame
  };
}

async function main() {
  const server = startDevServer();
  let browser;

  try {
    await waitForServer(BASE_URL, STARTUP_TIMEOUT_MS);

    browser = await launchBrowser();
    const context = await browser.newContext();
    await context.addInitScript(({ key }) => {
      window.localStorage.setItem(key, "true");
    }, { key: BASELINE_APPROVAL_KEY });

    const page = await context.newPage();
    await page.goto(HARNESS_URL, { waitUntil: "domcontentloaded", timeout: STARTUP_TIMEOUT_MS });

    let iteration = 0;
    let previousSample = null;
    let previousFrame = Number.NaN;
    const history = [];
    let degradedStreak = 0;

    while (true) {
      iteration += 1;
      const snapshot = await collectSnapshot(page, previousSample, previousFrame);
      const evaluation = evaluateCycle(snapshot, history);

      let correctionActions = [];
      let corrected = false;
      let finalEvaluation = evaluation;

      if (evaluation.state !== "HEALTHY") {
        correctionActions = await applyBoundedRepair(page, evaluation);
        if (correctionActions.length > 0) {
          const repairedSnapshot = await collectSnapshot(page, snapshot.canvas, snapshot.frame);
          finalEvaluation = evaluateCycle(repairedSnapshot, history);
          corrected = true;
          previousSample = repairedSnapshot.canvas;
          previousFrame = repairedSnapshot.frame;
          snapshot.canvas = repairedSnapshot.canvas;
          snapshot.motion = repairedSnapshot.motion;
          snapshot.status = repairedSnapshot.status;
          snapshot.comparison = repairedSnapshot.comparison;
          snapshot.canvasDelta = repairedSnapshot.canvasDelta;

          const repairLine = `[${new Date().toISOString()}] repair | failed=${[...evaluation.integrityIssues, ...evaluation.visualIssues, ...evaluation.behavioralIssues].join(", ")} | actions=${correctionActions.join("; ")} | recovered=${finalEvaluation.state}`;
          appendWatchdogLog(repairLine);
        }
      }

      if (finalEvaluation.state === "HEALTHY") {
        degradedStreak = 0;
        previousSample = snapshot.canvas;
        previousFrame = snapshot.frame;
      } else if (finalEvaluation.state === "DEGRADED") {
        degradedStreak += 1;
      }

      const escalate = finalEvaluation.state === "FAILED" || degradedStreak >= DEGRADED_STREAK_ESCALATE;
      const focusedDiagnosis = finalEvaluation.state === "DEGRADED"
        ? buildFocusedDiagnosis(finalEvaluation)
        : (finalEvaluation.state === "FAILED" ? "harness integrity failure requires immediate correction" : "none");

      const summary = {
        iteration,
        readinessState: finalEvaluation.state,
        integrityStatus: finalEvaluation.integrityStatus,
        visualStatus: finalEvaluation.visualStatus,
        behavioralStatus: finalEvaluation.behavioralStatus,
        trend: finalEvaluation.trend,
        visualSanity: {
          backgroundMeanLuma: finalEvaluation.metrics.backgroundMeanLuma,
          canvasMeanLuma: finalEvaluation.metrics.canvasMeanLuma,
          canvasStdLuma: finalEvaluation.metrics.canvasStdLuma,
          canvasDelta: finalEvaluation.metrics.canvasDelta
        },
        simulationMotion: {
          frame: finalEvaluation.metrics.frame,
          temporalDelta: finalEvaluation.metrics.temporalDelta,
          activeRatioPercent: finalEvaluation.metrics.activeRatioPercent,
          simWallRatio: finalEvaluation.metrics.simWallRatio,
          simThrottled: finalEvaluation.metrics.simThrottled
        },
        behavioralPlausibility: {
          framePersistence: finalEvaluation.metrics.framePersistence,
          downwardTrend: finalEvaluation.metrics.downwardTrend,
          streakBias: finalEvaluation.metrics.streakBias,
          columnPatternPeak: finalEvaluation.metrics.columnPatternPeak,
          issues: finalEvaluation.behavioralIssues
        },
        comparisonIntegrity: {
          comparisonMode: finalEvaluation.metrics.comparisonMode,
          baselineApproved: finalEvaluation.metrics.baselineApproved,
          issues: [...finalEvaluation.integrityIssues, ...finalEvaluation.visualIssues]
        },
        correctionsApplied: correctionActions,
        corrected,
        degradedStreak,
        escalate,
        focusedDiagnosis
      };

      history.push({
        iteration,
        state: finalEvaluation.state,
        visual: {
          canvasDelta: finalEvaluation.metrics.canvasDelta,
          canvasMeanLuma: finalEvaluation.metrics.canvasMeanLuma,
          canvasStdLuma: finalEvaluation.metrics.canvasStdLuma
        },
        behavioral: {
          activityCentroidY: finalEvaluation.metrics.activityCentroidY,
          framePersistence: finalEvaluation.metrics.framePersistence,
          streakBias: finalEvaluation.metrics.streakBias
        }
      });
      if (history.length > HISTORY_SIZE) {
        history.shift();
      }

      saveCycleArtifacts(iteration, snapshot, summary);
      console.log(JSON.stringify(summary));

      if (escalate) {
        appendWatchdogLog(`[${new Date().toISOString()}] escalate | state=${finalEvaluation.state} | diagnosis=${focusedDiagnosis}`);
        throw new Error(`Watchdog escalation: ${focusedDiagnosis}. Integrity issues: ${finalEvaluation.integrityIssues.join(", ") || "none"}; visual issues: ${finalEvaluation.visualIssues.join(", ") || "none"}; behavioral issues: ${finalEvaluation.behavioralIssues.join(", ") || "none"}`);
      }

      if (MAX_ITERATIONS > 0 && iteration >= MAX_ITERATIONS) {
        return;
      }

      await delay(LOOP_INTERVAL_MS);
    }
  } finally {
    if (browser) {
      await browser.close();
    }
    await stopProcessTree(server.child);
  }
}

main().catch((error) => {
  console.error("Harness watchdog: FAIL");
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
