# Reference Baseline Provenance (Fill Before Candidate Fidelity Work)

- Source name: raindrop-fx
- Source URL: https://github.com/SardineFish/raindrop-fx
- License: MIT
- Commit/Version: npm raindrop-fx@1.0.8
- Readability status: frozen upstream source copied from node_modules/raindrop-fx into src/reference/frozen/raindrop-fx
- Why selected as closest clean implementation: WebGL2 rain-on-glass engine in the required behavioral family, inspired by Codrops RainEffect, with mist/trail/deformation controls exposed.
- Known deviations from target behavior: still not guaranteed to replicate every proprietary/internal RaindropFX behavior; used as behavioral oracle candidate pending human approval.
- RainyDay.js status: demoted to technical mount/render/refraction sanity reference only, not behavioral target baseline.
- Human baseline approval record link: tests/baselines/approval-template.md
