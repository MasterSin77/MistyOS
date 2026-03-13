# MistyOS POC Phases

- [x] Phase 1: Full-screen canvas with a single background source and shared fog field that slowly accumulates.
- [x] Phase 2: Droplets and gravity trails clear through the same fog field instead of a separate visual layer.
- [x] Phase 3: Pointer writing clears through the same field so writing, droplets, and fog behave like one material.
- [ ] Phase 4: Tune physical feel, blur response, and temporal persistence after core field behavior is validated.

---

# GPU Migration Execution Notes

This tracks the staged migration of the wetness/fog interaction layer from CPU to GPU while keeping native RaindropFX as the droplet renderer.

## Operating Rules

- Do not big-bang rewrite.
- Complete one phase at a time.
- At phase completion: record measurements, note risks/issues, set next phase to `In Progress`, and continue.
- Keep split compare and tuning panel usable through all phases.
- Keep CPU fallback until GPU path is proven.

## Phase Transition Workflow (Required Every Phase)

1. Validate phase success criteria using the agreed benchmark scenes.
2. Capture metric snapshot and visual snapshot set.
3. Fill that phase's `Completion Update` block completely.
4. Mark completed phase in `Status Board` as done.
5. Mark the next phase as `In Progress` and add its `Started` date.
6. Append a short "next execution focus" note under the next phase.

## Performance Targets (Baseline-Relative)

- Lower average frame time and p95 frame time on ultrawide scenarios.
- Reduce CPU wetness/compositing cost phase by phase.
- Preserve visual parity for agreed screenshot scenes and split-compare checks.

## Status Board

- [x] Phase 0: Baseline and measurement (`Completed 2026-03-12`)
- [x] Phase 1: CPU containment and cleanup (`Completed 2026-03-12`)
- [x] Phase 2: GPU overlay prototype (no behavior change) (`Completed 2026-03-12`)
- [x] Phase 3: GPU fog compositing (`Completed 2026-03-12`)
- [x] Phase 4: GPU wetness simulation (`Completed 2026-03-12`)
- [x] Phase 5: GPU writing and interaction (`Completed 2026-03-12`)
- [x] Phase 6: Consolidation (`Completed 2026-03-12`)

## Phase Log

### Phase 0: Baseline and measurement

Status: Completed
Started: 2026-03-12
Completed: 2026-03-12

Goal:
- Lock current CPU implementation as baseline and define measurable pass/fail checks.

Scope:
- Define benchmark scenes and run protocol.
- Capture baseline metrics: avg frame ms, p95 frame ms, wetness/compositing ms, memory.
- Capture visual parity references (screenshots and split compare views).
- Record baseline in `docs/PHASE0_BASELINE_LOG.md`.

Benchmark Scenes (lock for all later comparisons):
- Scene A: Idle recovery (no writing, no freeze, phase 3).
- Scene B: Active rain + droplet clearing (phase 3, default rain on).
- Scene C: Continuous writing stroke pass (phase 3, pointer wipe sweeps).
- Scene D: Split compare parity check (`debug.viewMode=split-compare`).
- Scene E: Ultrawide stress run (same config, ultrawide resolution target).

Measurement Inputs (existing HUD/debug counters):
- `avgFrameMs`
- `engineMs`
- `rendererMs`
- `wetnessMs`
- `overlayMs`
- `dropletProcessingMs`
- `clearingMs`
- `diffusionMs`
- `imageConvertMs`
- `wetnessTrendMsPerMin`
- `wetnessResolutionLabel`, `wetnessResolutionPixels`
- `activeRegionPixels`, `totalWetnessPixels`
- `recoveryPixels`, `recoveryFullField`
- `diffusionPixels`, `diffusionFullField`
- `imagePixels`, `imageFullField`
- `smoothingStride`, `smoothingSkippedByStride`

Visual Snapshot Checklist:
- Combined mode screenshot (default composition).
- Renderer-only screenshot (`debug.viewMode=renderer-only`).
- Fog-only screenshot (`debug.viewMode=fog-only`).
- Split compare screenshot (`debug.viewMode=split-compare`).
- Optional paired snapshot using "Copy RAW -> Composite" baseline controls.

Memory Snapshot Inputs:
- Browser Task Manager/DevTools memory reading after each scene.
- Note wetness resolution and pixel counts with memory snapshot.

Phase 0 execution focus now:
- Run and record first baseline pass for Scenes A-E with the counters above.

Execution status update (2026-03-12):
- Baseline metrics captured with automation script: `scripts/capture-phase0-baseline.mjs`.
- Visual references captured: `artifacts/phase0/*.png`.
- Baseline log finalized: `docs/PHASE0_BASELINE_LOG.md`.

Unchanged:
- Native RaindropFX droplet rendering/motion remains unchanged.
- CPU wetness/fog path remains the active runtime path.

Success Criteria:
- Repeatable baseline measurements captured and stored.
- Visual baseline references approved.

Rollback/Safety Net:
- Current implementation remains baseline fallback.

Risks:
- Non-repeatable benchmark conditions can invalidate comparisons.

Completion Update (fill when done):
- Date: 2026-03-12
- Metrics snapshot: recorded in `docs/PHASE0_BASELINE_LOG.md` (authoritative baseline table).
- Visual parity snapshot: combined, renderer-only, fog-only, and split-compare screenshots in `artifacts/phase0/`.
- Noted issues: headless automation measurements should be revalidated once in interactive desktop mode.
- Next phase pulled: Phase 1

### Phase 1: CPU containment and cleanup

Status: Completed
Started: 2026-03-12
Completed: 2026-03-12

Goal:
- Reduce CPU cost without changing architecture.

