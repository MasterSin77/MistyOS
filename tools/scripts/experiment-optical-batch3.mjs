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
  name: "stage-c-batch3-optical-structure",
  experiments: [
    {
      parameter: "refractBase",
      baseline: 0.45,
      cases: [
        { label: "low", value: 0.25, query: "expRefractBase=0.25" },
        { label: "current", value: 0.45, query: "expRefractBase=0.45" },
        { label: "high", value: 0.7, query: "expRefractBase=0.70" }
      ]
    },
    {
      parameter: "refractScale",
      baseline: 0.62,
      cases: [
        { label: "low", value: 0.35, query: "expRefractScale=0.35" },
        { label: "current", value: 0.62, query: "expRefractScale=0.62" },
        { label: "high", value: 0.9, query: "expRefractScale=0.90" }
      ]
    },
    {
      parameter: "smoothRaindrop",
      baseline: [0.95, 1.0],
      cases: [
        { label: "low", value: [0.88, 0.98], query: "expSmoothMin=0.88&expSmoothMax=0.98" },
        { label: "current", value: [0.95, 1.0], query: "expSmoothMin=0.95&expSmoothMax=1.00" },
        { label: "high", value: [0.975, 1.0], query: "expSmoothMin=0.975&expSmoothMax=1.00" }
      ]
    },
    {
      parameter: "raindropEraserSize",
      baseline: [0.93, 1.0],
      cases: [
        { label: "low", value: [0.84, 0.96], query: "expEraserMin=0.84&expEraserMax=0.96" },
        { label: "current", value: [0.93, 1.0], query: "expEraserMin=0.93&expEraserMax=1.00" },
        { label: "high", value: [0.97, 1.0], query: "expEraserMin=0.97&expEraserMax=1.00" }
      ]
    },
    {
      parameter: "raindropCompose",
      baseline: "smoother",
      note: "Source exposes only two legal modes. High run repeats current for noise-control consistency.",
      cases: [
        { label: "low", value: "harder", query: "expCompose=harder" },
        { label: "current", value: "smoother", query: "expCompose=smoother" },
        { label: "high", value: "smoother", query: "expCompose=smoother&expComposeRepeat=1" }
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
      // wait for startup
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

function frameStructuralMetrics(sample) {
  const w = sample.gridWidth;
  const h = sample.gridHeight;
  if (w < 3 || h < 3) {
    return {
      streakBias: Number.NaN,
      clusterLocalVariance: Number.NaN,
      spotCoverage: Number.NaN
    };
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
      if (v > threshold) {
        spots += 1;
      }
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

  return {
    streakBias,
    clusterLocalVariance: localVarCount > 0 ? localVarSum / localVarCount : Number.NaN,
    spotCoverage: sample.grid.length > 0 ? spots / sample.grid.length : Number.NaN
  };
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
      return { phase: "running", status, diagnostic, health };
    }

    const initFailure = health.includes("phase=init-failure") || status.includes("fallback mode");
    if (initFailure) {
      return { phase: "init-failure", status, diagnostic, health };
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
  const structural = samples.map((s) => frameStructuralMetrics(s));

  const persistence = [];
  const deltas = [];
  const downward = [];
  for (let i = 0; i + 1 < samples.length; i += 1) {
    const a = samples[i];
    const b = samples[i + 1];
    persistence.push(correlation(a.grid, b.grid));
    deltas.push(deltaMean(a.grid, b.grid));
    downward.push(directionalBias(a.grid, b.grid, a.gridWidth, a.gridHeight));
  }

  const raf = await measureRaf(page);

  return {
    samples: samples.length,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    meanLumaAvg: avg(means),
    stdLumaAvg: avg(stds),
    temporalPersistenceAvg: avg(persistence),
    temporalDeltaAvg: avg(deltas),
    downwardBiasAvg: avg(downward),
    streakBiasAvg: avg(structural.map((s) => s.streakBias)),
    clusterLocalVarianceAvg: avg(structural.map((s) => s.clusterLocalVariance)),
    spotCoverageAvg: avg(structural.map((s) => s.spotCoverage)),
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
          const readyState = await waitForBaselineReady(page);
          if (readyState?.phase === "init-failure") {
            throw new Error(`Baseline failed to initialize for ${key}: ${readyState?.status ?? "unknown"}`);
          }
          const metrics = await captureRun(page, outDir, key);
          const record = {
            parameter: experiment.parameter,
            label: run.label,
            value: run.value,
            query: run.query,
            url,
            experimentNote: experiment.note ?? null,
            runtimePhase: readyState?.phase ?? null,
            runtimeStatus: readyState?.status ?? null,
            runtimeHealth: readyState?.health ?? null,
            metrics
          };
          expRuns.push(record);
          allRuns.push(record);
          fs.writeFileSync(path.join(outDir, `${key}.json`), JSON.stringify(record, null, 2), "utf8");
        } finally {
          await page.close();
        }
      }

      const current = expRuns.find((r) => r.label === "current");
      for (const run of expRuns) {
        run.metricDeltaFromCurrent = current ? {
          meanLumaAvg: metricDelta(run.metrics, current.metrics, "meanLumaAvg"),
          stdLumaAvg: metricDelta(run.metrics, current.metrics, "stdLumaAvg"),
          temporalPersistenceAvg: metricDelta(run.metrics, current.metrics, "temporalPersistenceAvg"),
          temporalDeltaAvg: metricDelta(run.metrics, current.metrics, "temporalDeltaAvg"),
          downwardBiasAvg: metricDelta(run.metrics, current.metrics, "downwardBiasAvg"),
          streakBiasAvg: metricDelta(run.metrics, current.metrics, "streakBiasAvg"),
          clusterLocalVarianceAvg: metricDelta(run.metrics, current.metrics, "clusterLocalVarianceAvg"),
          spotCoverageAvg: metricDelta(run.metrics, current.metrics, "spotCoverageAvg"),
          fpsApprox: metricDelta(run.metrics.renderTiming, current.metrics.renderTiming, "fpsApprox"),
          avgFrameMs: metricDelta(run.metrics.renderTiming, current.metrics.renderTiming, "avgFrameMs")
        } : null;
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
