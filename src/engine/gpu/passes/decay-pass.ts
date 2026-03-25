import type { SharedSurfaceState } from "../state/shared-surface";

export interface DecayPassInputs {
  deltaMs: number;
  decayScale: number;
  runoffScale: number;
  retentionScale: number;
}

export class DecayPass {
  private readonly pipeline: GPUComputePipeline;
  private readonly uniformBuffer: GPUBuffer;
  private readonly bindGroupLayout: GPUBindGroupLayout;

  public constructor(private readonly device: GPUDevice) {
    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "r32float" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rg32float" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "r32float" } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } }
      ]
    });

    this.uniformBuffer = this.device.createBuffer({
      label: "decay-uniforms",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    this.pipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      compute: {
        module: this.device.createShaderModule({
          code: `
struct Uniforms {
  deltaMsBits: u32,
  decayScaleBits: u32,
  runoffScaleBits: u32,
  retentionScaleBits: u32,
};

@group(0) @binding(0) var wetnessIn: texture_2d<f32>;
@group(0) @binding(1) var wetnessOut: texture_storage_2d<r32float, write>;
@group(0) @binding(2) var flowIn: texture_2d<f32>;
@group(0) @binding(3) var flowOut: texture_storage_2d<rg32float, write>;
@group(0) @binding(4) var disturbanceIn: texture_2d<f32>;
@group(0) @binding(5) var disturbanceOut: texture_storage_2d<r32float, write>;
@group(0) @binding(6) var<uniform> uniforms: Uniforms;

fn readClamped(pos: vec2<i32>, size: vec2<i32>) -> f32 {
  let clamped = clamp(pos, vec2<i32>(0, 0), size - vec2<i32>(1, 1));
  return textureLoad(wetnessIn, clamped, 0).r;
}

fn readFlowClamped(pos: vec2<i32>, size: vec2<i32>) -> vec2<f32> {
  let clamped = clamp(pos, vec2<i32>(0, 0), size - vec2<i32>(1, 1));
  return textureLoad(flowIn, clamped, 0).xy;
}

fn readDisturbanceClamped(pos: vec2<i32>, size: vec2<i32>) -> f32 {
  let clamped = clamp(pos, vec2<i32>(0, 0), size - vec2<i32>(1, 1));
  return textureLoad(disturbanceIn, clamped, 0).r;
}

fn signNonZero(v: f32) -> i32 {
  return select(-1, 1, v >= 0.0);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = textureDimensions(wetnessOut);
  if (gid.x >= dims.x || gid.y >= dims.y) {
    return;
  }

  let deltaMs = bitcast<f32>(uniforms.deltaMsBits);
  let decayScale = bitcast<f32>(uniforms.decayScaleBits);
  let runoffScale = bitcast<f32>(uniforms.runoffScaleBits);
  let retentionScale = bitcast<f32>(uniforms.retentionScaleBits);
  let pos = vec2<i32>(gid.xy);
  let size = vec2<i32>(dims);
  let yNorm = f32(pos.y) / max(1.0, f32(size.y - 1));

  let center = readClamped(pos, size);
  let centerFlow = readFlowClamped(pos, size);
  let centerDisturbance = readDisturbanceClamped(pos, size);
  let up = readClamped(pos + vec2<i32>(0, -1), size);
  let up2 = readClamped(pos + vec2<i32>(0, -2), size);
  let down = readClamped(pos + vec2<i32>(0, 1), size);
  let left = readClamped(pos + vec2<i32>(-1, 0), size);
  let right = readClamped(pos + vec2<i32>(1, 0), size);
  let flowUp = readFlowClamped(pos + vec2<i32>(0, -1), size);
  let flowDown = readFlowClamped(pos + vec2<i32>(0, 1), size);
  let flowLeft = readFlowClamped(pos + vec2<i32>(-1, 0), size);
  let flowRight = readFlowClamped(pos + vec2<i32>(1, 0), size);
  let disturbanceUp = readDisturbanceClamped(pos + vec2<i32>(0, -1), size);
  let disturbanceDown = readDisturbanceClamped(pos + vec2<i32>(0, 1), size);
  let disturbanceLeft = readDisturbanceClamped(pos + vec2<i32>(-1, 0), size);
  let disturbanceRight = readDisturbanceClamped(pos + vec2<i32>(1, 0), size);

  // Split transport into two regimes: thin-film local merge first, then runner concentration after accumulation.
  let localMean = (center + up + down + left + right) * 0.2;
  let verticalGradient = max(0.0, up - center) + max(0.0, up2 - up) * 0.7;
  let filmReservoir = localMean + max(0.0, center - 0.06) * 0.36 + verticalGradient * 0.30;
  let runnerGate = smoothstep(0.16, 0.42, filmReservoir);
  let filmGate = 1.0 - runnerGate;

  let filmMix = center * 0.34 + up * 0.18 + down * 0.18 + left * 0.15 + right * 0.15;
  let filmMerge = max(0.0, localMean - center) * (0.12 + filmGate * 0.18);
  let filmEqualize = (max(0.0, left - center) + max(0.0, right - center) + max(0.0, up - center) + max(0.0, down - center)) * (0.04 + filmGate * 0.07);

  let runnerMix = center * 0.28 + up * 0.39 + up2 * 0.14 + left * 0.095 + right * 0.095;
  let elongation = max(0.0, up - center) * 0.18 + max(0.0, up2 - up) * 0.09;
  let runoff = (max(0.0, up - 0.030) * 0.095 + max(0.0, up2 - 0.040) * 0.044) * runoffScale;
  let channelCarry = verticalGradient * (0.03 + center * 0.08 + runnerGate * 0.18);
  let downLink = max(0.0, min(center, up) - down);
  let wetPathPull = max(0.0, down - center) * (0.010 + runnerGate * 0.054 + smoothstep(0.01, 0.14, verticalGradient + downLink * 0.8) * 0.018);

  let decay = max(0.0, 1.0 - (deltaMs * 0.0028 * decayScale));
  let gravityDrain = mix(0.00022, 0.00110, yNorm);
  let gravityDrainBlended = gravityDrain * (0.30 + runnerGate * 0.70);
  let neighborhoodMean = (center + up + down + left + right) * 0.2;
  let uniformity = max(0.0, 0.030 - abs(center - neighborhoodMean));
  let saturationDrain = max(0.0, center - 0.46) * (0.020 + uniformity * 0.26) * runoffScale;
  let bottomOutflow = smoothstep(0.78, 1.0, yNorm) * max(0.0, center - 0.08) * 0.035;
  let horizontalFlat = max(0.0, 0.03 - abs(left - right));
  let puddleWidening = max(0.0, center - (up + down) * 0.5) * (0.03 + horizontalFlat * 0.9);
  let flowStrength = clamp(length(centerFlow) * 24.0, 0.0, 1.0);
  let advectionStep = clamp(deltaMs * 0.00034 * (1.0 + flowStrength * 0.55 + centerDisturbance * 0.16), 0.0, 0.026);
  let sourcePos = vec2<i32>(
    clamp(i32(round(f32(pos.x) - centerFlow.x * advectionStep * f32(size.x))), 0, size.x - 1),
    clamp(i32(round(f32(pos.y) - centerFlow.y * advectionStep * f32(size.y))), 0, size.y - 1)
  );
  let advectedByFlow = readClamped(sourcePos, size);
  let stepX = signNonZero(centerFlow.x);
  let stepY = signNonZero(centerFlow.y);
  let alongFlow = readClamped(pos + vec2<i32>(stepX, stepY), size);
  let againstFlow = readClamped(pos - vec2<i32>(stepX, stepY), size);
  let directionalPull = max(0.0, againstFlow - center) * (0.014 + flowStrength * (0.05 + runnerGate * 0.08));
  let directionalPush = max(0.0, center - alongFlow) * (0.012 + flowStrength * 0.07);
  let lateralConvergence = (max(0.0, left - center) + max(0.0, right - center)) * (0.015 + runnerGate * 0.095);

  // Bridge nearby wet neighbors so isolated blobs begin connecting into directional structures.
  let bridgeX = min(left, right);
  let bridgeY = min(up, down) + downLink * 0.22;
  let bridgeAlongFlow = min(alongFlow, againstFlow);
  let bridgeTarget = max(max(bridgeX, bridgeY), bridgeAlongFlow);
  let verticalCoherence = smoothstep(0.010, 0.14, verticalGradient + downLink * 0.8);
  let beadBridge = max(0.0, min(up, down) - center);
  let beadPeak = max(0.0, center - (up + down) * 0.5);
  let widthNoise = 0.90 + fract(sin(dot(vec2<f32>(f32(pos.x), f32(pos.y)), vec2<f32>(12.9898, 78.233))) * 43758.5453) * 0.22;
  let coalescence = max(0.0, bridgeTarget - center) * (0.05 + flowStrength * 0.10 + verticalCoherence * (0.04 + runnerGate * 0.08) + centerDisturbance * 0.018) * widthNoise + beadBridge * (0.016 + verticalCoherence * 0.014 + filmGate * 0.022);

  let disturbanceMean = (centerDisturbance + disturbanceUp + disturbanceDown + disturbanceLeft + disturbanceRight) * 0.2;
  let disturbanceBoost = disturbanceMean * (0.010 + flowStrength * 0.014);

  let filmTransport = filmMix + filmMerge + filmEqualize + coalescence * 0.35;
  let runnerTransport = runnerMix + elongation + runoff + channelCarry + advectedByFlow * (0.08 + flowStrength * (0.12 + runnerGate * 0.10)) + directionalPull + coalescence + wetPathPull + lateralConvergence;
  let transported = mix(filmTransport, runnerTransport, runnerGate) + disturbanceBoost;
  let drained = max(0.0, transported * decay - (gravityDrainBlended + localMean * 0.004 + saturationDrain + bottomOutflow + puddleWidening + directionalPush + beadPeak * 0.020));
  let retention = max(0.0, center - 0.036) * 0.054 * retentionScale;
  let antiPool = max(0.0, center - down) * (0.026 + runnerGate * 0.022);
  let nextWetness = clamp(drained + retention + antiPool, 0.0, 1.0);

  let localGradient = vec2<f32>(right - left, down - up);
  let neighborFlow = (flowUp + flowDown + flowLeft + flowRight) * 0.25;
  let wetnessDelta = nextWetness - center;
  let transportGradient = vec2<f32>(alongFlow - againstFlow, down - up);
  let disturbanceFlowKick = vec2<f32>(centerFlow.x * centerDisturbance * 0.0018, centerDisturbance * 0.0032);
  let nextFlow = clamp(
    centerFlow * 0.952
      + neighborFlow * 0.044
      + localGradient * (0.014 * filmGate + 0.006 * runnerGate)
      + transportGradient * (0.004 + flowStrength * (0.010 + runnerGate * 0.014))
      + vec2<f32>(0.0, wetnessDelta * (0.030 + runnerGate * 0.022))
      + disturbanceFlowKick,
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(1.0, 1.0)
  );

  let nextDisturbance = clamp(
    max(
      centerDisturbance * (1.0 - clamp(deltaMs * 0.0095, 0.0, 0.65)),
      disturbanceMean * 0.05
    ),
    0.0,
    1.0
  );

  textureStore(wetnessOut, pos, vec4<f32>(nextWetness, 0.0, 0.0, 1.0));
  textureStore(flowOut, pos, vec4<f32>(nextFlow, 0.0, 1.0));
  textureStore(disturbanceOut, pos, vec4<f32>(nextDisturbance, 0.0, 0.0, 1.0));
}
`
        }),
        entryPoint: "main"
      }
    });
  }

  public run(encoder: GPUCommandEncoder, state: SharedSurfaceState, inputs: DecayPassInputs): void {
    const uniforms = new Uint32Array([
      floatBits(inputs.deltaMs),
      floatBits(inputs.decayScale),
      floatBits(inputs.runoffScale),
      floatBits(inputs.retentionScale)
    ]);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

    const bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: state.currentReadView() },
        { binding: 1, resource: state.currentWriteView() },
        { binding: 2, resource: state.currentFlowReadView() },
        { binding: 3, resource: state.currentFlowWriteView() },
        { binding: 4, resource: state.currentDisturbanceReadView() },
        { binding: 5, resource: state.currentDisturbanceWriteView() },
        { binding: 6, resource: { buffer: this.uniformBuffer } }
      ]
    });

    const pass = encoder.beginComputePass({ label: "decay-pass" });
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
