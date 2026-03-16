import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const ARTIFACT_DIR = path.join(process.cwd(), "tools", "logs", "behavioral-opt");
const ITERATIONS = Number(process.env.OPT_ITERATIONS ?? "2");

const DEFAULT_PARAMS = {
  rainRate: 6,
  depChance: 1,
  depAmount: 1,
  depTopBias: 1,
  decayScale: 1,
  runoffScale: 1,
  retentionScale: 1,
  overlaySpot: 1,
  dropSpawn: 1,
  dropMass: 1,
  dropSlip: 1,
  dropMerge: 1,
  dropDeposit: 1
};

function toQuery(params) {
  const entries = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return entries.join("&");
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function neighbors(params, iteration) {
  const candidates = [];
  const deltas = [
    ["depChance", 0.12],
    ["depAmount", 0.10],
    ["depTopBias", 0.20],
    ["decayScale", 0.12],
    ["runoffScale", 0.18],
    ["retentionScale", 0.12],
    ["overlaySpot", 0.15],
    ["rainRate", 0.9],
    ["dropSpawn", 0.2],
    ["dropMass", 0.2],
    ["dropSlip", 0.15],
    ["dropMerge", 0.2],
    ["dropDeposit", 0.2]
  ];

  const window = 2;
  const start = ((iteration - 1) * window) % deltas.length;
  const selected = [];
  for (let i = 0; i < window; i += 1) {
    selected.push(deltas[(start + i) % deltas.length]);
  }

  for (const [key, delta] of selected) {
    const plus = { ...params };
    const minus = { ...params };
    const max = key === "rainRate" ? 12 : 2.5;
    plus[key] = clamp(Number(params[key]) + delta, 0.2, max);
    minus[key] = clamp(Number(params[key]) - delta, 0.2, max);
    candidates.push(plus, minus);
  }

  return candidates;
}

async function runEvaluator(params) {
  const query = toQuery(params);
  return await new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", "eval:behavior"], {
      cwd: process.cwd(),
      shell: true,
      env: { ...process.env, EVAL_PARAM_QUERY: query, EVAL_WINDOW_SECONDS: process.env.EVAL_WINDOW_SECONDS ?? "20" },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk) => { out += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { err += chunk.toString(); });

    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Evaluator failed with code ${code}\n${out}\n${err}`));
        return;
      }

      const lines = out.split(/\r?\n/).filter(Boolean);
      const jsonLine = [...lines].reverse().find((line) => line.trim().startsWith("{"));
      if (!jsonLine) {
        reject(new Error(`Could not parse evaluator output.\n${out}`));
        return;
      }

      try {
        resolve(JSON.parse(jsonLine));
      } catch (parseError) {
        reject(new Error(`Failed to parse evaluator JSON: ${String(parseError)}\n${jsonLine}`));
      }
    });
  });
}

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  let bestParams = { ...DEFAULT_PARAMS };
  let bestResult = await runEvaluator(bestParams);
  let bestAccepted = bestResult?.watchdogClassification !== "FAILED" && bestResult?.runValidity?.valid !== false;

  const timeline = [{
    iteration: 0,
    params: bestParams,
    result: bestResult,
    accepted: bestAccepted,
    rejectionReason: bestAccepted ? null : "initial candidate failed watchdog or run-validity"
  }];

  for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
    const candidates = neighbors(bestParams, iteration);
    let iterationBest = { params: bestParams, result: bestResult, accepted: false, rejectionReason: null };

    for (const params of candidates) {
      const result = await runEvaluator(params);
      const score = result?.similarity?.score ?? 0;
      const bestScore = iterationBest.result?.similarity?.score ?? 0;
      const runValid = result?.runValidity?.valid !== false;
      const watchdogOk = result.watchdogClassification !== "FAILED";

      if (!runValid || !watchdogOk) {
        iterationBest.rejectionReason = !watchdogOk
          ? "watchdog classification FAILED"
          : "run validity failed (burst/freeze or saturation plateau)";
        continue;
      }

      if (score > bestScore || !bestAccepted) {
        iterationBest = { params, result, accepted: true, rejectionReason: null };
      }
    }

    if (iterationBest.accepted) {
      bestParams = iterationBest.params;
      bestResult = iterationBest.result;
      bestAccepted = true;
    }

    timeline.push({
      iteration,
      params: iterationBest.params,
      result: iterationBest.result,
      accepted: iterationBest.accepted,
      rejectionReason: iterationBest.rejectionReason
    });
  }

  const output = {
    generatedAt: new Date().toISOString(),
    iterations: ITERATIONS,
    bestParams,
    bestScore: bestResult?.similarity?.score ?? 0,
    watchdogClassification: bestResult?.watchdogClassification ?? "UNKNOWN",
    timeline
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(ARTIFACT_DIR, `optimization-${stamp}.json`), JSON.stringify(output, null, 2), "utf8");
  console.log(JSON.stringify(output));
}

main().catch((error) => {
  console.error("Behavior optimizer: FAIL");
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
