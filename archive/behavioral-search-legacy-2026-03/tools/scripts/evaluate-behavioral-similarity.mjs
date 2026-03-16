import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { PNG } from "pngjs";

const HOST = "127.0.0.1";
const PORT = 4173;
const BASE_URL = `http://${HOST}:${PORT}`;
const BASELINE_URL = `${BASE_URL}/reference-baseline.html`;
const HARNESS_BASE_URL = `${BASE_URL}/`;
const STARTUP_TIMEOUT_MS = 35000;
const BASELINE_APPROVAL_KEY = "rain-engine-behavioral-reference-approved-v1";
const WINDOW_SECONDS = Number(process.env.EVAL_WINDOW_SECONDS ?? "20");
const SAMPLE_INTERVAL_MS = Number(process.env.EVAL_SAMPLE_INTERVAL_MS ?? "800");
const SEGMENT_COUNT = Math.max(3, Number(process.env.EVAL_SEGMENT_COUNT ?? "4"));
const PRESET = process.env.EVAL_PRESET ?? "night-boulevard";
const PARAM_QUERY = process.env.EVAL_PARAM_QUERY ?? "";
const ARTIFACT_DIR = path.join(process.cwd(), "tools", "logs", "behavioral-eval");

async function stopProcessTree(child) {
  if (!child || child.killed || child.exitCode !== null || child.pid == null) {
    return;
  }

  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", shell: false });
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
      // ignore
    }
  }
}

function startDevServer() {
  const child = spawn("npm", ["run", "dev", "--", `--host=${HOST}`, `--port=${String(PORT)}`, "--strictPort"], {
    cwd: process.cwd(),
    shell: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });

  return { child, logs: () => ({ stdout, stderr }) };
}

async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) return;
    } catch {
      // wait
    }
    await delay(250);
  }
  throw new Error(`Server did not start within ${timeoutMs} ms.`);
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true, channel: "msedge" });
  } catch {
    return await chromium.launch({ headless: true });
  }
}

async function sampleLocator(locator) {
  if ((await locator.count()) === 0) {
    return null;
  }
  const pngBuffer = await locator.screenshot({ type: "png" });
  const png = PNG.sync.read(pngBuffer);
  const { width, height, data } = png;
  const step = 6;

  const grid = [];
  let gridWidth = 0;
  let gridHeight = 0;
  let sum = 0;
  let sumSq = 0;

  for (let y = 0; y < height; y += step) {
    gridWidth = 0;
    for (let x = 0; x < width; x += step) {
      const idx = (y * width + x) * 4;
      const r = data[idx] ?? 0;
      const g = data[idx + 1] ?? 0;
      const b = data[idx + 2] ?? 0;
      const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      grid.push(l);
      sum += l;
      sumSq += l * l;
      gridWidth += 1;
    }
    gridHeight += 1;
  }

  const count = grid.length;
  const mean = count > 0 ? sum / count : 0;
  const variance = count > 0 ? Math.max(0, sumSq / count - mean * mean) : 0;
  return {
    pngBuffer,
    width,
    height,
    grid,
    gridWidth,
    gridHeight,
    mean,
    std: Math.sqrt(variance)
  };
}

function correlation(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return Number.NaN;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  const n = a.length;
  for (let i = 0; i < n; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    sa += av;
    sb += bv;
    saa += av * av;
    sbb += bv * bv;
    sab += av * bv;
  }
  const num = n * sab - sa * sb;
  const den = Math.sqrt(Math.max(0, (n * saa - sa * sa) * (n * sbb - sb * sb)));
  if (den <= 1e-9) return Number.NaN;
  return num / den;
}

function deltaMean(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return Number.NaN;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  }
  return sum / a.length;
}

function directionalBias(prev, next, w, h) {
  if (!prev || !next || prev.length !== next.length || w <= 1 || h <= 2) return Number.NaN;
  const downA = [];
  const downB = [];
  const upA = [];
  const upB = [];
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      downA.push(prev[i]);
      downB.push(next[i + w]);
      upA.push(prev[i]);
      upB.push(next[i - w]);
    }
  }
  const cDown = correlation(downA, downB);
  const cUp = correlation(upA, upB);
  if (!Number.isFinite(cDown) || !Number.isFinite(cUp)) return Number.NaN;
  return cDown - cUp;
}

