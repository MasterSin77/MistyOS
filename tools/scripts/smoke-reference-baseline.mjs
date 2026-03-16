import { spawn } from "node:child_process";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const HOST = "127.0.0.1";
const PORT = 4173;
const BASE_URL = `http://${HOST}:${PORT}`;
const PAGE_URL = `${BASE_URL}/reference-baseline.html`;
const STARTUP_TIMEOUT_MS = 50000;

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
    const text = chunk.toString();
    stdout += text;
  });

  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
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

function parseHealthFlag(healthLine) {
  if (!healthLine) {
    return false;
  }
  return /engineLikelyRunning=true/i.test(healthLine);
}

async function main() {
  const server = startDevServer();
  let browser;

  try {
    await waitForServer(BASE_URL, STARTUP_TIMEOUT_MS);

    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: STARTUP_TIMEOUT_MS });

    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let snapshot = {
      status: null,
      diagnostic: null,
      health: null,
      report: null
    };

    while (Date.now() < deadline) {
      snapshot = {
        status: await textContent(page, "#status-line"),
        diagnostic: await textContent(page, "#diagnostic-line"),
        health: await textContent(page, "#health-line"),
        report: await textContent(page, "#runtime-report")
      };

      const initFailure = snapshot.health?.includes("phase=init-failure") ?? false;

      if (parseHealthFlag(snapshot.health) && !initFailure) {
        console.log("Baseline telemetry smoke: PASS");
        console.log(JSON.stringify(snapshot, null, 2));
        return;
      }

      if (initFailure) {
        throw new Error(`Baseline reported init-failure. Snapshot: ${JSON.stringify(snapshot, null, 2)}`);
      }

      await delay(300);
    }

    throw new Error(`Timeout waiting for healthy baseline startup. Snapshot: ${JSON.stringify(snapshot, null, 2)}`);
  } finally {
    if (browser) {
      await browser.close();
    }

    await stopProcessTree(server.child);
  }
}

main().catch((error) => {
  console.error("Baseline telemetry smoke: FAIL");
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