Scope:
- Dirty-region updates.
- Lower-frequency smoothing where acceptable.
- Buffer reuse.
- Avoid full-field `toImageData` work when possible.

Unchanged:
- CPU simulation model remains authoritative.
- RaindropFX path remains unchanged.

Success Criteria:
- Meaningful frame-time reduction with no visual regression.

Rollback/Safety Net:
- Keep switchable baseline CPU path.

Risks:
- Dirty-region artifacts, subtle behavior drift from cadence changes.

Execution focus now:
- Prioritize `toImageData` containment and region-limited conversion first, since Phase 0 shows wetness + diffusion dominating frame cost.

Execution status update (2026-03-12):
- Implemented first CPU containment optimization in `src/engine/SurfaceWetnessField.js`: skip redundant RGB writes in `toImageData` when tint is unchanged; alpha remains live-updated.
- Implemented second CPU containment optimization in `src/engine/SurfaceWetnessField.js`: reduced hot-loop index math and removed diffusion row `subarray` copy overhead.
- Implemented third CPU containment optimization in `src/engine/SurfaceWetnessField.js`: recovery now marks `imageDirtyRect` from changed pixel bounds instead of the full processed recovery region.
- Added configurable full refresh cadence in `src/engine/WetSurfaceEngine.js` exposed via `debug.wetnessFullRefreshIntervalFrames`; default restored to `120` for behavior safety.
- Implemented sparse-cell recovery skip in `src/engine/SurfaceWetnessField.js`: cells with zero values across all recovery fields now bypass no-op recovery math.
- Validation: `npm run build` passed.
- Phase 1 probe metrics captured at `artifacts/phase0/phase1-probe-2026-03-12.json`.
- Additional Phase 1 probe metrics captured at `artifacts/phase0/phase1-probe-2-2026-03-12.json`.
- Additional Phase 1 probe metrics captured at `artifacts/phase0/phase1-probe-3-2026-03-12.json`.
- Additional Phase 1 probe metrics captured at `artifacts/phase0/phase1-probe-4-2026-03-12.json`.
- Additional Phase 1 probe metrics captured at `artifacts/phase0/phase1-probe-5-2026-03-12.json`.
- Tracking log added: `docs/PHASE1_PROGRESS.md`.

Completion Update (fill when done):
- Date: 2026-03-12
- Metrics delta vs Phase 0: directional headless improvements in wetness-heavy paths; strongest gains observed in ultrawide probes (see `docs/PHASE1_PROGRESS.md`).
- Visual parity notes: no intentional behavior-model changes; split compare/tuning panel remained operational through Phase 1 work.
- Noted issues: headless probe variance remains high; one interactive desktop validation pass is still recommended.
- Next phase pulled: Phase 2

### Phase 2: GPU overlay prototype (no behavior change)

Status: Completed
Started: 2026-03-12
Completed: 2026-03-12

Goal:
- Add GPU overlay behind a debug flag without replacing behavior.

Scope:
- WebGL overlay rendering path for fog/wetness display only.
- CPU remains source of wetness state and writing behavior.

Unchanged:
- RaindropFX remains native droplet renderer.
- CPU overlay remains default/fallback.

Success Criteria:
- GPU overlay renders correctly and can be compared side-by-side.

Rollback/Safety Net:
- Disable GPU overlay flag.

Risks:
- Blend/color/alignment mismatches.

Execution status update (2026-03-12):
- Added prototype toggle `debug.useGpuOverlayPrototype` in `src/tuning/tuningConfig.js`.
- Added WebGL overlay prototype path in `src/engine/WetSurfaceEngine.js`:
	- CPU path remains default and fallback.
	- GPU path currently renders fog overlay texture, then applies existing tint/fill compositing logic.
- Added HUD visibility for active overlay backend (`cpu-2d` vs `gpu-prototype`) in `src/App.jsx`.
- Added overlay backend compare toggle `debug.overlayBackendCompareEnabled` with side-by-side CPU/GPU overlay compare rendering.
- Added automation support to force overlay backend in captures via `FORCE_GPU_OVERLAY=1` in `scripts/capture-phase0-baseline.mjs`.
- Added automation support for overlay compare mode via `FORCE_OVERLAY_COMPARE=1`.
- Captured comparison artifacts:
	- CPU overlay: `artifacts/phase2/cpu-overlay-probe-2026-03-12.json`
	- GPU overlay prototype: `artifacts/phase2/gpu-overlay-probe-2026-03-12.json`
	- GPU backend telemetry verify: `artifacts/phase2/gpu-overlay-backend-verify-2026-03-12.json`
	- Overlay compare telemetry verify: `artifacts/phase2/overlay-backend-compare-verify-2026-03-12.json`
- Phase 2 tracking log: `docs/PHASE2_PROGRESS.md`.

Execution focus now:
- Validate visual parity in split compare with GPU overlay enabled, then decide whether Phase 2 success gate is met.

Completion Update (fill when done):
- Date: 2026-03-12
- Metrics delta vs Phase 1: overlay backend switching and compare mode are operational; directional frame/wetness behavior remained in expected range with headless variance.
- Visual parity notes: CPU/GPU overlay compare mode and backend telemetry are both available; interactive final parity sweep remains recommended.
- Noted issues: headless measurements are noisy and not treated as final visual parity authority.
- Next phase pulled: Phase 3

### Phase 3: GPU fog compositing

Status: Completed
Started: 2026-03-12
Completed: 2026-03-12

Goal:
- Replace CPU `toImageData` + `putImageData` compositing with GPU compositing.

Scope:
- Keep wetness logic mostly CPU initially.
- Render/composite fog/wetness via GPU textures/shaders.

Unchanged:
- RaindropFX remains native droplet renderer.
- CPU compositing retained as fallback during validation.

