# Success Criteria

## Primary Indicators

- Human-perceived fidelity to approved baseline motion language and feel
- Frame-speed viability at milestone target

## M1 Performance Gate

- 1080p on agreed mid-tier GPU
- Target <= 16.7 ms/frame average in native real-time mode
- Report p95 and p99 frame times

## Measurement Separation Rule

Report both:

- Native runtime cost (real-time mode, minimal instrumentation)
- Instrumented capture cost (deterministic mode and artifact capture)

Include overhead delta explicitly.

## Determinism

- Seeded replay consistency required
- Bounded parameter sweeps must be manifest-defined and reproducible

## Evidence Pack Per Milestone

- Avg/p95/p99 frame times
- Simulation vs render time split
- Capture overhead delta
- Frame hash and replay consistency
- Visual diff summaries (offline)
- Behavior metrics (droplet/trail/runner distributions)
- Human approval verdict
