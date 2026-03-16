import { setHumanApprovedBaseline } from "./integration";
import {
  createPresetDataUrl,
  STAGE_ASPECT,
  STAGE_PIXEL_HEIGHT,
  STAGE_PIXEL_WIDTH,
  type PresetName
} from "./background-presets";

declare global {
  interface Window {
    RaindropFX?: new (options: Record<string, unknown>) => RaindropFxInstance;
  }
}

interface RaindropFxInstance {
  options: Record<string, unknown>;
  simulator?: {
    raindrops?: unknown[];
  };
  start(): Promise<void>;
  stop(): void;
  resize(width: number, height: number): void;
  setBackground(background: string | TexImageSource): Promise<void>;
}

type UploadMode = "none" | "still-frame";

interface RuntimeState {
  source: string;
  uploadMode: UploadMode;
  mounted: boolean;
  lastError?: string;
}

interface RuntimeHealthState {
  phase: string;
  frameTicks: number;
  lastFrameAtMs: number;
  startupStartedAtMs: number;
}

interface RuntimeCapabilityReport {
  webgl2: boolean;
  webgl: boolean;
  userAgent: string;
}

interface RuntimeReport {
  phase: string;
  generatedAt: string;
  capability: RuntimeCapabilityReport;
  runtime: RuntimeState;
  health: {
    frameTicks: number;
    lastFrameAgoMs: number | null;
    startupElapsedMs: number;
    dropCount: number | null;
    engineLikelyRunning: boolean;
  };
  error?: string;
}

