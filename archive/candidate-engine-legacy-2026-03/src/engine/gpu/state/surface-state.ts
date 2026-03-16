export interface SurfaceStateLayout {
  wetnessTexture: "r16float" | "r8unorm";
  flowTexture: "rg16float" | "rg8unorm";
  disturbanceTexture: "r16float" | "r8unorm";
  dropletDensityTexture: "r16float" | "r8unorm";
  opticalGradientTexture: "rg16float" | "rg8unorm";
}

export const DEFAULT_SURFACE_STATE_LAYOUT: SurfaceStateLayout = {
  wetnessTexture: "r16float",
  flowTexture: "rg16float",
  disturbanceTexture: "r16float",
  dropletDensityTexture: "r16float",
  opticalGradientTexture: "rg16float"
};
