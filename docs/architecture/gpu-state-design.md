# GPU Shared Surface State Design

## Minimum Canonical Fields

- Wetness/water mass field
- Flow/slip tendency field
- Disturbance field for writing/wiping impulses and decay
- Droplet density/seed activation field
- Optical gradient/normal derivatives from shared state

## Design Principles

- Every effect reads and writes shared surface state.
- Optical outputs derive from shared state, not independent layer drift.
- Runners emerge from accumulation/advection thresholds, not scripted overlays.
- Mist/runoff must couple to surface dynamics.

## Initial Precision Strategy

- Prefer `r16float` or `rg16float` for primary dynamic fields
- Evaluate quantized fallback formats for memory/perf tuning after baseline fidelity lock

## Update Cadence

- Fixed-step updates in deterministic mode
- Real-time adaptive updates in observation mode (still seed-controlled where applicable)