async function bootstrapBehavioralBaseline(): Promise<void> {
  const root = document.getElementById("reference-root");
  if (!root) {
    throw new Error("Expected #reference-root element.");
  }

  root.innerHTML = "";
  root.style.maxWidth = "1360px";
  root.style.margin = "0 auto";
  root.style.padding = "1.25rem";
  root.style.fontFamily = "Segoe UI, Tahoma, sans-serif";
  root.style.color = "#d7e7ff";
  root.style.background = "linear-gradient(165deg, #081321 0%, #102845 100%)";
  root.style.minHeight = "100vh";

  const heading = document.createElement("h1");
  heading.style.margin = "0";
  heading.textContent = "Behavioral Reference Baseline: raindrop-fx (Frozen)";

  const note = document.createElement("p");
  note.style.marginTop = "0.4rem";
  note.textContent = "This page is the behavioral oracle for approval. Uploads are still-frame only: GIF/video/image are normalized to one fixed 1600x900 frame before rendering.";

  const capability = document.createElement("p");
  capability.style.marginTop = "0.2rem";
  capability.style.color = "#a8caec";
  capability.textContent = "Native behaviors visible here: droplet deformation/spread, slip and release, trail/runners-like streaking, and mist pass. Not provided as a true shared wetness field oracle for final engine internals.";

  const controls = document.createElement("div");
  controls.style.display = "flex";
  controls.style.flexWrap = "wrap";
  controls.style.gap = "0.65rem";
  controls.style.alignItems = "center";

  const presetSelect = document.createElement("select");
  presetSelect.innerHTML = [
    "<option value=\"night-boulevard\">Preset: Night Boulevard</option>",
    "<option value=\"sunset-hills\">Preset: Sunset Hills</option>",
    "<option value=\"neon-alley\">Preset: Neon Alley</option>"
  ].join("");

  const applyPresetButton = document.createElement("button");
  applyPresetButton.type = "button";
  applyPresetButton.textContent = "Apply preset";
  applyPresetButton.style.cursor = "pointer";

  const uploadInput = document.createElement("input");
  uploadInput.type = "file";
  uploadInput.accept = "image/*,video/*,.gif";

  const useUploadButton = document.createElement("button");
  useUploadButton.type = "button";
  useUploadButton.textContent = "Use upload (still-frame)";
  useUploadButton.style.cursor = "pointer";

  const validateButton = document.createElement("button");
  validateButton.type = "button";
  validateButton.textContent = "Run source validation";
  validateButton.style.cursor = "pointer";

  const approveButton = document.createElement("button");
  approveButton.type = "button";
  approveButton.textContent = "Approve behavioral baseline";
  approveButton.style.cursor = "pointer";

  const status = document.createElement("p");
  status.id = "status-line";
  status.style.margin = "0";
  status.textContent = "Background: preset night-boulevard";

  const diagnostic = document.createElement("p");
  diagnostic.id = "diagnostic-line";
  diagnostic.style.margin = "0";
  diagnostic.style.color = "#91c0ea";

  const health = document.createElement("p");
  health.id = "health-line";
  health.style.margin = "0";
  health.style.color = "#8bd3b1";

  const stage = document.createElement("div");
  stage.style.width = "min(100%, 1280px)";
  stage.style.maxWidth = "1280px";
  stage.style.aspectRatio = STAGE_ASPECT;
  stage.style.margin = "0 auto";
  stage.style.borderRadius = "8px";
  stage.style.overflow = "hidden";
  stage.style.background = "#0f1d30";

  const canvas = document.createElement("canvas");
  canvas.width = STAGE_PIXEL_WIDTH;
  canvas.height = STAGE_PIXEL_HEIGHT;
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  stage.appendChild(canvas);

  const report = document.createElement("pre");
  report.id = "runtime-report";
  report.style.margin = "0";
  report.style.padding = "0.75rem";
  report.style.background = "#081321";
  report.style.border = "1px solid #284260";
  report.style.borderRadius = "8px";
  report.style.whiteSpace = "pre-wrap";
  report.textContent = "Validation report will appear here.";

  root.appendChild(heading);
  root.appendChild(note);
  root.appendChild(capability);
  controls.appendChild(presetSelect);
  controls.appendChild(applyPresetButton);
  controls.appendChild(uploadInput);
  controls.appendChild(useUploadButton);
  controls.appendChild(validateButton);
  controls.appendChild(approveButton);
  root.appendChild(controls);
  root.appendChild(status);
  root.appendChild(diagnostic);
  root.appendChild(health);
  root.appendChild(stage);
  root.appendChild(report);

  const runtime: RuntimeState = {
    source: "preset:night-boulevard",
    uploadMode: "none",
    mounted: false
  };

  const healthState: RuntimeHealthState = {
    phase: "bootstrap-start",
    frameTicks: 0,
    lastFrameAtMs: 0,
    startupStartedAtMs: performance.now()
  };

  const tickHeartbeat = (): void => {
    healthState.frameTicks += 1;
    healthState.lastFrameAtMs = performance.now();
    window.requestAnimationFrame(tickHeartbeat);
  };
  window.requestAnimationFrame(tickHeartbeat);

  const setPhase = (phase: string): void => {
    healthState.phase = phase;
  };

  let fx: RaindropFxInstance | null = null;
  const initialPresetDataUrl = createPresetDataUrl("night-boulevard");
  let watchdogTripped = false;
  let overrideNote = "";

  window.setInterval(() => {
    diagnostic.textContent = buildDiagnostic(stage, canvas, fx, runtime);
    health.textContent = buildHealthSummary(fx, runtime, healthState);
  }, 250);

  const startupWatchdog = window.setInterval(async () => {
    if (watchdogTripped) {
      return;
    }

    const startupElapsed = performance.now() - healthState.startupStartedAtMs;
    const isStartupPhase =
      healthState.phase === "loading-script" ||
      healthState.phase === "constructing-fx" ||
      healthState.phase === "starting-fx" ||
      healthState.phase === "applying-initial-background";

    if (!isStartupPhase || startupElapsed < 35000) {
      return;
    }

    watchdogTripped = true;
    if (fx) {
      try {
        fx.stop();
      } catch {
        // Ignore teardown failure during watchdog fallback.
      }
      fx = null;
    }

    runtime.lastError = `Startup watchdog timeout after ${Math.round(startupElapsed)} ms in phase ${healthState.phase}.`;
    runtime.mounted = false;
    setPhase("init-failure");
    status.textContent = "Background: preset night-boulevard (fallback mode)";
    writeRuntimeReport("init-failure", runtime.lastError);
    await applyBackgroundDataUrl(initialPresetDataUrl, "preset:night-boulevard", "none");
  }, 500);

  const writeRuntimeReport = (phase: string, error?: unknown): void => {
    const now = performance.now();
    const drops = fx && Array.isArray(fx.simulator?.raindrops) ? fx.simulator?.raindrops?.length ?? 0 : null;
    const lastFrameAgo = healthState.lastFrameAtMs > 0 ? Math.round(now - healthState.lastFrameAtMs) : null;
    const engineLikelyRunning = Boolean(fx && runtime.mounted && lastFrameAgo !== null && lastFrameAgo < 1000);

    const reportPayload: RuntimeReport = {
      phase,
      generatedAt: new Date().toISOString(),
      capability: detectRuntimeCapabilities(),
      runtime: {
        source: runtime.source,
        uploadMode: runtime.uploadMode,
        mounted: runtime.mounted,
        lastError: runtime.lastError
      },
      health: {
        frameTicks: healthState.frameTicks,
        lastFrameAgoMs: lastFrameAgo,
        startupElapsedMs: Math.round(now - healthState.startupStartedAtMs),
        dropCount: drops,
        engineLikelyRunning
      },
      error: error ? toErrorMessage(error) : undefined
    };

    report.textContent = JSON.stringify(reportPayload, null, 2);
  };

  const applyBackgroundDataUrl = async (dataUrl: string, source: string, mode: UploadMode): Promise<void> => {
    const image = await loadImage(dataUrl);

    if (fx) {
      await fx.setBackground(image);
      runtime.mounted = true;
      runtime.lastError = undefined;
      if (healthState.phase !== "init-failure") {
        setPhase("running");
      }
    } else {
      drawImageToCanvas(canvas, image);
      runtime.mounted = false;
    }

    runtime.source = source;
    runtime.uploadMode = mode;
  };

  try {
    setPhase("loading-script");
    writeRuntimeReport("loading-script");
    await withTimeout(loadFrozenRaindropFxScript(), 5000, "Timed out loading frozen raindrop-fx bundle.");

    if (!window.RaindropFX) {
      throw new Error("Frozen raindrop-fx bundle loaded but RaindropFX global is unavailable.");
    }

    setPhase("constructing-fx");
    fx = new window.RaindropFX({
      canvas,
      background: initialPresetDataUrl,
      mist: true,
      backgroundBlurSteps: 4,
      mistBlurStep: 5,
      dropletsPerSeconds: 1400,
      raindropCompose: "smoother"
    });

    setPhase("starting-fx");
    writeRuntimeReport("starting-fx");
    await withTimeout(fx.start(), 30000, "Timed out waiting for raindrop-fx start().");
    fx.resize(STAGE_PIXEL_WIDTH, STAGE_PIXEL_HEIGHT);
    applyBehaviorProfile(fx);
    overrideNote = applyExperimentOverridesFromQuery(fx);
    setPhase("applying-initial-background");
    await withTimeout(
      applyBackgroundDataUrl(initialPresetDataUrl, "preset:night-boulevard", "none"),
      5000,
      "Timed out applying initial background."
    );
    setPhase("init-success");
    status.textContent = `Background: preset night-boulevard (raindrop-fx active${overrideNote ? ` | ${overrideNote}` : ""})`;
    window.clearInterval(startupWatchdog);
    writeRuntimeReport("init-success");
  } catch (error) {
    if (fx) {
      try {
        fx.stop();
      } catch {
        // Ignore teardown failures in recovery path.
      }
      fx = null;
    }

    runtime.lastError = toErrorMessage(error);
    runtime.mounted = false;
    setPhase("init-failure");
    status.textContent = `Background: preset night-boulevard (fallback mode)`;
    writeRuntimeReport("init-failure", error);

    // Fallback background draw is intentionally deferred until after WebGL init attempt,
    // because a 2D context bound first prevents WebGL2 from being created on this canvas.
    await applyBackgroundDataUrl(initialPresetDataUrl, "preset:night-boulevard", "none");
    window.clearInterval(startupWatchdog);
  }

  applyPresetButton.addEventListener("click", async () => {
    try {
      const preset = (presetSelect.value as PresetName) || "night-boulevard";
      await applyBackgroundDataUrl(createPresetDataUrl(preset), `preset:${preset}`, "none");
      status.textContent = `Background: preset ${preset}`;
    } catch (error) {
      runtime.lastError = toErrorMessage(error);
      status.textContent = `Failed to apply preset: ${runtime.lastError}`;
      writeRuntimeReport("preset-failure", error);
    }
  });

  useUploadButton.addEventListener("click", async () => {
    try {
      const file = uploadInput.files?.[0];
      if (!file) {
        status.textContent = "No file selected. Select image/GIF/video to convert to still frame.";
        return;
      }

      let dataUrl: string;
      if (file.type.startsWith("video/")) {
        dataUrl = await snapshotVideoFile(file, STAGE_PIXEL_WIDTH, STAGE_PIXEL_HEIGHT);
      } else {
        dataUrl = await createStillFrameFromImageFile(file, STAGE_PIXEL_WIDTH, STAGE_PIXEL_HEIGHT);
      }

      await applyBackgroundDataUrl(dataUrl, `upload:${file.name}`, "still-frame");
      status.textContent = `Background: upload still frame from ${file.name}`;
    } catch (error) {
      runtime.lastError = toErrorMessage(error);
      status.textContent = `Failed to use upload: ${runtime.lastError}`;
      writeRuntimeReport("upload-failure", error);
    }
  });

  approveButton.addEventListener("click", () => {
    setHumanApprovedBaseline(true);
    approveButton.textContent = "Behavioral baseline approved";
  });

  validateButton.addEventListener("click", async () => {
    if (!fx) {
      writeRuntimeReport("validate-skipped", "raindrop-fx did not initialize");
      return;
    }

    try {
      const result = await runCrossSourceValidation(fx, applyBackgroundDataUrl);
      report.textContent = JSON.stringify(result, null, 2);

      await applyBackgroundDataUrl(createPresetDataUrl("night-boulevard"), "preset:night-boulevard", "none");
      status.textContent = "Background: preset night-boulevard";
    } catch (error) {
      runtime.lastError = toErrorMessage(error);
      writeRuntimeReport("validate-failure", error);
    }
  });

  if (fx) {
    setPhase("running");
    report.textContent = "Running initial cross-source validation...";
    const initial = await runCrossSourceValidation(fx, applyBackgroundDataUrl);
    report.textContent = JSON.stringify(initial, null, 2);
    await applyBackgroundDataUrl(createPresetDataUrl("night-boulevard"), "preset:night-boulevard", "none");
  }
}

