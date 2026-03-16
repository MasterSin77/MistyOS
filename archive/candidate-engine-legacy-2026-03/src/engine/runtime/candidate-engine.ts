import { DecayPass } from "../gpu/passes/decay-pass";
import { DepositionPass } from "../gpu/passes/deposition-pass";
import { WetnessRenderPass } from "../gpu/passes/wetness-render-pass";
import { createSharedSurfaceState } from "../gpu/state/shared-surface";
import type { EngineFrameContext, EngineInterface, FrameStats } from "../types";
import { createPresetDataUrl } from "../../reference/background-presets";

const SAMPLE_WIDTH = 64;
const SAMPLE_HEIGHT = 16;
const SAMPLE_TEXELS = SAMPLE_WIDTH * SAMPLE_HEIGHT;
const SAMPLE_BYTES_PER_ROW = 256;
const SAMPLE_BUFFER_SIZE = SAMPLE_BYTES_PER_ROW * SAMPLE_HEIGHT;
const MOTION_SAMPLE_INTERVAL_FRAMES = 12;
const MAX_DROPLETS = 48;
const DROPLET_STRIDE = 4;
const DROPLET_BUFFER_SIZE = MAX_DROPLETS * DROPLET_STRIDE * Float32Array.BYTES_PER_ELEMENT;

interface DropletState {
  x: number;
  y: number;
  mass: number;
  vy: number;
}

