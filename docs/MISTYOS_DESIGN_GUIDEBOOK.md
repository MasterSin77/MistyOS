# MistyOS Design Guidebook — Version 1.0

> **Status:** Active design constitution. Treat as the primary product and UX reference for all future design decisions.

---

## 1. Purpose

MistyOS is not a generic UI shell, not a dashboard, and not merely a rain effect demo.

It is a **programmable atmospheric system** with two tightly related but intentionally different faces:

- an **art-first Presentation surface**
- a **desktop-style Studio authoring environment**

The Presentation surface exists to be experienced.
The Studio exists to direct, choreograph, inspect, and tune that experience.

The project's strength comes from keeping those roles separate.

MistyOS should feel like a living weather instrument: slow, natural, responsive, purposeful, and capable of both ambient beauty and intentional reveal.

It must support long atmospheric drift, deliberate buildup, local or global clearing, timeline-based authored events, and future message or icon reveals through natural-feeling condensation behavior.

The system is not trying to fake meaning with decoration. It is trying to make atmosphere authorable.

---

## 2. Product Model

MistyOS has two primary operational modes.

### Presentation

Presentation is the public-facing, immersive surface.

It should:
- prioritize open space
- minimize interface clutter
- emphasize the weather and background scene
- run authored timelines by default
- reset state on visit or refresh
- expose only a very subtle launcher into Studio

Presentation is the art object.

### Studio

Studio is the authoring workstation.

It should:
- feel like a serious desktop tool
- prioritize authoring clarity over spectacle
- expose timelines, assets, tuning, diagnostics, and layout controls
- keep the scene visible as the central subject
- allow the user to build and inspect atmospheric choreography
- behave like a purpose-built workstation, not a web page with floating widgets

Studio is the control room.

---

## 3. Core Design Thesis

MistyOS should be designed as a **scene-centered atmospheric authoring workstation** where the weather is the medium, the scheduler is the director, the scene is the stage, and every part of the interface serves immediate understanding before density, customization, or novelty.

That thesis contains several rules:

1. The scene is always the emotional center.
2. The scheduler is the temporal source of truth.
3. Spatial overlays must clarify intent, not obscure the scene.
4. Density is optional; readability is the default.
5. Advanced tuning is available but never allowed to dominate the main workflow.
6. Desktop workstation conventions should be used where they improve usability, not where they merely imitate software culture.
7. Presentation must remain art-first.
8. Studio must remain authoring-first.
9. Weather is not a visual gimmick. It is the programmable language of the system.
10. The UI must communicate the product's logic automatically, without relying on explanation.

---

## 4. Overarching Interaction Philosophy

The user should be able to answer these questions instantly:

- What am I looking at?
- What part of the system am I editing?
- What happens over time?
- What happens in space?
- What is selected?
- What can I do next?

If the interface cannot answer those automatically, it is not done.

The UX should prefer:
- directness
- clear hierarchy
- predictable placement
- context-sensitive editing
- responsive density
- restrained iconography
- meaningful defaults

The UX should avoid:
- duplicated information
- decorative complexity
- panels without a job
- hidden state with no recovery path
- oversized controls that waste space
- compressed controls that hide meaning by default

---

## 5. Architectural Separation of Concerns

MistyOS should be thought of as five stacked layers.

### Layer 1: Simulation

Owns: droplets, wetness, trail memory, runner memory, fog and clearing response.

This layer should not know about clocks, icons, or content intent.

### Layer 2: Render Interpretation

Owns: how simulated state appears visually, fog density response, softness, clearing visuals, preview and debug overlays.

This layer translates atmospheric state into image language.

### Layer 3: Scheduler

Owns: timeline, temporal envelopes, weather event sequencing, intent event timing, authored transitions.

This layer is the director.

### Layer 4: Spatial Authoring

Owns: regions, quadrants, target areas, composition overlays, future reveal placements.

This layer answers *where*.

### Layer 5: Product Interface

Owns: Presentation page, Studio page, asset selection, layout controls, menus, panels, tuning surfaces.

