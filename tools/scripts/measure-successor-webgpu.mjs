import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const url = process.env.MEASURE_URL || "http://127.0.0.1:5176/";
const targetFrame = Number.parseInt(process.env.MEASURE_TARGET_FRAME || "1200", 10);
const outputPath = process.env.MEASURE_OUTPUT_PATH || path.join(process.cwd(), "artifacts", "phase6", "successor-webgpu-perf-2026-03-15.json");

function parseTimingFromMotion(text) {
  const dominant = text.match(/timing\(dominant\):\s*(deposition|decay|render)\s*\(([^)]+)%\)/i);
  const frame = text.match(/frame:\s*(\d+)/);
  const timing4 = text.match(/timing\(frame\/dep\/decay\/render\):\s*([0-9.]+)\s*\/\s*([0-9.]+)\s*\/\s*([0-9.]+)\s*\/\s*([0-9.]+)\s*ms/i);
  const timingP = text.match(/timing\(p95\/min\/max\/spread\):\s*([0-9.]+)\s*\/\s*([0-9.]+)\s*\/\s*([0-9.]+)\s*\/\s*([0-9.]+)\s*ms/i);
  const smoothed = text.match(/timing\(smoothed frame\):\s*([0-9.]+)\s*ms/i);

  return {
    frame: frame ? Number(frame[1]) : null,
    totalFrameMs: timing4 ? Number(timing4[1]) : null,
    depositionMs: timing4 ? Number(timing4[2]) : null,
    decayMs: timing4 ? Number(timing4[3]) : null,
    renderMs: timing4 ? Number(timing4[4]) : null,
    smoothedTotalFrameMs: smoothed ? Number(smoothed[1]) : null,
    totalFrameP95Ms: timingP ? Number(timingP[1]) : null,
    totalFrameMinMs: timingP ? Number(timingP[2]) : null,
    totalFrameMaxMs: timingP ? Number(timingP[3]) : null,
    stabilitySpreadMs: timingP ? Number(timingP[4]) : null,
    dominantPass: dominant ? dominant[1].toLowerCase() : null,
    dominantShare: dominant ? Number(dominant[2]) / 100 : null
  };
}

async function runMeasurement() {
  const browser = await chromium.launch({
    headless: false,
    channel: "chrome",
    args: ["--enable-unsafe-webgpu"]
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 980 } });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.evaluate(() => localStorage.setItem("rain-engine-behavioral-reference-approved-v1", "true"));

    // Keep existing app entrypoint unchanged; only bootstrap runtime harness in-page for this measurement pass.
    await page.evaluate(async () => {
      document.body.innerHTML = '<div id="app"></div>';
      const mod = await import("/src/runtime-entry.ts");
      await mod.bootstrapApplication();
    });

    await page.waitForSelector("#harness-motion-line", { timeout: 120000 });

    const startedAt = Date.now();
    let frame = 0;
    while (frame < targetFrame) {
      const text = await page.locator("#harness-motion-line").innerText();
      const match = text.match(/frame:\s*(\d+)/);
      frame = match ? Number(match[1]) : 0;
      if (Date.now() - startedAt > 420000) {
        throw new Error(`Timeout waiting for target frame. Last frame=${frame}`);
      }
      await page.waitForTimeout(250);
    }

    const status = await page.locator("#harness-status-line").innerText();
    const comparisonLine = await page.locator("#harness-comparison-line").innerText();
    const motionLine = await page.locator("#harness-motion-line").innerText();

    const adapter = await page.evaluate(async () => {
      if (!navigator.gpu) {
        return { gpu: false };
      }
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        return { gpu: true, adapter: false };
      }
      const info = adapter.info || {};
      return {
        gpu: true,
        adapter: true,
        vendor: info.vendor || null,
        architecture: info.architecture || null,
        device: info.device || null,
        description: info.description || null,
        isFallbackAdapter: adapter.isFallbackAdapter ?? null,
        features: [...adapter.features]
      };
    });

    const timing = parseTimingFromMotion(motionLine);
    const payload = {
      collectedAt: new Date().toISOString(),
      url,
      harnessBoot: "runtime-entry bootstrapped from index session for measurement only",
      scenario: {
        id: "baseline-seed-001",
        resolution: { width: 1600, height: 900 },
        fixedDeltaMs: 16.6667,
        seed: 1337,
        renderMode: "comparison",
        preset: "night-boulevard"
      },
      sampleWindow: {
        targetFrame,
        finalFrame: timing.frame ?? frame
      },
      adapter,
      timingCheckpoint: timing,
      raw: {
        status,
        comparisonLine,
        motionLine
      }
    };

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));

    console.log(JSON.stringify({ outputPath, adapter, timing, finalFrame: payload.sampleWindow.finalFrame }, null, 2));
  } finally {
    await browser.close();
  }
}

runMeasurement().catch((error) => {
  console.error(error);
  process.exit(1);
});
