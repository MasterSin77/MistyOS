# RaindropFX Variable-to-Effect Map

## Stage C Batch 1: Motion-Language Controls (2026-03-15)

## Scope

This batch tested only baseline RaindropFX behavior with one-parameter-at-a-time overrides.

Parameters in scope:
- `slipRate`
- `motionInterval`
- `gravity`

Method constraints enforced:
- One parameter changed at a time.
- Other behavior profile values remained fixed.
- Low/current/high values tested for each parameter.
- Before/after artifacts captured per run.

Artifact root:
- `tools/logs/behavioral-exp/stage-c-batch1-motion-language-2026-03-16T02-20-15-171Z/`

Run summary JSON:
- `tools/logs/behavioral-exp/stage-c-batch1-motion-language-2026-03-16T02-20-15-171Z/batch-summary.json`

Capture mode note:
- Measurements were taken in headless browser execution with WebGL enabled; relative deltas are reliable for this batch, absolute FPS should be treated as environment-specific.

## Values tested

| Parameter | Low | Current | High |
|---|---:|---:|---:|
| `slipRate` | 0.55 | 0.74 | 0.90 |
| `motionInterval` | [0.06, 0.14] | [0.12, 0.28] | [0.20, 0.45] |
| `gravity` | 1800 | 2400 | 3000 |

## Artifact index (before/after captures)

### slipRate
- Low: `tools/logs/behavioral-exp/stage-c-batch1-motion-language-2026-03-16T02-20-15-171Z/screens/slipRate-low-frame-00.png`
- Current: `tools/logs/behavioral-exp/stage-c-batch1-motion-language-2026-03-16T02-20-15-171Z/screens/slipRate-current-frame-00.png`
- High: `tools/logs/behavioral-exp/stage-c-batch1-motion-language-2026-03-16T02-20-15-171Z/screens/slipRate-high-frame-00.png`

### motionInterval
- Low: `tools/logs/behavioral-exp/stage-c-batch1-motion-language-2026-03-16T02-20-15-171Z/screens/motionInterval-low-frame-00.png`
- Current: `tools/logs/behavioral-exp/stage-c-batch1-motion-language-2026-03-16T02-20-15-171Z/screens/motionInterval-current-frame-00.png`
- High: `tools/logs/behavioral-exp/stage-c-batch1-motion-language-2026-03-16T02-20-15-171Z/screens/motionInterval-high-frame-00.png`

### gravity
- Low: `tools/logs/behavioral-exp/stage-c-batch1-motion-language-2026-03-16T02-20-15-171Z/screens/gravity-low-frame-00.png`
- Current: `tools/logs/behavioral-exp/stage-c-batch1-motion-language-2026-03-16T02-20-15-171Z/screens/gravity-current-frame-00.png`
- High: `tools/logs/behavioral-exp/stage-c-batch1-motion-language-2026-03-16T02-20-15-171Z/screens/gravity-high-frame-00.png`

## Structured findings

### 1) `slipRate`

1. Exact values tested:
- Low 0.55, current 0.74, high 0.90.

2. What changed visually:
- Low value produced slightly less continuous slipping cadence and a subtly more stop/start feel.
- High value produced smoother, more continuously sliding motion with less perceived hesitation.
- Directional motion metric shifted downward from current for both low and high variants, indicating change in cadence character rather than large shape changes.

3. What did not change:
- Global scene brightness/contrast structure remained effectively stable.
- Droplet occupancy and texture density looked broadly similar frame-to-frame.
- No major compositing-style shift was observed.

4. Effect strength:
- Medium.

5. Classification:
- Important.

6. MistyOS extensibility relevance:
- Relevant. `slipRate` is a direct motion-language dial and should be retained as a first-class control in any reconstructed/extensible system.

Performance note:
- No consistent major cost signal. FPS deltas were modest in this batch (+0.62 to +1.44 FPS vs current).

### 2) `motionInterval`

1. Exact values tested:
- Low [0.06, 0.14], current [0.12, 0.28], high [0.20, 0.45].

2. What changed visually:
- Low interval increased motion-state refresh frequency, making motion micro-variations feel more jittery/reactive.
- High interval reduced refresh frequency, making paths feel steadier and less twitchy.
- Downward directional-bias metric changed sign versus current for low and high variants, indicating a meaningful cadence-pattern shift.

3. What did not change:
- Overall drop field density and tonal statistics remained near-constant.
- Optical style (refraction/lighting character) did not materially change.

4. Effect strength:
- Medium.

5. Classification:
- Important.

6. MistyOS extensibility relevance:
- High relevance. This parameter controls motion state-change cadence and can map to environment-mode behaviors (calm, windy, agitated) without changing rendering architecture.

Performance note:
- No obvious strong performance impact. FPS variation stayed within a narrow range around current.

### 3) `gravity`

1. Exact values tested:
- Low 1800, current 2400, high 3000.

2. What changed visually:
- Low gravity reduced downward drive; drops appeared to descend less aggressively with longer dwell.
- High gravity increased downward pull; drops appeared to accelerate and clear vertically faster.
- Directional-bias metric moved strongly relative to current (negative at low, positive at high), matching expected change in vertical motion character.

3. What did not change:
- Base optical rendering style remained stable.
- Edge softness and compositing signature were largely unchanged.

4. Effect strength:
- Strong.

5. Classification:
- Fundamental.

6. MistyOS extensibility relevance:
- High relevance. Gravity is a core motion-governing primitive and should remain explicit in an extensible architecture.

Performance note:
- Low gravity case showed a notable throughput improvement in this environment (about +4.14 FPS, -6.12 ms avg frame vs current).
- High gravity was near current cost.
- This should be rechecked on non-headless target hardware before final cost conclusions.

## Cross-parameter summary (Batch 1)

- Most influential motion-language control in this batch: `gravity`.
- `slipRate` and `motionInterval` are significant behavior-shaping controls but are secondary to gravity in observed effect magnitude.
- Across all tests, visual identity stayed in the same RaindropFX family; changes were behavioral/cadence-driven rather than pipeline-style shifts.

## Preliminary architecture implication

For reconstruction planning, these three controls should be preserved as explicit, documented policy knobs in the motion subsystem:
- `gravity` as fundamental physical drive.
- `slipRate` as slip activation/retention character control.
- `motionInterval` as stochastic state-refresh cadence control.
