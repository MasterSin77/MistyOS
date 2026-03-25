# MistyOS — Copilot Workspace Instructions

**Project:** MistyOS Design Integration

You are implementing and refining MistyOS according to the design guidebook at `docs/MISTYOS_DESIGN_GUIDEBOOK.md`. Treat that guidebook as the primary product and UX reference for all future design decisions in this workspace.

---

## Core product understanding

MistyOS has two intentionally different faces:

1. **Presentation** = the art-first atmospheric stage
2. **Studio** = the authoring workstation

Presentation must remain immersive, minimal, and uncluttered.  
Studio must remain scene-centered, timeline-driven, and understandable by default.

**Do not treat this as generic web UI work.**  
**Do not imitate desktop software for appearance alone.**  
**Do not add complexity unless it clearly serves the MistyOS workflow.**

---

## Overarching thesis

MistyOS is a scene-centered atmospheric authoring workstation where weather is the programmable medium, the scheduler is the temporal director, and clarity must win over density by default.

---

## Implementation priorities

1. Preserve the role separation between Presentation and Studio
2. Keep the scene as the visual center of Studio
3. Keep the scheduler/timeline as the temporal source of truth
4. Ensure panel behavior follows workstation conventions: resizable, collapsible, restorable, maximizable
5. Ensure the timeline defaults to readable authoring blocks, not compressed markers
6. Keep advanced tuning available but optional
7. Keep menus purposeful and grouped by workspace area
8. Use icon-first panel controls with tooltips where appropriate
9. Ensure responsive behavior across browser sizes and common desktop browsers
10. Make every visible region self-identifying and obviously useful

---

## Specific design rules

- Default to understanding first, density second
- Use available timeline width to make clips readable before compressing them
- Use compact views only as user options or space-constrained fallbacks
- Keep ruler and track labels pinned where appropriate
- Keep panel restore affordances visible when panels are collapsed
- Keep asset browsing dense and useful, not oversized and wasteful
- Keep inspector context-sensitive and truly editable
- Keep the top bar focused on primary context, not overloaded with secondary controls
- Move secondary controls into menus when they do not need to be always visible
- Keep Presentation clean and free of Studio clutter
- Keep Studio purposeful and workstation-like without becoming a fake OS clone

---

## Weather/timeline model

- Weather is authored over time through the timeline
- Scheduler is the source of truth for temporal behavior
- Supported tracks: Wind, Rain, Mist, Fog Buildup, Fog Clearing, Washdown, Intent
- Spatial authoring should remain compatible with future region-aware behavior
- Advanced tuning should not replace timeline authoring

---

## Five architectural layers (do not conflate them)

| Layer | Owns |
|-------|------|
| 1. Simulation | Droplets, wetness, trail/runner memory, fog response |
| 2. Render Interpretation | How state appears visually; debug overlays |
| 3. Scheduler | Timeline, envelopes, event sequencing, transitions |
| 4. Spatial Authoring | Regions, quadrants, composition overlays |
| 5. Product Interface | Presentation page, Studio page, menus, panels |

---

## When making design changes

- Explain how the change supports the guidebook thesis
- Prefer simplification over decorative enhancement
- Preserve engine/runtime behavior unless explicitly asked otherwise
- Avoid broad rewrites when a focused UX correction will solve the issue

## When uncertain

Choose the option that makes Studio more understandable, more scene-centered, and more workstation-like in a purposeful way.

---

## Key files

- `docs/MISTYOS_DESIGN_GUIDEBOOK.md` — design constitution (primary reference)
- `docs/architecture/engine-architecture.md` — GPU shared-surface model and pass graph
- `docs/architecture/validation-harness.md` — dual-mode harness design
- `docs/metrics/success-criteria.md` — fidelity/performance thresholds
- `src/pages/` — Presentation and Studio page implementations
- `src/engine/` — GPU simulation engine
- `src/scheduler/` — timeline and event sequencing
