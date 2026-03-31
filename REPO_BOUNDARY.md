# Repository Boundary

This document defines what belongs in this repository, what does not, and where to find authoritative resources.

**Last Updated:** 2026-03-31

---

## What Belongs in This Repo

### Active Editable Source
- **src/** — GPU rain engine implementation (WetSurfaceEngine, rendering, tuning)
- **tests/** — Test definitions and test infrastructure
- **public/** — Static web assets (stylesheets, fonts, etc.)

### Configuration & Build
- **package.json, package-lock.json** — Dependency manifest and lock file
- **tsconfig.json, tsconfig.app.json** — TypeScript configuration
- **vite.config.ts, vite.config.js** — Build configuration
- **.github/workflows/** — GitHub Actions CI/CD pipelines

### Project Metadata & Governance
- **.github/copilot-instructions.md** — Authoritative execution model (one-pass workflow)
- **ACTIVE_CONTEXT.md** — Authoritative project status and scope
- **PHASES.md** — Authoritative phase transition workflow and status board
- **README.md** — Project overview
- **REPO_BOUNDARY.md** — This file (repository scope definition)

### Architecture & Design Reference
- **docs/architecture/** — GPU authority contract, pass-graph order, prohibited patterns
- **docs/metrics/** — Success criteria, fidelity and performance thresholds
- **docs/decisions/** — Architectural decision log (permanent decisions, not exploratory notes)
- **docs/archive/** — Historical text docs and moved root-level historical reports/json indexes
- **docs/archive_external/pass4-root-surface/** — Quarantined non-runtime root trees (Pass 4)

### Development Harness & Tools
- **tools/** — Harness infrastructure, reference baseline, and test utilities (reusable across runs)

---

## What Does NOT Belong in This Repo

### Generated Build Outputs
- **dist/** — Build output (regenerated on demand)
- **node_modules/** — Npm packages (regenerated via `npm install`)
- **.venv/** — Python environment (regenerated if needed)

### Experiment Artifacts (Binary Payloads)
- **artifacts/baseline-seed-screenshots*.png** — Experiment screenshots (move to external storage)
- **artifacts/experiments/*/*.png** — Experiment run screenshots (move to external storage)
- **artifacts/baseline-seed-diag-*.png** — Diagnostic images (move to external storage)