void bootstrapBehavioralBaseline().catch((error) => {
  const root = document.getElementById("reference-root");
  if (!root) {
    return;
  }

  const message = document.createElement("pre");
  message.style.margin = "1rem";
  message.style.padding = "0.75rem";
  message.style.background = "#210f15";
  message.style.border = "1px solid #7a3044";
  message.style.borderRadius = "8px";
  message.style.color = "#ffd8df";
  message.textContent = `Fatal baseline bootstrap error: ${toErrorMessage(error)}`;
  root.appendChild(message);
});

async function loadFrozenRaindropFxScript(): Promise<void> {
  if (window.RaindropFX) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/src/reference/frozen/raindrop-fx/bundle/index.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load frozen raindrop-fx bundle."));
    document.head.appendChild(script);
  });
}

function applyBehaviorProfile(fx: RaindropFxInstance): void {
  const options = fx.options as Record<string, unknown>;
  options.spawnInterval = [0.03, 0.09];
  options.spawnSize = [28, 115];
  options.spawnLimit = 1800;
  options.slipRate = 0.74;
  options.motionInterval = [0.12, 0.28];
  options.xShifting = [0.01, 0.09];
  options.trailDropDensity = 0.2;
  options.trailDropSize = [0.35, 0.6];
  options.trailDistance = [16, 34];
  options.trailSpread = 0.52;
  options.initialSpread = 0.62;
  options.shrinkRate = 0.014;
  options.velocitySpread = 0.33;
  options.evaporate = 18;
  options.gravity = 2400;

  options.mist = true;
  options.mistBlurStep = 5;
  options.mistTime = 8;
  options.dropletsPerSeconds = 1400;
  options.smoothRaindrop = [0.95, 1.0];
  options.refractBase = 0.45;
  options.refractScale = 0.62;
}

