# Phase 2 Progress Log

Date started: 2026-03-12
Status: Completed

## Goal

Add a GPU-backed overlay path behind a debug flag with no behavior-model replacement.

## Implemented

- Added debug toggle: `debug.useGpuOverlayPrototype` in `src/tuning/tuningConfig.js`.
- Added GPU overlay prototype in `src/engine/WetSurfaceEngine.js`:
  - New `drawSurfaceGpuPrototype()` WebGL path.
  - GPU path uploads `fogCanvas` to texture and draws overlay in WebGL.
  - Existing tint/fill compositing logic is preserved to keep comparison fair.
  - CPU `drawSurfaceCpu()` path remains default and fallback.
- Added HUD line in `src/App.jsx`:
  - `Overlay backend: cpu-2d | gpu-prototype`.
- Updated `scripts/capture-phase0-baseline.mjs`:
  - Supports `FORCE_GPU_OVERLAY=1`.
  - Supports custom `OUT_JSON` path with auto directory creation.

## Artifacts

- CPU overlay probe: `artifacts/phase2/cpu-overlay-probe-2026-03-12.json`
- GPU overlay probe: `artifacts/phase2/gpu-overlay-probe-2026-03-12.json`
- GPU backend telemetry verify: `artifacts/phase2/gpu-overlay-backend-verify-2026-03-12.json`
- Overlay compare telemetry verify: `artifacts/phase2/overlay-backend-compare-verify-2026-03-12.json`

## Directional Snapshot (Headless)

- Scene E ultrawide:
  - CPU probe wetness: `250.42ms`, frame: `245.68ms`
  - GPU probe wetness: `323.79ms`, frame: `314.75ms`
- Overlay stage remained small in both runs; current bottleneck is still mostly wetness CPU simulation.

## Notes

- This phase is prototype-level by design and does not move wetness simulation off CPU.
- Headless captures validate path execution but do not replace interactive visual parity checks.
- Backend telemetry capture confirms `overlayBackend=gpu-prototype` during GPU-forced runs.
- Compare-mode telemetry capture confirms `overlayBackend=cpu-gpu-compare` when `overlayBackendCompareEnabled` is forced.

## Next Work Items

- Phase 2 completion recorded in `PHASES.md`.
- Phase 3 pulled and tracked in `docs/PHASE3_PROGRESS.md`.
