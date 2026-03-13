# Phase 3 Progress Log

Date started: 2026-03-12
Status: Completed (2026-03-12)

## Goal

Move fog compositing further onto GPU while keeping wetness simulation mostly CPU for now.

## Implemented

- Added debug toggle: `debug.useGpuFogCompositing` in `src/tuning/tuningConfig.js`.
- Extended GPU overlay shader in `src/engine/WetSurfaceEngine.js`:
  - Added in-shader compositing mode for fog alpha, tint gradient, and fill boost.
  - Preserved Phase 2 mode by retaining CPU tint/fill fallback path when Phase 3 toggle is off.
- Added backend telemetry label in HUD stats:
  - `overlayBackend=gpu-fog-composite` when Phase 3 mode is active.
- Extended capture automation in `scripts/capture-phase0-baseline.mjs`:
  - `FORCE_GPU_FOG_COMPOSITING=1` to force Phase 3 path in captures.

## Artifacts

- Phase 3 starter probe: `artifacts/phase3/gpu-fog-composite-probe-1-2026-03-12.json`
- CPU fallback probe: `artifacts/phase3/cpu-fallback-probe-2026-03-12.json`
- GPU fog compositing probe: `artifacts/phase3/gpu-fog-composite-probe-2-2026-03-12.json`
- GPU fog compositing compare verify: `artifacts/phase3/gpu-fog-composite-compare-verify-2026-03-12.json`

## Directional Snapshot (Headless)

- Scene E ultrawide directional samples:
  - Phase 2 GPU overlay prototype probe: frame `314.75ms`, wetness `323.79ms`
  - Phase 3 CPU fallback probe: frame `272.4ms`, wetness `279.29ms`, backend `cpu-2d`
  - Phase 3 forced GPU fog compositing probe: frame `229.68ms`, wetness `233.16ms`, backend `gpu-fog-composite`
- Scene D split-compare directional samples:
  - Phase 3 CPU fallback probe: frame `123.37ms`, wetness `122.75ms`
  - Phase 3 forced GPU fog compositing probe: frame `109.61ms`, wetness `109.84ms`
  - Phase 3 compare verify probe: frame `131.14ms`, wetness `133ms`, backend `cpu-gpu-compare`
- Directional result: Phase 3 compositing is operational with measurable wins in probe runs, while wetness simulation still dominates CPU time.

## Notes

- This is an incremental Phase 3 starter and does not yet remove CPU wetness-field image generation.
- CPU fallback and Phase 2 prototype modes remain available for safety.

## Next Work Items (Phase 4 Pull)

- Begin GPU wetness simulation scaffolding behind a dedicated Phase 4 flag.
- Preserve CPU wetness path as immediate rollback and parity reference.
- Define first calibration checkpoints for recovery/diffusion/disturbance parity before defaulting any runtime path.
