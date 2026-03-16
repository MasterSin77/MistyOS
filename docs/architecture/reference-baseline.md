# Reference Baseline Pointer (Transition)

## Full Reconstruction Location

The full readable RaindropFX reconstruction, provenance set, and Stage C experiment package now live in:

- `C:/Users/cerul/RaindropFX-Reconstruction`

Primary docs in the new repository:

- `docs/architecture/reference-baseline.md`
- `docs/architecture/raindropfx-archaeology-stage-a-b.md`
- `docs/architecture/raindropfx-variable-effect-map.md`
- `docs/architecture/raindropfx-variable-effect-map-batch2.md`
- `docs/architecture/raindropfx-variable-effect-map-batch3.md`

## What Remains Locally In This Repo

A minimal baseline validation path is intentionally retained during transition so successor/harness work can still run side-by-side checks.

Retained local baseline files:

- `reference-baseline.html`
- `src/reference/reference-baseline.ts`
- `src/reference/background-presets.ts`
- `src/reference/integration.ts`
- `src/reference/baseline-module.ts`
- `src/reference/provenance.md`
- `src/reference/frozen/raindrop-fx/**`

## Current Role In This Repo

In this repository, the baseline is now a validation dependency for successor-engine and harness research. Authoritative reconstruction documentation and curated archaeology evidence should be maintained in the standalone RaindropFX repository.
