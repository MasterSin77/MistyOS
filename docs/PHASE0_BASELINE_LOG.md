# Phase 0 Baseline Log

Date started: 2026-03-12
Status: Completed

This file is the single place to record Phase 0 baseline numbers and screenshots.

## Run Setup

- Start app: `npm run dev`
- Open with debug flags: `http://localhost:5173/?rdfxDebug=1`
- Keep phase at `3` (Unified Surface).
- Use tuning defaults unless noted in `Notes`.
- For split checks, set `debug.viewMode=split-compare`.

## Scenes

- Scene A: Idle recovery (no writing, no freeze).
- Scene B: Active rain + droplet clearing.
- Scene C: Continuous writing stroke pass.
- Scene D: Split compare parity check.
- Scene E: Ultrawide stress run.

## Metric Capture Table

Capture stable values after ~20s warm-up per scene.

| Scene | avgFrameMs | engineMs | rendererMs | wetnessMs | overlayMs | dropletProcessingMs | clearingMs | diffusionMs | imageConvertMs | wetnessTrendMsPerMin | wetnessResolutionLabel | activeCoveragePct | memoryNote | Notes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---|---|
| A | 163.49 | 164.83 | 1.66 | 164.74 | 0.09 | 0.06 | 0.34 | 106.91 | 28.38 | 555.77 | 1382x777 | 96.9 | heap 52.7MB used / 64.0MB total | idle recovery baseline |
| B | 182.24 | 183.06 | 1.48 | 182.98 | 0.07 | 0.07 | 0.30 | 125.91 | 27.39 | 910.38 | 1382x777 | 94.3 | heap 93.1MB used / 103.8MB total | active rain + droplet clearing |
| C | 151.44 | 150.93 | 1.92 | 150.84 | 0.09 | 0.12 | 0.71 | 88.11 | 30.16 | 35.77 | 1382x777 | 100.0 | heap 58.8MB used / 121.6MB total | scripted pointer writing sweep |
| D | 209.38 | 208.57 | 1.55 | 208.51 | 0.06 | 0.07 | 0.23 | 150.66 | 27.87 | 125.48 | 1382x777 | 95.6 | heap 46.4MB used / 51.1MB total | split-compare mode |
| E | 416.42 | 464.99 | 1.72 | 464.87 | 0.12 | 0.05 | 0.13 | 336.69 | 63.10 | 6054.81 | 2476x1036 | 94.5 | heap 100.5MB used / 110.8MB total | ultrawide 3440x1440 stress |

## Screenshot Checklist

Store screenshots in a dated folder and reference paths below.

- Combined mode screenshot: `artifacts/phase0/combined-reference.png`
- Renderer-only screenshot: `artifacts/phase0/renderer-only.png`
- Fog-only screenshot: `artifacts/phase0/fog-only.png`
- Split compare screenshot: `artifacts/phase0/D-split-compare.png`
- Optional RAW->Composite baseline pair: `artifacts/phase0/A-idle-recovery.png`

## Completion Criteria

- All Scene A-E rows filled with metrics.
- Screenshot checklist completed.
- Memory notes captured for each scene.
- Baseline accepted for Phase 1 comparison.

## Completion Summary

- Date completed: 2026-03-12
- Baseline highlights: wetness + diffusion dominate CPU cost; ultrawide heavily amplifies wetness cost.
- Outliers/issues: measurements are from headless MS Edge automation and should be validated once in interactive desktop mode.
- Decision: proceed to Phase 1 (yes)