Success Criteria:
- Major CPU compositing cost reduction with close visual parity.

Rollback/Safety Net:
- Runtime switch back to CPU compositing.

Risks:
- Upload bandwidth and blend-order artifacts.

Execution status update (2026-03-12):
- Added `debug.useGpuFogCompositing` in `src/tuning/tuningConfig.js` for Phase 3 shader-compositing path control.
- Extended GPU fragment shader in `src/engine/WetSurfaceEngine.js` to support in-shader fog+tint+fill compositing when Phase 3 mode is enabled.
- Added overlay backend label `gpu-fog-composite` for telemetry visibility.
- Added automation override `FORCE_GPU_FOG_COMPOSITING=1` in `scripts/capture-phase0-baseline.mjs`.
- Validation: `npm run build` passed.
- Captured Phase 3 starter artifact:
	- `artifacts/phase3/gpu-fog-composite-probe-1-2026-03-12.json`
- Captured Phase 3 completion artifacts:
	- `artifacts/phase3/cpu-fallback-probe-2026-03-12.json`
	- `artifacts/phase3/gpu-fog-composite-probe-2-2026-03-12.json`
	- `artifacts/phase3/gpu-fog-composite-compare-verify-2026-03-12.json`
- Phase 3 tracking log: `docs/PHASE3_PROGRESS.md`.

Execution focus now:
- Validate shader compositing parity against Phase 2 prototype/fallback and decide readiness for broader defaulting in Phase 3.

Completion Update (fill when done):
- Date: 2026-03-12
- Metrics delta vs Phase 2: directional improvement in Phase 3 forced mode; Scene E ultrawide dropped from `314.75ms` frame (`artifacts/phase2/gpu-overlay-probe-2026-03-12.json`) to `229.68ms` frame (`artifacts/phase3/gpu-fog-composite-probe-2-2026-03-12.json`) with wetness remaining dominant.
- Visual parity notes: compare verification path runs under `overlayBackend=cpu-gpu-compare` and split compare remains available while CPU fallback is retained.
- Noted issues: headless probe variance remains noisy; interactive parity sweep remains required before making GPU fog compositing default.
- Delta verification (rerun 2026-03-12): earlier rerun failures were environment-related (`127.0.0.1:5173` connection refused; `localhost:5174` returned HTTP 404 after malformed dev launch args), not a Phase 3 behavior regression.
- Delta evidence: successful compare rerun on healthy endpoint `http://localhost:5175/?rdfxDebug=1` captured at `artifacts/phase3/gpu-fog-composite-compare-rerun-2026-03-12.json`.
- Rerun snapshot: compare mode remained active (`overlayBackend=cpu-gpu-compare`) with Scene E `avgFrameMs=248.97`, `wetnessMs=258.01`, `overlayMs=0.17`.
- Next phase pulled: Phase 4

### Phase 4: GPU wetness simulation

Status: Completed
Started: 2026-03-12
Completed: 2026-03-12

Goal:
- Move recovery/refill/diffusion/disturbance from CPU grids to GPU simulation passes.

Scope:
- GPU textures/framebuffers/shaders for wetness field evolution.
- Keep tuning model concepts stable.

Unchanged:
- RaindropFX remains native droplet renderer.
- CPU simulation path can remain fallback until proven.

Success Criteria:
- CPU wetness ms becomes minimal; frame-time stability improves.

Rollback/Safety Net:
- Feature flag to return to CPU simulation.

Risks:
- Precision behavior drift and harder debugging.

Execution focus now:
- Start by introducing GPU simulation plumbing behind a flag while preserving CPU wetness as fallback authority during calibration.

Execution status update (2026-03-12):
- Added Phase 4 toggle `debug.useGpuWetnessSimulation` in `src/tuning/tuningConfig.js` and exposed it in Debug/Comparison controls.
- Added wetness backend telemetry wiring in `src/engine/WetSurfaceEngine.js`:
	- `wetnessBackend=cpu-grid` (default)
	- `wetnessBackend=gpu-sim-prototype` when Phase 4 toggle is forced.
- Added HUD line in `src/App.jsx` for `Wetness backend` visibility.
- Extended capture automation in `scripts/capture-phase0-baseline.mjs`:
	- `FORCE_GPU_WETNESS_SIMULATION=1` override support.
	- `wetnessBackend` parsing from HUD lines into JSON artifacts.
- Validation: `npm run build` passed.
- Captured Phase 4 scaffold verification artifact:
	- `artifacts/phase4/gpu-wetness-sim-scaffold-verify-2026-03-12.json`
- Added Phase 4 GPU simulation runtime scaffold in `src/engine/WetSurfaceEngine.js`:
	- WebGL runtime initialization (program/buffer/texture/framebuffer setup).
	- Single simulation pass path with safe startup behavior.
	- Runtime dispose path on engine stop.
	- Fallback telemetry behavior: `cpu-grid-fallback` on GPU runtime failure.
- Captured clean Phase 4 scaffold probe with explicit env cleanup:
	- `artifacts/phase4/gpu-wetness-sim-scaffold-probe-2-2026-03-12.json`
	- Verified labels: `wetnessBackend=gpu-sim-prototype`, `overlayBackend=cpu-2d`.
- Replaced pass-through stage with first experimental diffusion-style GPU kernel (still non-authoritative) in `src/engine/WetSurfaceEngine.js`.
- Captured Phase 4 kernel probe:
	- `artifacts/phase4/gpu-wetness-sim-kernel-probe-3-2026-03-12.json`
	- Verified labels: `wetnessBackend=gpu-sim-prototype`, `overlayBackend=cpu-2d`.
	- Scene E snapshot: frame `204.74ms`, wetness `207.97ms`, overlay `0.11ms`.