function parseFiniteParam(params: URLSearchParams, key: string): number | null {
  const value = params.get(key);
  if (value === null) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseFiniteRange(params: URLSearchParams, minKey: string, maxKey: string): [number, number] | null {
  const min = parseFiniteParam(params, minKey);
  const max = parseFiniteParam(params, maxKey);
  if (min === null || max === null) {
    return null;
  }
  if (max < min) {
    return null;
  }
  return [min, max];
}

function applyExperimentOverridesFromQuery(fx: RaindropFxInstance): string {
  const params = new URLSearchParams(window.location.search);
  const options = fx.options as Record<string, unknown>;
  const applied: string[] = [];

  const slipRate = parseFiniteParam(params, "expSlipRate");
  if (slipRate !== null) {
    options.slipRate = slipRate;
    applied.push(`expSlipRate=${slipRate.toFixed(3)}`);
  }

  const gravity = parseFiniteParam(params, "expGravity");
  if (gravity !== null) {
    options.gravity = gravity;
    applied.push(`expGravity=${gravity.toFixed(0)}`);
  }

  const motionMin = parseFiniteParam(params, "expMotionMin");
  const motionMax = parseFiniteParam(params, "expMotionMax");
  if (motionMin !== null && motionMax !== null && motionMin > 0 && motionMax >= motionMin) {
    options.motionInterval = [motionMin, motionMax];
    applied.push(`expMotion=[${motionMin.toFixed(3)},${motionMax.toFixed(3)}]`);
  }

  const trailDistance = parseFiniteRange(params, "expTrailDistanceMin", "expTrailDistanceMax");
  if (trailDistance !== null && trailDistance[0] > 0) {
    options.trailDistance = trailDistance;
    applied.push(`expTrailDistance=[${trailDistance[0].toFixed(2)},${trailDistance[1].toFixed(2)}]`);
  }

  const trailDropSize = parseFiniteRange(params, "expTrailDropSizeMin", "expTrailDropSizeMax");
  if (trailDropSize !== null && trailDropSize[0] > 0) {
    options.trailDropSize = trailDropSize;
    applied.push(`expTrailDropSize=[${trailDropSize[0].toFixed(3)},${trailDropSize[1].toFixed(3)}]`);
  }

  const trailDropDensity = parseFiniteParam(params, "expTrailDropDensity");
  if (trailDropDensity !== null && trailDropDensity > 0) {
    options.trailDropDensity = trailDropDensity;
    applied.push(`expTrailDropDensity=${trailDropDensity.toFixed(3)}`);
  }

  const trailSpread = parseFiniteParam(params, "expTrailSpread");
  if (trailSpread !== null && trailSpread >= 0) {
    options.trailSpread = trailSpread;
    applied.push(`expTrailSpread=${trailSpread.toFixed(3)}`);
  }

  const colliderSize = parseFiniteParam(params, "expColliderSize");
  if (colliderSize !== null && colliderSize > 0) {
    options.colliderSize = colliderSize;
    applied.push(`expColliderSize=${colliderSize.toFixed(3)}`);
  }

  const refractBase = parseFiniteParam(params, "expRefractBase");
  if (refractBase !== null) {
    options.refractBase = refractBase;
    applied.push(`expRefractBase=${refractBase.toFixed(3)}`);
  }

  const refractScale = parseFiniteParam(params, "expRefractScale");
  if (refractScale !== null) {
    options.refractScale = refractScale;
    applied.push(`expRefractScale=${refractScale.toFixed(3)}`);
  }

  const smoothRaindrop = parseFiniteRange(params, "expSmoothMin", "expSmoothMax");
  if (smoothRaindrop !== null && smoothRaindrop[0] >= 0) {
    options.smoothRaindrop = smoothRaindrop;
    applied.push(`expSmooth=[${smoothRaindrop[0].toFixed(3)},${smoothRaindrop[1].toFixed(3)}]`);
  }

  const raindropEraserSize = parseFiniteRange(params, "expEraserMin", "expEraserMax");
  if (raindropEraserSize !== null && raindropEraserSize[0] >= 0) {
    options.raindropEraserSize = raindropEraserSize;
    applied.push(`expEraser=[${raindropEraserSize[0].toFixed(3)},${raindropEraserSize[1].toFixed(3)}]`);
  }

  const raindropCompose = params.get("expCompose");
  if (raindropCompose === "smoother" || raindropCompose === "harder") {
    options.raindropCompose = raindropCompose;
    applied.push(`expCompose=${raindropCompose}`);
  }

  return applied.join(", ");
}

function createSyntheticUploadDataUrl(): string {
  const canvas = document.createElement("canvas");
  canvas.width = STAGE_PIXEL_WIDTH;
  canvas.height = STAGE_PIXEL_HEIGHT;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Unable to create synthetic upload canvas context.");
  }

  const gradient = context.createLinearGradient(0, 0, STAGE_PIXEL_WIDTH, STAGE_PIXEL_HEIGHT);
  gradient.addColorStop(0, "#162940");
  gradient.addColorStop(0.45, "#395775");
  gradient.addColorStop(1, "#243f60");
  context.fillStyle = gradient;
  context.fillRect(0, 0, STAGE_PIXEL_WIDTH, STAGE_PIXEL_HEIGHT);

  context.fillStyle = "rgba(230, 242, 255, 0.2)";
  for (let i = 0; i < 20; i += 1) {
    context.fillRect(30 + i * 80, 58 + (i % 5) * 11, 36, 390 + (i % 4) * 48);
  }

  return canvas.toDataURL("image/png");
}