This layer answers *how the human works with the system*.

---

## 6. Presentation Design Guide

### Purpose

Presentation is not a dashboard. It is a stage.

### Required characteristics

- full atmospheric scene
- minimal visible interface
- no debugging chrome by default
- no right rail, no scheduler, no inspector
- subtle bottom-right MistyOS launcher
- authored timeline runs by default
- scene resets per visit or refresh
- state is not persisted live between sessions by default

### Launcher behavior

The launcher should be:
- small
- nearly invisible until hover
- respectful of the visual field
- capable of opening Studio in a separate page or tab

The launcher should feel like part of the world, not a generic app link.

### Scene behavior

Default startup mode should be always atmospheric.

### Presentation constraints

No panel should appear on Presentation unless:
- it is intentionally invoked
- it serves the presentation experience directly
- it does not break immersion

---

## 7. Studio Design Guide

### Purpose

Studio is a desktop-style atmospheric authoring workstation.

It should not be an atmospheric page with controls on top of it.
It should not be an admin dashboard.
It should not be a debugging dump.

It is a structured tool.

### Studio layout model

```
┌──────────────────────────────────────────────────────────┐
│  Top menu bar + context bar                              │
├────────┬─────────────────────────────────┬───────────────┤
│        │                                 │               │
│  Left  │        Center scene             │    Right      │
│  rail  │        workspace                │    inspector  │
│        │                                 │               │
├────────┴─────────────────────────────────┴───────────────┤
│  Bottom timeline / scheduler                             │
└──────────────────────────────────────────────────────────┘
```

The center scene must remain the dominant area.

### Visual hierarchy

1. **Primary:** scene preview
2. **Secondary:** timeline
3. **Tertiary:** inspector
4. **Utility:** assets, advanced tuning, diagnostics

If that order is lost, the interface becomes noisy.

---

## 8. Top Bar and Menus

### Top bar purpose

The top region does two jobs:
- provide standard workstation menu access
- provide current project context

### Menu structure

| Menu | Contents |
|------|----------|
| **File** | Import/export studio JSON; export tuning JSON; reset studio defaults; future save/load project |
| **Edit** | Undo; redo; duplicate clip; delete selected; future clipboard actions |
| **View** | Organized by workspace area: Timeline, Scene Preview, Inspector, Assets, Panels, UI, Layout |
| **Layout** | Reset layout; layout presets (Preview focus, Timeline focus, Balanced, Diagnostics focus); future named layouts |
| **Tools** | Advanced tuning; diagnostics; future analyzers |
| **Help** | Shortcuts; panel explanations; future docs or guide links |

### View menu note

View should mirror the Studio's mental model, organized by workspace area — not a flat list of toggles.

### Context bar

The always-visible context controls should be minimal and important.

Good candidates for the context bar:
- Scene
- Timeline
- Preset

Move to menus when not always needed:
- UI scale
- density
- layout preset
- reset layout
- advanced tuning toggle

The bar should not become crowded with secondary controls.

---

## 9. Left Rail: Assets and Libraries

### Purpose

The left rail is a source browser, not a gallery wall.

### Grouping

```
Assets
  └── Scenes
  └── Media

Weather
  └── Presets
  └── Timelines
```

### Density

Rows or cards should:
- be readable at a glance
- allow thumbnails if helpful
- preserve names clearly
- support selection and future drag/drop
- not waste vertical space

### Collapsed state

If collapsed, the rail must leave:
- a visible restore affordance
- icon or tab indicating what the panel is
- never disappear without a way back

---

## 10. Center Workspace

### Purpose

The center workspace is the stage plus authoring overlays.

The scene must remain visible in all core modes.

### Scene-first rule

The scene is not replaced by tabs. Tabs switch overlays or authoring modes over the same scene.

### Workspace modes

| Mode | Purpose |
|------|---------|
| **Preview** | Atmospheric result; minimal overlay |
| **Composition** | Scene + quadrant/region guides + intent targets + selected event highlights |
| **Diagnostics** | Debug overlays, engine summaries, performance info, state readouts |
| **Weather** | Spatial weather understanding; future regional visualization |