function frameDirectionalStructure(sample) {
  const w = sample.gridWidth;
  const h = sample.gridHeight;
  if (w < 2 || h < 2) {
    return { streakBias: Number.NaN, clusterLocalVariance: Number.NaN, spotCoverage: Number.NaN };
  }

  let vdiff = 0;
  let hdiff = 0;
  let vc = 0;
  let hc = 0;
  let localVarSum = 0;
  let localVarCount = 0;
  const threshold = sample.mean + sample.std * 0.9;
  let spots = 0;

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      const v = sample.grid[i] ?? 0;
      if (v > threshold) spots += 1;
      if (y + 1 < h) {
        vdiff += Math.abs(v - (sample.grid[i + w] ?? 0));
        vc += 1;
      }
      if (x + 1 < w) {
        hdiff += Math.abs(v - (sample.grid[i + 1] ?? 0));
        hc += 1;
      }

      if (x > 0 && y > 0 && x + 1 < w && y + 1 < h) {
        const n0 = sample.grid[i] ?? 0;
        const n1 = sample.grid[i - 1] ?? 0;
        const n2 = sample.grid[i + 1] ?? 0;
        const n3 = sample.grid[i - w] ?? 0;
        const n4 = sample.grid[i + w] ?? 0;
        const m = (n0 + n1 + n2 + n3 + n4) / 5;
        const lv = ((n0 - m) ** 2 + (n1 - m) ** 2 + (n2 - m) ** 2 + (n3 - m) ** 2 + (n4 - m) ** 2) / 5;
        localVarSum += lv;
        localVarCount += 1;
      }
    }
  }

  const vMean = vc > 0 ? vdiff / vc : Number.NaN;
  const hMean = hc > 0 ? hdiff / hc : Number.NaN;
  const streakBias = Number.isFinite(vMean) && Number.isFinite(hMean) ? (hMean - vMean) : Number.NaN;
  const clusterLocalVariance = localVarCount > 0 ? localVarSum / localVarCount : Number.NaN;
  const spotCoverage = sample.grid.length > 0 ? spots / sample.grid.length : Number.NaN;
  return { streakBias, clusterLocalVariance, spotCoverage };
}

function aggregateMetrics(sequence) {
  if (!Array.isArray(sequence) || sequence.length < 3) {
    throw new Error("Need at least 3 samples for behavioral metric aggregation.");
  }

  const persist = [];
  const deltas = [];
  const downBias = [];
  const streakBiases = [];
  const clusterVars = [];
  const spotCoverage = [];
  const stds = [];

  for (let i = 0; i < sequence.length; i += 1) {
    const s = sequence[i];
    stds.push(s.std);
    const structural = frameDirectionalStructure(s);
    if (Number.isFinite(structural.streakBias)) streakBiases.push(structural.streakBias);
    if (Number.isFinite(structural.clusterLocalVariance)) clusterVars.push(structural.clusterLocalVariance);
    if (Number.isFinite(structural.spotCoverage)) spotCoverage.push(structural.spotCoverage);

    if (i + 1 < sequence.length) {
      const n = sequence[i + 1];
      const corr = correlation(s.grid, n.grid);
      const d = deltaMean(s.grid, n.grid);
      const bias = directionalBias(s.grid, n.grid, s.gridWidth, s.gridHeight);
      if (Number.isFinite(corr)) persist.push(corr);
      if (Number.isFinite(d)) deltas.push(d);
      if (Number.isFinite(bias)) downBias.push(bias);
    }
  }

  const mean = (arr) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : Number.NaN;
  return {
    framePersistence: mean(persist),
    temporalVariance: mean(deltas),
    downwardBias: mean(downBias),
    streakTendency: mean(streakBiases),
    clustering: mean(clusterVars),
    spotCoverage: mean(spotCoverage),
    spatialStd: mean(stds)
  };
}