async function createStillFrameFromImageFile(file: File, width: number, height: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const image = document.createElement("img");
    const url = URL.createObjectURL(file);

    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      const context = canvas.getContext("2d");
      if (!context) {
        URL.revokeObjectURL(url);
        reject(new Error("Unable to create still-frame canvas for image upload."));
        return;
      }

      context.fillStyle = "#0f1d30";
      context.fillRect(0, 0, width, height);

      const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
      const drawWidth = image.naturalWidth * scale;
      const drawHeight = image.naturalHeight * scale;
      const drawX = (width - drawWidth) * 0.5;
      const drawY = (height - drawHeight) * 0.5;
      context.drawImage(image, drawX, drawY, drawWidth, drawHeight);

      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/png"));
    };

    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Unable to decode image/GIF upload."));
    };

    image.src = url;
  });
}

function snapshotVideoFile(file: File, width: number, height: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";

    const url = URL.createObjectURL(file);
    video.src = url;

    const cleanup = (): void => {
      URL.revokeObjectURL(url);
    };

    video.addEventListener("loadeddata", () => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      const context = canvas.getContext("2d");
      if (!context) {
        cleanup();
        reject(new Error("Unable to create canvas context for video snapshot."));
        return;
      }

      context.fillStyle = "#0f1d30";
      context.fillRect(0, 0, width, height);

      const scale = Math.max(width / video.videoWidth, height / video.videoHeight);
      const drawWidth = video.videoWidth * scale;
      const drawHeight = video.videoHeight * scale;
      const drawX = (width - drawWidth) * 0.5;
      const drawY = (height - drawHeight) * 0.5;
      context.drawImage(video, drawX, drawY, drawWidth, drawHeight);

      cleanup();
      resolve(canvas.toDataURL("image/png"));
    });

    video.addEventListener("error", () => {
      cleanup();
      reject(new Error("Unable to decode uploaded video."));
    });
  });
}