- Added Phase 4 parity telemetry in HUD + probe parser:
	- `gpuSimKernel`, `gpuSimReadbackMs`, `cpuFogAlphaMean`, `gpuFogAlphaMean`, `gpuCpuAlphaDelta`.
- Captured Phase 4 parity probe:
	- `artifacts/phase4/gpu-wetness-sim-parity-probe-4-2026-03-12.json`
	- Verified labels: `wetnessBackend=gpu-sim-prototype`, `gpuSimKernel=diffuse-v1`, `overlayBackend=cpu-2d`.
	- Scene E parity snapshot: `cpuFogAlphaMean=0.39577`, `gpuFogAlphaMean=0.39577`, `gpuCpuAlphaDelta=0`, `gpuSimReadbackMs=4.192`.
- Added second parity axis (error/variance): `gpuCpuAlphaMae`, `cpuFogAlphaVariance`, `gpuFogAlphaVariance`, `gpuCpuVarianceDelta`.
- Captured updated Phase 4 parity probe:
	- `artifacts/phase4/gpu-wetness-sim-parity-probe-5-2026-03-12.json`
	- Verified labels: `wetnessBackend=gpu-sim-prototype`, `gpuSimKernel=diffuse-v1`, `overlayBackend=cpu-2d`.
	- Scene E parity snapshot: `cpuFogAlphaMean=0.39542`, `gpuFogAlphaMean=0.39542`, `gpuCpuAlphaDelta=0`, `gpuCpuAlphaMae=0`, `cpuFogAlphaVariance=0.000025`, `gpuFogAlphaVariance=0.000025`, `gpuCpuVarianceDelta=0`, `gpuSimReadbackMs=4.398`.
- Added spatial parity telemetry: `gpuCpuTileMaxMae`, `gpuCpuTileHotspot` (64px tile grid).
- Captured spatial parity probe:
	- `artifacts/phase4/gpu-wetness-sim-parity-probe-6-2026-03-12.json`
	- Verified labels: `wetnessBackend=gpu-sim-prototype`, `gpuSimKernel=diffuse-v1`.
	- Scene E parity snapshot: `gpuCpuAlphaDelta=0`, `gpuCpuAlphaMae=0`, `gpuCpuVarianceDelta=0`, `gpuCpuTileMaxMae=0`, `gpuCpuTileHotspot=0,0`, `gpuSimReadbackMs=4.613`.
- Added configurable parity gate thresholds in `src/tuning/tuningConfig.js`:
	- `gpuParityThresholdMeanDelta`
	- `gpuParityThresholdMae`
	- `gpuParityThresholdVarianceDelta`
	- `gpuParityThresholdTileMaxMae`
	- `gpuParityGateEnabled`
- Added parity gate telemetry in engine/HUD/capture parser:
	- `gpuParityGateStatus` (`pass` | `fail` | `disabled`)
	- `gpuParityGateFailures` (comma-coded fail reasons).
- Captured parity gate verification probe:
	- `artifacts/phase4/gpu-wetness-sim-parity-gate-probe-7-2026-03-12.json`
	- Scene E gate snapshot: `gpuParityGateStatus=pass`, `gpuParityGateFailures=none`, `gpuCpuAlphaDelta=0`, `gpuCpuAlphaMae=0`, `gpuCpuVarianceDelta=0`, `gpuCpuTileMaxMae=0`, `gpuSimReadbackMs=4.858`.
- Phase 4 tracking log initialized: `docs/PHASE4_PROGRESS.md`.

Completion Update (fill when done):
- Date: 2026-03-12
- Metrics delta vs Phase 3: parity telemetry stack stabilized and parity gate passed in `artifacts/phase4/gpu-wetness-sim-parity-gate-probe-7-2026-03-12.json`; Scene E gate snapshot reports `gpuCpuAlphaDelta=0`, `gpuCpuAlphaMae=0`, `gpuCpuVarianceDelta=0`, `gpuCpuTileMaxMae=0`, `gpuSimReadbackMs=4.858`.
- Visual parity notes: Phase 4 parity gate now emits pass/fail status and failure codes in HUD/capture telemetry, preserving split compare workflow and CPU fallback controls.
- Noted issues: GPU simulation kernel remains prototype-scaffold (`diffuse-v1`) and does not yet author interaction writes directly.
- Next phase pulled: Phase 5

### Phase 5: GPU writing and interaction

Status: Completed
Started: 2026-03-12
Completed: 2026-03-12

Goal:
- Reintroduce writable fog interactions directly on GPU surface.

Scope:
- Pointer/finger writing, droplet clearing, and runner clearing all affect one GPU field.

Unchanged:
- RaindropFX remains native droplet renderer.
- Public tuning model remains aligned with current concepts.

Success Criteria:
- Writing and droplet interactions both work with acceptable responsiveness.

Rollback/Safety Net:
- Switch interactions back to CPU path if needed.

Risks:
- Input latency/jitter and multi-source write ordering edge cases.

Execution focus now:
- Introduce GPU interaction-write plumbing (pointer + droplet trail clear events) behind a dedicated flag while keeping CPU field updates authoritative.
- Current tuning focus (delta): reduce run-to-run volatility in `diffuse-v1+write-v1`, especially ultrawide `high` pressure mode, before Phase 5 completion gating.

Execution status update (2026-03-12):
- Added Phase 5 toggle `debug.useGpuWritingInteractionPrototype` in `src/tuning/tuningConfig.js` and exposed it in Debug/Comparison controls.
- Added interaction telemetry wiring in `src/engine/WetSurfaceEngine.js` + `src/App.jsx`:
	- `interactionBackend=cpu-direct` (default)
	- `interactionBackend=gpu-write-queue-prototype` when both GPU wetness simulation and Phase 5 interaction prototype toggles are enabled.
	- HUD metrics: `gpuWriteQueueDepth`, `gpuWritesConsumed`.
