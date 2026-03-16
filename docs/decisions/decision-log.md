# Decision Log

## 2026-03-15

- Runtime selected: browser-first TypeScript.
- GPU backend sequence: WebGPU preferred first, WebGL2 fallback after M1 stabilization.
- Baseline selection policy: closest clean readable open implementation with provenance if official readable source unavailable.
- Determinism policy: seeded runs plus bounded parameter sweeps.
- Performance gate: 1080p at 60 FPS target (<=16.7 ms/frame average), with strict separation of native and instrumented costs.
- RaindropFX classification after Stage A-C evidence: strong donor/reference architecture, not the current preferred direct MistyOS foundation.
- Successor direction: reconstruct RaindropFX clearly for documentation/handoff value, but move new engine work toward a canonical GPU shared-surface architecture informed by the discovered motion, morphology, and optical layers.