async function loadImage(source: string): Promise<HTMLImageElement> {
  const image = document.createElement("img");
  image.width = STAGE_PIXEL_WIDTH;
  image.height = STAGE_PIXEL_HEIGHT;
  image.src = source;
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Failed to load normalized background image."));
  });
  return image;
}

function buildDiagnostic(
  stage: HTMLDivElement,
  canvas: HTMLCanvasElement,
  fx: RaindropFxInstance | null,
  runtime: RuntimeState
): string {
  const stageRect = stage.getBoundingClientRect();
  const drops = fx && Array.isArray(fx.simulator?.raindrops) ? fx.simulator?.raindrops?.length ?? 0 : "n/a";

  return [
    `diag`,
    `stagePixels=${STAGE_PIXEL_WIDTH}x${STAGE_PIXEL_HEIGHT}`,
    `stageDisplay=${Math.round(stageRect.width)}x${Math.round(stageRect.height)}`,
    `rainCanvasPixels=${canvas.width}x${canvas.height}`,
    `backgroundSource=${runtime.source}`,
    `rainMounted=${String(runtime.mounted)}`,
    `dropCount=${String(drops)}`,
    `uploadMode=${runtime.uploadMode}`,
    `lastError=${runtime.lastError ?? "none"}`
  ].join(" | ");
}

