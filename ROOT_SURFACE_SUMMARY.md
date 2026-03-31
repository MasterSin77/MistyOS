# Root Surface Summary (Pass 4)

Date: 2026-03-31

## Intentionally Remaining at Root
- Active source and runtime trees: src/, tests/, public/, tools/
- App/build/config entry points: package.json, package-lock.json, tsconfig*.json, vite.config.*
- Current workflow and governance docs: ACTIVE_CONTEXT.md, PHASES.md, REPO_BOUNDARY.md, README.md, OPERATIONAL_413_RULES.md
- Minimal active scripts and harness launch files used by current workflow

## Removed From Root (This Pass)
- Root non-runtime trees moved to quarantine:
  - archive/ -> docs/archive_external/pass4-root-surface/archive/
  - recovery-lab/ -> docs/archive_external/pass4-root-surface/recovery-lab/
- Root historical files moved to docs/archive/root-surface-pass4/root-historical-files/:
  - BASELINE_SEED_FINAL_REPORT.md
  - baseline-seed-analysis-report.json
  - baseline-seed-evidence-report.json
  - baseline-seed-validation-results.json
  - REPO_DIET_PASS_SUMMARY.md
  - PASS2_AUDIT_INDEX.md
  - ARCHIVAL_MANIFEST.md

## Authoritative Now
- ACTIVE_CONTEXT.md
- PHASES.md
- REPO_BOUNDARY.md
- README.md
- .github/copilot-instructions.md
- docs/architecture/*
- docs/decisions/*
- docs/metrics/*

## Externalized / Quarantined Now
- docs/archive_external/pass4-root-surface/archive/
- docs/archive_external/pass4-root-surface/recovery-lab/
- docs/archive/root-surface-pass4/root-historical-files/
- Move index for full reversibility: docs/archive/root-surface-pass4/PASS4_MOVE_INDEX.md