### Experiment Metrics & Logs
- **artifacts/*.json** (JSON metrics from capture runs) — move to external storage or archive if historical
- **artifacts/*.log** — capture run logs (move to external storage or archive)

### Historical & Superseded Docs
- **docs/PHASE*_PROGRESS.md** — individual phase step logs (superseded by PHASES.md; now in docs/archive/)
- **docs/*-forensics.md** — one-off debugging/issue investigation docs (now in docs/archive/)
- **docs/next-runner-experiment-*.md** — exploratory experiment plans (now in docs/archive/)
- **docs/runner-*-check.md** — one-off validation notes (now in docs/archive/)
- **Root historical reports/json** (`BASELINE_SEED_FINAL_REPORT.md`, `baseline-seed-*.json`, `REPO_DIET_PASS_SUMMARY.md`, `PASS2_AUDIT_INDEX.md`, `ARCHIVAL_MANIFEST.md`) — moved to `docs/archive/root-surface-pass4/root-historical-files/`

### Deprecated Instruction Files
- **IDE_LLM_WORKFLOW.md** — deprecated; consolidated into `.github/copilot-instructions.md` (now in docs/archive/)

### One-Off Validation Results
- **BASELINE_SEED_FINAL_REPORT.md** — historical baseline validation (now in artifacts/)
- **BASELINE_SEED_VERIFICATION_CHECKLIST.md** — historical baseline verification (now in artifacts/)
- **FINAL_OUTPUT_BASELINE_SEED_VERIFICATION.md** — historical verification output (now in artifacts/)

### Root Non-Runtime Storage Trees
- **archive/** — replaced by pointer stub; payload moved to `docs/archive_external/pass4-root-surface/archive/`
- **recovery-lab/** — replaced by pointer stub; payload moved to `docs/archive_external/pass4-root-surface/recovery-lab/`

---

## Where Things Go

### Active Development Captures & Metrics
- **Location:** `artifacts/` (with manifest reference to external storage)
- **Examples:** Recent experiment runs, latest validation results
- **Retention:** Keep as index; move binary content to external storage

### Historical Experiment Artifacts
- **Location 1 (local):** `docs/archive/` — small text files, diagnostics notes
- **Location 2 (external):** Sibling directory `../MistyOS_artifacts_external/artifacts/`
- **Location 3 (quarantine in-repo):** `docs/archive_external/pass4-root-surface/` — non-runtime root trees removed from active root surface

### Handoff Packages
- **Active:** `handoff/REVIEW_PACKAGE_MANIFEST.md` (concise pointer to current deliverable)
- **Historical:** `docs/archive/` (versioned, with dates)

### Design Documentation
- **Active architectural decision:** `docs/architecture/` or `docs/decisions/`
- **Exploratory notes / experiments:** `docs/archive/` (with date markers)
- **One-off diagnostics:** `docs/archive/` (never in active docs/)

---

## Authoritative Files (Single Sources of Truth)

**Do not create duplicates or competing versions of these files:**

| Document | Purpose | Never Duplicated As |
|----------|---------|---------------------|
| `.github/copilot-instructions.md` | Execution model (DISCOVER/CHANGE/VALIDATE/REPORT), scope rules, change rules | IDE_LLM_WORKFLOW.md (archived) |
| `ACTIVE_CONTEXT.md` | Current project status, active surfaces, excluded folders | Per-phase progress logs (archived) |
| `PHASES.md` | Phase workflow, transitions, status board | PHASE*_PROGRESS.md (archived) |
| `docs/architecture/engine-architecture.md` | GPU authority contract, pass graph | Architecture verification notes (archived) |
| `docs/decisions/decision-log.md` | Permanent architectural decisions | Scattered decision notes (archived) |
| `docs/metrics/success-criteria.md` | Fidelity/performance thresholds | One-off validation reports (archived) |

**If you need to add information:**
- **Is it an existing decision or criteria?** → Update the authoritative file
- **Is it a new decision or constraint?** → Add to the authoritative file
- **Is it exploratory or one-off?** → Create in `docs/archive/` with a date marker; do not add to active docs/

---

## Repository Size & Retrieval Scope

### Measured Composition (as of 2026-03-31)

| Component | Size | Files | Status |
|-----------|------|-------|--------|
| **src/** (active code) | 1.94 MB | 97 | Active in repo |
| **tools/** (harness) | 44.84 MB | 205 | In repo; consider external if > 50 MB |
| **docs/** (design) | 0.22 MB | 43 | Active reference (forensics moved to archive) |
| **artifacts/** (captures) | 0.39 MB | 13 | Lightweight manifest/index + small sample only |
| **docs/archive_external/pass4-root-surface/archive/** (legacy payload) | 36.76 MB | 240 | Quarantined from root (Pass 4) |
| **archive/** (root stub) | ~0.00 MB | 1 | Pointer only |
| **recovery-lab/** (root stub) | ~0.00 MB | 1 | Pointer only |
| **docs/archive/** (superseded) | ~0.05 MB | 15 | Historical docs (kept for reference) |

### IDE Retrieval Cost (413 Vector Mitigation)

- **Measured reduction (Pass 2):** ~52 KB of redundant docs archived; ~50 fewer files in active scan
- **Pass 3 result:** Heavy artifact payload externalized to `../MistyOS_artifacts_external/artifacts/` (466 files, 300565447 bytes)
- **Pass 4 result:** Root non-runtime trees quarantined to `docs/archive_external/pass4-root-surface/` and root historical report/json files moved to `docs/archive/root-surface-pass4/root-historical-files/` (38604441 bytes moved)
- **Remaining vector:** Long IDE chat history (outside repo; managed via chat settings)

---

## Import Rules (Do Not Break These)

- **src/** is canonical source code; no move outside repo (import contracts depend on it)
- **tools/** reference baseline is frozen; moves here require coordination
- **Configuration files** are glued to repo root; keep them here

---

## Checks & Governance

### Pre-Commit Checklist
- [ ] No new .md files at root level (use docs/ or docs/archive/)
- [ ] No new workflow files (all rules in .github/copilot-instructions.md)
- [ ] No duplicate instruction/context/authority documents
- [ ] Large new files (> 5 MB) → move to artifacts/ or external storage

### Quarterly Repo Hygiene
- Review docs/ for superseded content → move to docs/archive/
- Review artifacts/ for old experiment runs → extract to external storage
- Review root-level files → consolidate into active docs/

---

## See Also

- [.github/copilot-instructions.md](.github/copilot-instructions.md) — Execution contract
- [ACTIVE_CONTEXT.md](ACTIVE_CONTEXT.md) — Project status
- [PHASES.md](PHASES.md) — Phase workflow
- [docs/architecture/engine-architecture.md](docs/architecture/engine-architecture.md) — GPU design
