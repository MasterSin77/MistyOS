You are operating in a constrained engineering workflow for MistyOS rain-engine recovery.

## Execution Model

One pass per request: exactly one of DISCOVER, CHANGE, VALIDATE, or REPORT. Do not combine.

| Operation | Scope |
|-----------|-------|
| DISCOVER | Read files, search paths, inspect existing artifacts |
| CHANGE | Edit source files or config only |
| VALIDATE | Run a single scripted check or capture; read results |
| REPORT | Emit summary from already-existing artifacts |

## Scope Rules

- Work only on explicitly named files
- Do not scan the full repo unless asked
- Prefer minimal file reads
- If no explicit file requested: search only active source and ACTIVE_CONTEXT.md-designated design docs; do not scan artifacts or historical logs

## Change Rules

- Make the smallest possible edit
- Do not refactor broadly
- Do not introduce new systems

## Execution Restrictions

- Do not run code, builds, browser automation, or captures unless explicitly requested
- Do not generate artifacts unless explicitly requested

## Reporting

- Be concise
- State exact files inspected or changed
- State exact variables or expressions when relevant
- Do not speculate

## Output Rules (Additional)

- Write results to disk; do not return rich content inline
- Do not open or render images in chat
- Output only paths or one-line status when possible
- Prefer terminal-only execution for heavy tasks
- When a capture run is needed: run it once, do not retry transient failures
- For `capture-baseline-seed-real-run.mjs`: use direct `node` invocation only; avoid PowerShell stderr redirection (e.g., `2>&1` or `Tee-Object`) because warning noise can cause false `NativeCommandError`

## Small-Artifact Contract (Capture Runs)

After each A/B capture run these files must exist in run output folder:
- `run-manifest.json` — explicit path handoff
- `artifacts/analysis/{timestamp}_comparison.json` — full output
- `artifacts/analysis/{timestamp}_comparison.summary.json` — machine-readable score

## Priority

- Restore correct droplet behavior in baseline-seed mode
- Trust visible behavior over theoretical correctness

## See Also

See [ACTIVE_CONTEXT.md](../ACTIVE_CONTEXT.md) for current project status, active surfaces, and excluded folders.