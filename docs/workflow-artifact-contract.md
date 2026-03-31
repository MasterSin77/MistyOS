# Workflow Artifact Contract

Defines the small-artifact set produced by each validation capture run.

## Files

| File | Location | Purpose |
|------|----------|---------|
| `{timestamp}_comparison.json` | `artifacts/analysis/` | Full analyzer output (all metrics, deltas, per-checkpoint results) |
| `{timestamp}_comparison.summary.json` | `artifacts/analysis/` | Tiny machine-readable score: `run_id`, `score_20s`, `score_60s`, `verdict` |
| `run-manifest.json` | `artifacts/experiments/{run_id}/` | Explicit path handoff for REPORT turns; contains `run_id`, `baseline_dir`, `candidate_dir`, `comparison_json`, `comparison_summary_json` |

## Rules

- `comparison.json` is written by the Python analyzer (`tools/perception/analyze_run_images.py`). Do not parse it in hot paths.
- `comparison.summary.json` is written by the capture runner after the analyzer exits. It never replaces `comparison.json`.
- `run-manifest.json` contains only paths and IDs. No image blobs, no large arrays.
- Future REPORT turns must read summary/manifest directly — do not re-scan artifact directories.