export async function createCandidateEngine(width: number, height: number, seed: number): Promise<EngineInterface> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = "100%";
  canvas.style.aspectRatio = `${width} / ${height}`;
  canvas.style.border = "1px solid #2f363d";
  canvas.style.background = "#0a0f17";

  if (!navigator.gpu) {
    throw new Error("WebGPU unavailable. This vertical slice requires a WebGPU-capable browser.");
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error("Failed to acquire WebGPU adapter.");
  }

  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
  if (!context) {
    throw new Error("Failed to acquire WebGPU context.");
  }

  const surfaceFormat = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format: surfaceFormat,
    alphaMode: "premultiplied"
  });

  const state = createSharedSurfaceState(device, width, height);
  const depositionPass = new DepositionPass(device);
  const decayPass = new DecayPass(device);
  const renderPass = new WetnessRenderPass(device, surfaceFormat, width, height);
  const initialBackground = await loadImage(createPresetDataUrl("night-boulevard"));
  renderPass.setBackgroundImage(initialBackground);

  const hashReadBufferSize = SAMPLE_BUFFER_SIZE;
  const hashReadBuffer = device.createBuffer({
    label: "wetness-state-hash-readback",
    size: hashReadBufferSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });

  const motionSampleBytesPerRow = alignTo(width * Float32Array.BYTES_PER_ELEMENT, 256);
  const motionReadBufferSize = motionSampleBytesPerRow * height;
  const motionReadBuffer = device.createBuffer({
    label: "wetness-state-motion-readback",
    size: motionReadBufferSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });

  const dropletStateBuffer = device.createBuffer({
    label: "droplet-state-buffer",
    size: DROPLET_BUFFER_SIZE,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  });
  const dropletUpload = new Float32Array(MAX_DROPLETS * DROPLET_STRIDE);
  const droplets: DropletState[] = [];
  const channelMemory = new Float32Array(Math.max(8, Math.floor(width / 6)));
  let spawnAccumulator = 0;
  let spawnPhase = 0;
  let rng = createLcg(seed ^ 0x9e3779b9);

  let motionSamplePending = false;
  let lastMotionSampleFrame = -MOTION_SAMPLE_INTERVAL_FRAMES;
  let previousMotionSample: Float32Array | null = null;
  let motionSampleTicket = 0;
  let renderMode: "comparison" | "debug-wetness" = "comparison";
  let backgroundApplied = true;
  let backgroundMeanLuma = computeMeanLumaFromImage(initialBackground, width, height);

  const applyCanvasBackground = (dataUrl: string): void => {
    canvas.style.backgroundImage = `url("${dataUrl}")`;
    canvas.style.backgroundSize = "cover";
    canvas.style.backgroundPosition = "center";
  };

  applyCanvasBackground(createPresetDataUrl("night-boulevard"));


  let lastStats: FrameStats = {
    frame: 0,
    simulationMs: 0,
    renderMs: 0,
    frameMs: 0
  };

  return {
    view: canvas,
    update(frameContext: EngineFrameContext): void {
      const start = performance.now();

      const encoder = device.createCommandEncoder({ label: "candidate-update-encoder" });
      const tuning = frameContext.scenario.tuning;
      const activeDroplets = advanceDroplets(
        droplets,
        frameContext.deltaMs,
        width,
        height,
        frameContext.scenario.rain.ratePerSecond,
        {
          spawnRate: Math.max(0.2, tuning?.dropletSpawnRate ?? 1),
          mass: Math.max(0.2, tuning?.dropletMass ?? 1),
          slipThreshold: Math.max(0.2, tuning?.dropletSlipThreshold ?? 1),
          mergeRadius: Math.max(0.2, tuning?.dropletMergeRadius ?? 1),
          anisotropicTransport: Math.max(0, tuning?.anisotropicTransport ?? 0),
          trailMemory: Math.max(0, tuning?.trailMemory ?? 0),
          slipRelease: Math.max(0, tuning?.slipRelease ?? 0),
          channelAttraction: Math.max(0, tuning?.channelAttraction ?? 0),
          mergeToRunnel: Math.max(0, tuning?.mergeToRunnel ?? 0)
        },
        channelMemory,
        () => rng()
      );
      writeDropletBuffer(dropletUpload, droplets, width, height);
      device.queue.writeBuffer(dropletStateBuffer, 0, dropletUpload.buffer, dropletUpload.byteOffset, dropletUpload.byteLength);

      depositionPass.run(encoder, state, dropletStateBuffer, {
        frame: frameContext.frame,
        seed,
        rainRate: frameContext.scenario.rain.ratePerSecond,
        deltaMs: frameContext.deltaMs,
        chanceScale: Math.max(0.2, tuning?.depositionChanceScale ?? 1),
        amountScale: Math.max(0.2, tuning?.depositionAmountScale ?? 1),
        topBiasScale: Math.max(0.2, tuning?.depositionTopBias ?? 1),
        dropletCount: activeDroplets,
        dropletDepositionRate: Math.max(0.2, tuning?.dropletDepositionRate ?? 1) * 0.021
      });
      decayPass.run(encoder, state, {
        deltaMs: frameContext.deltaMs,
        decayScale: Math.max(0.2, tuning?.decayRateScale ?? 1),
        runoffScale: Math.max(0.2, tuning?.runoffScale ?? 1),
        retentionScale: Math.max(0.2, tuning?.retentionScale ?? 1)
      });
      device.queue.submit([encoder.finish()]);

      scheduleMotionSample(frameContext.frame);

      lastStats = {
        ...lastStats,
        frame: frameContext.frame,
        simulationMs: performance.now() - start
      };
    },
    render(frameContext: EngineFrameContext): void {
      const start = performance.now();
      renderPass.setComparisonTuning(Math.max(0.2, frameContext.scenario.tuning?.overlaySpotScale ?? 1));

      const encoder = device.createCommandEncoder({ label: "candidate-render-encoder" });
      renderPass.run(encoder, state, context.getCurrentTexture().createView());
      device.queue.submit([encoder.finish()]);

      lastStats = {
        ...lastStats,
        renderMs: performance.now() - start
      };
    },
    collectStats(frameContext: EngineFrameContext): FrameStats {
      const frameMs = lastStats.simulationMs + lastStats.renderMs;
      return {
        frame: frameContext.frame,
        simulationMs: lastStats.simulationMs,
        renderMs: lastStats.renderMs,
        frameMs,
        motionSanity: lastStats.motionSanity,
        motionSanityError: lastStats.motionSanityError,
        comparisonReadiness: {
          renderMode,
          backgroundApplied,
          backgroundMeanLuma
        }
      };
    },
    async setBackgroundDataUrl(dataUrl: string): Promise<void> {
      const image = await loadImage(dataUrl);
      backgroundMeanLuma = computeMeanLumaFromImage(image, width, height);
      backgroundApplied = true;
      renderPass.setBackgroundImage(image);
      applyCanvasBackground(dataUrl);
    },
    setRenderMode(mode: "comparison" | "debug-wetness"): void {
      renderMode = mode;
      renderPass.setRenderMode(mode);
    },
    async captureStateHash(): Promise<string> {
      const bytesPerRow = 256;
      const extentWidth = 64;
      const extentHeight = 16;

      const encoder = device.createCommandEncoder({ label: "candidate-hash-encoder" });
      encoder.copyTextureToBuffer(
        {
          texture: state.wetnessRead,
          origin: { x: 0, y: 0, z: 0 }
        },
        {
          buffer: hashReadBuffer,
          bytesPerRow,
          rowsPerImage: extentHeight
        },
        {
          width: extentWidth,
          height: extentHeight,
          depthOrArrayLayers: 1
        }
      );
      device.queue.submit([encoder.finish()]);

      await hashReadBuffer.mapAsync(GPUMapMode.READ);
      const bytes = new Uint8Array(hashReadBuffer.getMappedRange().slice(0, hashReadBufferSize));
      const hash = fnv1aHash(bytes);
      hashReadBuffer.unmap();
      return hash;
    }
  };

  function scheduleMotionSample(frame: number): void {
    if (motionSamplePending || frame - lastMotionSampleFrame < MOTION_SAMPLE_INTERVAL_FRAMES) {
      return;
    }

    motionSamplePending = true;
    lastMotionSampleFrame = frame;

    const encoder = device.createCommandEncoder({ label: "candidate-motion-sample-encoder" });
    encoder.copyTextureToBuffer(
      {
        texture: state.wetnessRead,
        origin: { x: 0, y: 0, z: 0 }
      },
      {
        buffer: motionReadBuffer,
        bytesPerRow: motionSampleBytesPerRow,
        rowsPerImage: height
      },
      {
        width,
        height,
        depthOrArrayLayers: 1
      }
    );
    device.queue.submit([encoder.finish()]);

    const ticket = ++motionSampleTicket;
    void device.queue.onSubmittedWorkDone()
      .then(() => motionReadBuffer.mapAsync(GPUMapMode.READ))
      .then(() => {
        const mapped = motionReadBuffer.getMappedRange();
        const values = new Float32Array(mapped);
        const sample = downsampleWetness(values, width, height, motionSampleBytesPerRow / Float32Array.BYTES_PER_ELEMENT);
        motionReadBuffer.unmap();

        const nextMotionStats = computeMotionStats(sample, previousMotionSample);
        previousMotionSample = sample;

        lastStats = {
          ...lastStats,
          motionSanityError: undefined,
          motionSanity: {
            sampledFrame: frame,
            sampledTexels: SAMPLE_TEXELS,
            meanWetness: nextMotionStats.meanWetness,
            variance: nextMotionStats.variance,
            activeRatio: nextMotionStats.activeRatio,
            temporalDelta: nextMotionStats.temporalDelta,
            sampleIntervalFrames: MOTION_SAMPLE_INTERVAL_FRAMES,
            classification: nextMotionStats.classification
          }
        };
      })
      .catch((error: unknown) => {
        lastStats = {
          ...lastStats,
          motionSanityError: toErrorMessage(error)
        };
      })
      .finally(() => {
        if (motionSampleTicket === ticket) {
          motionSamplePending = false;
        }
      });

    window.setTimeout(() => {
      if (!motionSamplePending || motionSampleTicket !== ticket) {
        return;
      }

      motionSamplePending = false;
      lastStats = {
        ...lastStats,
        motionSanityError: "Motion sampling timed out waiting for GPU readback."
      };
    }, 3000);
  }

  function advanceDroplets(
    list: DropletState[],
    deltaMs: number,
    simWidth: number,
    simHeight: number,
    rainRate: number,
    tuning: {
      spawnRate: number;
      mass: number;
      slipThreshold: number;
      mergeRadius: number;
      anisotropicTransport: number;
      trailMemory: number;
      slipRelease: number;
      channelAttraction: number;
      mergeToRunnel: number;
    },
    channels: Float32Array,
    random: () => number
  ): number {
    const dtSec = Math.max(0, deltaMs * 0.001);
    if (dtSec <= 0) {
      return Math.min(MAX_DROPLETS, list.length);
    }

    spawnPhase += dtSec * (0.42 + tuning.spawnRate * 0.08);
    const pulse = 0.92 + Math.sin(spawnPhase * Math.PI * 2) * 0.08;
    const spawnPerSec = rainRate * 1.78 * tuning.spawnRate * Math.max(0.78, pulse);
    spawnAccumulator += spawnPerSec * dtSec;
    const maxTopY = simHeight * 0.20;
    while (spawnAccumulator >= 1 && list.length < MAX_DROPLETS) {
      spawnAccumulator -= 1;
      list.push({
        x: random() * simWidth,
        y: random() * maxTopY,
        mass: (0.19 + random() * 0.30) * tuning.mass,
        vy: 16 + random() * 14
      });
    }

    const anisotropy = Math.max(0, tuning.anisotropicTransport);
    const gravity = 305 * tuning.slipThreshold * (1 + anisotropy * 0.55);
    const transferRate = 0.48 + tuning.mass * 0.24;
    const sway = 3.5 * (1 - Math.min(0.85, anisotropy * 0.45));
    const trailMemory = Math.max(0, tuning.trailMemory);
    const channelAttraction = Math.max(0, tuning.channelAttraction);

    if (trailMemory > 0 || channelAttraction > 0) {
      const channelDecay = Math.max(0, 1 - dtSec * (0.45 - Math.min(0.25, trailMemory * 0.10)));
      for (let i = 0; i < channels.length; i += 1) {
        channels[i] = (channels[i] ?? 0) * channelDecay;
      }
    }

    for (let i = list.length - 1; i >= 0; i -= 1) {
      const d = list[i];
      if (!d) {
        continue;
      }
      const slipRelease = Math.max(0, tuning.slipRelease);
      const slipGate = Math.max(0.16, tuning.slipThreshold * (0.34 + slipRelease * 0.14));
      const startsSlipping = d.mass > slipGate;
      if (startsSlipping) {
        const releaseBoost = 1 + Math.min(0.85, slipRelease * 0.50);
        d.vy += gravity * releaseBoost * dtSec;
      } else {
        d.vy *= 0.94 - Math.min(0.08, slipRelease * 0.03);
      }

      d.x += (random() - 0.5) * sway * dtSec;
      if (channelAttraction > 0 && channels.length > 2) {
        const idx = clampInt(Math.floor((d.x / simWidth) * channels.length), 1, channels.length - 2);
        const left = channels[idx - 1] ?? 0;
        const right = channels[idx + 1] ?? 0;
        const pull = (right - left) * Math.min(1.4, channelAttraction * 0.35);
        d.x += pull * dtSec;
      }
      d.y += d.vy * dtSec;

      if (trailMemory > 0 && channels.length > 0) {
        const idx = clampInt(Math.floor((d.x / simWidth) * channels.length), 0, channels.length - 1);
        const deposit = (0.14 + d.vy * 0.0028 + d.mass * 0.52) * trailMemory * dtSec;
        channels[idx] = Math.min(1, (channels[idx] ?? 0) + deposit);
      }

      const transferred = Math.min(d.mass, transferRate * dtSec * (0.18 + d.vy * 0.018));
      d.mass -= transferred;
      d.mass *= Math.max(0.0, 1 - dtSec * 0.12);

      if (d.vy < 14 && d.mass < 0.055) {
        d.mass *= Math.max(0.0, 1 - dtSec * 0.50);
      }

      if (d.y > simHeight + 4 || d.mass < 0.014) {
        list.splice(i, 1);
      }
    }

    const mergeRadiusPx = Math.max(2, tuning.mergeRadius * 6);
    const mergeRadiusSq = mergeRadiusPx * mergeRadiusPx;
    for (let i = 0; i < list.length; i += 1) {
      const a = list[i];
      if (!a) {
        continue;
      }
      for (let j = i + 1; j < list.length; j += 1) {
        const b = list[j];
        if (!b) {
          continue;
        }
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distSq = dx * dx + dy * dy;
        if (distSq > mergeRadiusSq) {
          continue;
        }

        const totalMass = a.mass + b.mass;
        if (totalMass <= 1e-5) {
          continue;
        }

        a.x = (a.x * a.mass + b.x * b.mass) / totalMass;
        a.y = (a.y * a.mass + b.y * b.mass) / totalMass;
        const runnelBias = Math.max(0, tuning.mergeToRunnel);
        a.vy = Math.max(a.vy, b.vy) * (0.94 + Math.min(0.22, runnelBias * 0.08));
        a.mass = Math.min(0.72, totalMass * 0.82);

        if (runnelBias > 0 && channels.length > 0) {
          const idx = clampInt(Math.floor((a.x / simWidth) * channels.length), 0, channels.length - 1);
          channels[idx] = Math.min(1, (channels[idx] ?? 0) + 0.22 * runnelBias);
        }
        list.splice(j, 1);
        j -= 1;
      }
    }

    return Math.min(MAX_DROPLETS, list.length);
  }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value | 0));
}

