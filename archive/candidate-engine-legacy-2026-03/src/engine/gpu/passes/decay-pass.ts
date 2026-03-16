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
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } }
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
@group(0) @binding(2) var<uniform> uniforms: Uniforms;

fn readClamped(pos: vec2<i32>, size: vec2<i32>) -> f32 {
  let clamped = clamp(pos, vec2<i32>(0, 0), size - vec2<i32>(1, 1));
  return textureLoad(wetnessIn, clamped, 0).r;
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
  let up = readClamped(pos + vec2<i32>(0, -1), size);
  let up2 = readClamped(pos + vec2<i32>(0, -2), size);
  let down = readClamped(pos + vec2<i32>(0, 1), size);
  let left = readClamped(pos + vec2<i32>(-1, 0), size);
  let right = readClamped(pos + vec2<i32>(1, 0), size);

  // Pulling from rows above each pixel creates a simple gravity-biased flow pattern.
  let advected = center * 0.32 + up * 0.40 + up2 * 0.16 + left * 0.06 + right * 0.06;
  let elongation = max(0.0, up - center) * 0.18 + max(0.0, up2 - up) * 0.09;
  let decay = max(0.0, 1.0 - (deltaMs * 0.0028 * decayScale));
  let gravityDrain = mix(0.00022, 0.00110, yNorm);
  let runoff = (max(0.0, up - 0.030) * 0.095 + max(0.0, up2 - 0.040) * 0.044) * runoffScale;
  let verticalGradient = max(0.0, up - center) + max(0.0, up2 - up) * 0.7;
  let channelCarry = verticalGradient * (0.08 + center * 0.20);
  let neighborhoodMean = (center + up + down + left + right) * 0.2;
  let uniformity = max(0.0, 0.030 - abs(center - neighborhoodMean));
  let saturationDrain = max(0.0, center - 0.46) * (0.020 + uniformity * 0.26) * runoffScale;
  let bottomOutflow = smoothstep(0.78, 1.0, yNorm) * max(0.0, center - 0.08) * 0.035;
  let horizontalFlat = max(0.0, 0.03 - abs(left - right));
  let puddleWidening = max(0.0, center - (up + down) * 0.5) * (0.03 + horizontalFlat * 0.9);
  let drained = max(0.0, (advected + elongation + runoff + channelCarry) * decay - (gravityDrain + advected * 0.006 + saturationDrain + bottomOutflow + puddleWidening));
  let retention = max(0.0, center - 0.036) * 0.054 * retentionScale;
  let antiPool = max(0.0, center - down) * 0.045;
  let nextWetness = clamp(drained + retention + antiPool, 0.0, 1.0);

  textureStore(wetnessOut, pos, vec4<f32>(nextWetness, 0.0, 0.0, 1.0));
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
        { binding: 2, resource: { buffer: this.uniformBuffer } }
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
