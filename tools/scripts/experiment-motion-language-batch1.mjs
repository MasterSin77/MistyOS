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
const STARTUP_TIMEOUT_MS = 70000;
const SAMPLE_INTERVAL_MS = 800;
const SAMPLE_COUNT = 12;
const WARMUP_MS = 4000;
const ARTIFACT_BASE = path.join(process.cwd(), "tools", "logs", "behavioral-exp");

const batch = {
  name: "stage-c-batch1-motion-language",
  experiments: [
    {
      parameter: "slipRate",
      baseline: 0.74,
      cases: [
        { label: "low", value: 0.55, query: "expSlipRate=0.55" },
        { label: "current", value: 0.74, query: "expSlipRate=0.74" },
        { label: "high", value: 0.9, query: "expSlipRate=0.90" }
      ]
    },
    {
      parameter: "motionInterval",
      baseline: [0.12, 0.28],
      cases: [
        { label: "low", value: [0.06, 0.14], query: "expMotionMin=0.06&expMotionMax=0.14" },
        { label: "current", value: [0.12, 0.28], query: "expMotionMin=0.12&expMotionMax=0.28" },
        { label: "high", value: [0.2, 0.45], query: "expMotionMin=0.20&expMotionMax=0.45" }
      ]
    },
    {
      parameter: "gravity",
      baseline: 2400,
      cases: [
        { label: "low", value: 1800, query: "expGravity=1800" },
        { label: "current", value: 2400, query: "expGravity=2400" },
        { label: "high", value: 3000, query: "expGravity=3000" }
      ]
    }
  ]
};

function isoTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function startDevServer() {
  const child = spawn("npx", ["vite", "--host", HOST, "--port", String(PORT), "--strictPort"], {
    cwd: process.cwd(),
    shell: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

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
      // ignore
    }
  }
}

async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) {
        return;
      }
    } catch {
      // Wait for startup.
    }
    await delay(250);
  }
  throw new Error(`Server did not become ready within ${timeoutMs} ms.`);
}

async function launchBrowser() {
  try {
    return await chromium.launch({
      headless: true,
      channel: "msedge",
      args: ["--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"]
    });
  } catch {
    return await chromium.launch({
      headless: true,
      args: ["--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"]
    });
  }
}

function correlation(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) {
    return Number.NaN;
  }
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
  if (den <= 1e-9) {
    return Number.NaN;
  }
  return num / den;
}

function deltaMean(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) {
    return Number.NaN;
  }
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  }
  return sum / a.length;
}

function directionalBias(prev, next, w, h) {
  if (!prev || !next || prev.length !== next.length || w <= 1 || h <= 2) {
    return Number.NaN;
  }
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
  if (!Number.isFinite(cDown) || !Number.isFinite(cUp)) {
    return Number.NaN;
  }
  return cDown - cUp;
}

function avg(values) {
  const valid = values.filter((v) => Number.isFinite(v));
  if (valid.length === 0) {
    return Number.NaN;
  }
  return valid.reduce((acc, v) => acc + v, 0) / valid.length;
}

async function sampleCanvas(page, selector) {
  const target = page.locator(selector);
  if ((await target.count()) === 0) {
    return null;
  }
  const pngBuffer = await target.screenshot({ type: "png" });
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
    grid,
    gridWidth,
    gridHeight,
    mean,
    std: Math.sqrt(variance)
  };
}

async function waitForBaselineReady(page) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = (await page.locator("#status-line").textContent())?.trim() ?? "";
    const diagnostic = (await page.locator("#diagnostic-line").textContent())?.trim() ?? "";
    const health = (await page.locator("#health-line").textContent())?.trim() ?? "";

    const running = health.includes("phase=running") && diagnostic.includes("rainMounted=true");
    if (running) {
      return {
        phase: "running",
        status,
        diagnostic,
        health
      };
    }

    const initFailure = health.includes("phase=init-failure") || status.includes("fallback mode");
    if (initFailure) {
      return {
        phase: "init-failure",
        status,
        diagnostic,
        health
      };
    }

    await delay(250);
  }

  throw new Error("Timed out waiting for baseline runtime readiness.");
}