function closeness(candidate, baseline, floorScale = 0.02) {
  if (!Number.isFinite(candidate) || !Number.isFinite(baseline)) return 0;
  const scale = Math.max(floorScale, Math.abs(baseline) * 0.5);
  return Math.max(0, 1 - Math.abs(candidate - baseline) / scale);
}

function computeSimilarityScore(candidate, baseline) {
  const weights = {
    downwardBias: 0.24,
    streakTendency: 0.20,
    framePersistence: 0.18,
    clustering: 0.14,
    temporalVariance: 0.14,
    spatialStd: 0.10
  };

  const components = {
    downwardBias: closeness(candidate.downwardBias, baseline.downwardBias, 0.01),
    streakTendency: closeness(candidate.streakTendency, baseline.streakTendency, 0.01),
    framePersistence: closeness(candidate.framePersistence, baseline.framePersistence, 0.03),
    clustering: closeness(candidate.clustering, baseline.clustering, 0.0005),
    temporalVariance: closeness(candidate.temporalVariance, baseline.temporalVariance, 0.001),
    spatialStd: closeness(candidate.spatialStd, baseline.spatialStd, 0.01)
  };

  let total = 0;
  for (const [key, weight] of Object.entries(weights)) {
    total += (components[key] ?? 0) * weight;
  }

  // Penalize obvious non-rain artifacts.
  let penalties = 0;
  if (candidate.spotCoverage > 0.65) penalties += 0.08;
  if (candidate.spatialStd < 0.03) penalties += 0.08;
  if (candidate.temporalVariance < 0.0005) penalties += 0.08;

  return {
    score: Math.max(0, Math.min(1, total - penalties)),
    components,
    penalties
  };
}

function splitIntoSegments(sequence, segmentCount) {
  const count = Math.max(1, Math.min(segmentCount, sequence.length));
  const segments = [];
  for (let i = 0; i < count; i += 1) {
    const start = Math.floor((i * sequence.length) / count);
    const end = Math.floor(((i + 1) * sequence.length) / count);
    const frames = sequence.slice(start, end);
    if (frames.length >= 3) {
      segments.push({
        index: i,
        startFrame: start,
        endFrameExclusive: end,
        frameCount: frames.length,
        metrics: aggregateMetrics(frames)
      });
    }
  }
  return segments;
}

function assessRunValidity(segments, baselineMetrics) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return {
      valid: false,
      penalty: 0.6,
      stalledSegmentCount: 0,
      stalledFraction: 1,
      burstThenFreeze: false,
      reasons: ["insufficient segmented samples"],
      segments: []
    };
  }

  const evalSegments = segments.slice(1);
  const candidateSegments = evalSegments.length > 0 ? evalSegments : segments;
  const baselineTemporal = Number.isFinite(baselineMetrics?.temporalVariance)
    ? baselineMetrics.temporalVariance
    : 0.0015;
  const lowTemporalThreshold = Math.max(0.00065, baselineTemporal * 0.30);
  const highPersistenceThreshold = 0.995;
  const highCoverageThreshold = 0.24;
  const lowStdThreshold = 0.055;

  const evaluatedSegments = candidateSegments.map((segment) => {
    const m = segment.metrics;
    const lowTemporal = Number.isFinite(m.temporalVariance) && m.temporalVariance < lowTemporalThreshold;
    const highPersistence = Number.isFinite(m.framePersistence) && m.framePersistence > highPersistenceThreshold;
    const highCoverage = Number.isFinite(m.spotCoverage) && m.spotCoverage > highCoverageThreshold;
    const lowStd = Number.isFinite(m.spatialStd) && m.spatialStd < lowStdThreshold;
    const stalled = (lowTemporal && highPersistence) || (highCoverage && lowStd && highPersistence);
    return {
      ...segment,
      checks: {
        lowTemporal,
        highPersistence,
        highCoverage,
        lowStd,
        stalled
      }
    };
  });

  const stalledSegments = evaluatedSegments.filter((segment) => segment.checks.stalled);
  const stalledFraction = evaluatedSegments.length > 0 ? stalledSegments.length / evaluatedSegments.length : 1;

  const firstTemporal = segments[0]?.metrics?.temporalVariance;
  const laterTemporal = evaluatedSegments
    .map((segment) => segment.metrics.temporalVariance)
    .filter((value) => Number.isFinite(value));
  const laterTemporalMean = laterTemporal.length > 0
    ? laterTemporal.reduce((sum, value) => sum + value, 0) / laterTemporal.length
    : Number.NaN;

  const burstThenFreeze = Number.isFinite(firstTemporal)
    && Number.isFinite(laterTemporalMean)
    && firstTemporal > laterTemporalMean * 2.4
    && stalledFraction >= 0.5;

  const persistentCoverageFreeze = evaluatedSegments.some((segment) => {
    const m = segment.metrics;
    return Number.isFinite(m.spotCoverage)
      && Number.isFinite(m.framePersistence)
      && Number.isFinite(m.temporalVariance)
      && m.spotCoverage > 0.30
      && m.framePersistence > 0.993
      && m.temporalVariance < lowTemporalThreshold;
  });

  const reasons = [];
  if (stalledFraction >= 0.5) reasons.push("long low-motion plateau across evaluation segments");
  if (burstThenFreeze) reasons.push("burst-then-freeze temporal profile detected");
  if (persistentCoverageFreeze) reasons.push("high-coverage persistence with weak temporal change");

  const valid = reasons.length === 0;
  let penalty = 0;
  if (!valid) {
    penalty = Math.min(0.75, stalledFraction * 0.45 + (burstThenFreeze ? 0.22 : 0) + (persistentCoverageFreeze ? 0.20 : 0));
  }

  return {
    valid,
    penalty,
    stalledSegmentCount: stalledSegments.length,
    stalledFraction,
    burstThenFreeze,
    reasons,
    segments: evaluatedSegments
  };
}

