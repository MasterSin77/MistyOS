# Validation Harness Architecture

## Modes

### Real-time mode

- Native simulation/render observation
- Minimal instrumentation
- Primary source of performance timing

### Deterministic capture mode

- Fixed timestep stepping
- Seed-locked replay
- Frame stepping and bounded sweeps
- Checkpoint artifact generation

## Fairness Controls

Reference and candidate must share identical:

- Seed
- Fixed dt
- Resolution
- Background
- Camera/scene script
- Parameter timeline

Mismatched runs are invalid.

## Contamination Controls

- Keep expensive analysis out of hot rendering path
- Defer diff/metric generation offline
- Use checkpointed capture instead of always-live deep bridge
- Measure instrumented overhead separately from native runtime

## Artifact Contract

Capture packets include:

- Scenario ID and seed manifest
- Frame index
- Frame timing summary
- Frame hash/signature
- Optional sampled state snapshots

## Determinism Contract

- Fixed dt enforced in deterministic mode
- Seeded RNG required
- Bounded parameter sweeps use explicit manifest definitions
