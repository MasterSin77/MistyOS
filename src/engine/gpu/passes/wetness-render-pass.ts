import type { SharedSurfaceState } from "../state/shared-surface";
import type { RenderMode } from "../../types";

export class WetnessRenderPass {
  private readonly pipeline: GPURenderPipeline;
  private readonly bindGroupLayout: GPUBindGroupLayout;
  private readonly modeBuffer: GPUBuffer;
  private readonly backgroundTexture: GPUTexture;
  private readonly backgroundCanvas: HTMLCanvasElement;
  private renderMode: RenderMode = "comparison";

  public constructor(
    private readonly device: GPUDevice,
    format: GPUTextureFormat,
    private readonly width: number,
    private readonly height: number
  ) {
    this.modeBuffer = this.device.createBuffer({
      label: "wetness-render-mode",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    this.backgroundTexture = this.device.createTexture({
      label: "wetness-background",
      size: { width, height },
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
    });

    this.backgroundCanvas = document.createElement("canvas");
    this.backgroundCanvas.width = width;
    this.backgroundCanvas.height = height;

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }
      ]
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: {
        module: this.device.createShaderModule({
          code: `
@vertex
fn main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
  var positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(1.0, -1.0),
    vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0),
    vec2<f32>(1.0, -1.0),
    vec2<f32>(1.0, 1.0)
  );
  let p = positions[vertexIndex];
  return vec4<f32>(p, 0.0, 1.0);
}
`
        }),
        entryPoint: "main"
      },
      fragment: {
        module: this.device.createShaderModule({
          code: `
@group(0) @binding(0) var wetnessTex: texture_2d<f32>;
@group(0) @binding(1) var flowTex: texture_2d<f32>;
@group(0) @binding(2) var disturbanceTex: texture_2d<f32>;
@group(0) @binding(3) var backgroundTex: texture_2d<f32>;

struct RenderUniforms {
  mode: u32,
  spotScaleBits: u32,
  _pad1: u32,
  _pad2: u32,
};
@group(0) @binding(4) var<uniform> renderUniforms: RenderUniforms;

fn hsvToRgb(h: f32, s: f32, v: f32) -> vec3<f32> {
  let k = vec3<f32>(5.0, 3.0, 1.0);
  let p = abs(fract(vec3<f32>(h) + k / 3.0) * 6.0 - vec3<f32>(3.0));
  return v * mix(vec3<f32>(1.0), clamp(p - vec3<f32>(1.0), vec3<f32>(0.0), vec3<f32>(1.0)), s);
}

fn readWetness(pos: vec2<i32>, dims: vec2<i32>) -> f32 {
  let clamped = clamp(pos, vec2<i32>(0, 0), dims - vec2<i32>(1, 1));
  return textureLoad(wetnessTex, clamped, 0).r;
}

fn readFlow(pos: vec2<i32>, dims: vec2<i32>) -> vec2<f32> {
  let clamped = clamp(pos, vec2<i32>(0, 0), dims - vec2<i32>(1, 1));
  return textureLoad(flowTex, clamped, 0).xy;
}

fn readBackground(pos: vec2<i32>, dims: vec2<i32>) -> vec3<f32> {
  let clamped = clamp(pos, vec2<i32>(0, 0), dims - vec2<i32>(1, 1));
  return textureLoad(backgroundTex, clamped, 0).rgb;
}

@fragment
fn main(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let dimsU = textureDimensions(wetnessTex);
  let dims = vec2<i32>(dimsU);
  let pixel = vec2<i32>(
    clamp(i32(pos.x), 0, i32(dims.x) - 1),
    clamp(i32(pos.y), 0, i32(dims.y) - 1)
  );

  let wetness = readWetness(pixel, dims);
  let wetnessUp = readWetness(pixel + vec2<i32>(0, -1), dims);
  let wetnessDown = readWetness(pixel + vec2<i32>(0, 1), dims);
  let wetnessLeft = readWetness(pixel + vec2<i32>(-1, 0), dims);
  let wetnessRight = readWetness(pixel + vec2<i32>(1, 0), dims);
  let flow = readFlow(pixel, dims);
  let disturbance = clamp(textureLoad(disturbanceTex, pixel, 0).r, 0.0, 1.0);
  let wetnessUL = readWetness(pixel + vec2<i32>(-1, -1), dims);
  let wetnessUR = readWetness(pixel + vec2<i32>(1, -1), dims);
  let wetnessDL = readWetness(pixel + vec2<i32>(-1, 1), dims);
  let wetnessDR = readWetness(pixel + vec2<i32>(1, 1), dims);
  let localWetness = wetness * 0.42
    + (wetnessUp + wetnessDown + wetnessLeft + wetnessRight) * 0.10
    + (wetnessUL + wetnessUR + wetnessDL + wetnessDR) * 0.045;
  let c = clamp(wetness, 0.0, 1.0);

  if (renderUniforms.mode == 1u) {
    return vec4<f32>(0.04 + c * 0.25, 0.08 + c * 0.50, 0.12 + c * 0.78, 1.0);
  }

  if (renderUniforms.mode == 2u) {
    let mag = clamp(length(flow) * 24.0, 0.0, 1.0);
    let dir = atan2(flow.y, flow.x);
    let hue = (dir + 3.14159265) / 6.28318530;
    let flowRgb = hsvToRgb(hue, 0.88, 0.10 + mag * 0.90);
    let accent = disturbance * 0.08;
    return vec4<f32>(flowRgb + vec3<f32>(accent, accent, accent), 1.0);
  }

  if (renderUniforms.mode == 3u) {
    let d = smoothstep(0.0, 1.0, disturbance);
    let color = vec3<f32>(0.04, 0.03, 0.08) + vec3<f32>(0.90, 0.44, 0.11) * d;
    return vec4<f32>(color, 1.0);
  }

  let spotScale = bitcast<f32>(renderUniforms.spotScaleBits);

  let gradX = readWetness(pixel + vec2<i32>(1, 0), dims) - readWetness(pixel + vec2<i32>(-1, 0), dims);
  let gradY = readWetness(pixel + vec2<i32>(0, 1), dims) - readWetness(pixel + vec2<i32>(0, -1), dims);

  // First optics pass: derive normals only from shared wetness + flow state.
  let reservoir = clamp(localWetness * 0.78 + c * 0.22, 0.0, 1.0);
  let flowMag = clamp(length(flow) * 24.0, 0.0, 1.0);
  let runnerMask = clamp(smoothstep(0.18, 0.50, reservoir) * smoothstep(0.12, 0.66, flowMag), 0.0, 1.0);
  let filmMask = 1.0 - runnerMask;

  let flowDir = normalize(flow + vec2<f32>(0.0, 1e-4));
  let flowPerp = vec2<f32>(-flowDir.y, flowDir.x);

  let alongStep = vec2<i32>(i32(round(flowDir.x * 1.4)), i32(round(flowDir.y * 1.4)));
  let crossStep = vec2<i32>(i32(round(flowPerp.x * 1.4)), i32(round(flowPerp.y * 1.4)));
  let alongF = readWetness(pixel + alongStep, dims);
  let alongB = readWetness(pixel - alongStep, dims);
  let crossF = readWetness(pixel + crossStep, dims);
  let crossB = readWetness(pixel - crossStep, dims);
  let alongGrad = alongF - alongB;
  let crossGrad = crossF - crossB;
  let runnerSignal = max(0.0, alongGrad) * (0.62 + flowMag * 0.58);
  let laplacian = (wetnessLeft + wetnessRight + wetnessUp + wetnessDown) - wetness * 4.0;
  let curvature = clamp(abs(laplacian) * (1.8 + runnerMask * 1.1), 0.0, 1.0);
  let runnerThickness = smoothstep(0.26, 0.62, reservoir);
  let runnerHead = max(0.0, wetness - alongB) * smoothstep(0.18, 0.72, flowMag);
  let runnerRefine = runnerMask * (0.55 + runnerThickness * 0.45);

  let filmNormal = vec2<f32>(-gradX * 0.44, -gradY * 0.40);
  let runnerNormal = vec2<f32>(
    -flowPerp.x * crossGrad * (0.34 + runnerRefine * 0.12) - flowDir.x * (runnerSignal * (0.58 + runnerRefine * 0.20) + runnerHead * 0.12),
    -flowPerp.y * crossGrad * (0.30 + runnerRefine * 0.10) - flowDir.y * (runnerSignal * (0.80 + runnerRefine * 0.24) + runnerHead * 0.18)
  );
  let curvatureNormal = vec2<f32>(-gradX, -gradY) * curvature * (0.035 + runnerRefine * 0.080);

  // Stability gate suppresses low-reservoir high-contrast sparkle.
  let lowReservoir = 1.0 - smoothstep(0.07, 0.20, reservoir);
  let localContrast = abs(c - localWetness);
  let stability = 1.0 - lowReservoir * smoothstep(0.009, 0.046, localContrast + flowMag * 0.08 + abs(laplacian) * 0.04);
  let normalXY = (mix(filmNormal, runnerNormal, runnerMask) + curvatureNormal) * stability;

  let normalScale = mix(0.40, 1.08, runnerRefine);
  let nxy = clamp(normalXY * normalScale, vec2<f32>(-0.46, -0.46), vec2<f32>(0.46, 0.46));
  let normal = normalize(vec3<f32>(nxy.x, nxy.y, 1.0));

  let lightDir = normalize(vec3<f32>(-0.26, -0.34, 0.90));
  let viewDir = vec3<f32>(0.0, 0.0, 1.0);
  let halfDir = normalize(lightDir + viewDir);
  let ndotl = max(dot(normal, lightDir), 0.0);
  let specPower = mix(22.0, 86.0, runnerRefine);
  let spec = pow(max(dot(normal, halfDir), 0.0), specPower) * (0.038 + runnerRefine * 0.26 + curvature * 0.06);

  let refractOffset = vec2<i32>(
    i32(round(nxy.x * f32(dims.x) * (0.012 + runnerRefine * 0.016))),
    i32(round(nxy.y * f32(dims.y) * (0.008 + runnerRefine * 0.018)))
  );
  let baseBg = readBackground(pixel, dims);
  let shiftedBg = readBackground(pixel + refractOffset, dims);
  let refractedBg = mix(baseBg, shiftedBg, 0.24 + runnerRefine * 0.38);

  // Comparison mode renders only the wetness layer; the baseline-matched preset is the canvas background.
  let damp = clamp(smoothstep(0.030, 0.085, localWetness), 0.0, 1.0);
  let spot = clamp(smoothstep(0.075 / max(0.25, spotScale), 0.16 / max(0.25, spotScale), wetness), 0.0, 1.0);
  let opticalFlow = clamp(length(vec2<f32>(gradX, gradY)) * 180.0, 0.0, 1.0);
  let trail = clamp(max(0.0, wetnessUp - wetnessDown) * 280.0, 0.0, 1.0);
  let structure = clamp(max(opticalFlow * 0.7, trail), 0.0, 1.0);
  let grainMask = smoothstep(0.038, 0.095, localWetness);

  // Keep film softer and mature runners crisper while remaining coupled to simulation state.
  let wetTint = vec3<f32>(0.07, 0.11, 0.16)
    + vec3<f32>(0.04, 0.06, 0.09) * damp * filmMask
    + vec3<f32>(0.06, 0.10, 0.13) * spot
    + vec3<f32>(0.05) * structure;
  let opticalLift = ndotl * (0.05 + runnerRefine * 0.10) + spec;
  let tint = mix(wetTint, refractedBg + vec3<f32>(opticalLift), 0.22 + runnerRefine * 0.38);
  let alpha = clamp((damp * 0.016 + spot * 0.095 + opticalFlow * 0.060 + trail * (0.090 + runnerRefine * 0.060) + spec * 0.58) * grainMask, 0.0, 0.39);
  return vec4<f32>(tint, alpha);
}
`
        }),
        entryPoint: "main",
        targets: [{ format }]
      },
      primitive: { topology: "triangle-list" }
    });

    this.setRenderMode("comparison");
    this.fillDefaultBackground();
  }

  public setRenderMode(mode: RenderMode): void {
    this.renderMode = mode;
    const modeValue = renderModeToU32(mode);
    this.device.queue.writeBuffer(this.modeBuffer, 0, new Uint32Array([modeValue, floatBits(1), 0, 0]));
  }

  public setComparisonTuning(spotScale: number): void {
    const modeValue = renderModeToU32(this.renderMode);
    this.device.queue.writeBuffer(this.modeBuffer, 0, new Uint32Array([modeValue, floatBits(spotScale), 0, 0]));
  }

  public setBackgroundImage(source: CanvasImageSource): void {
    const context = this.backgroundCanvas.getContext("2d");
    if (!context) {
      return;
    }

    context.clearRect(0, 0, this.width, this.height);
    context.drawImage(source, 0, 0, this.width, this.height);
    this.uploadBackgroundFromCanvas(context);
  }

  public run(encoder: GPUCommandEncoder, state: SharedSurfaceState, targetView: GPUTextureView): void {
    const bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: state.currentReadView() },
        { binding: 1, resource: state.currentFlowReadView() },
        { binding: 2, resource: state.currentDisturbanceReadView() },
        { binding: 3, resource: this.backgroundTexture.createView() },
        { binding: 4, resource: { buffer: this.modeBuffer } }
      ]
    });

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: targetView,
          clearValue: this.renderMode === "comparison"
            ? { r: 0.0, g: 0.0, b: 0.0, a: 0.0 }
            : this.renderMode === "debug-wetness"
              ? { r: 0.04, g: 0.08, b: 0.12, a: 1 }
              : this.renderMode === "debug-flow"
                ? { r: 0.02, g: 0.02, b: 0.03, a: 1 }
                : { r: 0.04, g: 0.03, b: 0.05, a: 1 },
          loadOp: "clear",
          storeOp: "store"
        }
      ]
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();
  }

  private fillDefaultBackground(): void {
    const context = this.backgroundCanvas.getContext("2d");
    if (!context) {
      return;
    }

    const gradient = context.createLinearGradient(0, 0, this.width, this.height);
    gradient.addColorStop(0, "#10243b");
    gradient.addColorStop(0.5, "#234a72");
    gradient.addColorStop(1, "#2f5980");
    context.fillStyle = gradient;
    context.fillRect(0, 0, this.width, this.height);

    this.uploadBackgroundFromCanvas(context);
  }

  private uploadBackgroundFromCanvas(context: CanvasRenderingContext2D): void {
    const imageData = context.getImageData(0, 0, this.width, this.height);
    this.device.queue.writeTexture(
      { texture: this.backgroundTexture },
      imageData.data,
      {
        bytesPerRow: this.width * 4,
        rowsPerImage: this.height
      },
      {
        width: this.width,
        height: this.height,
        depthOrArrayLayers: 1
      }
    );
  }
}

function floatBits(value: number): number {
  const scratch = new ArrayBuffer(4);
  new Float32Array(scratch)[0] = value;
  return new Uint32Array(scratch)[0] ?? 0;
}

function renderModeToU32(mode: RenderMode): number {
  if (mode === "debug-wetness") {
    return 1;
  }
  if (mode === "debug-flow") {
    return 2;
  }
  if (mode === "debug-disturbance") {
    return 3;
  }
  return 0;
}
