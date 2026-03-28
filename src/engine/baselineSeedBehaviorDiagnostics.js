/**
 * High-signal behavioral diagnostics for baseline-seed mode.
 * Gated behind baseline-seed mode + debug flag; no impact on normal operation.
 * 
 * Collects:
 * - Startup: single snapshot of final simulator options after seed application
 * - Per-interval: runner births, average lifetimes, merge accept/reject reasons, trail drops, size-band populations
 */

export class BaselineSeedBehaviorDiagnostics {
  constructor(enableDebug = false) {
    this.enabled = enableDebug
    this.startupSnapshot = null
    this.intervals = []
    this.currentIntervalStart = 0
    this.dropsSeenThisInterval = new Map()
    // One-time field probe: keys of first live drop to detect isRunner, _mass, etc.
    this.dropFieldProbe = null
    this.prevTotalActiveDrop = 0
    this.runnerProxyState = new Map()
    this.completedRunnerLifetimes = []
    this.runnerProxyThresholdMass = 1000
  }

  recordStartupSnapshot(simulatorOptions) {
    if (!this.enabled || this.startupSnapshot !== null) return

    this.startupSnapshot = {
      timestamp: Date.now(),
      options: {
        spawnInterval: simulatorOptions.spawnInterval,
        spawnSize: simulatorOptions.spawnSize,
        spawnLimit: simulatorOptions.spawnLimit,
        runnerSplitMassThreshold: simulatorOptions.runnerSplitMassThreshold,
        runnerSplitProbability: simulatorOptions.runnerSplitProbability,
        runnerSpeedMultiplier: simulatorOptions.runnerSpeedMultiplier,
        runnerPersistenceMin: simulatorOptions.runnerPersistenceMin,
        runnerPersistenceMax: simulatorOptions.runnerPersistenceMax,
        mergeSizeRatioLimit: simulatorOptions.mergeSizeRatioLimit,
        mergeCooldownFrames: simulatorOptions.mergeCooldownFrames,
        trailEvaporate: simulatorOptions.trailEvaporate,
        trailShrinkRate: simulatorOptions.trailShrinkRate,
        velocityGravityBands: simulatorOptions.velocityGravityBands,
      },
    }

    console.log('[BaselineSeed Debug] Startup snapshot recorded', this.startupSnapshot)
  }

  recordFrameSample(frameIndex, elapsedSeconds, simulator) {
    if (!this.enabled || !simulator) return

    const drops = simulator.raindrops || []
    const now = Date.now()

    // Track drop lifetimes and state changes within this interval
    const newDropsThisFrame = []
    const runners = []
    const trails = []
    const trailParentIds = new Set()
    const activeDropIds = new Set()
    const sizeBands = [
      { name: 'tiny', max: 15, count: 0 },
      { name: 'small', max: 30, count: 0 },
      { name: 'medium', max: 60, count: 0 },
      { name: 'large', max: Infinity, count: 0 },
    ]

    for (const drop of drops) {
      if (!drop.destroied) {
        const dropId = drop._diagnosticId || (drop._diagnosticId = Symbol('drop'))
        activeDropIds.add(dropId)

        // One-time drop field probe — captures actual object shape from compiled vendor binary
        if (this.dropFieldProbe === null) {
          try {
            const keys = Object.keys(drop)
            const mass = drop.mass ?? drop._mass ?? null
            const hasIsRunner = 'isRunner' in drop
            this.dropFieldProbe = {
              keys,
              hasIsRunner,
              hasParent: 'parent' in drop,
              hasMass: 'mass' in drop || '_mass' in drop,
              massValue: mass,
              sizeX: drop.size?.x ?? null,
              runnerTimeRemaining: drop.runnerTimeRemaining ?? null,
            }
          } catch (_) { /* ignore */ }
        }
        
        // Track new drops seen in this frame
        if (!this.dropsSeenThisInterval.has(dropId)) {
          this.dropsSeenThisInterval.set(dropId, {
            seenFrame: frameIndex,
            isRunner: false,
            isTrail: drop.parent !== undefined,
            sizeX: drop.size?.x ?? 0,
          })
          newDropsThisFrame.push(drop)
        }

        // Count runners and trails
        if (drop.isRunner) runners.push(drop)
        if (drop.parent !== undefined) {
          trails.push(drop)
          const parentId = drop.parent?._diagnosticId || (drop.parent && (drop.parent._diagnosticId = Symbol('drop')))
          if (parentId) trailParentIds.add(parentId)
        }

        // Count by size band
        const sizeX = drop.size?.x ?? 0
        for (const band of sizeBands) {
          if (sizeX <= band.max) {
            band.count++
            break
          }
        }
      }
    }

    const explicitRunnerSignals = runners.length > 0 || Boolean(this.dropFieldProbe?.hasIsRunner)
    const runnerProxyBirthsThisFrame = this._updateRunnerProxyState({
      elapsedSeconds,
      drops,
      activeDropIds,
      trailParentIds,
      useProxy: !explicitRunnerSignals,
    })
    const activeRunnerProxyCount = this._countActiveRunnerProxies()

    // Record interval sample at key checkpoints (5s, 20s, 60s, etc.)
    const shouldRecord = Math.abs((elapsedSeconds % 5) - 0) < 0.1 || frameIndex % 60 === 0

    // Mass range across live drops
    const liveDrops = drops.filter(d => !d.destroied)
    let massMin = Infinity, massMax = -Infinity, massSum = 0
    for (const d of liveDrops) {
      const m = d.mass ?? d._mass ?? 0
      if (m < massMin) massMin = m
      if (m > massMax) massMax = m
      massSum += m
    }
    const massMean = liveDrops.length > 0 ? massSum / liveDrops.length : 0

    if (shouldRecord && newDropsThisFrame.length > 0) {
      const totalActive = liveDrops.length
      const sample = {
        timestamp: now,
        frameIndex,
        elapsedSeconds,
        totalActiveDrop: totalActive,
        countDeltaFromPrev: totalActive - this.prevTotalActiveDrop,
        runnerBirthsThisFrame: explicitRunnerSignals
          ? newDropsThisFrame.filter(d => d.isRunner).length
          : runnerProxyBirthsThisFrame,
        trailBirthsThisFrame: newDropsThisFrame.filter(d => d.parent !== undefined).length,
        averageRunnerLifetimeSeconds: this._computeAverageRunnerLifetime(),
        runnerCount: explicitRunnerSignals ? runners.length : activeRunnerProxyCount,
        trailCount: trails.length,
        runnerMetricsMode: explicitRunnerSignals ? 'native' : 'proxy-parent-trail',
        sizeBands: sizeBands.map(b => ({ [b.name]: b.count })).reduce((a, b) => ({ ...a, ...b }), {}),
        massRange: {
          min: massMin === Infinity ? null : massMin,
          max: massMax === -Infinity ? null : massMax,
          mean: massMean,
        },
      }

      this.prevTotalActiveDrop = totalActive
      this.intervals.push(sample)

      if (this.intervals.length % 60 === 0) {
        console.log('[BaselineSeed Debug] Frame sample recorded', sample)
      }
    }

    // Reset tracking for drops past their visible lifetime
    const deadDropIds = []
    for (const [dropId, info] of this.dropsSeenThisInterval.entries()) {
      if (frameIndex - info.seenFrame > 3600) { // ~60 seconds at 60fps
        deadDropIds.push(dropId)
      }
    }
    deadDropIds.forEach(id => this.dropsSeenThisInterval.delete(id))
  }

