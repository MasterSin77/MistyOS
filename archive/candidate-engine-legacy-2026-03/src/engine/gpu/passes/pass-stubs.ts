import type { EngineFrameContext } from "../../types";
import type { GpuPass } from "./pass-pipeline";

class LoggingPass implements GpuPass {
  public constructor(public readonly name: string) {}

  public run(context: EngineFrameContext): void {
    void context;
  }
}

export function createDefaultPasses(): GpuPass[] {
  return [
    new LoggingPass("deposition"),
    new LoggingPass("advection"),
    new LoggingPass("coalescence"),
    new LoggingPass("disturbance"),
    new LoggingPass("evaporation"),
    new LoggingPass("optical-derivatives")
  ];
}