async function captureSequence(page, locatorSelector, durationSeconds, intervalMs) {
  const frames = [];
  const startedAt = Date.now();
  while (Date.now() - startedAt < durationSeconds * 1000) {
    const sample = await sampleLocator(page.locator(locatorSelector));
    if (sample) {
      frames.push(sample);
    }
    await delay(intervalMs);
  }
  return frames;
}

async function captureBaselineAndInactiveHarnessSequence(
  baselinePage,
  harnessPage,
  baselineSelector,
  harnessSelector,
  durationSeconds,
  intervalMs
) {
  const baselineFrames = [];
  const inactiveHarnessFrames = [];
  const startedAt = Date.now();

  while (Date.now() - startedAt < durationSeconds * 1000) {
    await baselinePage.bringToFront();
    const [baselineSample, inactiveHarnessSample] = await Promise.all([
      sampleLocator(baselinePage.locator(baselineSelector)),
      sampleLocator(harnessPage.locator(harnessSelector))
    ]);

    if (baselineSample) {
      baselineFrames.push(baselineSample);
    }
    if (inactiveHarnessSample) {
      inactiveHarnessFrames.push(inactiveHarnessSample);
    }

    await delay(intervalMs);
  }

  return {
    baselineFrames,
    inactiveHarnessFrames
  };
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

async function readHarnessTimingIntegrity(page) {
  const comparisonLine = (await page.locator("#harness-comparison-line").textContent())?.trim() ?? "";
  return {
    simWallRatio: parseNumberField(comparisonLine, "simWallRatio"),
    simThrottled: parseBooleanField(comparisonLine, "simThrottled"),
    simWallMs: parseNumberField(comparisonLine, "simWallMs"),
    simTimeMs: parseNumberField(comparisonLine, "simTimeMs")
  };
}

function buildHarnessUrl() {
  if (!PARAM_QUERY) {
    return HARNESS_BASE_URL;
  }
  const query = PARAM_QUERY.startsWith("?") ? PARAM_QUERY.slice(1) : PARAM_QUERY;
  return `${HARNESS_BASE_URL}?${query}`;
}

function parseWatchdogClassificationFromOutput(rawText) {
  const lines = rawText.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith("{")) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.readinessState) {
          return parsed.readinessState;
        }
      } catch {
        // continue
      }
    }
  }
  return "UNKNOWN";
}

