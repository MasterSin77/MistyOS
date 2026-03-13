# MistyOS v1.0

MistyOS is a WebGL-driven atmospheric surface simulation prototype that renders:

- raindrops
- mist
- fog
- surface moisture behavior

The current system is derived from RaindropFX-style rendering techniques and extends them with a custom wetness/fog interaction layer.

In v1.0, native RaindropFX remains the dominant droplet renderer/simulator, while MistyOS provides orchestration, wetness/fog interaction, compositing, tuning controls, and comparison tooling around that renderer. The baseline is intentionally hybrid rather than a fully unified moisture engine.

## Project Status

This repository represents the **MistyOS v1.0 baseline implementation**.

This version is frozen as the reference implementation before work begins on the next-generation unified moisture simulation engine.

Future development will evolve from this baseline.

## Visual Features

Current behavior in the codebase includes:

- Rain droplets rendered by the native RaindropFX renderer/simulator path.
- Mist/fog layers that accumulate over time via a condensation model.
- Droplet accumulation and merging behavior in the native raindrop simulation.
- Streaking/runners produced by droplet motion, trail disturbance, and split/wake events.
- Surface interaction via pointer writing/clearing that carves through fog/wetness.
- Blending/compositing of background, raindrop output, and fog overlay with tint/fill controls.

Visual goal: present a wet glass surface where condensation rebuilds continuously while droplets and finger interaction clear and reshape the same visible moisture field.

Implementation note for v1.0: writing is currently modeled primarily as a clearing interaction on the shared visible fog/wetness field. It is not yet a full residue/displacement/barrier fluid simulation.

## Rendering Architecture

High-level runtime flow:

1. React mounts a full-screen `<canvas>` (`src/main.jsx`, `src/App.jsx`).
2. `WetSurfaceEngine` owns the frame loop, simulation state, and draw orchestration (`src/engine/WetSurfaceEngine.js`).
3. Native RaindropFX is loaded from `public/vendor/raindropfx-bundle.js` through `RaindropFxRendererAdapter` (`src/engine/RaindropFxRendererAdapter.js`).
4. Surface wetness/fog state is maintained in a CPU field (`SurfaceWetnessField`) and converted into an alpha texture/canvas (`src/engine/SurfaceWetnessField.js`).
5. Final compositing draws background/raindrops first, then overlays fog/wetness through CPU 2D or optional WebGL overlay paths.

### Core pipeline stages

1. Frame timing and setup
- `requestAnimationFrame` drives `animate()` in `WetSurfaceEngine`.
- Delta time is clamped for stability.

2. Wetness field update
- `SurfaceWetnessField.beginFrame()` resets per-frame stats.
- Condensation recovery/refill runs via `addCondensation()`.
- Optional smoothing/diffusion runs via `smooth()` over dirty/full regions.
- Field converts to `ImageData` alpha in `toImageData()` and updates the fog canvas.

3. Raindrop renderer update
- In phase `>= 2`, `RaindropFxRendererAdapter.update()` runs native simulator + renderer.
- Snapshot droplets are normalized and fed back into wetness interaction coupling.

4. Droplet-to-surface interaction
- `updateDropletsFromRenderer()` maps renderer drops into fog-space.
- Head clearing and trail disturbance are applied via `clearFogBlob()` and `disturbFogTrail()`.
- Large-runner gating, slope plausibility, and downward-only rules are tunable.

5. Pointer writing interaction
- Pointer events (`pointerdown/move/up`) in phase `>= 3` call `applyFingerWipe()`.
- Writing stamps multiple overlapping clear blobs to mimic finger-pad contact.
- This interaction is clearance-driven in v1.0, not a physically complete material displacement model.

6. Compositing/presentation
- Background source: frozen frame, RaindropFX canvas, or fallback image/gradient.
- Surface overlay:
	- Default CPU path: draw fog canvas with alpha + tint/fill in 2D.
	- Optional GPU overlay path: WebGL fullscreen quad samples fog texture and composes tint/fill.
	- Optional split/compare modes render CPU vs GPU or RAW vs COMPOSITE side-by-side.

### WebGL, buffers, and passes

WebGL is used in three places in the current implementation:

- Native RaindropFX renderer (external bundle, authoritative droplet renderer).
- GPU overlay compositor runtime (`useGpuOverlayPrototype` / `useGpuFogCompositing`).
- GPU wetness simulation scaffold (`useGpuWetnessSimulation`) with `diffuse-v1` and optional `write-v1` interaction pass.

Current GPU wetness scaffold details:

- Uses textures + framebuffer ping/pong strategy.
- Runs a fullscreen fragment shader diffusion approximation.
- Optionally applies queued write events (blob/segment clear) in a dedicated write pass.
- Supports parity diagnostics against CPU fog alpha stats.
- Falls back to CPU labels/behavior if GPU runtime is unavailable.

### Compatibility and runtime modes

For validation and benchmarking, the engine exposes multiple runtime/debug paths that can be switched through tuning/debug controls and capture-script overrides: CPU compatibility mode, GPU simulation modes, CPU/GPU overlay comparison, and split compare views. These modes are used for parity/performance testing of the v1.0 baseline rather than as separate product architectures.

## Major Systems

- Render loop engine: `src/engine/WetSurfaceEngine.js`
	- Owns lifecycle, resize, pointer input, update sequencing, compositing, and telemetry.

