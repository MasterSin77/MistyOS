# RaindropFX Variable-to-Effect Map

## Stage C Batch 2: Morphology Controls (2026-03-15)

## Scope

This batch stayed on the baseline/source-understanding track only and varied one parameter at a time against the frozen baseline runtime.

Parameters tested:
- trailDistance
- trailDropSize
- trailDropDensity
- trailSpread
- colliderSize

Method:
- Low/current/high per parameter.
- All non-target parameters fixed to the same baseline behavior profile.
- Before/after screenshots captured.
- Runtime health, motion/structure, and performance artifacts captured using the same pipeline as Batch 1.

Artifact root:
- tools/logs/behavioral-exp/stage-c-batch2-morphology-2026-03-16T02-28-53-365Z/

Run summary:
- tools/logs/behavioral-exp/stage-c-batch2-morphology-2026-03-16T02-28-53-365Z/batch-summary.json

## Exact values tested

| Parameter | Low | Current | High |
|---|---:|---:|---:|
| trailDistance | [10, 20] | [16, 34] | [26, 48] |
| trailDropSize | [0.20, 0.40] | [0.35, 0.60] | [0.50, 0.85] |
| trailDropDensity | 0.12 | 0.20 | 0.32 |
| trailSpread | 0.30 | 0.52 | 0.75 |
| colliderSize | 0.70 | 1.00 | 1.20 |

## Parameter findings

### 1) trailDistance

1. What changed visually:
- Low values caused trail-drop emission to occur more frequently along paths, increasing perceived streak segmentation and continuity.
- High values spaced trail emissions farther apart, making streaks look more intermittent and less chain-like.

2. What did not change:
- Blob/body size impression of primary drops changed only mildly.
- Optical/compositing style remained stable.

3. Effect strength:
- Strong on trail continuity and streak spacing.

4. Classification:
- Fundamental for trail morphology identity.

5. MistyOS extensibility relevance:
- High. This is a direct morphology control for runnel cadence/segmentation.

6. Morphology questions:
- Thin streak formation: materially affects (yes).
- Rounded blob formation: materially affects (weak/secondary).
- Trail continuity: materially affects (yes, strong).
- Droplet merging/coalescence: materially affects (weak/indirect).
- Lower-screen pooling/curtain formation: materially affects (medium, through how quickly trail material is deposited downstream).

7. Performance note:
- No large cost cliff; small FPS variation around baseline.

### 2) trailDropSize

1. What changed visually:
- Low values reduced trail-bead footprint and made trails appear finer/thinner.
- High values increased trail-bead footprint, yielding chunkier streak fragments and more rounded secondary blobs.

2. What did not change:
- Global motion cadence stayed close to baseline.
- Lighting/refraction character did not materially shift.

3. Effect strength:
- Strong on morphology.

4. Classification:
- Fundamental for streak-vs-blob balance.

5. MistyOS extensibility relevance:
- High. This is a primary shape-language control for trail identity.

6. Morphology questions:
- Thin streak formation: materially affects (yes, inverse with value).
- Rounded blob formation: materially affects (yes, direct with value).
- Trail continuity: materially affects (medium).
- Droplet merging/coalescence: materially affects (medium, larger trail droplets create more overlap opportunities).
- Lower-screen pooling/curtain formation: materially affects (medium, larger fragments accumulate more visibly).

7. Performance note:
- High setting showed a modest cost increase vs low in this environment.

### 3) trailDropDensity

1. What changed visually:
- Low density produced lighter trail offspring and reduced visual mass transfer from parent to trail droplets.
- High density produced heavier trail offspring with stronger localized droplet bodies, shifting appearance toward denser trail fragments.

2. What did not change:
- Core drop motion cadence remained in the same family.
- Background/mist optical style unchanged.

3. Effect strength:
- Medium to strong.

4. Classification:
- Important (bordering fundamental for some looks).

5. MistyOS extensibility relevance:
- High. Useful for controlling morphology mass distribution without rewriting renderer.

6. Morphology questions:
- Thin streak formation: materially affects (medium; higher density tends to thicken fragments).
- Rounded blob formation: materially affects (yes, medium).
- Trail continuity: materially affects (medium).
- Droplet merging/coalescence: materially affects (medium, via offspring mass profile).
- Lower-screen pooling/curtain formation: materially affects (medium, denser offspring increase accumulation presence).

7. Performance note:
- Higher density tended to reduce FPS modestly relative to current in this run set.

### 4) trailSpread

1. What changed visually:
- Low spread constrained vertical spread of trail droplets, producing tighter, more compact trail signatures.
- High spread broadened trail droplet elongation/spread impression and slightly softened streak definition.

2. What did not change:
- Merge topology did not show major shifts compared with trailDistance/trailDropSize changes.
- Primary blob size regime remained broadly similar.

3. Effect strength:
- Medium.

4. Classification:
- Important, but not top-tier secret-sauce driver by itself.

5. MistyOS extensibility relevance:
- Medium-high. Good secondary shape tuning control.

6. Morphology questions:
- Thin streak formation: materially affects (medium).
- Rounded blob formation: materially affects (weak-medium).
- Trail continuity: materially affects (medium).
- Droplet merging/coalescence: materially affects (weak).
- Lower-screen pooling/curtain formation: materially affects (weak-medium).

7. Performance note:
- No obvious consistent penalty; small run-to-run variance.

### 5) colliderSize

1. What changed visually:
- Low collider size reduced effective merge radius, preserving more separated droplets and finer granularity.
- High collider size increased merge encounters, producing larger coalesced blobs and stronger aggregate structures.

2. What did not change:
- Intrinsic trail spawn cadence itself was not directly altered.
- Optical rendering style remained stable.

3. Effect strength:
- Strong for coalescence morphology.

4. Classification:
- Fundamental for merge behavior.

5. MistyOS extensibility relevance:
- High. Core control for coalescence topology and macro droplet growth.

6. Morphology questions:
- Thin streak formation: materially affects (medium, indirectly via merge suppression/enhancement).
- Rounded blob formation: materially affects (yes, strong).
- Trail continuity: materially affects (weak-medium, indirect).
- Droplet merging/coalescence: materially affects (yes, strong).
- Lower-screen pooling/curtain formation: materially affects (medium-strong, by enabling larger merged bodies to accumulate and descend).

7. Performance note:
- No severe cost cliff in this batch; expected to influence CPU collision workload in larger-scale scenarios and should be stress-tested.

## Cross-batch interpretation (Batch 1 + Batch 2)

- Batch 1 established motion-language primaries: gravity (strong), then slipRate/motionInterval (important cadence controls).
- Batch 2 identifies morphology primaries: trailDropSize and colliderSize are the strongest structural levers.
- trailDistance is also a major structural lever specifically for streak continuity/segmentation.
- trailDropDensity and trailSpread are important secondary morphology shapers.

## Current evidence-based central controls for streak/trail/merge identity

Top central controls after Batch 2:
- trailDropSize
- colliderSize

Close third for trail identity:
- trailDistance

## Recommendation for Stage C Batch 3

Focus Batch 3 on optical-structure coupling controls only, because morphology and cadence baselines are now separated with evidence:
- refractBase
- refractScale
- smoothRaindrop
- raindropEraserSize
- raindropCompose

Objective for Batch 3:
- determine which controls alter true structural readability of morphology versus merely changing perceived style/contrast.
