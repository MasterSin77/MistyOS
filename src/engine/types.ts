export type HarnessMode = "realtime" | "deterministic";

export interface ScenarioTuning {
  depositionChanceScale: number;
  depositionAmountScale: number;
  depositionTopBias: number;
  decayRateScale: number;
  runoffScale: number;
  retentionScale: number;
  overlaySpotScale: number;
  dropletSpawnRate: number;
  dropletMass: number;
  dropletSlipThreshold: number;
  dropletMergeRadius: number;
  dropletDepositionRate: number;
  anisotropicTransport: number;
  trailMemory: number;
  slipRelease: number;
  channelAttraction: number;
  mergeToRunnel: number;
}

export interface ScenarioManifest {
  id: string;
  description: string;
  resolution: {
    width: number;
    height: number;
  };
  fixedDeltaMs: number;
  totalFrames: number;
  seed: number;
  background: {
    style: "solid";
    color: string;
  };
  rain: {
    ratePerSecond: number;
  };
  tuning?: ScenarioTuning;
}

export interface FrameStats {
  frame: number;
  simulationMs: number;
  renderMs: number;
  frameMs: number;
  simulationClock?: {
    simulatedTimeMs: number;
    wallTimeMs: number;
    simToWallRatio: number;
    throttled: boolean;
    threshold: number;
  };
  motionSanityError?: string;
  comparisonReadiness?: {
    renderMode: "comparison" | "debug-wetness";
    backgroundApplied: boolean;
    backgroundMeanLuma: number;
  };
  motionSanity?: {
    sampledFrame: number;
    sampledTexels: number;
    meanWetness: number;
    variance: number;
    activeRatio: number;
    temporalDelta: number;
    sampleIntervalFrames: number;
    classification: "dry" | "low-motion" | "structured-motion";
  };
}

export interface EngineFrameContext {
  frame: number;
  deltaMs: number;
  scenario: ScenarioManifest;
}

export interface EngineInterface {
  readonly view: HTMLCanvasElement;
  update(context: EngineFrameContext): void;
  render(context: EngineFrameContext): void;
  collectStats(context: EngineFrameContext): FrameStats;
  captureStateHash?(): Promise<string>;
  setBackgroundDataUrl?(dataUrl: string): Promise<void>;
  setRenderMode?(mode: "comparison" | "debug-wetness"): void;
}

export interface HarnessController {
  readonly view: HTMLElement;
  start(): void;
  stop(): void;
}
