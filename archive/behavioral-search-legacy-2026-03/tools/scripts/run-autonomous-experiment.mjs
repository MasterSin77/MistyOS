import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = process.cwd();
const EVAL_DIR = path.join(ROOT, "tools", "logs", "behavioral-eval");
const EXP_ROOT = path.join(ROOT, "tools", "logs", "behavioral-exp");
const NOW = new Date().toISOString().replace(/[:.]/g, "-");
const RUN_DIR = path.join(EXP_ROOT, `exp-${NOW}`);

const STAGE1_BATCH_BUDGET = Number(process.env.EXP_STAGE1_BUDGET ?? "14");
const STAGE1_TOP_K = Number(process.env.EXP_STAGE1_TOP_K ?? "3");
const PIVOT_BATCH_BUDGET = Number(process.env.EXP_PIVOT_BUDGET ?? "10");
const IMPROVEMENT_EPS = Number(process.env.EXP_IMPROVEMENT_EPS ?? "0.015");
const ACCEPTED_PLATEAU_WINDOW = Number(process.env.EXP_PLATEAU_WINDOW ?? "8");
const DISABLE_PIVOTS = String(process.env.EXP_DISABLE_PIVOTS ?? "false").toLowerCase() === "true";

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

const DEFAULT_MECHANISMS = {
  mechAniso: 0,
  mechTrail: 0,
  mechSlipRelease: 0,
  mechChannel: 0,
  mechRunnel: 0
};

const PARAM_BOUNDS = {
  rainRate: [2.2, 11.5],
  depChance: [0.35, 2.2],
  depAmount: [0.35, 2.2],
  depTopBias: [0.35, 2.8],
  decayScale: [0.25, 2.3],
  runoffScale: [0.25, 2.4],
  retentionScale: [0.25, 2.4],
  overlaySpot: [0.25, 2.4],
  dropSpawn: [0.35, 2.4],
  dropMass: [0.35, 2.4],
  dropSlip: [0.35, 2.8],
  dropMerge: [0.35, 2.4],
  dropDeposit: [0.35, 2.4]
};

const PARAM_STEPS = {
  rainRate: 0.8,
  depChance: 0.11,
  depAmount: 0.11,
  depTopBias: 0.18,
  decayScale: 0.11,
  runoffScale: 0.16,
  retentionScale: 0.13,
  overlaySpot: 0.13,
  dropSpawn: 0.15,
  dropMass: 0.15,
  dropSlip: 0.17,
  dropMerge: 0.13,
  dropDeposit: 0.13
};

const SEARCH_KEYS = [
  "dropSpawn",
  "dropMass",
  "dropSlip",
  "dropMerge",
  "dropDeposit",
  "depChance",
  "depAmount",
  "depTopBias",
  "runoffScale",
  "retentionScale",
  "decayScale",
  "overlaySpot",
  "rainRate"
];