### Composition mode answers

- Where will this happen?
- What region is involved?

### Avoid

- Do not create a separate giant boxed composition panel if the same information can be overlaid on the scene.
- Do not duplicate timeline elements inside the scene by default.

---

## 11. Right Inspector

### Purpose

The right side is an editor, not a metadata dump.

### Context-sensitive behavior

| Selection state | Show |
|----------------|------|
| **Nothing selected** | High-value summary: scene, preset, timeline, startup mode, workspace mode, a few important toggles. Should not be mostly empty. |
| **Scene selected** | Scene selector, preset selector, timeline selector, startup behavior, scene-related settings |
| **Weather clip selected** | Type, intensity, duration, start/end, blend in/out, region if relevant |
| **Intent clip selected** | Intent type, region, lead-in behavior, reveal behavior, timing metadata |

### Affordances

Fields should look editable: dropdowns, toggles, sliders where appropriate, grouped sections. Static text should be minimized.

### Collapsed state

Inspector collapse must always leave a visible restore affordance.

---

## 12. Bottom Scheduler / Timeline

### Purpose

The timeline is the temporal source of truth.

It is not telemetry. It is not a histogram. It is an authoring sequencer.

### Structure

The timeline pane includes:
- title/header
- ruler (pinned)
- track labels (pinned column)
- track content area
- horizontal scrollbar for time
- vertical scrollbar for tracks

### Track types

**Continuous atmospheric tracks:**
- Wind
- Rain
- Mist
- Fog Buildup
- Fog Clearing
- Washdown

**Event/intention tracks:**
- Intent

### Track grouping

```
Atmosphere
  └── Wind
  └── Rain
  └── Mist

Fog System
  └── Fog Buildup
  └── Fog Clearing

Surface
  └── Washdown

Events
  └── Intent
```

### Clip behavior

Clips should look like editable authoring blocks, not tiny compressed markers, by default.

### Readability rule

Default to understanding first, density second.

As available width increases, clips should automatically reveal:
1. type/name
2. intensity/value
3. duration
4. time range

### Scaling behavior

- If the timeline can fit content while making clips meaningfully readable: auto-fit them.
- If not: allow horizontal scroll.
- Never leave lots of empty space while clips stay tiny.

### View options

Timeline-specific view options belong under **View → Timeline**:
- label density
- fit timeline to window
- snap
- clip style (future)

### Playback (future)

Eventually the timeline should support: rewind, play, pause, step. Clip clarity is primary.

---

## 13. Advanced Tuning Panel

### Purpose

Legacy sliders and detailed render/weather controls remain useful, but are optional. They are not the main workflow.

### Behavior

Advanced tuning should be:
- toggleable
- docked
- integrated into layout, not floating randomly
- vertically scrollable
- tabbed

### Tab structure

| Tab | Contents |
|-----|---------|
| Atmosphere | General atmospheric settings |
| Rain | Droplet intensity, size, distribution |
| Fog | Density, softness, clearing rate |
| Surface Wetness | Wetness accumulation, evaporation, trails |
| Render | Visual quality, debug aids |

### Important rule

Opening advanced tuning should not destroy the layout. It should resize intelligently and feel like a utility dock.

---

## 14. Panel System

### Every panel must have a job

No panel exists because there is room.

### Required panel behaviors

- resize
- collapse
- restore
- maximize

### Maximize behavior

When a panel is maximized:
- competing panels should temporarily hide or minimize
- the maximized panel becomes the active task space

Layout presets:
- Preview focus
- Timeline focus
- Inspector focus
- Balanced
- Diagnostics focus

### Headers

All major panels need:
- a clear title
- consistent header styling
- grouped actions on the right (icons with tooltips)

### Iconography conventions

| Action | Icon |
|--------|------|
| Collapse | Chevron/caret |
| Maximize | Square |
| Restore | Overlapping squares |
| Close (if needed) | X |