function computeMeanLumaFromImage(image: CanvasImageSource, width: number, height: number): number {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return 0;
  }

  context.drawImage(image, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height).data;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  const pixels = width * height;
  if (pixels <= 0) {
    return 0;
  }
  return (sum / pixels) / 255;
}

async function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = document.createElement("img");
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load candidate background image."));
    image.src = dataUrl;
  });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function computeMotionStats(sample: Float32Array, previous: Float32Array | null): {
  meanWetness: number;
  variance: number;
  activeRatio: number;
  temporalDelta: number;
  classification: "dry" | "low-motion" | "structured-motion";
} {
  let sum = 0;
  let sumSq = 0;
  let activeCount = 0;

  for (let i = 0; i < sample.length; i += 1) {
    const value = sample[i] ?? 0;
    sum += value;
    sumSq += value * value;
    if (value > 0.002) {
      activeCount += 1;
    }
  }

  const count = sample.length;
  const meanWetness = count > 0 ? sum / count : 0;
  const variance = count > 0 ? Math.max(0, sumSq / count - meanWetness * meanWetness) : 0;
  const activeRatio = count > 0 ? activeCount / count : 0;

  let temporalDelta = 0;
  if (previous && previous.length === sample.length) {
    for (let i = 0; i < sample.length; i += 1) {
      temporalDelta += Math.abs((sample[i] ?? 0) - (previous[i] ?? 0));
    }
    temporalDelta /= count;
  }

  let classification: "dry" | "low-motion" | "structured-motion" = "structured-motion";
  if (activeRatio < 0.002 && meanWetness < 0.005) {
    classification = "dry";
  } else if (temporalDelta < 0.0012 || variance < 0.00002) {
    classification = "low-motion";
  }

  return {
    meanWetness,
    variance,
    activeRatio,
    temporalDelta,
    classification
  };
}