async function runWatchdogOneShot() {
  return await new Promise((resolve) => {
    const child = spawn("npm", ["run", "watchdog:harness:probe"], {
      cwd: process.cwd(),
      shell: true,
      env: {
        ...process.env,
        WATCHDOG_ITERATIONS: "1",
        WATCHDOG_PORT: "4174",
        WATCHDOG_PARAM_QUERY: PARAM_QUERY
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let output = "";
    child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { output += chunk.toString(); });
    child.on("exit", () => {
      resolve(parseWatchdogClassificationFromOutput(output));
    });
  });
}

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  const server = startDevServer();
  let browser;

  try {
    await waitForServer(BASE_URL, STARTUP_TIMEOUT_MS);

    browser = await launchBrowser();
    const context = await browser.newContext();
    await context.addInitScript(({ key }) => {
      window.localStorage.setItem(key, "true");
    }, { key: BASELINE_APPROVAL_KEY });

    const baselinePage = await context.newPage();
    await baselinePage.goto(BASELINE_URL, { waitUntil: "domcontentloaded", timeout: STARTUP_TIMEOUT_MS });
    const harnessPage = await context.newPage();
    await harnessPage.goto(buildHarnessUrl(), { waitUntil: "domcontentloaded", timeout: STARTUP_TIMEOUT_MS });

    const { baselineFrames: baselineSequence, inactiveHarnessFrames } = await captureBaselineAndInactiveHarnessSequence(
      baselinePage,
      harnessPage,
      "#reference-root canvas",
      "#harness-candidate-canvas",
      WINDOW_SECONDS,
      SAMPLE_INTERVAL_MS
    );

    await harnessPage.bringToFront();
    const candidateSequence = await captureSequence(harnessPage, "#harness-candidate-canvas", WINDOW_SECONDS, SAMPLE_INTERVAL_MS);

    const baselineMetrics = aggregateMetrics(baselineSequence);
    const candidateMetrics = aggregateMetrics(candidateSequence);
    const inactiveWindowMetrics = inactiveHarnessFrames.length >= 3
      ? aggregateMetrics(inactiveHarnessFrames)
      : null;
    const rawSimilarity = computeSimilarityScore(candidateMetrics, baselineMetrics);
    const segmentMetrics = splitIntoSegments(candidateSequence, SEGMENT_COUNT);
    const runValidity = assessRunValidity(segmentMetrics, baselineMetrics);
    const similarity = {
      ...rawSimilarity,
      rawScore: rawSimilarity.score,
      validityPenalty: runValidity.penalty,
      score: Math.max(0, rawSimilarity.score - runValidity.penalty)
    };
    const timingIntegrity = await readHarnessTimingIntegrity(harnessPage);
    const watchdogClassification = await runWatchdogOneShot();

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const result = {
      generatedAt: new Date().toISOString(),
      windowSeconds: WINDOW_SECONDS,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      preset: PRESET,
      params: PARAM_QUERY,
      frameCounts: {
        baseline: baselineSequence.length,
        candidate: candidateSequence.length,
        inactiveHarness: inactiveHarnessFrames.length
      },
      watchdogClassification,
      timingIntegrity,
      runValidity,
      inactiveWindowMetrics,
      baselineMetrics,
      candidateMetrics,
      similarity
    };

    fs.writeFileSync(path.join(ARTIFACT_DIR, `eval-${timestamp}.json`), JSON.stringify(result, null, 2), "utf8");

    if (baselineSequence[0]?.pngBuffer) {
      fs.writeFileSync(path.join(ARTIFACT_DIR, `baseline-sample-${timestamp}.png`), baselineSequence[0].pngBuffer);
    }
    if (candidateSequence[0]?.pngBuffer) {
      fs.writeFileSync(path.join(ARTIFACT_DIR, `candidate-sample-${timestamp}.png`), candidateSequence[0].pngBuffer);
    }

    console.log(JSON.stringify(result));
  } finally {
    if (browser) {
      await browser.close();
    }
    await stopProcessTree(server.child);
  }
}

main().catch((error) => {
  console.error("Behavioral evaluator: FAIL");
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
