import type { EngineFrameContext } from "../../types";

export interface GpuPass {
  readonly name: string;
  run(context: EngineFrameContext): void;
}

export class PassPipeline {
  public constructor(private readonly passes: GpuPass[]) {}

  public execute(context: EngineFrameContext): void {
    for (const pass of this.passes) {
      pass.run(context);
    }
  }
}
