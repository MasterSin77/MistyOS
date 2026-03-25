# Runner Carve Diagnosis Scenario

This scenario is a repeatable Studio authoring setup for runner fog-carve debugging.

## Scenario Asset
- Timeline ID: `runner-carve-diagnosis`
- Timeline name in Studio: **Runner Carve Diagnosis**
- Duration: 70 seconds (loop)

## Authoring Intent
- Fog-first staging: build dense visible fog before runner evaluation (`fogBuildup` ramps high early, `fogClearing` stays near zero)
- Low-noise establishment window: keep rain very low in the opening segment so fog mass is legible
- Bounded runner-focus window where rain is elevated long enough for channel continuity checks (about 28s to 56s)

## Studio Workflow
1. Open Studio.
2. In Inspector, select **Active Timeline = Runner Carve Diagnosis**.
3. Run preview and scrub/play in two windows:
	- Fog establish: 0s to 22s
	- Runner carve inspect: 28s to 56s
4. Save via **File -> Save**.
5. Publish via **File -> Update Desktop**.
6. Restart/open Presentation and verify the same published timeline behavior.

## Expected Visual Readout
- Before fix: dotted puncture artifacts along fast runner motion.
- After fix: continuous carved channels aligned to runner travel direction.