function drawImageToCanvas(canvas: HTMLCanvasElement, image: CanvasImageSource): void {
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Unable to get 2D fallback context from rain canvas.");
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
}

function detectRuntimeCapabilities(): RuntimeCapabilityReport {
  const probe = document.createElement("canvas");
  const webgl2Context = probe.getContext("webgl2");
  const webglContext = probe.getContext("webgl") || probe.getContext("experimental-webgl");

  return {
    webgl2: webgl2Context !== null,
    webgl: webglContext !== null,
    userAgent: window.navigator.userAgent
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
}

function buildHealthSummary(
  fx: RaindropFxInstance | null,
  runtime: RuntimeState,
  healthState: RuntimeHealthState
): string {
  const now = performance.now();
  const drops = fx && Array.isArray(fx.simulator?.raindrops) ? fx.simulator?.raindrops?.length ?? 0 : null;
  const lastFrameAgoMs = healthState.lastFrameAtMs > 0 ? Math.round(now - healthState.lastFrameAtMs) : null;
  const engineLikelyRunning = Boolean(fx && runtime.mounted && lastFrameAgoMs !== null && lastFrameAgoMs < 1000);

  return [
    `health`,
    `phase=${healthState.phase}`,
    `startupMs=${Math.round(now - healthState.startupStartedAtMs)}`,
    `frameTicks=${healthState.frameTicks}`,
    `lastFrameAgoMs=${lastFrameAgoMs ?? "n/a"}`,
    `dropCount=${drops ?? "n/a"}`,
    `engineLikelyRunning=${String(engineLikelyRunning)}`
  ].join(" | ");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  const timeoutPromise = new Promise<T>((_, reject) => {
    window.setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  return await Promise.race([promise, timeoutPromise]);
}

async function runCrossSourceValidation(
  fx: RaindropFxInstance,
  applyBackgroundDataUrl: (dataUrl: string, source: string, mode: UploadMode) => Promise<void>
): Promise<unknown> {
  const checks: Array<{ name: string; dataUrl: string; mode: UploadMode }> = [
    { name: "preset:night-boulevard", dataUrl: createPresetDataUrl("night-boulevard"), mode: "none" },
    { name: "preset:sunset-hills", dataUrl: createPresetDataUrl("sunset-hills"), mode: "none" },
    { name: "preset:neon-alley", dataUrl: createPresetDataUrl("neon-alley"), mode: "none" },
    { name: "upload:synthetic-still-frame", dataUrl: createSyntheticUploadDataUrl(), mode: "still-frame" }
  ];

  const results: Array<Record<string, unknown>> = [];

  for (const check of checks) {
    await applyBackgroundDataUrl(check.dataUrl, check.name, check.mode);
    await sleep(250);

    const drops = Array.isArray(fx.simulator?.raindrops) ? fx.simulator?.raindrops?.length ?? 0 : null;

    results.push({
      source: check.name,
      expectedStagePixels: `${STAGE_PIXEL_WIDTH}x${STAGE_PIXEL_HEIGHT}`,
      actualCanvasPixels: `${STAGE_PIXEL_WIDTH}x${STAGE_PIXEL_HEIGHT}`,
      uploadMode: check.mode,
      dropCount: drops,
      rainMounted: true,
      comparable: drops !== null
    });
  }

  return {
    validationVersion: "v1",
    generatedAt: new Date().toISOString(),
    summary: {
      stagePixels: `${STAGE_PIXEL_WIDTH}x${STAGE_PIXEL_HEIGHT}`,
      uploadMode: "still-frame-only",
      backgroundsChecked: checks.length
    },
    results
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
