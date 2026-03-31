# MistyOS

MistyOS is a wet-surface weather runtime and authoring system with two coordinated browser surfaces:

- Presentation: desktop or stage playback surface for runtime review.
- Studio: authoring surface for timeline, scene, and runtime payload editing.

Current purpose: keep runtime behavior deterministic and handoff-safe while iterating toward GPU-authoritative wet-surface simulation.

## Current Product Model

MistyOS operates as a two-surface workflow:

1. Edit in Studio (`/studio`): adjust timeline, scene, and settings.
2. Save: write an explicit saved authoring snapshot (`savedRevision`).
3. Update Desktop: publish from saved state only (`publishRevision`, `restartToken`) and hand off runtime ownership to Presentation.
4. Review in Presentation (`/`): runtime restarts from the published payload and runs as a consumer surface.

Important behavior:

- Save does not publish.
- Update Desktop is the publish and handoff action.
- Presentation consumes published runtime payload and does not author it.

## Current Architecture Summary

Core runtime model today:

- Deterministic engine authority: scheduler-sampled weather and runtime payload drive replay behavior.
- Presentation is a rendering and review surface, not an authoring surface.
- Studio is the authoring surface and controls Save and Update Desktop lifecycle actions.
- `runtimeMode: gpuFields` is the default runtime mode in tuning config and introduces independent moisture-field authority (`src/engine/GpuFieldsState.js`).
- Single-active-surface lifecycle is enforced through runtime surface priority heartbeats and TTL-based resolution (`src/runtime/authoringRuntimeBridge.js`).
- Save vs Update Desktop semantics are explicit: Save writes `savedDocument`; Update Desktop publishes `publishedDocument` from saved state and issues `update-desktop-handoff`.
- Canonical Presentation window targeting uses a named window (`mistyos-presentation-window`) and reuse-first behavior before opening a new window.

No-copy presentation baseline details:

- In `gpuFields` runtime mode, Presentation uses the renderer canvas directly as the presentation source.
- Legacy composite-source copy behavior remains available for non-`gpuFields` runtime modes.

## Current Status And Milestones

Recent stabilization outcomes reflected in current code and docs:

- No-copy presentation baseline path is active for `gpuFields` runtime mode.
- Adapter timing instrumentation is split (`raindropFxUpdateTimeMs`, `adapterSimulationTimeMs`, `adapterGlStateResetTimeMs`, `adapterRendererDrawTimeMs`) to separate simulation and draw/reset costs.
- Cross-tab contention was surfaced and handled through runtime-surface ownership controls and preview pause semantics.
- Single-active-surface policy is implemented via heartbeats, TTL staleness resolution, and explicit release/handoff transitions.
- Update Desktop performs explicit Studio to Presentation handoff (`update-desktop-handoff`) and Presentation honors this state during startup/priority resolution.
- Presentation window reuse is canonicalized with named-window targeting (`mistyos-presentation-window`) before fallback open.
- Repo context and payload reduction work is reflected in active authority docs and repository boundary guidance (see `ACTIVE_CONTEXT.md` and `REPO_BOUNDARY.md`).

## Performance Notes

- Presentation is expected to run near browser VSync cadence on a 60 Hz path (around 60 FPS when the active surface is focused).
- Recent regressions below cadence were traced primarily to lifecycle and cross-tab scheduling contention, not raw adapter cost alone.
- Browser visibility and focus scheduling can reduce cadence for non-active surfaces by design.

## Contributor Working Rules

Use these repo rules when making changes:

- Treat active authority docs as primary references: `ACTIVE_CONTEXT.md`, `PHASES.md`, `REPO_BOUNDARY.md`, `.github/copilot-instructions.md`, and active architecture/decision/metrics docs.
- `artifacts/`, `archive/`, and archived docs are not normal coding surfaces.
- Prefer small, single-purpose changes.
- Preserve runtime baseline behavior while iterating.
- Do not reintroduce legacy copy/composite assumptions into the `gpuFields` presentation path.
- Do not broaden retrieval or editing scope beyond active surfaces unless explicitly required.

## Run And Development

Prerequisites:

- Node.js 18+
- npm

Install:

```bash
npm install
```

Run dev server:

```bash
npm run dev
```

Common local URL:

- `http://127.0.0.1:5173`

Routes:

- Presentation route: `/`
- Studio route: `/studio`

Build:

```bash
npm run build
```

Preview build:

```bash
npm run preview
```

## Validation And Workflow Notes

Quick sanity checks:

- Presentation sanity:
  - Open `/` with `?rdfxDebug=1`.
  - Confirm runtime is rendering and timing counters are live.
  - Confirm Presentation acts as active surface when focused.

- Studio sanity:
  - Open `/studio`.
  - Make a change and verify unsaved state.
  - Run Save and verify saved state/revision update.
  - Run Update Desktop and verify publish revision/restart token update.

Update Desktop semantics:

- Save alone does not hand off ownership.
- Update Desktop publishes from saved state, performs explicit ownership handoff to Presentation, and triggers Presentation-focused review flow.

## Repository Structure Overview

High-level map:

- `src/`: active runtime, authoring, scheduler, and verification code.
- `public/`: media and vendor assets.
- `tests/`: test scenarios and baselines.
- `tools/`: verification and analysis utilities.
- `scripts/`: active capture and support scripts.
- `docs/architecture/`, `docs/decisions/`, `docs/metrics/`: active technical references.
- `artifacts/`: run outputs and reports (not primary coding surface).
- `archive/`, `docs/archive/`, `docs/archive_external/`: historical or externalized material.

## Current Priorities

- Continue RaindropFX behavior parity validation against baseline-seed flows.
- Advance wetness-driven fog coupling without breaking deterministic lifecycle contracts.
- Preserve performance while keeping authoritative-field architecture and single-active-surface behavior intact.
