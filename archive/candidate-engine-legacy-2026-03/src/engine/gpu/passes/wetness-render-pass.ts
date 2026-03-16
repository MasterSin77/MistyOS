import type { SharedSurfaceState } from "../state/shared-surface";

export class WetnessRenderPass {
  private readonly pipeline: GPURenderPipeline;
  private readonly bindGroupLayout: GPUBindGroupLayout;
  private readonly modeBuffer: GPUBuffer;
  private readonly backgroundTexture: GPUTexture;
  private readonly backgroundCanvas: HTMLCanvasElement;
  private renderMode: "comparison" | "debug-wetness" = "comparison";

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
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }
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
@group(0) @binding(1) var backgroundTex: texture_2d<f32>;

struct RenderUniforms {
  mode: u32,
  spotScaleBits: u32,
  _pad1: u32,
  _pad2: u32,
};
@group(0) @binding(2) var<uniform> renderUniforms: RenderUniforms;

fn readWetness(pos: vec2<i32>, dims: vec2<i32>) -> f32 {
  let clamped = clamp(pos, vec2<i32>(0, 0), dims - vec2<i32>(1, 1));
  return textureLoad(wetnessTex, clamped, 0).r;
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
  let localWetness = wetness * 0.62 + (wetnessUp + wetnessDown) * 0.14 + (wetnessLeft + wetnessRight) * 0.05;
  let c = clamp(wetness, 0.0, 1.0);

  if (renderUniforms.mode == 1u) {
    return vec4<f32>(0.04 + c * 0.25, 0.08 + c * 0.50, 0.12 + c * 0.78, 1.0);
  }

  let spotScale = bitcast<f32>(renderUniforms.spotScaleBits);

  let gradX = readWetness(pixel + vec2<i32>(1, 0), dims) - readWetness(pixel + vec2<i32>(-1, 0), dims);
  let gradY = readWetness(pixel + vec2<i32>(0, 1), dims) - readWetness(pixel + vec2<i32>(0, -1), dims);

  // Comparison mode renders only the wetness layer; the baseline-matched preset is the canvas background.
  let damp = clamp(smoothstep(0.030, 0.085, localWetness), 0.0, 1.0);
  let spot = clamp(smoothstep(0.075 / max(0.25, spotScale), 0.16 / max(0.25, spotScale), wetness), 0.0, 1.0);
  let flow = clamp(length(vec2<f32>(gradX, gradY)) * 180.0, 0.0, 1.0);
  let trail = clamp(max(0.0, wetnessUp - wetnessDown) * 280.0, 0.0, 1.0);
  let structure = clamp(max(flow * 0.7, trail), 0.0, 1.0);
  let grainMask = smoothstep(0.038, 0.095, localWetness);

  // Separate background dampness from denser spots/trails so rain logic is readable by eye.
  let tint = vec3<f32>(0.07, 0.11, 0.16)
    + vec3<f32>(0.05, 0.08, 0.11) * damp
    + vec3<f32>(0.07, 0.11, 0.14) * spot
    + vec3<f32>(0.06) * structure;
  let alpha = clamp((damp * 0.018 + spot * 0.12 + flow * 0.08 + trail * 0.14) * grainMask, 0.0, 0.34);
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

  public setRenderMode(mode: "comparison" | "debug-wetness"): void {
    this.renderMode = mode;
    const modeValue = mode === "debug-wetness" ? 1 : 0;
    this.device.queue.writeBuffer(this.modeBuffer, 0, new Uint32Array([modeValue, floatBits(1), 0, 0]));
  }

  public setComparisonTuning(spotScale: number): void {
    const modeValue = this.renderMode === "debug-wetness" ? 1 : 0;
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
        { binding: 1, resource: this.backgroundTexture.createView() },
        { binding: 2, resource: { buffer: this.modeBuffer } }
      ]
    });

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: targetView,
          clearValue: this.renderMode === "debug-wetness"
            ? { r: 0.04, g: 0.08, b: 0.12, a: 1 }
            : { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
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