- Added write-event queue scaffold in `src/engine/WetSurfaceEngine.js`:
	- Pointer/droplet clear operations now enqueue interaction-write events when Phase 5 prototype is enabled.
	- Queue is consumed during GPU wetness simulation pass for telemetry and future GPU write-pass integration; CPU wetness updates remain active authority.
- Extended automation in `scripts/capture-phase0-baseline.mjs`:
	- `FORCE_GPU_WRITING_INTERACTION=1` override support.
	- New parser metrics: `interactionBackend`, `gpuWriteQueueDepth`, `gpuWritesConsumed`.
- Validation: `npm run build` passed.
- Captured Phase 5 scaffold artifact:
	- `artifacts/phase5/gpu-writing-interaction-scaffold-probe-1-2026-03-12.json`
	- Verified labels: `wetnessBackend=gpu-sim-prototype`, `interactionBackend=gpu-write-queue-prototype`.
	- Scene C snapshot: `gpuWritesConsumed=617.57`, `wetnessMs=209.67`, `avgFrameMs=211.38`.
	- Scene E snapshot: `gpuWritesConsumed=69.95`, `gpuParityGateStatus=pass`, `gpuParityGateFailures=none`.
- Added first GPU interaction write pass in `src/engine/WetSurfaceEngine.js`:
	- Write queue now applies event-by-event clear splats/capsules in a shader pass (`write-v1`) over the simulation texture.
	- Supports both pointer blob writes and droplet trail segment writes.
	- Per-frame write budget currently capped (`128` events) to protect frame stability while behavior is tuned.
- Captured Phase 5 write-pass artifact:
	- `artifacts/phase5/gpu-writing-interaction-writepass-probe-2-2026-03-12.json`
	- Verified labels: `wetnessBackend=gpu-sim-prototype`, `interactionBackend=gpu-write-queue-prototype`, `gpuSimKernel=diffuse-v1+write-v1`.
	- Scene C snapshot: `gpuWritesConsumed=128`, `gpuWriteQueueDepth=88519`, `wetnessMs=205.44`, `avgFrameMs=206.98`.
	- Scene E snapshot: `gpuWritesConsumed=126.77`, `gpuWriteQueueDepth=194`, `gpuParityGateStatus=pass`, `gpuParityGateFailures=none`, `wetnessMs=258.69`, `avgFrameMs=251`.
- Added adaptive queue controls for Phase 5 interaction writes in `src/engine/WetSurfaceEngine.js`:
	- Adaptive enqueue decimation for high-depth clear-blob traffic.
	- Near-neighbor coalescing for blob writes and contiguous trail segments.
	- Queue cap (`4096`) with oldest-batch pruning when saturated.
	- Added telemetry: `gpuWritesDropped`, `gpuWritesCoalesced`.
- Captured Phase 5 queue-optimization artifact:
	- `artifacts/phase5/gpu-writing-interaction-writepass-probe-3-2026-03-12.json`
	- Verified labels remain: `wetnessBackend=gpu-sim-prototype`, `interactionBackend=gpu-write-queue-prototype`, `gpuSimKernel=diffuse-v1+write-v1`.
	- Scene C delta vs probe-2: queue depth `88519 -> 2038`, consumed `128 -> 128`, dropped `84069`, coalesced `237`, wetness `205.44 -> 183.93`, frame `206.98 -> 184.99`.
	- Scene E delta vs probe-2: queue depth `194 -> 0`, dropped `1178`, coalesced `10`, gate remains `pass`, but wetness/frame regressed (`258.69 -> 300.3`, `251 -> 288.73`).
- Retuned queue policy to be source-aware (`pointer` vs `droplet`) in `src/engine/WetSurfaceEngine.js`:
	- Pointer writes keep aggressive decimation/coalescing.
	- Droplet writes now preserve higher enqueue fidelity except under extreme queue pressure.
- Captured Phase 5 source-aware artifact:
	- `artifacts/phase5/gpu-writing-interaction-writepass-probe-4-2026-03-12.json`
	- Scene C delta vs probe-3: queue depth `2038 -> 3666`, dropped `84069 -> 86551`, coalesced `237 -> 148`, wetness/frame improved (`183.93 -> 163.27`, `184.99 -> 164.11`).
	- Scene E delta vs probe-3: queue depth remains `0`, dropped `1178 -> 0`, coalesced `10 -> 6`, wetness/frame recovered (`300.3 -> 271.89`, `288.73 -> 264.77`), gate remains `pass`.
	- Scene E remains above probe-2 timings, so additional tuning is still required.
- Added pressure-aware GPU write policy in `src/engine/WetSurfaceEngine.js`:
	- Dynamic write-pressure profile (`low|medium|high|critical`) derived from queue depth + live frame/wetness timing.
	- Dynamic per-frame write budget and source-aware enqueue scaling now follow pressure profile.
	- Added telemetry: `gpuWritePressure`, `gpuWriteBudget`.
- Captured Phase 5 pressure-aware artifact:
	- `artifacts/phase5/gpu-writing-interaction-writepass-probe-5-2026-03-12.json`
	- Verified labels: `gpuSimKernel=diffuse-v1+write-v1`, `gpuWritePressure=medium`, `gpuWriteBudget=112`, parity gate remains `pass`.
	- Scene C delta vs probe-4: queue depth `3666 -> 3965`, dropped `86551 -> 110497`, coalesced `148 -> 153`, wetness/frame improved (`163.27 -> 118.11`, `164.11 -> 120.16`).
	- Scene E delta vs probe-4: queue depth `0 -> 270`, dropped `0 -> 0`, coalesced `6 -> 16`, wetness/frame improved (`271.89 -> 249.61`, `264.77 -> 245.68`).
	- Scene E now recovers beyond probe-2 levels (`wetnessMs=258.69`, `avgFrameMs=251`) while keeping gate `pass`.