function fnv1aHash(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i] ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function createLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function writeDropletBuffer(target: Float32Array, droplets: DropletState[], width: number, height: number): void {
  target.fill(0);
  const count = Math.min(MAX_DROPLETS, droplets.length);
  const invWidth = width > 0 ? 1 / width : 0;
  const invHeight = height > 0 ? 1 / height : 0;
  for (let i = 0; i < count; i += 1) {
    const base = i * DROPLET_STRIDE;
    const d = droplets[i];
    if (!d) {
      continue;
    }
    target[base] = clamp01(d.x * invWidth);
    target[base + 1] = clamp01(d.y * invHeight);
    target[base + 2] = Math.max(0, d.mass);
    target[base + 3] = Math.max(0, d.vy * 0.01);
  }
}

function clamp01(value: number): number {
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function downsampleWetness(
  values: Float32Array,
  sourceWidth: number,
  sourceHeight: number,
  sourceStride: number
): Float32Array {
  const sample = new Float32Array(SAMPLE_TEXELS);
  if (sourceWidth <= 0 || sourceHeight <= 0 || sourceStride <= 0) {
    return sample;
  }

  for (let sy = 0; sy < SAMPLE_HEIGHT; sy += 1) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor(((sy + 0.5) / SAMPLE_HEIGHT) * sourceHeight));
    for (let sx = 0; sx < SAMPLE_WIDTH; sx += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor(((sx + 0.5) / SAMPLE_WIDTH) * sourceWidth));
      const sourceIndex = sourceY * sourceStride + sourceX;
      sample[sy * SAMPLE_WIDTH + sx] = values[sourceIndex] ?? 0;
    }
  }

  return sample;
}
