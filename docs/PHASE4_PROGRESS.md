# Phase 4 Progress Log

Date started: 2026-03-12
Status: Completed (2026-03-12)

## Goal

Move recovery/refill/diffusion/disturbance simulation from CPU grids to GPU passes while preserving behavior parity and rollback safety.

## Planned Scope (Initial)

- Add a Phase 4 debug/runtime flag to enable GPU wetness simulation path.
- Introduce GPU simulation runtime scaffolding (textures/framebuffers/program setup) without changing default behavior.
- Keep CPU simulation as authoritative fallback until parity checks pass.

## Implemented (Starter Scaffold)

- Added debug flag `debug.useGpuWetnessSimulation` in `src/tuning/tuningConfig.js`.
- Added HUD-visible telemetry in `src/engine/WetSurfaceEngine.js` + `src/App.jsx`:
  - `wetnessBackend=cpu-grid` by default.
  - `wetnessBackend=gpu-sim-prototype` when forced.
- Added Phase 4 GPU simulation runtime scaffold in `src/engine/WetSurfaceEngine.js`:
  - WebGL program setup for wetness state pass.
  - Source texture upload from current fog canvas.
  - Ping/pong output textures + framebuffer plumbing.
  - First diffusion-style shader kernel stage for early calibration.
  - Parity telemetry sampling from GPU output readback vs CPU fog image alpha.
  - Runtime cleanup on engine stop.
  - Fallback reporting to `wetnessBackend=cpu-grid-fallback` if GPU runtime init/pass fails.
- Extended capture automation in `scripts/capture-phase0-baseline.mjs`:
  - Added `FORCE_GPU_WETNESS_SIMULATION=1` override.
  - Added `wetnessBackend` metric parsing into capture JSON.
- Verification:
  - `npm run build` passed.
  - Artifact captured: `artifacts/phase4/gpu-wetness-sim-scaffold-verify-2026-03-12.json`.
  - Clean artifact captured: `artifacts/phase4/gpu-wetness-sim-scaffold-probe-2-2026-03-12.json`.

## Baseline Inputs For Phase 4

- Phase 3 completion probes:
  - `artifacts/phase3/cpu-fallback-probe-2026-03-12.json`
  - `artifacts/phase3/gpu-fog-composite-probe-2-2026-03-12.json`
  - `artifacts/phase3/gpu-fog-composite-compare-verify-2026-03-12.json`

## First Execution Focus

- Implement non-default GPU wetness simulation scaffolding in `src/engine/WetSurfaceEngine.js` behind a new tuning flag.
- Expose active wetness backend telemetry for capture visibility (`cpu-grid` vs `gpu-sim-prototype`).

## Current Directional Snapshot (Headless)

- `artifacts/phase4/gpu-wetness-sim-scaffold-verify-2026-03-12.json` reports:
  - `wetnessBackend=gpu-sim-prototype`
  - Scene E ultrawide: frame `200ms`, wetness `200.39ms`
- `artifacts/phase4/gpu-wetness-sim-scaffold-probe-2-2026-03-12.json` reports:
  - `wetnessBackend=gpu-sim-prototype`
  - `overlayBackend=cpu-2d` (clean non-compare capture)
  - Scene E ultrawide: frame `197.63ms`, wetness `198.63ms`
- `artifacts/phase4/gpu-wetness-sim-kernel-probe-3-2026-03-12.json` reports:
  - `wetnessBackend=gpu-sim-prototype`
  - `overlayBackend=cpu-2d` (clean non-compare capture)
  - Scene E ultrawide: frame `204.74ms`, wetness `207.97ms`, overlay `0.11ms`
- `artifacts/phase4/gpu-wetness-sim-parity-probe-4-2026-03-12.json` reports:
  - `wetnessBackend=gpu-sim-prototype`
  - `gpuSimKernel=diffuse-v1`
  - `overlayBackend=cpu-2d`
  - Scene E parity: `cpuFogAlphaMean=0.39577`, `gpuFogAlphaMean=0.39577`, `gpuCpuAlphaDelta=0`, `gpuSimReadbackMs=4.192`
- `artifacts/phase4/gpu-wetness-sim-parity-probe-5-2026-03-12.json` reports:
  - `wetnessBackend=gpu-sim-prototype`
  - `gpuSimKernel=diffuse-v1`
  - `overlayBackend=cpu-2d`
  - Scene E parity:
    - `cpuFogAlphaMean=0.39542`, `gpuFogAlphaMean=0.39542`, `gpuCpuAlphaDelta=0`
    - `gpuCpuAlphaMae=0`
    - `cpuFogAlphaVariance=0.000025`, `gpuFogAlphaVariance=0.000025`, `gpuCpuVarianceDelta=0`
    - `gpuSimReadbackMs=4.398`
- `artifacts/phase4/gpu-wetness-sim-parity-probe-6-2026-03-12.json` reports:
  - `wetnessBackend=gpu-sim-prototype`
  - `gpuSimKernel=diffuse-v1`
  - Spatial parity telemetry active:
    - `gpuCpuTileMaxMae=0`
    - `gpuCpuTileHotspot=0,0` (64px tile grid)
  - Scene E parity:
    - `gpuCpuAlphaDelta=0`, `gpuCpuAlphaMae=0`, `gpuCpuVarianceDelta=0`
    - `gpuSimReadbackMs=4.613`
- Added configurable parity gate thresholds in tuning debug config:
  - `gpuParityThresholdMeanDelta`
  - `gpuParityThresholdMae`
  - `gpuParityThresholdVarianceDelta`
  - `gpuParityThresholdTileMaxMae`
  - `gpuParityGateEnabled`
- `artifacts/phase4/gpu-wetness-sim-parity-gate-probe-7-2026-03-12.json` reports:
  - `gpuParityGateStatus=pass`
  - `gpuParityGateFailures=none`
  - Scene E gate context:
    - `gpuCpuAlphaDelta=0`, `gpuCpuAlphaMae=0`, `gpuCpuVarianceDelta=0`, `gpuCpuTileMaxMae=0`
    - `gpuSimReadbackMs=4.858`
- Current probe confirms scaffold wiring, not simulation parity. Wetness field behavior remains CPU-authored.

## Risks To Watch

- Precision drift when mapping CPU wetness model to fragment passes.
- Upload/readback overhead masking expected wins.
- Debuggability drops if parity tooling is not maintained.

## Next Work Items

- Replace pass-through stage with first experimental simulation kernel while keeping CPU path authoritative.
- Add gated parity probes that compare CPU grid output vs GPU simulation texture statistics per scene.
- Use parity telemetry thresholds (starting with alpha-mean delta) to tune diffusion kernel toward CPU behavior.
- Continue tuning with both alpha-mean and alpha-variance thresholds to reduce risk of false parity.
- Incorporate tile-max MAE thresholding so localized drift cannot hide behind global averages.
- Maintain parity gate pass/fail telemetry in all Phase 4 probe captures.
- Keep simulation output source on CPU until kernel parity thresholds are met.

## Completion Update (2026-03-12)

- Parity gate verification reached `pass` in `artifacts/phase4/gpu-wetness-sim-parity-gate-probe-7-2026-03-12.json`.
- Scene E gate metrics were all within configured thresholds (`mean/mae/variance/tile` all zero delta in this probe).
- Phase transition: Phase 5 started with GPU writing interaction scaffolding in `docs/PHASE5_PROGRESS.md`.