- Native raindrop adapter: `src/engine/RaindropFxRendererAdapter.js`
	- Loads RaindropFX script, initializes runtime options, updates simulator/render, and emits normalized droplet snapshots.

- Wetness field simulation: `src/engine/SurfaceWetnessField.js`
	- Maintains multi-grid wetness/trail/runner-memory data, dirty-region tracking, condensation recovery, diffusion, and image conversion.

- Tuning/control schema: `src/tuning/tuningConfig.js`
	- Defines default config, linked controls, UI schema, debug toggles, and compatibility modes.

- UI/HUD + tuning panel: `src/App.jsx`
	- Exposes phase switching, tuning controls, presets, A/B slots, favorites, parameter sweeps, and extensive runtime metrics.

- Capture/test automation: `scripts/capture-phase0-baseline.mjs`, `scripts/capture-phase0-visuals.mjs`
	- Headless Playwright captures baseline scenes, screenshots, and HUD-derived metrics into `artifacts/`.

## File Structure

Important files/directories:

- `src/main.jsx`: React entry point.
- `src/App.jsx`: App shell, HUD, tuning panel, shortcuts (`1/2/3`), and engine wiring.
- `src/styles.css`: App/HUD/tuning panel styling.
- `src/engine/WetSurfaceEngine.js`: Main simulation and render orchestration.
- `src/engine/RaindropFxRendererAdapter.js`: Adapter to native RaindropFX bundle.
- `src/engine/SurfaceWetnessField.js`: CPU wetness field and conversion pipeline.
- `src/engine/RaindropSimulation.js`: In-repo droplet simulation module (present, not currently wired into the active runtime path).
- `src/tuning/tuningConfig.js`: Defaults, schema, storage keys, and linked parameter logic.
- `public/media/`: Background/media assets.
- `public/vendor/`: Vendor bundles, including RaindropFX runtime.
- `scripts/`: Baseline and visual capture automation.
- `artifacts/phase0..phase6/`: Captured measurements and images from baseline/migration runs.
- `docs/`: Baseline and per-phase progress logs.
- `PHASES.md`: Phase board and GPU migration execution notes.

## Running the Project

### Prerequisites

- Node.js 18+
- npm
- Microsoft Edge (used by Playwright scripts via `channel: 'msedge'`)

### Install

```bash
npm install
```

### Run locally

```bash
npm run dev
```

Open the Vite URL (usually `http://127.0.0.1:5173`).

Useful URL flags:

- `?rdfxDebug=1`: enable extended renderer debug/HUD telemetry.
- `?rdfxOnly=1`: renderer-only debug behavior path.
- `?rdfxNativeOnly=1`: disable adapter-driven mist/droplet procedural tuning for debug isolation.

### Build

```bash
npm run build
```

### Preview build

```bash
npm run preview
```

### Baseline/test capture commands

- Baseline scenes + metrics + screenshots:
	- `node scripts/capture-phase0-baseline.mjs`
- Visual references only:
	- `node scripts/capture-phase0-visuals.mjs`

Common PowerShell overrides:

- Custom output path:
	- `$env:OUT_JSON='artifacts/phase0/my-run.json'; node scripts/capture-phase0-baseline.mjs`
- Force GPU overlay:
	- `$env:FORCE_GPU_OVERLAY='1'; node scripts/capture-phase0-baseline.mjs`
- Force GPU fog compositing:
	- `$env:FORCE_GPU_OVERLAY='1'; $env:FORCE_GPU_FOG_COMPOSITING='1'; node scripts/capture-phase0-baseline.mjs`
- Force GPU wetness + interaction:
	- `$env:FORCE_GPU_WETNESS_SIMULATION='1'; $env:FORCE_GPU_WRITING_INTERACTION='1'; node scripts/capture-phase0-baseline.mjs`
- Force compatibility mode (`auto|cpu-compat|gpu-sim|gpu-interaction`):
	- `$env:FORCE_COMPAT_MODE='gpu-interaction'; node scripts/capture-phase0-baseline.mjs`

## Known Limitations

Current v1.0 constraints:

- Physical realism is stylized rather than physically rigorous.
- Fluid behavior is simplified (heuristic clearing, trail deposition, diffusion), not a full fluid dynamics solver.
- Raindrop rendering/simulation and wetness field are coupled but still partly separate systems.
- GPU wetness path is a scaffold/prototype kernel (`diffuse-v1` + optional `write-v1`) designed for staged migration and parity checks.
- High-write scenarios can trigger aggressive queue dropping/coalescing in GPU interaction mode.
- Some parity/performance conclusions are based on headless capture runs and should be supplemented with interactive validation.
- There is no fully unified moisture material model that simultaneously solves rain, mist, condensation, residue, and runoff as one physically coherent surface state.

## Vision: MistyOS Next Generation

The long-term direction is a unified moisture simulation engine where rain, mist, condensation, droplets, and user interaction all operate on one shared simulated surface.

Intended conceptual behavior:

- moisture accumulation across the full surface
- droplets merging and exchanging mass
- threshold-based runner formation and acceleration
- persistent residue from writing on glass
- cascading water behavior when local accumulation exceeds thresholds

This section describes direction only. It is not implemented in v1.0.

## Development Philosophy

MistyOS evolves in phased iterations.

The v1.0 baseline implementation remains available for:

- visual comparison
- performance comparison
- regression testing

Future phases progressively introduce a more physically coherent unified moisture surface simulation while preserving a stable baseline reference.