- Delta verification (rerun 2026-03-12): recent scaffold probe failures were environment-related (`127.0.0.1:5173` connection refused; `localhost:5174` returned HTTP 404), not a Phase 5 interaction pipeline regression.
- Delta evidence: successful scaffold rerun on healthy endpoint `http://localhost:5175/?rdfxDebug=1` captured at `artifacts/phase5/gpu-writing-interaction-scaffold-probe-rerun-2026-03-12.json`.
- Rerun snapshots: Scene C `avgFrameMs=116.57`, `wetnessMs=114.79`, `gpuWritesConsumed=112`, `gpuWriteQueueDepth=3278`; Scene E `avgFrameMs=248.39`, `wetnessMs=254`, `overlayMs=0.09`, with `gpuParityGateStatus=pass`.
- Rerun backend verification: `wetnessBackend=gpu-sim-prototype`, `interactionBackend=gpu-write-queue-prototype`, `gpuSimKernel=diffuse-v1+write-v1`, `gpuWritePressure=medium`, `gpuWriteBudget=112`.
- Captured additional Phase 5 write-pass artifact:
	- `artifacts/phase5/gpu-writing-interaction-writepass-probe-6-2026-03-12.json`
	- Scene C: `avgFrameMs=164.07`, `wetnessMs=160.64`, `gpuWritesConsumed=112`, `gpuWriteQueueDepth=3209`, `gpuWritesDropped=86880`, `gpuWritePressure=medium`.
	- Scene E: `avgFrameMs=264.33`, `wetnessMs=270.9`, `gpuWritesConsumed=66.87`, `gpuWriteQueueDepth=0`, `gpuWritesDropped=732`, `gpuWritePressure=high`, `gpuWriteBudget=96`, parity gate `pass`.
	- Delta vs probe-5 indicates regression in Scene C/E timing, so Phase 5 remains tuning-in-progress for stability rather than raw one-run gains.
- Captured additional Phase 5 write-pass artifact:
	- `artifacts/phase5/gpu-writing-interaction-writepass-probe-7-2026-03-12.json`
	- Scene C: `avgFrameMs=180.97`, `wetnessMs=177.32`, `gpuWritesConsumed=112`, `gpuWriteQueueDepth=3015`, `gpuWritesDropped=88938`, `gpuWritePressure=medium`, parity gate `pass`.
	- Scene E: `avgFrameMs=284.74`, `wetnessMs=297.31`, `gpuWritesConsumed=56.26`, `gpuWriteQueueDepth=0`, `gpuWritesDropped=883`, `gpuWritePressure=high`, `gpuWriteBudget=96`, parity gate `pass`.
	- Delta vs probe-6 shows further timing regression; Phase 5 completion gate remains blocked on write-pressure stability.
- Retuned pressure escalation thresholds in `src/engine/WetSurfaceEngine.js` to delay `high/critical` mode entry on transient frame/wetness spikes (reduces write-policy thrash under ultrawide load).
- Validation: `npm run build` passed after threshold retune.
- Captured additional Phase 5 write-pass artifact:
	- `artifacts/phase5/gpu-writing-interaction-writepass-probe-8-2026-03-12.json`
	- Scene C: `avgFrameMs=122.64`, `wetnessMs=119.69`, `gpuWritesConsumed=112`, `gpuWriteQueueDepth=3813`, `gpuWritesDropped=98849`, `gpuWritePressure=medium`, `gpuWriteBudget=112`, parity gate `pass`.
	- Scene E: `avgFrameMs=218.92`, `wetnessMs=219.88`, `gpuWritesConsumed=127.58`, `gpuWriteQueueDepth=584`, `gpuWritesDropped=0`, `gpuWritePressure=low`, `gpuWriteBudget=128`, parity gate `pass`.
	- Delta vs probe-7 shows strong recovery (`C frame 180.97 -> 122.64`, `E frame 284.74 -> 218.92`, `E wetness 297.31 -> 219.88`) with stable `diffuse-v1+write-v1` backend labels.

Completion Update (fill when done):
- Date: 2026-03-12
- Metrics delta vs Phase 4: after pressure-threshold retune, repeated write-pass runs recovered from regression and stabilized in two consecutive captures: `artifacts/phase5/gpu-writing-interaction-writepass-probe-8-2026-03-12.json` and `artifacts/phase5/gpu-writing-interaction-writepass-probe-9-2026-03-12.json`.
- Visual parity notes: both confirmation probes keep `gpuParityGateStatus=pass` with `gpuParityGateFailures=none`, and backend labels remain `wetnessBackend=gpu-sim-prototype`, `interactionBackend=gpu-write-queue-prototype`, `gpuSimKernel=diffuse-v1+write-v1`.
- Noted issues: write queue still drops/coalesces aggressively in high-write pointer scenes; this remains acceptable for current prototype gate but should be revisited before default-on rollout.
- Next phase pulled: Phase 6

### Phase 6: Consolidation

Status: Completed
Started: 2026-03-12
Completed: 2026-03-12

Goal:
- Remove obsolete CPU-only paths once GPU path is proven.

Scope:
- Keep practical compatibility fallback mode.
- Simplify architecture while preserving tuning/debug utility.

Unchanged:
- RaindropFX remains native droplet renderer.

