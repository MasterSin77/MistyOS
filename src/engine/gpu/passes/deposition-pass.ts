import type { SharedSurfaceState } from "../state/shared-surface";

export interface DepositionPassInputs {
  frame: number;
  seed: number;
  rainRate: number;
  deltaMs: number;
  chanceScale: number;
  amountScale: number;
  topBiasScale: number;
  dropletCount: number;
  dropletDepositionRate: number;
}

export class DepositionPass {
  private readonly pipeline: GPUComputePipeline;
  private readonly uniformBuffer: GPUBuffer;
  private readonly bindGroupLayout: GPUBindGroupLayout;

  public constructor(private readonly device: GPUDevice) {
    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "r32float" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } }
      ]
    });

    this.uniformBuffer = this.device.createBuffer({
      label: "deposition-uniforms",
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    this.pipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      compute: {
        module: this.device.createShaderModule({
          code: `
struct Uniforms {
  frame: u32,
  seed: u32,
  rainRateBits: u32,
  deltaMsBits: u32,
  chanceScaleBits: u32,
  amountScaleBits: u32,
  topBiasScaleBits: u32,
  dropletCount: u32,
  dropletDepositionRateBits: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

@group(0) @binding(0) var wetnessIn: texture_2d<f32>;
@group(0) @binding(1) var wetnessOut: texture_storage_2d<r32float, write>;
@group(0) @binding(2) var<uniform> uniforms: Uniforms;
@group(0) @binding(3) var<storage, read> droplets: array<vec4<f32>>;

fn hash(v: u32) -> u32 {
  var x = v;
  x = ((x >> 16u) ^ x) * 73244475u;
  x = ((x >> 16u) ^ x) * 73244475u;
  x = (x >> 16u) ^ x;
  return x;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = textureDimensions(wetnessOut);
  if (gid.x >= size.x || gid.y >= size.y) {
    return;
  }

  let prior = textureLoad(wetnessIn, vec2<i32>(gid.xy), 0).r;
  let rate = bitcast<f32>(uniforms.rainRateBits);
  let deltaMs = bitcast<f32>(uniforms.deltaMsBits);
  let chanceScale = bitcast<f32>(uniforms.chanceScaleBits);
  let amountScale = bitcast<f32>(uniforms.amountScaleBits);
  let topBiasScale = bitcast<f32>(uniforms.topBiasScaleBits);
  let dropletDepositionRate = bitcast<f32>(uniforms.dropletDepositionRateBits);
  let deltaSec = max(0.0, deltaMs * 0.001);
  let yNorm = f32(gid.y) / max(1.0, f32(size.y - 1u));
  let maxX = i32(size.x) - 1;
  let maxY = i32(size.y) - 1;
  let px = i32(gid.x);
  let py = i32(gid.y);
  let up = textureLoad(wetnessIn, vec2<i32>(px, max(0, py - 1)), 0).r;
  let down = textureLoad(wetnessIn, vec2<i32>(px, min(maxY, py + 1)), 0).r;
  let left = textureLoad(wetnessIn, vec2<i32>(max(0, px - 1), py), 0).r;
  let right = textureLoad(wetnessIn, vec2<i32>(min(maxX, px + 1), py), 0).r;

  // Keep deposition deterministic but dt-aware so replay and realtime stay comparable.
  let verticalBias = mix(2.8 * topBiasScale, 0.05, yNorm);
  let depositChance = clamp(rate * deltaSec * 0.030 * verticalBias * chanceScale, 0.00008, 0.0072);
  let depositAmount = clamp((0.0022 + rate * 0.0007) * amountScale, 0.0018, 0.0049);

  let h = hash(gid.x * 1973u + gid.y * 9277u + uniforms.frame * 26699u + uniforms.seed * 17431u);
  let rnd = f32(h & 1023u) / 1023.0;

  // Coarse-cell spawning creates denser localized wet starts instead of uniform per-pixel noise.
  let cellSize = 14u;
  let cell = gid.xy / cellSize;
  let frameBucket = uniforms.frame / 3u;
  let cellHash = hash(cell.x * 13697u + cell.y * 19139u + frameBucket * 26699u + uniforms.seed * 17431u);
  let cellRnd = f32(cellHash & 4095u) / 4095.0;
  let centerX = f32((cellHash >> 4u) & 15u);
  let centerY = f32((cellHash >> 9u) & 15u);
  let local = vec2<f32>(f32(gid.x % cellSize) - centerX, f32(gid.y % cellSize) - centerY);
  let kernel = max(0.0, 1.0 - abs(local.x) * 0.34 - abs(local.y) * 0.14);
  let clusterChance = clamp(depositChance * 1.18, 0.00008, 0.0090);
  let clusterInjected = select(0.0, depositAmount * (0.40 + kernel * 0.70), cellRnd < clusterChance && kernel > 0.0);

  // Light sparse deposition keeps background dampness secondary to localized starts.
  let sparseInjected = select(0.0, depositAmount * 0.10, rnd < depositChance * 0.08);
  let drySeedInjected = select(0.0, depositAmount * 0.18, prior < 0.035 && cellRnd < depositChance * 0.70 && kernel > 0.45);

  // CPU-simulated droplets inject local kernels and downward trails.
  let uv = (vec2<f32>(gid.xy) + vec2<f32>(0.5, 0.5)) / vec2<f32>(f32(size.x), f32(size.y));
  var dropletInjected = 0.0;
  for (var i = 0u; i < uniforms.dropletCount; i = i + 1u) {
    let d = droplets[i];
    let dxy = d.xy;
    let mass = d.z;
    let vy = max(0.0, d.w);

    let dx = uv.x - dxy.x;
    let dy = uv.y - dxy.y;
    let radius = clamp(0.0020 + mass * 0.0080, 0.0020, 0.0105);
    let radialDist = sqrt(dx * dx + dy * dy);
    let core = max(0.0, 1.0 - radialDist / radius);

    let trailLen = clamp(radius * (1.1 + vy * 1.35), radius, 0.034);
    let tailDx = abs(dx);
    let tailDy = uv.y - dxy.y;
    let inTrail = select(0.0, 1.0, tailDy >= 0.0 && tailDy < trailLen);
    let trailWidth = radius * 0.20;
    let trail = inTrail * max(0.0, 1.0 - tailDx / max(0.0001, trailWidth)) * max(0.0, 1.0 - tailDy / max(0.0001, trailLen));

    dropletInjected += (core * 0.70 + trail * 1.32) * mass * dropletDepositionRate;
  }

  // Preserve a living mid-regime: gently support dry areas while shedding overly wet regions.
  let dryBoost = 1.0 + (1.0 - smoothstep(0.02, 0.12, prior)) * 0.60;
  let saturationGate = clamp(1.0 - smoothstep(0.22, 0.54, prior), 0.20, 1.0);
  let saturationBleed = max(0.0, prior - 0.58) * 0.016;
  let verticalChannel = max(0.0, up - prior) + max(0.0, prior - down) * 0.6;
  let channelFollow = smoothstep(0.004, 0.060, verticalChannel);
  let lateralSpread = abs(left - right);
  let lateralSuppress = 1.0 - smoothstep(0.02, 0.12, lateralSpread) * 0.30;
  let injected = (clusterInjected + sparseInjected + drySeedInjected + dropletInjected * (1.0 + channelFollow * 0.55)) * lateralSuppress;
  let nextWetness = clamp(prior + injected * dryBoost * saturationGate - saturationBleed, 0.0, 1.0);
  textureStore(wetnessOut, vec2<i32>(gid.xy), vec4<f32>(nextWetness, 0.0, 0.0, 1.0));
}
`
        }),
        entryPoint: "main"
      }
    });
  }

  public run(encoder: GPUCommandEncoder, state: SharedSurfaceState, dropletBuffer: GPUBuffer, inputs: DepositionPassInputs): void {
    const uniforms = new Uint32Array([
      inputs.frame,
      inputs.seed,
      floatBits(inputs.rainRate),
      floatBits(inputs.deltaMs),
      floatBits(inputs.chanceScale),
      floatBits(inputs.amountScale),
      floatBits(inputs.topBiasScale),
      inputs.dropletCount,
      floatBits(inputs.dropletDepositionRate),
      0,
      0,
      0
    ]);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

    const bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: state.currentReadView() },
        { binding: 1, resource: state.currentWriteView() },
        { binding: 2, resource: { buffer: this.uniformBuffer } },
        { binding: 3, resource: { buffer: dropletBuffer } }
      ]
    });

    const pass = encoder.beginComputePass({ label: "deposition-pass" });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(state.width / 8), Math.ceil(state.height / 8));
    pass.end();
    state.swap();
  }
}

function floatBits(value: number): number {
  const scratch = new ArrayBuffer(4);
  new Float32Array(scratch)[0] = value;
  return new Uint32Array(scratch)[0] ?? 0;
}
