# Deterministic Engine Boundary Transition (2026-03-25)

## Status
Planning and architecture definition only for branch `deterministic-engine-boundary`.
No runtime behavior changes are included in this document.

## Scope and Non-Goals

Scope:
- Define the transition from React-lifecycle-influenced runtime control to engine-authoritative deterministic runtime control.
- Preserve the existing MistyOS mission and constraints from the design guidebook and architecture contracts.
- Keep scheduler weather intent as the sole temporal authority.

Non-goals:
- No product scope expansion.
- No Studio/Presentation role change.
- No rendering model rewrite in this pass.
- No big-bang refactor.

## 1) Problem Statement in Repo Terms

Current direction already states the right contract (Presentation as consumer, scheduler as temporal authority, startup idempotence), but execution paths are still partially React-lifecycle-influenced.

Observed boundary risk in current repo structure:
- `src/pages/PresentationPage.jsx` carries startup orchestration, pre-start bootstrap scanning, session/restart classification, startup-phase sampling tags, and clock reset triggers.
- Scheduler sampling is correctly centralized in `src/scheduler/runtime.js`, but sampling cadence/bootstrap decisions can still be initiated from React effect/callback ordering.
- Weather-driven config projection exists in `src/runtime/runtimeExecution.js` and is consumed from Presentation runtime orchestration, not from an engine-owned deterministic boundary.

Why startup and early-live divergence was possible:
- Multiple startup call sites and lifecycle triggers can race or reorder around mount/restart/refresh.
- Bootstrap and first-live sampling were protected by diagnostics and flags, but not yet enforced by a single engine-owned startup state machine.
- React-level orchestration still has opportunities to influence when simulation-time advancement and weather application happen.

Net effect:
- Contracts were documented and partially defended, but authority was split across UI lifecycle and runtime internals, leaving early-live path ambiguity risk.

## 2) Desired End-State Architecture

### Ownership Boundaries

React (UI/orchestration only):
- Owns route/page lifecycle, canvas host attachment, and published payload subscription.
- Sends runtime session commands and external inputs to engine boundary.
- Displays diagnostics and state reported by engine.
- Must not advance simulation time, perform startup sequencing decisions, or directly apply weather-derived simulation updates.

Engine (authoritative runtime execution):
- Owns runtime session lifecycle and deterministic startup state machine.
- Owns simulation-time advancement and fixed-step progression policy.
- Owns when scheduler samples are requested and when sampled weather is applied.
- Applies all config/weather inputs only at explicit simulation boundaries.

Scheduler (temporal weather intent authority):
- Owns timeline weather evaluation for a requested simulation time.
- Returns deterministic weather snapshot and diagnostics from compiled timeline/intent data.
- Does not own engine frame loop or startup sequencing.

### Weather Boundary Crossing

- Engine requests scheduler sample using engine-owned simulation time.
- Engine maps scheduler weather snapshot into runtime tuning inputs through a deterministic projection.
- Presentation does not push direct per-frame weather values into engine.
- Any payload/config changes from Presentation are queued as commands and applied at controlled engine boundaries.

## 3) Deterministic Startup State Machine (Presentation Runtime Session)

Canonical startup model for each `runtimeSessionKey`:

1. `UNINITIALIZED`
- Engine instance exists, no session boot accepted.

2. `CANONICAL_BOOTSTRAP`
- Accept one boot command for session key (idempotent).
- Resolve initial scheduler bootstrap sample via deterministic policy (including first-rain-window scan policy if retained).
- Apply bootstrap inputs before first live simulation tick.
- Emit bootstrap diagnostics artifact.

3. `FIRST_LIVE_BOUNDARY`
- Run first live simulation boundary at deterministic frame/time marker.
- Sample scheduler for first-live boundary time and apply through same boundary mechanism.
- Emit first-live parity diagnostics artifact.

4. `STARTUP_FRAME_SYNC`
- Optional bounded startup sync window (if needed for parity) with explicit frame limits.
- No alternate path branching; only deterministic bounded transition.

5. `STEADY_STATE_LIVE`
- Continuous live fixed-step simulation progression.
- Scheduler sampling and external input application remain boundary-gated.

6. `STOPPED`
- Session terminated; all pending commands discarded or archived per policy.

State machine invariants:
- Exactly one canonical bootstrap per session key.
- Exactly one first-live boundary record per session key.
- No direct jump from `UNINITIALIZED` to `STEADY_STATE_LIVE`.
- Re-entering with same session key is idempotent.

## 4) Presentation <-> Engine Input/Application Contract

All inbound runtime changes use command envelopes:

Command envelope fields (minimum):
- `runtimeSessionKey`
- `sequenceNumber` (monotonic per session)
- `kind` (`boot`, `runtime-payload-update`, `ui-input`, `shutdown`)
- `applyPolicy` (`bootstrap-only`, `next-boundary`, `frame-boundary:N`)
- `payload`

Application rules:
- Engine is the only component that mutates simulation state.
- Commands are accepted into an engine queue and applied only at allowed boundaries.
- Mid-tick direct mutation is prohibited.
- Commands for stale session keys are rejected.
- Duplicate sequence numbers are ignored (idempotence guard).

Weather/config projection rules:
- Scheduler snapshot -> deterministic projection -> engine-applied config.
- Projection is pure for the same input snapshot.
- Projection is executed by engine-owned runtime boundary module, not by React effects.

## 5) Verification Requirements During and After Refactor

Must remain true throughout each slice:

Determinism:
- Same published payload + same seed + same startup mode + same fixed-step policy -> same startup artifacts and equivalent runtime output envelope.

Startup idempotence:
- Cold load, publish-restart, and manual refresh produce equivalent canonical bootstrap and first-live boundary results for the same runtime payload/session lineage.

Boundary discipline:
- No React-originated direct simulation-time advancement.
- No React-originated direct weather application into simulation state.

Parity diagnostics continuity:
- Preserve and continue using startup parity evidence labels/events used by current verification lane (`pre-start-bootstrap-result`, `boot-parity-first-frame`, `boot-parity-summary`) or explicitly version/replace them with migration notes.

Harness compatibility:
- Validation harness fairness controls remain unchanged (seed/dt/resolution/background/scene script/parameter timeline alignment).

## 6) Smallest Safe Implementation Slices

Slice A: Engine session-state authority scaffold (no behavior change)
- Introduce an engine-owned runtime session controller/state machine interface.
- Keep existing behavior but route startup phase bookkeeping through controller.
- Add instrumentation proving one bootstrap and one first-live boundary per session.

Slice B: Simulation clock authority migration
- Move simulation clock reset/advance authority from Presentation lifecycle helpers into engine session controller.
- React only issues boot/restart commands.

Slice C: Bootstrap logic migration
- Move pre-start bootstrap sampling policy from Presentation component into engine boundary module.
- Preserve existing scan policy and diagnostics labels for parity.

Slice D: Boundary-gated input queue
- Introduce command envelope queue and apply-policy enforcement.
- Replace direct config/weather application pathways with boundary-applied commands.

Slice E: Verification hardening and cleanup
- Add explicit startup state-machine assertions in verification scripts.
- Remove obsolete React lifecycle startup guards once engine authority is proven.

## Recommended First Implementation Slice

Start with Slice A: Engine session-state authority scaffold (no behavior change).

Why first:
- Lowest risk, creates the authority seam before moving timing/bootstrap responsibilities.
- Produces immediate verification value by making startup phases explicit and machine-checkable.
- Enables incremental migration of clock/bootstrap/input contracts without blind rewrite.