const PIVOT_ORDER = [
  { key: "mechAniso", value: 1, label: "anisotropic transport reinforcement" },
  { key: "mechTrail", value: 1, label: "trail memory" },
  { key: "mechSlipRelease", value: 1, label: "slip-release rule" },
  { key: "mechChannel", value: 1, label: "channel attraction" },
  { key: "mechRunnel", value: 1, label: "merge-to-runnel rule" }
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toQuery(input) {
  return Object.entries(input)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

function scoreOf(result) {
  return Number(result?.similarity?.score ?? 0);
}

function metric(result, key) {
  return Number(result?.candidateMetrics?.[key] ?? Number.NaN);
}

function isAccepted(result) {
  const watchdog = String(result?.watchdogClassification ?? "UNKNOWN");
  const valid = result?.runValidity?.valid !== false;
  const burstFreeze = result?.runValidity?.burstThenFreeze === true;
  return watchdog !== "FAILED" && valid && !burstFreeze;
}

function ensureDirs() {
  fs.mkdirSync(EVAL_DIR, { recursive: true });
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.mkdirSync(path.join(RUN_DIR, "accepted"), { recursive: true });
  fs.mkdirSync(path.join(RUN_DIR, "batches"), { recursive: true });
}

function listEvalJsonNames() {
  return new Set(
    fs.readdirSync(EVAL_DIR)
      .filter((name) => name.startsWith("eval-") && name.endsWith(".json"))
  );
}

function newestFileOrNull(dir, prefix, suffix) {
  const names = fs.readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .sort();
  if (names.length === 0) return null;
  return path.join(dir, names[names.length - 1]);
}

function parseTimestampFromEvalFile(evalPath) {
  const base = path.basename(evalPath, ".json");
  return base.replace(/^eval-/, "");
}

function safeReadJson(jsonPath) {
  return JSON.parse(fs.readFileSync(jsonPath, "utf8"));
}

function runNpmScript(scriptName, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", scriptName], {
      cwd: ROOT,
      shell: true,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk) => { out += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { err += chunk.toString(); });

    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Script ${scriptName} failed with code ${code}\n${out}\n${err}`));
        return;
      }
      resolve({ out, err });
    });
    child.on("error", reject);
  });
}

async function runEvaluation(params, mechanisms, contextLabel) {
  const query = toQuery({ ...params, ...mechanisms });
  const before = listEvalJsonNames();

  await runNpmScript("eval:behavior", {
    EVAL_PARAM_QUERY: query,
    EVAL_WINDOW_SECONDS: process.env.EVAL_WINDOW_SECONDS ?? "20"
  });

  const after = listEvalJsonNames();
  const diff = [...after].filter((name) => !before.has(name)).sort();

  let evalJsonPath = null;
  if (diff.length > 0) {
    evalJsonPath = path.join(EVAL_DIR, diff[diff.length - 1]);
  } else {
    evalJsonPath = newestFileOrNull(EVAL_DIR, "eval-", ".json");
  }

  if (!evalJsonPath) {
    throw new Error("No evaluator JSON artifact found after run.");
  }

  const result = safeReadJson(evalJsonPath);
  const stamp = parseTimestampFromEvalFile(evalJsonPath);

  const baselinePngPath = path.join(EVAL_DIR, `baseline-sample-${stamp}.png`);
  const candidatePngPath = path.join(EVAL_DIR, `candidate-sample-${stamp}.png`);

  return {
    contextLabel,
    params,
    mechanisms,
    query,
    evalJsonPath,
    baselinePngPath: fs.existsSync(baselinePngPath) ? baselinePngPath : null,
    candidatePngPath: fs.existsSync(candidatePngPath) ? candidatePngPath : null,
    result,
    accepted: isAccepted(result)
  };
}

function mutateParams(base, iteration) {
  const next = { ...base };
  const keysToTouch = 4;

  for (let i = 0; i < keysToTouch; i += 1) {
    const key = SEARCH_KEYS[(iteration + i * 3) % SEARCH_KEYS.length];
    const [lo, hi] = PARAM_BOUNDS[key];
    const step = PARAM_STEPS[key];
    const dir = ((iteration + i) % 2 === 0) ? 1 : -1;
    const jitter = 0.45 + ((iteration * (i + 3)) % 7) * 0.11;
    const candidate = Number(next[key]) + dir * step * jitter;
    next[key] = Number(clamp(candidate, lo, hi).toFixed(4));
  }

  return next;
}

function classifyBand(bestRun, baselineRun, bestPriorScore) {
  const result = bestRun?.result;
  const watchdog = String(result?.watchdogClassification ?? "UNKNOWN");
  if (!bestRun?.accepted || watchdog === "FAILED") {
    return "FAILED";
  }

  const score = scoreOf(result);
  const baseScore = scoreOf(baselineRun?.result);
  const streakDelta = metric(result, "streakTendency") - metric(baselineRun?.result, "streakTendency");
  const downDelta = metric(result, "downwardBias") - metric(baselineRun?.result, "downwardBias");
  const improved = score > Math.max(bestPriorScore, baseScore) + IMPROVEMENT_EPS;

  if (score >= 0.72 && watchdog !== "FAILED") {
    return "ACCEPTABLE";
  }

  if (improved && streakDelta > 0.0015 && downDelta > 0.001 && watchdog === "DEGRADED") {
    return "PROMISING";
  }

  return "DEGRADED";
}

function summarizeMetrics(run) {
  const candidate = run?.result?.candidateMetrics ?? {};
  return {
    downwardBias: Number(candidate.downwardBias ?? Number.NaN),
    streakTendency: Number(candidate.streakTendency ?? Number.NaN),
    temporalVariance: Number(candidate.temporalVariance ?? Number.NaN),
    persistence: Number(candidate.framePersistence ?? Number.NaN),
    coverage: Number(candidate.spotCoverage ?? Number.NaN),
    uniformity: Number(candidate.spatialStd ?? Number.NaN)
  };
}

function oneLineDiagnosis(run, baselineRun) {
  const m = summarizeMetrics(run);
  const base = summarizeMetrics(baselineRun);
  const streakGain = m.streakTendency - base.streakTendency;
  const downGain = m.downwardBias - base.downwardBias;
  if (streakGain > 0.002 && downGain > 0.002) {
    return "More downward structure is visible, but trails still broaden into wet patches before coherent runnels persist.";
  }
  if (m.coverage > base.coverage + 0.04) {
    return "Coverage rises into damp-sheet behavior with rounded blobs, not narrow sustained streak/runnel paths.";
  }
  return "Motion remains active but morphology stays blob-biased with insufficient narrow vertical trail continuity.";
}

function copyIfExists(sourcePath, targetPath) {
  if (sourcePath && fs.existsSync(sourcePath)) {
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function saveAcceptedArtifact(run, label, note) {
  const score = scoreOf(run.result).toFixed(6);
  const dir = path.join(RUN_DIR, "accepted", `${label}-score-${score}`);
  fs.mkdirSync(dir, { recursive: true });

  const evalFile = path.join(dir, "evaluator.json");
  fs.copyFileSync(run.evalJsonPath, evalFile);
  copyIfExists(run.baselinePngPath, path.join(dir, "baseline-sample.png"));
  copyIfExists(run.candidatePngPath, path.join(dir, "candidate-sample.png"));

  const watchdogSummary = {
    watchdogClassification: run.result.watchdogClassification,
    runValidity: run.result.runValidity,
    timingIntegrity: run.result.timingIntegrity
  };
  fs.writeFileSync(path.join(dir, "watchdog-summary.json"), JSON.stringify(watchdogSummary, null, 2), "utf8");

  const exact = {
    params: run.params,
    mechanisms: run.mechanisms,
    query: run.query,
    score: scoreOf(run.result)
  };
  fs.writeFileSync(path.join(dir, "exact-config.json"), JSON.stringify(exact, null, 2), "utf8");
  fs.writeFileSync(path.join(dir, "note.md"), note, "utf8");

  return dir;
}

function plateauDetected(history, baselineScore) {
  const accepted = history.filter((h) => h.accepted);
  if (accepted.length < ACCEPTED_PLATEAU_WINDOW) {
    return false;
  }

  const window = accepted.slice(-ACCEPTED_PLATEAU_WINDOW);
  const scores = window.map((w) => scoreOf(w.result));
  const best = Math.max(...scores);
  const first = scores[0];
  const gain = best - Math.max(first, baselineScore);

  const streakGain = (metric(window[window.length - 1].result, "streakTendency")
    - metric(window[0].result, "streakTendency"));

  return gain <= IMPROVEMENT_EPS && streakGain <= 0.0015;
}

function writeBatchReport(name, report) {
  const file = path.join(RUN_DIR, "batches", `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf8");
}

function batchNote(stage, status, run, baselineRun) {
  const metrics = summarizeMetrics(run);
  return [
    `# ${stage}`,
    "",
    `- status: ${status}`,
    `- score: ${scoreOf(run.result).toFixed(6)}`,
    `- watchdog: ${run.result.watchdogClassification}`,
    `- burstThenFreeze: ${String(run.result?.runValidity?.burstThenFreeze === true)}`,
    `- params: ${JSON.stringify(run.params)}`,
    `- mechanisms: ${JSON.stringify(run.mechanisms)}`,
    `- diagnosis: ${oneLineDiagnosis(run, baselineRun)}`,
    `- metrics: ${JSON.stringify(metrics)}`,
    ""
  ].join("\n");
}

function printBatchSummary(bestRun, baselineRun, retained, status, mechanismLabel = null) {
  const bestScore = scoreOf(bestRun.result);
  const metrics = summarizeMetrics(bestRun);
  const payload = {
    bestSimilarityScore: Number(bestScore.toFixed(6)),
    watchdogClassification: String(bestRun.result.watchdogClassification ?? "UNKNOWN"),
    topMetricChanges: {
      downwardBias: Number((metrics.downwardBias - summarizeMetrics(baselineRun).downwardBias).toFixed(6)),
      streakTendency: Number((metrics.streakTendency - summarizeMetrics(baselineRun).streakTendency).toFixed(6)),
      temporalVariance: Number((metrics.temporalVariance - summarizeMetrics(baselineRun).temporalVariance).toFixed(6)),
      persistence: Number((metrics.persistence - summarizeMetrics(baselineRun).persistence).toFixed(6)),
      coverage: Number((metrics.coverage - summarizeMetrics(baselineRun).coverage).toFixed(6)),
      uniformity: Number((metrics.uniformity - summarizeMetrics(baselineRun).uniformity).toFixed(6))
    },
    burstThenFreezeAbsent: bestRun.result?.runValidity?.burstThenFreeze !== true,
    retainedChanges: retained,
    visualDiagnosis: oneLineDiagnosis(bestRun, baselineRun),
    systemState: status,
    mechanism: mechanismLabel
  };

  console.log(JSON.stringify(payload));
}

async function runBoundedBatch({
  stageName,
  startParams,
  mechanisms,
  baselineRun,
  budget,
  topK,
  bestPriorScore
}) {
  let currentBestParams = { ...startParams };
  let currentBestRun = await runEvaluation(currentBestParams, mechanisms, `${stageName}-seed`);
  const history = [currentBestRun];
  const acceptedRuns = currentBestRun.accepted ? [currentBestRun] : [];

  for (let i = 1; i <= budget; i += 1) {
    const candidateParams = mutateParams(currentBestParams, i);
    const run = await runEvaluation(candidateParams, mechanisms, `${stageName}-iter-${i}`);
    history.push(run);

    if (!run.accepted) {
      continue;
    }

    acceptedRuns.push(run);
    if (scoreOf(run.result) > scoreOf(currentBestRun.result)) {
      currentBestRun = run;
      currentBestParams = { ...candidateParams };
    }

    if (plateauDetected(acceptedRuns, scoreOf(baselineRun.result))) {
      break;
    }
  }

  const rankedAccepted = [...acceptedRuns]
    .sort((a, b) => scoreOf(b.result) - scoreOf(a.result));

  const topAccepted = rankedAccepted.slice(0, Math.max(1, topK));
  const bestRun = topAccepted[0] ?? currentBestRun;

  const band = classifyBand(bestRun, baselineRun, bestPriorScore);
  const baselineScore = scoreOf(baselineRun.result);
  const improving = scoreOf(bestRun.result) > bestPriorScore + IMPROVEMENT_EPS;
  const plateau = plateauDetected(acceptedRuns, baselineScore) || !improving;

  const systemState = band === "ACCEPTABLE"
    ? "ACCEPTABLE"
    : band === "PROMISING"
      ? "PROMISING"
      : plateau
        ? "PLATEAUED"
        : "IMPROVING";

  const retained = {
    params: bestRun.params,
    mechanisms: bestRun.mechanisms
  };

  const report = {
    stageName,
    budget,
    acceptedCount: acceptedRuns.length,
    evaluatedCount: history.length,
    bestScore: scoreOf(bestRun.result),
    watchdogClassification: bestRun.result.watchdogClassification,
    systemState,
    band,
    retained,
    runs: history.map((h) => ({
      contextLabel: h.contextLabel,
      accepted: h.accepted,
      score: scoreOf(h.result),
      watchdogClassification: h.result.watchdogClassification,
      burstThenFreeze: h.result?.runValidity?.burstThenFreeze === true,
      evalJsonPath: path.relative(ROOT, h.evalJsonPath)
    }))
  };

  writeBatchReport(stageName, report);

  topAccepted.forEach((run, index) => {
    const note = batchNote(stageName, systemState, run, baselineRun);
    saveAcceptedArtifact(run, `${stageName}-top${index + 1}`, note);
  });

  return {
    bestRun,
    topAccepted,
    report,
    systemState,
    retained
  };
}

async function main() {
  ensureDirs();

  const freezeNote = {
    frozenTruth: {
      evaluator: "tools/scripts/evaluate-behavioral-similarity.mjs",
      watchdog: "tools/scripts/watchdog-harness.mjs",
      timing: "fixed harness dt and sim-wall integrity checks"
    },
    constraints: {
      changedEvaluatorRules: false,
      changedWatchdogRules: false,
      changedAcceptanceRules: false
    }
  };
  fs.writeFileSync(path.join(RUN_DIR, "stage0-freeze.json"), JSON.stringify(freezeNote, null, 2), "utf8");

  const stage0 = await runEvaluation(DEFAULT_PARAMS, DEFAULT_MECHANISMS, "stage0-baseline");
  const stage0Note = [
    "# Stage 0 Baseline",
    "",
    `- score: ${scoreOf(stage0.result).toFixed(6)}`,
    `- watchdog: ${stage0.result.watchdogClassification}`,
    `- burstThenFreeze: ${String(stage0.result?.runValidity?.burstThenFreeze === true)}`,
    `- diagnosis: ${oneLineDiagnosis(stage0, stage0)}`,
    ""
  ].join("\n");
  saveAcceptedArtifact(stage0, "stage0-baseline", stage0Note);

  const baseScore = scoreOf(stage0.result);

  const stage1 = await runBoundedBatch({
    stageName: "stage1-architecture-only",
    startParams: DEFAULT_PARAMS,
    mechanisms: DEFAULT_MECHANISMS,
    baselineRun: stage0,
    budget: STAGE1_BATCH_BUDGET,
    topK: STAGE1_TOP_K,
    bestPriorScore: baseScore
  });

  printBatchSummary(
    stage1.bestRun,
    stage0,
    stage1.retained,
    stage1.systemState,
    null
  );

  if (stage1.systemState === "ACCEPTABLE") {
    return;
  }

  if (stage1.systemState === "PROMISING") {
    return;
  }

  if (DISABLE_PIVOTS) {
    return;
  }

  let bestSoFar = stage1.bestRun;
  let failedPivotStreak = 0;

  for (let i = 0; i < PIVOT_ORDER.length; i += 1) {
    const pivot = PIVOT_ORDER[i];
    const mechanisms = { ...DEFAULT_MECHANISMS, [pivot.key]: pivot.value };

    const result = await runBoundedBatch({
      stageName: `stage3-pivot-${i + 1}`,
      startParams: bestSoFar.params,
      mechanisms,
      baselineRun: stage0,
      budget: PIVOT_BATCH_BUDGET,
      topK: STAGE1_TOP_K,
      bestPriorScore: scoreOf(bestSoFar.result)
    });

    const materialImprovement = scoreOf(result.bestRun.result) > scoreOf(bestSoFar.result) + IMPROVEMENT_EPS;
    if (materialImprovement) {
      bestSoFar = result.bestRun;
      failedPivotStreak = 0;
    } else {
      failedPivotStreak += 1;
    }

    printBatchSummary(
      result.bestRun,
      stage0,
      result.retained,
      result.systemState,
      pivot.label
    );

    if (result.systemState === "ACCEPTABLE" || result.systemState === "PROMISING") {
      return;
    }

    if (failedPivotStreak >= 2) {
      const insufficient = {
        status: "INSUFFICIENT",
        reason: "Two consecutive mechanism pivots failed to deliver material improvement.",
        bestScore: scoreOf(bestSoFar.result),
        bestWatchdog: bestSoFar.result.watchdogClassification,
        bestParams: bestSoFar.params,
        bestMechanisms: bestSoFar.mechanisms
      };
      fs.writeFileSync(path.join(RUN_DIR, "final-insufficient.json"), JSON.stringify(insufficient, null, 2), "utf8");
      const insufficientRun = {
        ...bestSoFar,
        result: {
          ...bestSoFar.result,
          watchdogClassification: bestSoFar.result.watchdogClassification
        }
      };
      printBatchSummary(
        insufficientRun,
        stage0,
        { params: bestSoFar.params, mechanisms: bestSoFar.mechanisms },
        "INSUFFICIENT",
        pivot.label
      );
      return;
    }
  }
}

main().catch((error) => {
  console.error("Autonomous experiment: FAIL");
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