async function measureRaf(page, durationMs = 2800) {
  return await page.evaluate(async ({ runMs }) => {
    const intervals = [];
    let prev = performance.now();
    const start = prev;

    await new Promise((resolve) => {
      const tick = (now) => {
        intervals.push(now - prev);
        prev = now;
        if (now - start >= runMs) {
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    intervals.sort((a, b) => a - b);
    const avg = intervals.length > 0 ? intervals.reduce((acc, v) => acc + v, 0) / intervals.length : NaN;
    const idx95 = intervals.length > 0 ? Math.min(intervals.length - 1, Math.floor(intervals.length * 0.95)) : 0;
    const p95 = intervals.length > 0 ? intervals[idx95] : NaN;
    const fpsApprox = Number.isFinite(avg) && avg > 0 ? 1000 / avg : NaN;

    return {
      samples: intervals.length,
      avgFrameMs: avg,
      p95FrameMs: p95,
      fpsApprox
    };
  }, { runMs: durationMs });
}

async function captureRun(page, outputDir, label) {
  await delay(WARMUP_MS);

  const samples = [];
  for (let i = 0; i < SAMPLE_COUNT; i += 1) {
    const sample = await sampleCanvas(page, "canvas");
    if (sample) {
      samples.push(sample);
    }
    await delay(SAMPLE_INTERVAL_MS);
  }

  if (samples.length < 3) {
    throw new Error(`Insufficient samples for ${label}.`);
  }

  const screenshotIndices = [0, Math.floor(samples.length / 2), samples.length - 1];
  const screenshots = [];
  for (const idx of screenshotIndices) {
    const name = `${label}-frame-${String(idx).padStart(2, "0")}.png`;
    const relPath = path.join("screens", name);
    const fullPath = path.join(outputDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, samples[idx].pngBuffer);
    screenshots.push(relPath.replace(/\\/g, "/"));
  }

  const means = samples.map((s) => s.mean);
  const stds = samples.map((s) => s.std);
  const persistence = [];
  const deltas = [];
  const directional = [];

  for (let i = 0; i + 1 < samples.length; i += 1) {
    const a = samples[i];
    const b = samples[i + 1];
    persistence.push(correlation(a.grid, b.grid));
    deltas.push(deltaMean(a.grid, b.grid));
    directional.push(directionalBias(a.grid, b.grid, a.gridWidth, a.gridHeight));
  }

  const raf = await measureRaf(page);

  return {
    samples: samples.length,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    meanLumaAvg: avg(means),
    stdLumaAvg: avg(stds),
    temporalPersistenceAvg: avg(persistence),
    temporalDeltaAvg: avg(deltas),
    downwardBiasAvg: avg(directional),
    renderTiming: raf,
    screenshots
  };
}

function metricDelta(runMetrics, currentMetrics, key) {
  const a = runMetrics?.[key];
  const b = currentMetrics?.[key];
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return Number.NaN;
  }
  return a - b;
}

async function main() {
  const ts = isoTimestamp();
  const outDir = path.join(ARTIFACT_BASE, `${batch.name}-${ts}`);
  fs.mkdirSync(outDir, { recursive: true });

  const server = startDevServer();
  let browser = null;

  try {
    await waitForServer(BASE_URL, STARTUP_TIMEOUT_MS);

    browser = await launchBrowser();
    const context = await browser.newContext();

    const allRuns = [];

    for (const experiment of batch.experiments) {
      const expRuns = [];

      for (const run of experiment.cases) {
        const url = `${BASELINE_URL}?${run.query}`;
        const key = `${experiment.parameter}-${run.label}`;
        const page = await context.newPage();
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: STARTUP_TIMEOUT_MS });
          const readyReport = await waitForBaselineReady(page);
          if (readyReport?.phase === "init-failure") {
            throw new Error(`Baseline failed to initialize for ${key}: ${readyReport?.status ?? "unknown status"} | ${readyReport?.health ?? "unknown health"}`);
          }
          const metrics = await captureRun(page, outDir, key);

          const record = {
            parameter: experiment.parameter,
            label: run.label,
            value: run.value,
            query: run.query,
            url,
            runtimePhase: readyReport?.phase ?? null,
            metrics
          };
          expRuns.push(record);
          allRuns.push(record);

          fs.writeFileSync(
            path.join(outDir, `${key}.json`),
            JSON.stringify(record, null, 2),
            "utf8"
          );
        } finally {
          await page.close();
        }
      }

      const current = expRuns.find((r) => r.label === "current");
      for (const run of expRuns) {
        run.metricDeltaFromCurrent = current
          ? {
              temporalPersistenceAvg: metricDelta(run.metrics, current.metrics, "temporalPersistenceAvg"),
              temporalDeltaAvg: metricDelta(run.metrics, current.metrics, "temporalDeltaAvg"),
              downwardBiasAvg: metricDelta(run.metrics, current.metrics, "downwardBiasAvg"),
              stdLumaAvg: metricDelta(run.metrics, current.metrics, "stdLumaAvg"),
              fpsApprox: metricDelta(run.metrics.renderTiming, current.metrics.renderTiming, "fpsApprox"),
              avgFrameMs: metricDelta(run.metrics.renderTiming, current.metrics.renderTiming, "avgFrameMs")
            }
          : null;
      }
    }

    const summary = {
      generatedAt: new Date().toISOString(),
      batchName: batch.name,
      outputDir: outDir,
      baselineUrl: BASELINE_URL,
      runs: allRuns
    };

    fs.writeFileSync(path.join(outDir, "batch-summary.json"), JSON.stringify(summary, null, 2), "utf8");

    console.log(JSON.stringify({ ok: true, outputDir: outDir }, null, 2));
  } finally {
    if (browser) {
      await browser.close();
    }
    await stopProcessTree(server.child);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
