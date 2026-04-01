# Studio Layout Engineering Rules

**Status:** Standing rules — apply to all future Studio layout work  
**Established:** 2026-04-01  
**Source:** Side-panel resizing work; lessons generalize to any resizable Studio element

---

## Core model

Studio layout engineering is systems engineering, not CSS cleanup. The resizing work exposed that panel width was being treated as a loosely-derived layout outcome rather than a user-chosen, pixel-authoritative state constrained by measured content and a shared workspace budget. The fix required restoring ownership first, then measurement, then budgeting — in that order.

---

## Reasoning order for future layout changes

Apply these eight checks whenever modifying any resizable Studio element:

1. **Ownership** — What single state owns the size? Can any other effect or path rewrite it after user interaction?
2. **Coordinate system** — Is the size stored and rendered in plain CSS pixels? Is any scale or density transform being mixed into the state itself?
3. **Live clamp** — Is the gesture clamped during drag? Can mouseup change the size visibly?
4. **Minimum readable width** — What are the panel's critical row and control patterns? At what width do those stop being readable?
5. **Maximum useful width** — What standard content still needs horizontal room? Is there remaining overflow? Are measurements based on natural content rather than constrained DOM?
6. **Shared workspace budget** — How much width can this element claim without violating the center workspace minimum or other panel needs?
7. **CSS reality** — Does actual DOM width match state width? Is flex or grid fighting the chosen size?
8. **Diagnostics** — Which exact term limited min or max? Can the logs prove why the panel stopped where it stopped?

If a future layout change feels mysterious, assume first that one of these eight steps is being violated.

---

## Standing rules

### Width ownership is singular and authoritative

- User drag computes a proposed pixel width.
- That width is clamped to a live min/max range.
- The clamped pixel width becomes the canonical state.
- mouseup ends the gesture only — it must not rewrite width.
- No post-release normalization, density transform, hydration pass, or layout reconciliation may silently rewrite user-chosen width unless a true external constraint changed (e.g., container resize, explicit layout mode change).

### Clamp during drag, not after drag

- Outward drag stops live at max.
- Inward drag always works.
- Release causes no visible width change.
- Any correction that happens after mouseup is a design smell indicating split ownership or derived-width reflow.

### Never measure max width from constrained DOM

A panel that is already clipped, wrapped, ellipsized, overflow-hidden, or flex-squashed cannot be used as evidence for how wide the panel ought to be. Doing so produces over-tight max calculations and prevents expansion even when horizontal room remains.

Measure instead:
- Natural single-line content requirements (natural-width probe with no constraining parent)
- Chrome, gaps, padding, and control allowances on top of natural measurements
- Horizontal overflow in standard content as evidence that useful max has not been reached

### Minimum width is readability-based

The minimum is the smallest width where standard row patterns remain readable and structurally intact. Examples:
- Inspector summary rows must not collapse into stacked letter-columns
- Definition/value layouts must remain horizontally legible
- Filter rows must remain usable
- Asset rows must preserve icon/name/meta relationships
- Header title and actions must not collide

### Maximum width is usefulness-based and budget-aware

Combine all of the following:
- Natural content max (measured from unconstrained probe)
- Shared workspace budget max (derived from container width minus other panels, splitters, padding/chrome reserve, and a preserved center minimum width)
- If standard content still has horizontal overflow and workspace budget remains, effective max may grow toward budget
- Otherwise use the smaller of natural content max and budget max

### Shared workspace budget is required context

Left and right panels are not independent; they compete for the same horizontal budget and steal space from the center workspace. Any panel sizing change must account for:
- Container width
- Left panel width
- Right panel width
- Splitter widths
- Padding and chrome reserves
- Center minimum width

### UI density and font scale affect constraints, not width ownership

Density and font scale may change measured content needs, which may change min/max constraints. They must not silently rewrite the user's chosen width unless that width is now genuinely outside the valid range. Scaling modes influence measurement inputs; they are not a hidden alternate width coordinate system.

### CSS layout must be made explicit for resizable rails

- Use explicit pixel width, min-width, and max-width on side rails.
- Avoid flex growth/shrink, `width: auto`, or flex-basis reinterpretation on resizable containers.
- When debugging, compare canonical width state to actual DOM width before assuming a state bug.

### Diagnostics are required for adaptive layout

Any adaptive layout system must log the following so the winning constraint is visible:
- `currentWidth`
- `minReadableWidth`
- `naturalContentMax`
- `workspaceBudgetMax`
- `effectiveMax`
- `overflowPresent`
- `limitedBy`
- `measuredAt` / source of last recomputation

"Feels wrong" layout problems almost always come from one hidden limiting term.

---

## Scope of application

These rules apply to any future work on:

- Timeline lane/sidebar widths
- Footer/tool cluster overflow handling
- Inspector subsection collapses and control density
- Scene preview chrome and toolbars
- Modal and dialog sizing
- Adaptive menu widths
- Multi-pane preset and layout systems

The panel is irrelevant. The ownership, measurement, and budgeting model is the same.

---

## Success criterion

A resizable element is finished when the interaction feels standard and obvious:
- No spring-back
- No bounce
- Max stops where it should
- Min stops before unreadability
- Wide screens allow useful expansion
- Content fits cleanly
- Center workspace remains healthy

"Finished" means the interaction is unsurprising, not merely technically explainable.