Replace text labels like "Collapse" and "Maximize" with icons + tooltips.

### Tooltip policy

Use tooltips for: icon actions, unusual controls, timeline clips, intent markers, diagnostics overlays.

Do not use tooltips to explain the whole app.

---

## 15. Readability and Density Strategy

### Rule

Readable by default.

### UI scale options

- 100%
- 110%
- 125%
- 150%

Default should be slightly larger than earlier iterations.

### Density modes

- Compact
- Comfortable

### Prioritization when space is tight

1. collapse panels
2. reduce padding
3. hide secondary detail

Do not solve layout pressure by making critical text too small.

---

## 16. Responsive Behavior

### Priority order under space pressure

1. preview (protect most)
2. timeline (protect second)
3. inspector (collapse first)
4. assets (compress or collapse second)

### On wider screens

- preview grows most
- timeline gets useful width
- inspector may remain moderate
- asset rail stays efficient

### On narrower screens

- inspector collapses or narrows first
- assets compress or collapse
- timeline remains usable
- preview keeps a minimum viable size

### Cross-browser robustness goals

- sticky headers remain aligned
- scrollbars do not break layout
- menu/dropdown controls stay readable
- font sizes do not collapse
- timeline ruler and tracks remain aligned

Target browsers: Chrome, Edge, Firefox, Safari (where feasible).

### Recommended strategies

- avoid brittle absolute sizing
- prefer CSS variables and `clamp()`-based sizing
- test scroll containers explicitly
- use `ResizeObserver` where layout measurement is required
- maintain minimum panel sizes
- allow overflow gracefully rather than clipping critical controls

---

## 17. Design Language

### Tone

MistyOS should feel: cool, atmospheric, precise, modern, serious, restrained.

### Avoid

- toy-like color noise
- overly decorative neon
- excessive animation in the authoring UI
- fake complexity

### Color

Use color functionally:
- calm dark shell
- atmospheric blue/gray palette
- clip colors to distinguish track meaning
- highlights only where interaction matters

### Motion

UI motion should be minimal and purposeful. Weather motion should dominate emotional motion, not UI chrome.

### Borders and contrast

Use subtle but clear panel separations. The Studio should not become a wall of identical dark rectangles.

---

## 18. Feature Communication Through Design

A user should be able to infer these system powers from the UI alone:

| System power | What communicates it |
|--------------|---------------------|
| Weather is programmable | Timeline + grouped weather tracks |
| Atmosphere can be authored over time | Scheduler + playhead |
| Events can happen in specific places | Composition overlays + spatial selection |
| System supports ambient and intentional moments | Preview + timeline together |
| Advanced tuning exists without overwhelming | Optional tuning dock |

If the interface does not communicate those things at a glance, the design has failed.

---

## 19. Future Features Already Implied by the Design

The design must remain compatible with future additions such as:

- richer intent tracks
- transition tracks
- transport controls (play/pause/step/rewind)
- timeline zoom
- named layouts
- drag-and-drop authoring
- region templates
- scene collections
- event templates
- future export workflows

These should emerge naturally from the existing structure, not force a redesign.

---

## 20. What Not To Do

- Do not turn Studio into a fake OS clone.
- Do not fill menus with meaningless commands.
- Do not compress readability in pursuit of density.
- Do not duplicate timeline controls in the scene preview.
- Do not let debugging dominate the main workflow.
- Do not leave empty panels consuming major space.
- Do not make Presentation look like Studio.
- Do not force every idea on screen at once.

---

## 21. Success Criteria

### Presentation succeeds when

- feels immersive
- feels quiet
- feels atmospheric
- makes the launcher easy to find only when needed

### Studio succeeds when

- feels like a serious authoring workstation
- has obvious spatial and temporal logic
- makes the scene the center
- makes timeline editing readable
- makes tuning accessible but optional
- remains understandable without explanation

### Overall success when

- weather feels like a directable medium
- the interface communicates the product's logic naturally
- each screen has a thesis and obeys it

---

*MistyOS Design Guidebook — Version 1.0 — March 2026*
