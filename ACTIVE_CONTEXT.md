# ACTIVE_CONTEXT.md

**Project:** GPU-native wet-surface rain engine recovery for MistyOS. Migrate canonical wet-surface authority from CPU-authored texture overlays to GPU-resident shared state while maintaining visual parity and performance targets against frozen baseline.

**Current Status:** Phase 6 complete (2026-03-30). All phase transitions documented in [PHASES.md](PHASES.md).

---

## Active Source Surfaces

| Surface | Path | Purpose |
|---------|------|---------|
| Main Engine | [src/engine/WetSurfaceEngine.js](src/engine/WetSurfaceEngine.js) | Orchestrator; owns simulation loop, tuning, lifecycle. Primary refactor subject. |
| Wetness Field | [src/engine/SurfaceWetnessField.js](src/engine/SurfaceWetnessField.js) | Per-surface moisture accumulation model. Migrate to GPU. |
| Renderer Adapter | [src/engine/RaindropFxRendererAdapter.js](src/engine/RaindropFxRendererAdapter.js) | CPU-to-render boundary. Authority migration point. |
| Tuning Config | [src/tuning/tuningConfig.js](src/tuning/tuningConfig.js) | Wetness/flow/render parameters. GPU-side contract definition. |
| Presentation Page | [src/pages/PresentationPage.jsx](src/pages/PresentationPage.jsx) | Runtime entry point. Engine instantiation and session control. |

---

## Active Design Docs

| Doc | Purpose |
|-----|---------|
| [.github/copilot-instructions.md](.github/copilot-instructions.md) | **Authoritative:** One-pass execution model (DISCOVER, CHANGE, VALIDATE, REPORT). Scope and change rules. |
| [docs/architecture/engine-architecture.md](docs/architecture/engine-architecture.md) | **Authoritative:** GPU authority contract, prohibited patterns, pass-graph order. |
| [docs/decisions/](docs/decisions/) | Active architectural decisions and design trade-offs. |
| [docs/metrics/](docs/metrics/) | Success criteria, fidelity thresholds, performance targets. |
| [PHASES.md](PHASES.md) | **Authoritative:** Current phase status and phase transition workflow. |

---

## Excluded from IDE Retrieval

**Reason:** Reduce automatic payload size and prevent context bloat. All information preserved; access via explicit search if needed.

- **artifacts/*** — validation runs, screenshots, JSON metrics (all historical captures)
- **docs/PHASE*_PROGRESS.md** — individual phase step logs (superseded by PHASES.md)
- **docs/*-forensics.md** — specific-issue debugging notes
- **handoff/*** — review package and delivery artifacts
- **archive/*** — legacy experiment branches
- **Root test/capture files** — one-off harness runs (capture-*.mjs, test-*.mjs, baseline-seed-*.json)
- **IDE_LLM_WORKFLOW.md** — consolidated into .github/copilot-instructions.md; kept for legacy references only

---

## Operating Rules

**Execution:** One pass per request (DISCOVER | CHANGE | VALIDATE | REPORT). Do not combine.

**Scope:** If no explicit file requested, search only active source and current design docs. Do not scan artifacts or historical logs.

**Edits:** Make smallest possible change. Do not refactor broadly. Do not introduce new systems.

**Priority:** Restore correct droplet behavior in GPU baseline mode. Trust visible behavior over theoretical correctness.

---

## Next Checkpoint

Run baseline visual approval ritual against Phase 6 outputs. If pass, execute M1 replication-core implementation.

**See also:** [PHASES.md](PHASES.md#completion-criteria), [docs/architecture/engine-architecture.md](docs/architecture/engine-architecture.md).
