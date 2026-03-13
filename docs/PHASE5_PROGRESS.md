# Phase 5 Progress Log

Date started: 2026-03-12
Status: In Progress

## Goal

Reintroduce writable fog interactions on the GPU-side pipeline while preserving CPU fallback safety and split-compare tooling.

## Planned Scope (Initial)

- Add a dedicated Phase 5 interaction flag independent of Phase 4 wetness simulation toggle.
- Queue pointer and droplet interaction writes for GPU-side consumption scaffolding.
- Keep CPU writes authoritative until GPU write pass parity and responsiveness gates are met.

## Implemented (Scaffold)

- Added debug flag `debug.useGpuWritingInteractionPrototype` in `src/tuning/tuningConfig.js`.
- Added HUD-visible interaction telemetry in `src/engine/WetSurfaceEngine.js` + `src/App.jsx`:
  - `interactionBackend=cpu-direct` by default.
  - `interactionBackend=gpu-write-queue-prototype` when Phase 5 scaffold is forced with GPU wetness simulation.
  - `gpuWriteQueueDepth` and `gpuWritesConsumed` metrics.
- Added write queue scaffold in `src/engine/WetSurfaceEngine.js`:
  - Pointer clear blobs and droplet trail disturbances enqueue interaction events when Phase 5 prototype is enabled.
  - Queue is consumed per GPU wetness sim pass and fed into the write-pass stage.
  - CPU `SurfaceWetnessField` updates remain authoritative.
- Extended capture automation in `scripts/capture-phase0-baseline.mjs`:
  - Added `FORCE_GPU_WRITING_INTERACTION=1` override.
  - Added parser support for `interactionBackend`, `gpuWriteQueueDepth`, `gpuWritesConsumed`.
- Added first real GPU interaction write pass (`write-v1`) in `src/engine/WetSurfaceEngine.js`:
  - Uses a dedicated shader program to apply queued clear events to the simulated alpha field.
  - Supports blob clear writes and segment/capsule trail writes.
  - Applies writes with ping-pong texture swaps and bounded per-frame consumption.
  - Reports combined kernel label `diffuse-v1+write-v1` when write pass is active.
- Fixed runtime regression discovered during Phase 5 bring-up:
  - Symptom: `writeProgram is not defined` when forcing GPU wetness + writing flags.
  - Resolution: restored `initGpuOverlayPrototype()` to overlay-only setup and scoped write program creation to `initGpuWetnessSimulationRuntime()`.

## Validation

- `npm run build` passed.
- Probe captured: `artifacts/phase5/gpu-writing-interaction-scaffold-probe-1-2026-03-12.json`.
- Probe summary:
  - `wetnessBackend=gpu-sim-prototype`
  - `interactionBackend=gpu-write-queue-prototype`
  - Scene C (`C-writing-strokes`): `gpuWritesConsumed=617.57`, `wetnessMs=209.67`, `avgFrameMs=211.38`
  - Scene E (`E-ultrawide-stress`): `gpuWritesConsumed=69.95`, `gpuParityGateStatus=pass`, `gpuParityGateFailures=none`
- Write-pass probe: `artifacts/phase5/gpu-writing-interaction-writepass-probe-2-2026-03-12.json`
  - `wetnessBackend=gpu-sim-prototype`
  - `interactionBackend=gpu-write-queue-prototype`
  - `gpuSimKernel=diffuse-v1+write-v1`
  - Scene C (`C-writing-strokes`): `gpuWritesConsumed=128`, `gpuWriteQueueDepth=88519`, `wetnessMs=205.44`, `avgFrameMs=206.98`
  - Scene E (`E-ultrawide-stress`): `gpuWritesConsumed=126.77`, `gpuWriteQueueDepth=194`, `gpuParityGateStatus=pass`, `gpuParityGateFailures=none`, `wetnessMs=258.69`, `avgFrameMs=251`
- Queue-optimization probe: `artifacts/phase5/gpu-writing-interaction-writepass-probe-3-2026-03-12.json`
  - Queue controls added: adaptive enqueue decimation, near-neighbor coalescing, capped queue with pruning.
  - Labels unchanged: `wetnessBackend=gpu-sim-prototype`, `interactionBackend=gpu-write-queue-prototype`, `gpuSimKernel=diffuse-v1+write-v1`.
  - Scene C delta vs probe-2: `gpuWriteQueueDepth=88519 -> 2038`, `gpuWritesConsumed=128 -> 128`, `gpuWritesDropped=84069`, `gpuWritesCoalesced=237`, `wetnessMs=205.44 -> 183.93`, `avgFrameMs=206.98 -> 184.99`.
  - Scene E delta vs probe-2: `gpuWriteQueueDepth=194 -> 0`, `gpuWritesDropped=1178`, `gpuWritesCoalesced=10`, parity gate still `pass`, but `wetnessMs=258.69 -> 300.3` and `avgFrameMs=251 -> 288.73` regressed.
- Source-aware retune probe: `artifacts/phase5/gpu-writing-interaction-writepass-probe-4-2026-03-12.json`
  - Queue policy now differentiates pointer vs droplet write sources.
  - Scene C delta vs probe-3: `gpuWriteQueueDepth=2038 -> 3666`, `gpuWritesDropped=84069 -> 86551`, `gpuWritesCoalesced=237 -> 148`, `wetnessMs=183.93 -> 163.27`, `avgFrameMs=184.99 -> 164.11`.
  - Scene E delta vs probe-3: `gpuWriteQueueDepth=0 -> 0`, `gpuWritesDropped=1178 -> 0`, `gpuWritesCoalesced=10 -> 6`, parity gate `pass`, `wetnessMs=300.3 -> 271.89`, `avgFrameMs=288.73 -> 264.77`.
  - Interpretation: recovered substantial Scene E regression from probe-3 while keeping strong Scene C gains, but Scene E is still above probe-2 timing.
- Pressure-aware retune probe: `artifacts/phase5/gpu-writing-interaction-writepass-probe-5-2026-03-12.json`
  - Dynamic pressure profile active with telemetry (`gpuWritePressure=medium`, `gpuWriteBudget=112`).
  - Scene C delta vs probe-4: `gpuWriteQueueDepth=3666 -> 3965`, `gpuWritesDropped=86551 -> 110497`, `gpuWritesCoalesced=148 -> 153`, `wetnessMs=163.27 -> 118.11`, `avgFrameMs=164.11 -> 120.16`.
  - Scene E delta vs probe-4: `gpuWriteQueueDepth=0 -> 270`, `gpuWritesDropped=0 -> 0`, `gpuWritesCoalesced=6 -> 16`, parity gate `pass`, `wetnessMs=271.89 -> 249.61`, `avgFrameMs=264.77 -> 245.68`.
  - Scene E now outperforms probe-2 (`wetnessMs=258.69`, `avgFrameMs=251`) while preserving gate pass.

## Risks To Watch

- Event queue semantics can diverge from eventual GPU write-pass ordering if not defined early.
- High write density (writing + runners) could cause bursty queue costs.
- Aggressive decimation may underfeed interaction writes in some scenes and shift overall wetness/frame behavior.
- CPU-authoritative dual-path behavior must remain visually coherent while scaffold evolves.

## Next Work Items

- Validate interaction visual parity under sustained writing and rain now that C/E perf targets have directionally recovered.
- Introduce interaction-specific parity checks (stroke continuity and trail cohesion) in addition to global alpha gates.
- Keep CPU fallback and compare mode active while calibrating write-pass thresholds.
