# Phase 1: Save -> Update Desktop -> Presentation Restart Verification

Date: 2026-03-20
Status: Complete and browser-verified

## Scope

This phase hardens the existing Studio/Presentation workflow without architectural redesign:

- Studio edits are working state.
- Save writes authoring state.
- Update Desktop publishes from saved state only.
- Presentation restarts runtime from time zero on each publish.

## Deterministic revision model

Implemented behavior:

- `savedRevision` increments only when Save is executed.
- `publishRevision` increments only when Update Desktop is executed.
- Publish snapshots only the latest saved payload (never working payload).
- `restartToken` regenerates on every publish.

## Presentation runtime proof (DEV only)

Presentation now shows a development metadata overlay with:

- `publishRevision`
- `fromSavedRevision`
- `restartToken`
- `sceneId`
- `timelineId`
- `published timestamp`

The overlay updates live on every publish without manual refresh.

## Restart correctness

On publish, Presentation performs a full runtime restart by session key change:

- Scheduler runtime is recreated.
- Engine instance is recreated.
- Playback starts from time zero (`sampleSec: 0` lifecycle).
- Previous runtime instance is stopped and discarded.

## Studio state clarity

Studio footer now exposes explicit state:

- Working unsaved/saved state.
- Saved revision state.
- Published state: Not published, Outdated, or Up to date.
- Publish timestamp/revision metadata.

Update Desktop is disabled when working state is unsaved or no saved document exists.

## Cross-tab sync

Bridge synchronization remains storage + broadcast based:

- Local storage key updates (`saved`, `published`).
- `storage` events.
- `BroadcastChannel` sync events.
- Custom sync event fallback.

Result: Presentation updates from Studio publish events without refresh.

## Verification logging

Concise dev logs were added:

- Save event and saved revision values.
- Publish event with revision chain and restart token.
- Presentation restart trigger with previous/next runtime session key.
- Scheduler/engine recreation at restart with `sampleSec: 0`.

## Automated browser verification

Script:

- `tools/scripts/verify-phase1-workflow.mjs`

Run:

```powershell
$env:MISTYOS_BASE_URL='http://127.0.0.1:5177'
node tools/scripts/verify-phase1-workflow.mjs
```

Validated by script:

1. Studio and Presentation open in separate tabs.
2. Timeline modification produces unsaved state.
3. Save increments `savedRevision`.
4. Update Desktop increments `publishRevision` and updates Presentation metadata live.
5. `fromSavedRevision` matches saved revision used for publish.
6. `restartToken` changes on each publish.
7. Outdated publish state appears when saved revision exceeds published revision.
8. Republish returns Studio to up-to-date published state.
