# IDE Retrieval Surface

## Primary (auto-context preferred)
- src/**
- package.json
- vite.config.ts
- vite.config.js
- tsconfig.json
- tsconfig.app.json
- ACTIVE_CONTEXT.md
- PHASES.md
- REPO_BOUNDARY.md
- OPERATIONAL_413_RULES.md
- README.md
- docs/architecture/engine-architecture.md
- docs/decisions/**
- docs/metrics/**
- tools/scripts/**
- tools/verification/**
- tools/analysis/*.mjs
- scripts/**

## Avoid Unless Explicitly Requested
- artifacts/**
- handoff/**
- recovery-lab/**
- archive/**
- docs/** (except primary authority docs above)
- tools/** (except active workflow utilities above)
- tools/perception/**
- tools/logs/**
- root one-off capture/test runners (capture-*.mjs, test-*.mjs)
- baseline output/report snapshots (baseline-seed-*.json, baseline-seed-*.md, BASELINE_SEED_*.md, FINAL_OUTPUT_*.md)
