# Phase 1 Bootstrap Instrumentation Report

## Overview

Bootstrap instrumentation added to distinguish refresh vs publish restart initialization failures. When the same timeline is published and then manually refreshed, bootstrap tracking captures 10 diagnostic fields that reveal exactly which initialization step diverges between the two paths.

## Bootstrap Tracking Fields

### Renderer Lifecycle
- **rendererCreated** (boolean): Marks when RaindropFxRendererAdapter is instantiated in `initializeRaindropRenderer()`
- **rendererAttached** (boolean): Marks when adapter.init() succeeds and renderer is ready
- **firstRenderFrameTime** (ms): Wall-clock timestamp of first animate() frame execution after attachment

### Weather State Application
- **initialWeatherApplied** (boolean): Marks first call to setTuningConfig()
- **initialRainApplied** (boolean): Marks when first setTuningConfig has rain intensity > 0.001
- **initialFogApplied** (boolean): Marks when first setTuningConfig has fog level > 0.001

### Simulation & Rendering
- **seededDropletCount** (integer): Record of simulator snapshot length when first visible rain frame is detected
- **firstVisibleRainFrame** (integer): Frame counter (-1 if never visible) when pixel coverage first exceeds 0.0001

### Bootstrap Path Context
- **refreshPath** (boolean): True if bootstrap is from manual browser refresh (reload navigation + same session key)
- **publishRestartPath** (boolean): True if bootstrap is from publish restart (new session key or initial load)

## Diagnostic Scenarios & What They Prove

### Scenario 1: Both paths identical across all fields
**What it proves**: Initialization succeeds identically in both paths. Failure is downstream in render pipeline, animation loop, or state synchronization.

### Scenario 2: rendererAttached diverges (false on refresh, true on restart)
**What it proves**: Renderer initialization fails silently on refresh path, likely async/await or promise chain issue in `initializeRaindropRenderer()`.

### Scenario 3: initialWeatherApplied diverges (false on refresh, true on restart)
**What it proves**: Scheduler/engine not applying initial weather state on refresh. Check session initialization or tuning config injection.

### Scenario 4: initialRainApplied diverges (false on refresh, true on restart)
**What it proves**: Scheduler has weather tracks but refresh path never applies rain config to engine. Weather track activation issue.

### Scenario 5: seededDropletCount = 0 with initialRainApplied = true
**What it proves**: Rain config reaches engine, but simulator never seeds droplets. Check `updateDropletsFromRenderer()` or droplet initialization.

### Scenario 6: firstVisibleRainFrame = -1 with seededDropletCount > 0
**What it proves**: Simulator seeded correctly, but pixel coverage never appears. Render output lost—check canvas context, blend modes, or visibility.

### Scenario 7: firstRenderFrameTime differs by >100ms between paths
**What it proves**: Refresh path delays or pauses between renderer attachment and first animate frame. Event loop or timing issue.

### Scenario 8: refreshPath/publishRestartPath flags differ
**What it proves**: Session key tracking is working correctly; paths are properly labeled for comparison.

## Evidence Extraction

**In artifacts, compare samples field:**
```
publishRevision: same value
restartToken: different (marks restart vs refresh)
bootstrap.refreshPath vs bootstrap.publishRestartPath: mutually exclusive
```

**Key comparison logic:**
1. Filter samples by `bootstrap.refreshPath === true` for refresh-only samples
2. Filter samples by `bootstrap.publishRestartPath === true` for restart-only samples
3. Compare first few samples from each path to find divergence point
4. If divergence found, the divergent field identifies the failure root cause

## Verification Harness Integration

The verifier script `verify-publish-rain-fog-integrity.mjs` now captures bootstrap data in each sample window:
- initial-load stage: bootstrap should show rendererCreated=true, rendererAttached=true, initially all false until weather applied
- post-initial-publish-reload: restart path should show progressive bootstrap fields becoming true
- post-initial-refresh: refresh path bootstrap progression should match or diverge from restart
- post-update-desktop-reload: second restart path for comparison
- post-update-desktop-refresh: second refresh path for comparison

## Example Artifact Analysis

If artifact shows:
```json
{
  "stage": "post-initial-refresh",
  "samples": [
    {
      "bootstrap": {
        "rendererCreated": true,
        "rendererAttached": true,
        "initialWeatherApplied": false,  // <-- DIVERGES HERE
        "initialRainApplied": false,
        "seededDropletCount": 0,
        "firstVisibleRainFrame": -1,
        "refreshPath": true
      }
    }
  ]
}
```

**Diagnosis**: Refresh path successfully creates and attaches renderer, but scheduler never applies initial weather state. Check:
- applyLiveSettings() not called on refresh
- tuning config not being set after engine creation
- scheduler sample not driving weather updates

## Next Steps After Artifact Capture

1. Run verify-publish-rain-fog-integrity.mjs with timeline deployed to Presentation
2. Capture artifact (will have bootstrap data in all samples)
3. Compare bootstrap progression between refresh vs restart samples
4. Identify first divergent field
5. Based on which field diverges, trace to that specific code path
6. No behavioral fixes yet; diagnostics only

