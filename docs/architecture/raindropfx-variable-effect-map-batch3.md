# RaindropFX Variable-to-Effect Map

## Stage C Batch 3: Optical Structure and Rendering Coupling (2026-03-15)

## Scope

This batch stayed on the baseline/source-understanding track only and varied one optical/compositing parameter at a time against the actual frozen RaindropFX baseline runtime.

Parameters tested:
- refractBase
- refractScale
- smoothRaindrop
- raindropEraserSize
- raindropCompose

Method:
- Low/current/high per parameter where the source allowed it.
- All non-target parameters fixed to the same baseline behavior profile.
- Before/after screenshots captured.
- Runtime health, motion/structure, and performance artifacts captured using the same pipeline as Batches 1 and 2.

Constraint note:
- `raindropCompose` is binary in source (`smoother` or `harder`). The batch used the two real source states plus a repeat-control third run for consistency; findings are based on the real state change rather than pretending a third legal value exists.

Artifact root:
- tools/logs/behavioral-exp/stage-c-batch3-optical-structure-2026-03-16T02-41-50-286Z/

Run summary:
- tools/logs/behavioral-exp/stage-c-batch3-optical-structure-2026-03-16T02-41-50-286Z/batch-summary.json

## Exact values tested

| Parameter | Low | Current | High |
|---|---:|---:|---:|
| refractBase | 0.25 | 0.45 | 0.70 |
| refractScale | 0.35 | 0.62 | 0.90 |
| smoothRaindrop | [0.88, 0.98] | [0.95, 1.00] | [0.975, 1.00] |
| raindropEraserSize | [0.84, 0.96] | [0.93, 1.00] | [0.97, 1.00] |
| raindropCompose | harder | smoother | smoother repeat-control |

## Parameter findings

### 1) refractBase

1. What changed visually:
- Low values reduced the baseline amount of background UV distortion for all droplets, flattening the glass illusion and making droplets read more like bright overlays with weaker lensing.
- High values increased baseline distortion strength, making even smaller droplets read as more lens-like and increasing perceived glass depth.

2. What did not change:
- Edge softness did not materially change.
- Morphology topology and trail structure remained in the same family.
- Motion cadence remained unchanged.

3. Effect strength:
- Medium.

4. Classification:
- Important.

5. MistyOS extensibility relevance:
- High, because this is a direct control over the core water-on-glass illusion without changing morphology logic.

6. Structural questions:
- Perceived depth or glass illusion: materially changes (yes).
- Droplet edge definition or blur boundaries: weak effect.
- Background refraction distortion or only droplet brightness: primarily refraction distortion.
- Perceived droplet thickness or curvature: medium effect, by making droplets read flatter or more lens-like.
- Compositing pipeline or only final color/contrast: final optical distortion, not a pipeline-mode change.

7. Performance note:
- No meaningful performance cliff observed.

### 2) refractScale

1. What changed visually:
- Low values reduced size-driven distortion escalation, so large drops looked less optically deep relative to smaller ones.
- High values increased size-dependent refraction strength and made larger droplets distort the background more aggressively.

2. What did not change:
- Edge softness and eraser boundary behavior stayed stable.
- Trail/merge morphology did not materially change.

3. Effect strength:
- Medium.

4. Classification:
- Important.

5. MistyOS extensibility relevance:
- High, especially for scaling optical response across droplet sizes.

6. Structural questions:
- Perceived depth or glass illusion: materially changes (medium-strong).
- Droplet edge definition or blur boundaries: weak effect.
- Background refraction distortion or only droplet brightness: primarily refraction distortion.
- Perceived droplet thickness or curvature: medium, especially for larger drops.
- Compositing pipeline or only final color/contrast: no pipeline change; optical distortion weighting only.

7. Performance note:
- High setting showed only a modest cost increase in this environment.

### 3) smoothRaindrop

1. What changed visually:
- Low values broadened the transition band, making droplet silhouettes softer, more blurred, and less crisply defined.
- High values tightened edge transition, making droplets read cleaner and more sharply bounded.
- This was one of the clearest controls for whether the water reads as soft blur mass versus crisp lens boundary.

2. What did not change:
- Underlying trail/merge topology did not materially change.
- Motion cadence and coalescence behavior remained the same.

3. Effect strength:
- Strong.

4. Classification:
- Important, close to core for perceptual readability of the water layer.

5. MistyOS extensibility relevance:
- High. This control will matter in any reconstructed renderer because it determines whether structural morphology stays legible.

6. Structural questions:
- Perceived depth or glass illusion: materially changes (medium).
- Droplet edge definition or blur boundaries: materially changes (yes, strong).
- Background refraction distortion or only droplet brightness: mostly edge/boundary behavior, not primary distortion amount.
- Perceived droplet thickness or curvature: medium, through silhouette sharpness.
- Compositing pipeline or only final color/contrast: final mask/edge behavior, not a pipeline-mode change.

7. Performance note:
- No strong performance signal beyond noise-level variation.

### 4) raindropEraserSize

