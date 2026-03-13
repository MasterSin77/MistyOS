# Phase 1 Progress Log

Date started: 2026-03-12
Status: In Progress

## Goal

Reduce CPU cost in the existing CPU architecture while keeping behavior and visual output stable.

## Completed Work

- Added a `toImageData` optimization in `src/engine/SurfaceWetnessField.js`:
  - Cache fog tint key.
  - Skip redundant RGB channel rewrites when tint is unchanged.
  - Continue updating alpha per pixel each frame/dirty region.
  - Force full-field RGB refresh only when tint changes or RGB is uninitialized.
- Added hot-loop arithmetic reductions in `src/engine/SurfaceWetnessField.js`:
  - Reduced repeated row index multiplications in `diffusePass` and `toImageData` loops.
  - Removed row-wise `subarray` view creation in diffusion copy-back and switched to direct index copy.
  - Cached reciprocal max wetness for normalization.
- Tightened recovery dirty propagation in `src/engine/SurfaceWetnessField.js`:
  - Track per-pixel changes during `addCondensation` recovery.
  - Union only changed bounds into `imageDirtyRect` instead of always unioning the full processed region.
  - Preserve full-field recovery behavior when explicitly requested.
- Added configurable full refresh cadence in `src/engine/WetSurfaceEngine.js` + `src/tuning/tuningConfig.js`:
  - New debug control: `debug.wetnessFullRefreshIntervalFrames`.
  - Runtime now uses configured interval for periodic forced full refresh.
  - Default restored to `120` frames to preserve baseline behavior safety.
- Added sparse-cell recovery skip in `src/engine/SurfaceWetnessField.js`:
  - In `addCondensation`, skip recovery math when `grid`, `trailGrid`, and `runnerMemoryGrid` are all exactly zero for a cell.
  - Keeps behavior unchanged for zero-state cells while reducing no-op arithmetic.

## Validation

- Build check passed: `npm run build`.
- Post-change probe capture artifact:
  - `artifacts/phase0/phase1-probe-2026-03-12.json`
  - `artifacts/phase0/phase1-probe-2-2026-03-12.json`
  - `artifacts/phase0/phase1-probe-3-2026-03-12.json`
  - `artifacts/phase0/phase1-probe-4-2026-03-12.json`
  - `artifacts/phase0/phase1-probe-5-2026-03-12.json`

Probe highlights (headless, directional only):

- Ulrawide Scene E wetness ms moved from `464.87` (Phase 0 baseline) to `283.33` in probe 2.
- Ulrawide Scene E avgFrameMs moved from `416.42` (Phase 0 baseline) to `278.03` in probe 2.
- Image convert ms generally improved while diffusion remains dominant.
- Probe 3 remains directionally improved vs Phase 0 baseline (Scene E wetness `384.15`, avg frame `358.71`) but regresses vs probe 2, reinforcing run-to-run variance.
- Probe 4 (with temporary default interval adjustment) was noisier and not adopted as default behavior.
- Probe 5 shows directional improvement vs Phase 0 baseline in idle and ultrawide scenes (`E` wetness `332.83` vs baseline `464.87`), while still exhibiting headless run variance.

## Notes

- Headless browser automation shows high variance and should not be used alone as a pass/fail gate.
- Authoritative Phase 1 success decision should include interactive desktop re-check against Phase 0 baseline.

## Next Work Items

- Reduce avoidable full-field refresh cadence while preserving parity.
- Tighten diffusion/image region scopes when activity is sparse.
- Re-run metrics with separate artifact output using `OUT_JSON` to keep snapshots immutable.
- Validate one interactive desktop sample before declaring Phase 1 complete.