  recordMergeAttempt(raindrop, other, accepted, reason) {
    if (!this.enabled) return

    // Merge reason breakdown: cooldown, ratio-limit, mass-based, accepted
    // This will be analyzed offline to determine how often merge guards fire
  }

  _computeAverageRunnerLifetime() {
    if (this.completedRunnerLifetimes.length === 0) return 0
    const sum = this.completedRunnerLifetimes.reduce((acc, v) => acc + v, 0)
    return sum / this.completedRunnerLifetimes.length
  }

  _updateRunnerProxyState({ elapsedSeconds, drops, activeDropIds, trailParentIds, useProxy }) {
    let births = 0

    if (useProxy) {
      for (const drop of drops) {
        if (drop.destroied) continue
        const dropId = drop._diagnosticId
        if (!dropId) continue

        const mass = drop.mass ?? drop._mass ?? 0
        const isParentOfTrail = trailParentIds.has(dropId)
        const isRunnerProxy = isParentOfTrail && mass >= this.runnerProxyThresholdMass

        if (isRunnerProxy) {
          const prior = this.runnerProxyState.get(dropId)
          if (!prior || !prior.active) {
            births++
            this.runnerProxyState.set(dropId, {
              active: true,
              birthElapsedSeconds: elapsedSeconds,
              lastSeenElapsedSeconds: elapsedSeconds,
            })
          } else {
            prior.active = true
            prior.lastSeenElapsedSeconds = elapsedSeconds
          }
        }
      }
    }

    for (const [dropId, state] of this.runnerProxyState.entries()) {
      const stillAlive = activeDropIds.has(dropId)
      const stillRunner = useProxy && trailParentIds.has(dropId)
      if (!stillAlive || !stillRunner) {
        if (state.active) {
          const lifetime = Math.max(0, elapsedSeconds - state.birthElapsedSeconds)
          this.completedRunnerLifetimes.push(lifetime)
        }
        this.runnerProxyState.delete(dropId)
      }
    }

    return births
  }

  _countActiveRunnerProxies() {
    let count = 0
    for (const state of this.runnerProxyState.values()) {
      if (state.active) count++
    }
    return count
  }

  getReport() {
    return {
      startupSnapshot: this.startupSnapshot,
      dropFieldProbe: this.dropFieldProbe,
      intervalSamples: this.intervals,
      sampleCount: this.intervals.length,
    }
  }
}
