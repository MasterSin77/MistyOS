import { spawn } from "node:child_process";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { PNG } from "pngjs";

const HOST = "127.0.0.1";
const PORT = 4173;
const BASE_URL = `http://${HOST}:${PORT}`;
const HARNESS_URL = `${BASE_URL}/`;
const STARTUP_TIMEOUT_MS = 18000;
const BLACK_FRAME_FAIL_STREAK = 3;
const STATIC_FRAME_FAIL_STREAK = 4;
const BASELINE_APPROVAL_KEY = "rain-engine-behavioral-reference-approved-v1";

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
  let count = 0;
  let sum = 0;
  let sumSq = 0;
  let hash = 0x811c9dc5;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const idx = (y * width + x) * 4;
      const r = data[idx] ?? 0;
      const g = data[idx + 1] ?? 0;
      const b = data[idx + 2] ?? 0;
      const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      grid.push(luma);
      sum += luma;
      sumSq += luma * luma;
      count += 1;

      hash ^= r;
      hash = Math.imul(hash, 0x01000193);
      hash ^= g;
      hash = Math.imul(hash, 0x01000193);
      hash ^= b;
      hash = Math.imul(hash, 0x01000193);
    }
  }

  const meanLuma = count > 0 ? sum / count : 0;
  const variance = count > 0 ? Math.max(0, sumSq / count - meanLuma * meanLuma) : 0;
  return {
    width,
    height,
    meanLuma,
    stdLuma: Math.sqrt(variance),
    hash: (hash >>> 0).toString(16).padStart(8, "0"),
    grid
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

    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let baselineMotionFrame = Number.NaN;
    let blackFrameStreak = 0;
    let staticFrameStreak = 0;
    let snapshot = {
      status: null,
      comparison: null,
      motion: null,
      report: null,
      canvas: null,
      canvasDelta: Number.NaN
    };

    while (Date.now() < deadline) {
      const sampleA = await sampleCanvas(page);
      const motionA = await textContent(page, "#harness-motion-line");
      const frameA = parseFrameNumber(motionA);
      await delay(700);
      const sampleB = await sampleCanvas(page);
      const motionB = await textContent(page, "#harness-motion-line");
      const frameB = parseFrameNumber(motionB);

      if (!Number.isFinite(baselineMotionFrame) && Number.isFinite(frameA)) {
        baselineMotionFrame = frameA;
      }

      const canvasDelta = gridDelta(sampleA, sampleB);

      snapshot = {
        status: await textContent(page, "#harness-status-line"),
        comparison: await textContent(page, "#harness-comparison-line"),
        motion: motionB,
        report: await textContent(page, "pre"),
        canvas: sampleB,
        canvasDelta
      };

      const baselineApproved = /Baseline approved:\s*yes/i.test(snapshot.status ?? "");
      const comparisonMode = /renderMode=comparison/i.test(snapshot.comparison ?? "");
      const backgroundApplied = parseBooleanField(snapshot.comparison, "backgroundApplied");
      const baselineGate = parseBooleanField(snapshot.comparison, "baselineApprovalGate");
      const meanLuma = parseNumberField(snapshot.comparison, "backgroundMeanLuma");
      const renderViewComparison = /View:\s*comparison/i.test(snapshot.status ?? "");
      const hasMotionClassification = /classification:\s*(structured-motion|low-motion|dry)/i.test(snapshot.motion ?? "");
      const hasNoSampleStall = !(snapshot.motion ?? "").includes("No motion sample available yet");
      const hasMotionError = /classification:\s*unavailable/i.test(snapshot.motion ?? "");

      const canvasMeanLuma = snapshot.canvas?.meanLuma ?? Number.NaN;
      const canvasStdLuma = snapshot.canvas?.stdLuma ?? Number.NaN;
      const canvasNotBlack = Number.isFinite(canvasMeanLuma) && canvasMeanLuma > 0.05;
      const canvasNonUniform = Number.isFinite(canvasStdLuma) && canvasStdLuma > 0.01;
      const evolvingCanvas = Number.isFinite(canvasDelta) && canvasDelta > 0.0002;
      const frameAdvancing = Number.isFinite(frameA) && Number.isFinite(frameB) && frameB > frameA;
      const longFrameAdvance = Number.isFinite(baselineMotionFrame) && Number.isFinite(frameB) && frameB - baselineMotionFrame > 8;

      if (comparisonMode && backgroundApplied && canvasMeanLuma < 0.01) {
        blackFrameStreak += 1;
      } else {
        blackFrameStreak = 0;
      }

      if (frameAdvancing && Number.isFinite(canvasDelta) && canvasDelta <= 0.00002) {
        staticFrameStreak += 1;
      } else {
        staticFrameStreak = 0;
      }

      if (blackFrameStreak >= BLACK_FRAME_FAIL_STREAK) {
        const compactSnapshot = {
          ...snapshot,
          canvas: snapshot.canvas
            ? {
              width: snapshot.canvas.width,
              height: snapshot.canvas.height,
              meanLuma: snapshot.canvas.meanLuma,
              stdLuma: snapshot.canvas.stdLuma,
              hash: snapshot.canvas.hash
            }
            : null
        };
        throw new Error(`Fail-fast: comparison canvas is effectively black for ${blackFrameStreak} consecutive samples. Snapshot: ${JSON.stringify(compactSnapshot, null, 2)}`);
      }

      if (staticFrameStreak >= STATIC_FRAME_FAIL_STREAK) {
        const compactSnapshot = {
          ...snapshot,
          canvas: snapshot.canvas
            ? {
              width: snapshot.canvas.width,
              height: snapshot.canvas.height,
              meanLuma: snapshot.canvas.meanLuma,
              stdLuma: snapshot.canvas.stdLuma,
              hash: snapshot.canvas.hash
            }
            : null
        };
        throw new Error(`Fail-fast: canvas appears static while frame telemetry advances (${staticFrameStreak} consecutive samples). Snapshot: ${JSON.stringify(compactSnapshot, null, 2)}`);
      }

      if (hasMotionError) {
        const compactSnapshot = {
          ...snapshot,
          canvas: snapshot.canvas
            ? {
              width: snapshot.canvas.width,
              height: snapshot.canvas.height,
              meanLuma: snapshot.canvas.meanLuma,
              stdLuma: snapshot.canvas.stdLuma,
              hash: snapshot.canvas.hash
            }
            : null
        };
        throw new Error(`Harness motion telemetry unavailable. Snapshot: ${JSON.stringify(compactSnapshot, null, 2)}`);
      }

      if (
        baselineApproved &&
        renderViewComparison &&
        comparisonMode &&
        backgroundApplied &&
        baselineGate &&
        Number.isFinite(meanLuma) &&
        meanLuma > 0.02 &&
        hasMotionClassification &&
        hasNoSampleStall &&
        canvasNotBlack &&
        canvasNonUniform &&
        evolvingCanvas &&
        frameAdvancing &&
        longFrameAdvance
      ) {
        const compactSnapshot = {
          ...snapshot,
          canvas: snapshot.canvas
            ? {
              width: snapshot.canvas.width,
              height: snapshot.canvas.height,
              meanLuma: snapshot.canvas.meanLuma,
              stdLuma: snapshot.canvas.stdLuma,
              hash: snapshot.canvas.hash
            }
            : null
        };
        console.log("Harness comparison smoke: PASS");
        console.log(JSON.stringify(compactSnapshot, null, 2));
        return;
      }

      await delay(120);
    }

    const compactSnapshot = {
      ...snapshot,
      canvas: snapshot.canvas
        ? {
          width: snapshot.canvas.width,
          height: snapshot.canvas.height,
          meanLuma: snapshot.canvas.meanLuma,
          stdLuma: snapshot.canvas.stdLuma,
          hash: snapshot.canvas.hash
        }
        : null
    };
    throw new Error(`Timeout waiting for healthy harness comparison state. Snapshot: ${JSON.stringify(compactSnapshot, null, 2)}`);
  } finally {
    if (browser) {
      await browser.close();
    }

    await stopProcessTree(server.child);
  }
}

main().catch((error) => {
  console.error("Harness comparison smoke: FAIL");
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