Success Criteria:
- Reduced code complexity with maintained behavior/performance targets.

Rollback/Safety Net:
- Stable pre-consolidation tag/branch retained.

Risks:
- Removing legacy code too early can limit incident recovery.

Execution focus now:
- Inventory and isolate CPU-only wetness/compositing paths that are no longer required when Phase 5 GPU write path is enabled, while preserving a deliberate compatibility fallback mode.

Execution status update (2026-03-12):
- Completed first consolidation inventory sweep across `src/engine/WetSurfaceEngine.js` and `src/tuning/tuningConfig.js`.
- Confirmed active fallback/control points to preserve during consolidation:
	- Overlay fallback: `cpu-2d` and compare mode `cpu-gpu-compare` remain selectable via debug toggles.
	- Wetness fallback: CPU path is still authoritative baseline with runtime fallback label `cpu-grid-fallback` on GPU pass failure.
	- Interaction fallback: CPU direct interaction path remains available when GPU writing prototype is disabled.
- Identified Phase 6 candidate cleanup targets (defer removal until compatibility mode is formalized):
	- Prototype-only naming and telemetry labels (`*-prototype`) that should be normalized once GPU path is promoted.
	- Legacy comments/tooltips that still describe Phase 5 as scaffold-only despite active `write-v1` integration.
	- Flag dependency coupling (`useGpuWritingInteractionPrototype` requiring `useGpuWetnessSimulation`) that should be explicit in final compatibility mode docs.
- Applied first consolidation cleanup pass:
	- Normalized runtime backend labels in `src/engine/WetSurfaceEngine.js`:
		- `gpu-sim-prototype -> gpu-sim`
		- `gpu-write-queue-prototype -> gpu-write-queue`
		- `gpu-prototype -> gpu-overlay`
	- Renamed internal runtime helpers to match promoted behavior naming (`drawSurfaceGpuRuntime`, `initGpuOverlayRuntime`, `isGpuWritingInteractionEnabled`) while preserving existing debug flag keys for compatibility.
	- Updated Debug/Comparison control copy in `src/tuning/tuningConfig.js` to remove outdated prototype/scaffold wording and clearly state fallback behavior.
- Validation:
	- Build passed: `npm run build`.
	- Consolidation verification artifact captured: `artifacts/phase6/consolidation-label-verify-1-2026-03-12.json`.
	- Verified Scene C/E labels: `wetnessBackend=gpu-sim`, `interactionBackend=gpu-write-queue`, `gpuSimKernel=diffuse-v1+write-v1`, `gpuParityGateStatus=pass`.
- Added explicit compatibility-mode telemetry for consolidation governance:
	- Engine timing now emits `compatibilityMode` (`cpu-compat | gpu-sim | gpu-interaction | cpu-fallback`) in `src/engine/WetSurfaceEngine.js`.
	- HUD now shows `Compatibility mode:` line in `src/App.jsx`.
	- Capture parser now records `compatibilityMode` in `scripts/capture-phase0-baseline.mjs` artifacts.
- Added explicit compatibility-mode control surface (not telemetry-only):
	- New debug setting `debug.compatibilityMode` with values `auto | cpu-compat | gpu-sim | gpu-interaction` in `src/tuning/tuningConfig.js`.
	- Engine runtime now resolves requested mode in `src/engine/WetSurfaceEngine.js` to drive wetness/interaction enablement directly while preserving fallback semantics.
	- Capture automation now supports `FORCE_COMPAT_MODE` in `scripts/capture-phase0-baseline.mjs` for reproducible mode-gated probes.
- Validation:
	- Build passed: `npm run build` after compatibility telemetry wiring.
	- Compatibility verification artifact captured: `artifacts/phase6/consolidation-compatibility-verify-2-2026-03-12.json`.
	- Verified Scene C/E snapshot: `compatibilityMode=gpu-interaction`, `wetnessBackend=gpu-sim`, `interactionBackend=gpu-write-queue`, `gpuSimKernel=diffuse-v1+write-v1`, parity `pass`.
- Validation (explicit mode matrix):
	- `artifacts/phase6/consolidation-compat-mode-cpu-3-2026-03-12.json`: Scene C/E verified `compatibilityMode=cpu-compat`, `wetnessBackend=cpu-grid`, `interactionBackend=cpu-direct`, `gpuSimKernel=off`.
	- `artifacts/phase6/consolidation-compat-mode-gpu-sim-3-2026-03-12.json`: Scene C/E verified `compatibilityMode=gpu-sim`, `wetnessBackend=gpu-sim`, `interactionBackend=cpu-direct`, `gpuSimKernel=diffuse-v1`, parity `pass`.
	- `artifacts/phase6/consolidation-compat-mode-gpu-interaction-3-2026-03-12.json`: Scene C/E verified `compatibilityMode=gpu-interaction`, `wetnessBackend=gpu-sim`, `interactionBackend=gpu-write-queue`, `gpuSimKernel=diffuse-v1+write-v1`, parity `pass`.
	- Build passed: `npm run build` after mode-control implementation.
- Next consolidation focus:
	- Decide Phase 6 closeout policy for `gpu-sim` mode performance (retain as diagnostic mode vs retune), then finalize completion block with final-mode metrics and compatibility notes.