1. What changed visually:
- Low values enlarged the eraser/clear region and produced a more aggressively cleaned area around large droplets, reducing surrounding micro-droplet residue and making big droplets read more isolated.
- High values reduced that clearing effect, preserving more nearby fine detail and making the composed surface feel denser around large drops.

2. What did not change:
- Core morphology generation rules stayed the same.
- Primary refractive distortion strength did not change much.

3. Effect strength:
- Medium.

4. Classification:
- Important secondary compositing control.

5. MistyOS extensibility relevance:
- Medium-high. Relevant if a reconstructed system keeps this micro-droplet/mist carve-out approach.

6. Structural questions:
- Perceived depth or glass illusion: medium effect.
- Droplet edge definition or blur boundaries: yes, medium.
- Background refraction distortion or only droplet brightness: mostly boundary cleanup/composition, not core distortion amplitude.
- Perceived droplet thickness or curvature: weak-medium.
- Compositing pipeline or only final color/contrast: affects how layers are spatially carved/combined, but not the overall mode.

7. Performance note:
- No meaningful cost cliff observed.

### 5) raindropCompose

1. What changed visually:
- `harder` produced a harsher, more contrasty overlay feel with less of the soft exclusion-style blending that helps water read as a coherent glass layer.
- `smoother` produced the more convincing integrated water-on-glass appearance.
- This parameter made the largest purely visual/compositing change in the batch.

2. What did not change:
- Underlying morphology generation, trail spawning, and merge behavior did not change.
- Motion cadence did not change.

3. Effect strength:
- Strong.

4. Classification:
- Important optical/compositing control, not a morphology primitive.

5. MistyOS extensibility relevance:
- Medium. It matters if the reconstruction preserves the same raster compositing strategy, but it is not a core simulation variable.

6. Structural questions:
- Perceived depth or glass illusion: materially changes (yes, strong).
- Droplet edge definition or blur boundaries: medium effect.
- Background refraction distortion or only droplet brightness: mostly changes overall blend/composite character more than the underlying distortion field.
- Perceived droplet thickness or curvature: medium, via shading/composition readout.
- Compositing pipeline or only final color/contrast: this directly changes the compositing pipeline behavior.

7. Performance note:
- No significant performance change observed between legal modes in this batch.

## Cross-batch synthesis (Batches 1, 2, 3)

### Motion language controls
- gravity
- slipRate
- motionInterval

Interpretation:
- These primarily govern cadence, acceleration, hesitation, and directionality.
- They change how droplets move, not the underlying trail/merge topology or core optical mode.

### Morphology controls
- trailDistance
- trailDropSize
- trailDropDensity
- trailSpread
- colliderSize

Interpretation:
- These govern streak segmentation, bead size, mass distribution, merge topology, and pooling tendency.
- The strongest structural levers found so far are `trailDropSize`, `colliderSize`, and `trailDistance`.

### Optical/compositing controls
- refractBase
- refractScale
- smoothRaindrop
- raindropEraserSize
- raindropCompose

Interpretation:
- These govern whether the existing morphology reads as convincing water-on-glass.
- They alter lensing, edge legibility, layer cleanup, and blend style more than simulation structure.
- The strongest optical-readability levers found so far are `smoothRaindrop` and `raindropCompose`, with `refractBase` and `refractScale` directly controlling glass-depth illusion.

## Core optical categorization

### Core to the water-on-glass illusion
- refractBase
- refractScale
- smoothRaindrop
- raindropCompose

### Secondary style or readability controls
- raindropEraserSize

### Purely cosmetic post-processing
- None of the tested Batch 3 parameters were purely cosmetic in the strict sense.
- The weakest/most secondary of the tested optical controls was `raindropEraserSize`, but even it materially changes local layer cleanup and droplet readability.

## Architectural evaluation

Evidence-based verdict so far:
- RaindropFX appears best classified as a partial donor/reference architecture.

Reasoning grounded in experiment results:
1. The system exposes real, separable control layers.
- Batch 1 isolated motion-language controls.
- Batch 2 isolated true morphology controls.
- Batch 3 isolated optical/compositing controls.
- This separation is a strong sign that the codebase is understandable and reconstructible.

2. The strongest structural behavior is still tied to droplet-object logic rather than a shared wet-surface field.
- Morphology is governed by trail spawn/drop sizing/coalescence parameters rather than a unified surface simulation.
- Optical strength comes from compositing and refraction tricks layered on top of that structure.

3. This makes the system very useful as a readable donor/reference, but less suitable as a direct MistyOS foundation.
- It is strong as a documented source of motion, trail, merge, and illusion mechanisms.
- It is weaker as a direct base for a broader extensible wet-surface OS-style system, because the architecture is still drop-object-centric and compositing-driven rather than generalized shared-state-driven.

4. No experiment so far suggests the system is unsuitable as a reference.
- On the contrary, the experiments show it is internally coherent and tunable.
- But the evidence still favors “partial donor/reference” over “direct extensible foundation”.

Current project answer:
- Not an unsuitable base.
- Not yet supported as a direct extensible MistyOS foundation.
- Best current classification: partial donor/reference architecture that should inform a cleaner reconstructed implementation.
