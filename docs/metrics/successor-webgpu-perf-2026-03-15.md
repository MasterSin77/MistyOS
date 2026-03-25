# Successor Vertical Slice WebGPU Performance Pass

Date: 2026-03-15
Machine run mode: local headed browser session (Playwright + Chrome channel, headless=false)

## Measurement Setup

- Runtime under test: successor-engine vertical slice (wetness + flow + disturbance + current render path).
- Browser path: WebGPU adapter acquired, vendor reported as `nvidia`, architecture reported as `blackwell`.
- Fallback status: no headless fallback path used.
- Scenario: `baseline-seed-001`.
- Resolution: `1600x900` canvas pixels.
- Fixed delta: `16.6667 ms`.
- Seed: `1337`.
- View mode: `comparison`.
- Background preset: `night-boulevard`.
- Window length: reached frame `1239` (target >= 1200).

Artifact: `artifacts/phase6/successor-webgpu-perf-2026-03-15.json`.

## timingCheckpoint Snapshot

- depositionMs: `0.00`
- decayMs: `0.10`
- renderMs: `0.10`
- totalFrameMs: `0.20`
- smoothedTotalFrameMs: `0.12`
- totalFrameP95Ms: `0.20`
- totalFrameMinMs: `0.00`
- totalFrameMaxMs: `0.40`
- stabilitySpreadMs: `0.40`
- dominantPass: `decay`
- dominantShare: `0.50` (50%)

## Viability Read

- p95 against 60fps budget (16.7 ms): **under budget** (`0.20 ms` < `16.7 ms`).
- Dominant pass: **decay** at approximately **50%** share in the sampled frame.
- Stability character: **stable**, not spiky in this window (min/max spread `0.40 ms`).
- Vertical-slice viability before adding more behavior: **plausibly viable for 60fps** on this machine with the current workload.

## Interpretation Guardrail

These values come from current timingCheckpoint instrumentation around command encoding/submission boundaries, so treat this as a first hardware viability read rather than a full GPU wall-clock proof. Keep this result as a gate indicator before optimization or additional behavior work.