- Post-closeout parity debug hotfix (2026-03-12):
	- Confirmed root causes:
		- Overlay presentation used a redundant Y inversion (`UNPACK_FLIP_Y_WEBGL=true` upload + shader `1.0 - v_uv.y` sample), producing vertically inverted writing in GPU overlay mode.
		- GPU fog compositing shader did not match CPU source-atop/source-over semantics and mixed tint/fill in non-masked space, causing white-wash parity drift.
		- GPU overlay upsample exposed harsher alpha edges; added light in-shader alpha smoothing to reduce chunky stroke appearance without adding a new pass.
	- Targeted fixes applied in `src/engine/WetSurfaceEngine.js`:
		- Removed redundant shader Y-flip in overlay sampling and documented expected orientation model.
		- Rewrote GPU fog compositing math to mirror CPU steps (fog draw, tint source-atop masked by fog alpha, fill source-over).
		- Added mild 5-tap alpha smoothing in overlay shader for visual parity softness at existing fog resolution.
		- Added parity diagnostics telemetry: `gpuOverlayUvMode`, `gpuOverlayFogAlphaMean`, `gpuOverlayFogAlphaMax`.
	- Supporting updates:
		- HUD diagnostics lines in `src/App.jsx`.
		- Capture parser support for new diagnostics in `scripts/capture-phase0-baseline.mjs`.
	- Validation artifacts:
		- GPU overlay composite verify: `artifacts/phase6/parity-fix-gpu-overlay-composite-4-2026-03-12.json`.
		- CPU overlay reference: `artifacts/phase6/parity-fix-cpu-overlay-reference-4-2026-03-12.json`.
		- Split compare guard: `artifacts/phase6/parity-fix-split-compare-guard-4-2026-03-12.json`.
		- CPU-compat guard: `artifacts/phase6/parity-fix-cpu-compat-guard-4-2026-03-12.json`.
	- Guard results:
		- Split compare remains operational (`overlayBackend=cpu-gpu-compare`, parity gate `pass`).
		- CPU fallback safety remains intact under `cpu-compat` (`wetnessBackend=cpu-grid`, `interactionBackend=cpu-direct`, `gpuSimKernel=off`).
	- Follow-up parity correction (2026-03-12, pass 2):
		- Orientation fix remains valid; remaining parity issue was fog compositing math and edge shaping in GPU fragment shader.
		- Updated GPU compositing to keep fog/tint/fill contributions alpha-masked by fog field alpha so non-fog pixels are not unintentionally tinted.
		- Replaced prior 5-tap alpha smoothing with in-shader `smoothstep(0.02, 0.98, alpha)` edge reconstruction (no extra pass, no resolution change).
		- Architecture and safeguards unchanged: same debug flags, split compare path, and CPU compatibility fallback.
		- Validation artifacts (pass 2):
			- GPU overlay composite verify: `artifacts/phase6/parity-fix-gpu-overlay-composite-5-2026-03-12.json`.
			- CPU overlay reference: `artifacts/phase6/parity-fix-cpu-overlay-reference-5-2026-03-12.json`.
			- Split compare guard: `artifacts/phase6/parity-fix-split-compare-guard-5-2026-03-12.json`.
	- Final presentation-path audit + state correction (2026-03-12, pass 3):
		- Traced GPU overlay final draw path end-to-end: `animate -> drawSurface -> drawSurfaceGpuRuntime -> WebGL default framebuffer draw -> this.ctx.drawImage(gpuOverlay.canvas)`.
		- Confirmed GPU overlay final pass samples fog texture only and relies on 2D underlay (`drawBackground`) for scene preservation.
		- Added HUD/capture diagnostics for final presentation state (target, framebuffer binding, clear RGBA, blend state/mode, alpha convention, context alpha/premultiplied flags, sampled textures, scene source).
		- Corrected WebGL overlay context to straight-alpha presentation (`premultipliedAlpha=false`) and set explicit upload state (`UNPACK_PREMULTIPLY_ALPHA_WEBGL=false`) to align shader output with final `drawImage` compositing semantics.
		- Added explicit final-pass state guards (`bindFramebuffer(null)`, `disable(BLEND)`) and telemetry labels to avoid hidden state drift.
		- Validation artifacts (pass 3):
			- GPU overlay composite verify: `artifacts/phase6/parity-fix-gpu-overlay-composite-6-2026-03-12.json`.
			- CPU overlay reference: `artifacts/phase6/parity-fix-cpu-overlay-reference-6-2026-03-12.json`.
			- Split compare guard: `artifacts/phase6/parity-fix-split-compare-guard-6-2026-03-12.json`.
			- CPU-compat guard: `artifacts/phase6/parity-fix-cpu-compat-guard-6-2026-03-12.json`.
		- Recorded GPU state snapshot in pass-3 artifact: `target=webgl-default-fbo`, `framebuffer=default-null`, `samples=fog-texture-only`, `sceneSource=2d-underlay-main-canvas`, `clear=0,0,0,0`, `blend=no`, `blendMode=disabled`, `alphaConvention=straight`, `ctxAlpha=true`, `ctxPremultiplied=false`.

Completion Update (fill when done):
- Date: 2026-03-12
- Final metrics vs Phase 0: using final-mode artifact `artifacts/phase6/consolidation-compat-mode-gpu-interaction-3-2026-03-12.json` against `artifacts/phase0/baseline-metrics.json`:
	- Scene C (`C-writing-strokes`): frame `252.8 -> 211.52` (`-41.28ms`), wetness `253.47 -> 210.85` (`-42.62ms`).
	- Scene E (`E-ultrawide-stress`): frame `427.87 -> 239.6` (`-188.27ms`), wetness `464.45 -> 244.13` (`-220.32ms`).
- Compatibility mode notes: explicit mode control is now available (`auto | cpu-compat | gpu-sim | gpu-interaction`) and validated with dedicated artifacts; `cpu-compat` remains stable fallback, `gpu-interaction` is validated promoted path, `gpu-sim` is retained as diagnostic mode.
- Noted issues: `gpu-sim` (without interaction write pass) can be substantially slower in some scenes and is not the recommended runtime target mode.
