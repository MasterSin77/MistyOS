const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

const createRect = (minX, minY, maxX, maxY) => ({ minX, minY, maxX, maxY })

const rectWidth = (rect) => (rect ? rect.maxX - rect.minX + 1 : 0)
const rectHeight = (rect) => (rect ? rect.maxY - rect.minY + 1 : 0)
const rectPixels = (rect) => rectWidth(rect) * rectHeight(rect)

const expandRect = (rect, amount, width, height) => {
  if (!rect) {
    return null
  }
  return createRect(
    Math.max(0, rect.minX - amount),
    Math.max(0, rect.minY - amount),
    Math.min(width - 1, rect.maxX + amount),
    Math.min(height - 1, rect.maxY + amount),
  )
}

const unionRect = (a, b) => {
  if (!a) {
    return b
  }
  if (!b) {
    return a
  }
  return createRect(
    Math.min(a.minX, b.minX),
    Math.min(a.minY, b.minY),
    Math.max(a.maxX, b.maxX),
    Math.max(a.maxY, b.maxY),
  )
}

const includePointBounds = (bounds, x, y) => {
  if (!bounds.found) {
    bounds.found = true
    bounds.minX = x
    bounds.maxX = x
    bounds.minY = y
    bounds.maxY = y
    return
  }
  if (x < bounds.minX) bounds.minX = x
  if (x > bounds.maxX) bounds.maxX = x
  if (y < bounds.minY) bounds.minY = y
  if (y > bounds.maxY) bounds.maxY = y
}

const boundsToRect = (bounds) =>
  bounds.found ? createRect(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY) : null

export class SurfaceWetnessField {
  constructor(width, height, options = {}) {
    this.options = {
      minWetness: 0,
      maxWetness: 0.5,
      refillRate: 0.0065,
      recoveryRate: 1.4,
      diffusionRate: 5.4,
      trailRecoveryRate: 0.82,
      runnerMemoryRecoveryRate: 0.56,
      downwardReinforcementFactor: 0.62,
      pathMemoryReinforcementFactor: 0,
      continuityReinforcementFactor: 0.32,
      wetnessConvergenceStrength: 0.11,
      wetnessDownwardTransportFactor: 0.05,
      wetnessFlowMemoryFactor: 0,
      enablePathDominanceAmplification: false,
      pathDominanceWetnessThreshold: 0.24,
      pathDominanceFlowMemoryThreshold: 0.2,
      pathDominanceStrength: 0.18,
      pathDominanceExponent: 1.5,
      pathDominanceMaxBoost: 0.2,
      initialWetness: 0.14,
      ...options,
    }

    this.width = 1
    this.height = 1
    this.baseWetness = clamp(this.options.initialWetness, this.options.minWetness, this.options.maxWetness)
    this.grid = new Float32Array(1)
    this.scratch = new Float32Array(1)
    this.trailGrid = new Float32Array(1)
    this.trailScratch = new Float32Array(1)
    this.runnerMemoryGrid = new Float32Array(1)
    this.runnerMemoryScratch = new Float32Array(1)
    this.flowMemoryGrid = new Float32Array(1)
    this.flowMemoryScratch = new Float32Array(1)
    this.displayGrid = new Float32Array(1)
    this.imageColorKey = ''
    this.imageRgbInitialized = false
    this.activityThreshold = 0.0009
    this.runnerMemoryMinClamp = -0.72
    this.frameId = 0
    this.activeRect = null
    this.imageDirtyRect = null
    this.stats = this.createEmptyStats()
    this.resize(width, height)
  }

  createEmptyStats() {
    return {
      frameId: this.frameId,
      clearingMs: 0,
      clearingOps: 0,
      clearAreaOps: 0,
      trailOps: 0,
      recoveryMs: 0,
      diffusionMs: 0,
      imageMs: 0,
      recoveryPixels: 0,
      diffusionPixels: 0,
      imagePixels: 0,
      totalPixels: this.width * this.height,
      recoveryFullField: false,
      diffusionFullField: false,
      imageFullField: false,
      smoothingStride: 1,
      smoothingPasses: 0,
      smoothingSkippedByStride: false,
      activeRegionPixels: 0,
      activeRegionRect: null,
    }
  }

  beginFrame() {
    this.frameId += 1
    this.stats = this.createEmptyStats()
    this.stats.totalPixels = this.width * this.height
  }

  getLastStats() {
    const region = this.activeRect
    return {
      ...this.stats,
      activeRegionPixels: rectPixels(region),
      activeRegionRect: region
        ? {
            x: region.minX,
            y: region.minY,
            width: rectWidth(region),
            height: rectHeight(region),
          }
        : null,
    }
  }

  applySettings(nextOptions = {}) {
    this.options = {
      ...this.options,
      ...nextOptions,
    }
    this.baseWetness = clamp(this.baseWetness, this.options.minWetness, this.options.maxWetness)
  }

  resize(width, height) {
    this.width = Math.max(1, Math.floor(width))
    this.height = Math.max(1, Math.floor(height))
    this.grid = new Float32Array(this.width * this.height)
    this.scratch = new Float32Array(this.width * this.height)
    this.trailGrid = new Float32Array(this.width * this.height)
    this.trailScratch = new Float32Array(this.width * this.height)
    this.runnerMemoryGrid = new Float32Array(this.width * this.height)
    this.runnerMemoryScratch = new Float32Array(this.width * this.height)
    this.flowMemoryGrid = new Float32Array(this.width * this.height)
    this.flowMemoryScratch = new Float32Array(this.width * this.height)
    this.displayGrid = new Float32Array(this.width * this.height)
    this.imageColorKey = ''
    this.imageRgbInitialized = false
    this.activeRect = createRect(0, 0, this.width - 1, this.height - 1)
    this.imageDirtyRect = createRect(0, 0, this.width - 1, this.height - 1)
    this.beginFrame()
  }

  markDirtyRect(minX, minY, maxX, maxY) {
    const rect = createRect(
      clamp(Math.floor(minX), 0, this.width - 1),
      clamp(Math.floor(minY), 0, this.height - 1),
      clamp(Math.ceil(maxX), 0, this.width - 1),
      clamp(Math.ceil(maxY), 0, this.height - 1),
    )
    if (rect.minX > rect.maxX || rect.minY > rect.maxY) {
      return
    }

    if (!this.activeRect) {
      this.activeRect = rect
    } else {
      this.activeRect.minX = Math.min(this.activeRect.minX, rect.minX)
      this.activeRect.minY = Math.min(this.activeRect.minY, rect.minY)
      this.activeRect.maxX = Math.max(this.activeRect.maxX, rect.maxX)
      this.activeRect.maxY = Math.max(this.activeRect.maxY, rect.maxY)
    }

    if (!this.imageDirtyRect) {
      this.imageDirtyRect = createRect(rect.minX, rect.minY, rect.maxX, rect.maxY)
    } else {
      this.imageDirtyRect.minX = Math.min(this.imageDirtyRect.minX, rect.minX)
      this.imageDirtyRect.minY = Math.min(this.imageDirtyRect.minY, rect.minY)
      this.imageDirtyRect.maxX = Math.max(this.imageDirtyRect.maxX, rect.maxX)
      this.imageDirtyRect.maxY = Math.max(this.imageDirtyRect.maxY, rect.maxY)
    }
  }

  addCondensation(dt, options = {}) {
    const fullField = Boolean(options.fullField)
    this.baseWetness = clamp(
      this.baseWetness + this.options.refillRate * dt,
      this.options.minWetness,
      this.options.maxWetness,
    )

    const recovery = clamp(dt * this.options.recoveryRate, 0, 1)
    if (recovery <= 0) {
      return
    }

    const trailRecovery = clamp(dt * this.options.trailRecoveryRate, 0, 1)
    const runnerRecovery = clamp(dt * this.options.runnerMemoryRecoveryRate, 0, 1)
    const flowMemoryDecay = clamp(dt * 0.35, 0, 1)
    const region = fullField
      ? createRect(0, 0, this.width - 1, this.height - 1)
      : expandRect(this.activeRect, 2, this.width, this.height)

    if (!region) {
      return
    }

    const started = performance.now()
    const dirtyThreshold = 0.00005
    const activeBounds = {
      found: false,
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
    }
    const changedBounds = {
      found: false,
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
    }
    for (let y = region.minY; y <= region.maxY; y += 1) {
      const row = y * this.width
      for (let x = region.minX; x <= region.maxX; x += 1) {
        const idx = row + x
        const prevGrid = this.grid[idx]
        const prevTrail = this.trailGrid[idx]
        const prevRunner = this.runnerMemoryGrid[idx]
        const prevFlowMemory = this.flowMemoryGrid[idx]

        // Exact-zero cells are a no-op for recovery integration, so skip math early.
        if (prevGrid === 0 && prevTrail === 0 && prevRunner === 0 && prevFlowMemory === 0) {
          continue
        }

        this.grid[idx] += (0 - this.grid[idx]) * recovery
        this.trailGrid[idx] += (0 - this.trailGrid[idx]) * trailRecovery
        this.runnerMemoryGrid[idx] += (0 - this.runnerMemoryGrid[idx]) * runnerRecovery
        this.runnerMemoryGrid[idx] = Math.max(this.runnerMemoryMinClamp, this.runnerMemoryGrid[idx])
        this.flowMemoryGrid[idx] += (0 - this.flowMemoryGrid[idx]) * flowMemoryDecay
        this.flowMemoryGrid[idx] = clamp(this.flowMemoryGrid[idx], 0, 1)

        if (
          Math.abs(this.grid[idx] - prevGrid) > dirtyThreshold ||
          Math.abs(this.trailGrid[idx] - prevTrail) > dirtyThreshold ||
          Math.abs(this.runnerMemoryGrid[idx] - prevRunner) > dirtyThreshold ||
          Math.abs(this.flowMemoryGrid[idx] - prevFlowMemory) > dirtyThreshold
        ) {
          includePointBounds(changedBounds, x, y)
        }

        const activity =
          Math.max(
            Math.abs(this.grid[idx]),
            Math.abs(this.trailGrid[idx]),
            Math.abs(this.runnerMemoryGrid[idx]),
            Math.abs(this.flowMemoryGrid[idx]),
          ) > this.activityThreshold

        if (activity) {
          includePointBounds(activeBounds, x, y)
        }
      }
    }

    this.activeRect = boundsToRect(activeBounds)
    this.imageDirtyRect = unionRect(this.imageDirtyRect, boundsToRect(changedBounds))
    this.stats.recoveryMs += performance.now() - started
    this.stats.recoveryPixels += rectPixels(region)
    this.stats.recoveryFullField = fullField
  }

  smooth(dt, passes = 1, options = {}) {
    const diffusion = clamp(dt * this.options.diffusionRate, 0, 0.16)
    if (diffusion <= 0 || this.width < 2 || this.height < 2) {
      return
    }

    const stride = Math.max(1, options.stride | 0)
    this.stats.smoothingStride = stride
    this.stats.smoothingPasses = Math.max(1, passes | 0)
    if (stride > 1 && this.frameId % stride !== 0) {
      this.stats.smoothingSkippedByStride = true
      return
    }

    const regionOnly = options.regionOnly !== false
    const fullField = !regionOnly || Boolean(options.fullField)
    let region = null
    if (fullField) {
      region = createRect(0, 0, this.width - 1, this.height - 1)
    } else {
      const padding = 2 + Math.max(1, passes | 0)
      region = expandRect(this.activeRect, padding, this.width, this.height)
    }
    if (!region) {
      return
    }

    const passCount = Math.max(1, passes | 0)
    const started = performance.now()
    for (let pass = 0; pass < passCount; pass += 1) {
      this.diffusePass(this.grid, this.scratch, diffusion * 0.45, region)
      this.diffusePass(this.trailGrid, this.trailScratch, diffusion * 0.22, region)
      this.diffusePass(this.runnerMemoryGrid, this.runnerMemoryScratch, diffusion * 0.12, region)
    }

    const downwardTransportFactor = clamp(
      Number(this.options.wetnessDownwardTransportFactor) || 0,
      0,
      1,
    )
    const flowMemoryFactor = clamp(Number(this.options.wetnessFlowMemoryFactor) || 0, 0, 1)
    if (downwardTransportFactor > 0) {
      this.downwardTransportPass(
        this.runnerMemoryGrid,
        this.runnerMemoryScratch,
        downwardTransportFactor,
        region,
        {
          flowMemoryGrid: this.flowMemoryGrid,
          flowMemoryScratch: this.flowMemoryScratch,
          flowMemoryFactor,
        },
      )
    }

    this.imageDirtyRect = unionRect(this.imageDirtyRect, region)
    this.stats.diffusionMs += performance.now() - started
    this.stats.diffusionPixels += rectPixels(region) * passCount
    this.stats.diffusionFullField = fullField
  }

  downwardTransportPass(source, scratch, factor, region, options = {}) {
    const { width } = this
    const minValue = this.runnerMemoryMinClamp
    const maxValue = 0
    const flowMemoryGrid = options.flowMemoryGrid || null
    const flowMemoryScratch = options.flowMemoryScratch || null
    const flowMemoryFactor = clamp(Number(options.flowMemoryFactor) || 0, 0, 1)
    const useFlowMemory = flowMemoryGrid && flowMemoryScratch && flowMemoryFactor > 0
    const pathDominanceEnabled = Boolean(this.options.enablePathDominanceAmplification)
    const wetnessThreshold = clamp(Number(this.options.pathDominanceWetnessThreshold) || 0, 0, 1)
    const flowThreshold = clamp(Number(this.options.pathDominanceFlowMemoryThreshold) || 0, 0, 1)
    const pathDominanceStrength = Math.max(0, Number(this.options.pathDominanceStrength) || 0)
    const pathDominanceExponent = Math.max(0, Number(this.options.pathDominanceExponent) || 0)
    const pathDominanceMaxBoost = Math.max(0, Number(this.options.pathDominanceMaxBoost) || 0)

    for (let y = region.minY; y <= region.maxY; y += 1) {
      const rowStart = y * width
      for (let x = region.minX; x <= region.maxX; x += 1) {
        const idx = rowStart + x
        scratch[idx] = source[idx]
        if (useFlowMemory) {
          flowMemoryScratch[idx] = flowMemoryGrid[idx]
        }
      }
    }

    const maxY = Math.min(region.maxY, this.height - 2)
    for (let y = region.minY; y <= maxY; y += 1) {
      const rowStart = y * width
      const rowDownStart = (y + 1) * width
      for (let x = region.minX; x <= region.maxX; x += 1) {
        const idx = rowStart + x
        const idxDown = rowDownStart + x
        const sourceValue = source[idx]
        const destValue = source[idxDown]
        let desiredTransfer = sourceValue * factor
        if (pathDominanceEnabled) {
          const wetness = clamp(-this.grid[idxDown], 0, 1)
          const flowMemory = useFlowMemory ? clamp(flowMemoryScratch[idxDown], 0, 1) : 0
          const normalizedWetness = clamp(
            (wetness - wetnessThreshold) / Math.max(1e-6, 1 - wetnessThreshold),
            0,
            1,
          )
          const normalizedFlow = clamp(
            (flowMemory - flowThreshold) / Math.max(1e-6, 1 - flowThreshold),
            0,
            1,
          )
          const dominanceSignal = normalizedWetness * normalizedFlow
          const boost =
            1 +
            Math.min(
              pathDominanceMaxBoost,
              pathDominanceStrength * Math.pow(dominanceSignal, pathDominanceExponent),
            )
          desiredTransfer *= boost
        }
        if (useFlowMemory) {
          const downstreamFlowMemory = clamp(flowMemoryScratch[idxDown], 0, 1)
          desiredTransfer *= 1 + downstreamFlowMemory * flowMemoryFactor * 0.35
        }
        const transferMin = Math.max(sourceValue - maxValue, minValue - destValue)
        const transferMax = Math.min(sourceValue - minValue, maxValue - destValue)
        const transfer = clamp(desiredTransfer, transferMin, transferMax)
        scratch[idx] = clamp(scratch[idx] - transfer, minValue, maxValue)
        scratch[idxDown] = clamp(scratch[idxDown] + transfer, minValue, maxValue)
        if (useFlowMemory) {
          const movedDownward = Math.max(0, -transfer)
          if (movedDownward > 0) {
            flowMemoryGrid[idxDown] = clamp(
              flowMemoryGrid[idxDown] + movedDownward * flowMemoryFactor * 0.5,
              0,
              1,
            )
          }
        }
      }
    }

    for (let y = region.minY; y <= region.maxY; y += 1) {
      const rowStart = y * width
      for (let x = region.minX; x <= region.maxX; x += 1) {
        const idx = rowStart + x
        source[idx] = scratch[idx]
      }
    }
  }

  diffusePass(source, scratch, strength, region) {
    const { width, height } = this

    for (let y = region.minY; y <= region.maxY; y += 1) {
      const yUp = y > 0 ? y - 1 : y
      const yDown = y < height - 1 ? y + 1 : y
      const row = y * width
      const rowUp = yUp * width
      const rowDown = yDown * width

      for (let x = region.minX; x <= region.maxX; x += 1) {
        const xLeft = x > 0 ? x - 1 : x
        const xRight = x < width - 1 ? x + 1 : x
        const idx = row + x
        const center = source[idx]
        const neighbors =
          source[row + xLeft] +
          source[row + xRight] +
          source[rowUp + x] +
          source[rowDown + x]
        const laplacian = neighbors * 0.25 - center
        scratch[idx] = center + laplacian * strength
      }
    }

    for (let y = region.minY; y <= region.maxY; y += 1) {
      const rowStart = y * width
      for (let x = region.minX; x <= region.maxX; x += 1) {
        const idx = rowStart + x
        source[idx] = scratch[idx]
      }
    }
  }

  clearArea(x, y, radius, strength = 1) {
    const started = performance.now()
    const r = Math.max(0.5, radius)
    const s = clamp(strength, 0, 1)
    const minX = Math.max(0, Math.floor(x - r))
    const maxX = Math.min(this.width - 1, Math.ceil(x + r))
    const minY = Math.max(0, Math.floor(y - r))
    const maxY = Math.min(this.height - 1, Math.ceil(y + r))
    const invR = 1 / r
    // Head impact deposition is intentionally stronger so round clearings read before ribbon trails take over.
    const pointScale = 0.24 + clamp((r - 1.5) * 0.06, 0, 0.16)

    for (let py = minY; py <= maxY; py += 1) {
      const dy = py - y
      for (let px = minX; px <= maxX; px += 1) {
        const dx = px - x
        const distance = Math.hypot(dx, dy)
        if (distance > r) {
          continue
        }

        const edge = clamp(1 - distance * invR, 0, 1)
        const falloff = edge * edge * (3 - 2 * edge)
        const headCore = clamp(1 - distance * invR * 1.35, 0, 1)
        const idx = py * this.width + px
        const blendedHeadFalloff = falloff * 0.74 + headCore * headCore * 0.26
        this.grid[idx] -= s * blendedHeadFalloff * pointScale
      }
    }

    this.markDirtyRect(minX, minY, maxX, maxY)
    this.stats.clearingMs += performance.now() - started
    this.stats.clearingOps += 1
    this.stats.clearAreaOps += 1
  }

  depositSegmentRibbon(x1, y1, x2, y2, radius, strength, targetGrid, magnitude = 1, options = {}) {
    const started = performance.now()
    const r = Math.max(0.35, radius)
    const s = clamp(strength, 0, 1)
    const taperStart = clamp(options.taperStart ?? 0.76, 0.25, 1.3)
    const taperEnd = clamp(options.taperEnd ?? 1, 0.25, 1.35)
    const accumulationClamp = Math.max(0.02, options.accumulationClamp ?? 0.6)
    const isRunnerMemoryTarget = targetGrid === this.runnerMemoryGrid
    const downwardReinforcementFactor = Math.max(0, Number(this.options.downwardReinforcementFactor) || 0)
    const pathMemoryReinforcementFactor = Math.max(0, Number(this.options.pathMemoryReinforcementFactor) || 0)
    const continuityReinforcementFactor = Math.max(0, Number(this.options.continuityReinforcementFactor) || 0)
    const wetnessConvergenceStrength = Math.max(0, Number(this.options.wetnessConvergenceStrength) || 0)
    const convergenceBalanceActive = wetnessConvergenceStrength > 0
    const continuityBalanceScale = convergenceBalanceActive ? 0.88 : 1
    const convergenceBalanceScale = convergenceBalanceActive ? 1.15 : 1
    const downwardness = clamp((y2 - y1) / Math.max(1, Math.abs(x2 - x1) + Math.abs(y2 - y1)), 0, 1)
    const dx = x2 - x1
    const dy = y2 - y1
    const len2 = Math.max(0.0001, dx * dx + dy * dy)
    const invLen = 1 / Math.sqrt(len2)
    const minX = Math.max(0, Math.floor(Math.min(x1, x2) - r - 1))
    const maxX = Math.min(this.width - 1, Math.ceil(Math.max(x1, x2) + r + 1))
    const minY = Math.max(0, Math.floor(Math.min(y1, y2) - r - 1))
    const maxY = Math.min(this.height - 1, Math.ceil(Math.max(y1, y2) + r + 1))
    const invR = 1 / r

    for (let py = minY; py <= maxY; py += 1) {
      for (let px = minX; px <= maxX; px += 1) {
        const relX = px - x1
        const relY = py - y1
        const t = clamp((relX * dx + relY * dy) / len2, 0, 1)
        const projX = x1 + dx * t
        const projY = y1 + dy * t
        const dist = Math.hypot(px - projX, py - projY)
        if (dist > r) {
          continue
        }

        const edge = clamp(1 - dist * invR, 0, 1)
        const radial = edge * edge * (3 - 2 * edge)
        const alongCore = 0.78 + (1 - Math.abs(t - 0.5) * 2) * 0.12
        const directionalTaper = taperStart + (taperEnd - taperStart) * t
        const idx = py * this.width + px
        const accumulated = Math.max(0, -targetGrid[idx])
        // Repeated passes over the same channel taper off instead of endlessly deepening.
        const accumulationLimiter = clamp(1 - accumulated / accumulationClamp, 0.2, 1)
        let reinforcement = 1
        if (isRunnerMemoryTarget) {
          const xLeft = px > 0 ? px - 1 : px
          const xRight = px < this.width - 1 ? px + 1 : px
          const yUp = py > 0 ? py - 1 : py
          const yDown = py < this.height - 1 ? py + 1 : py
          const continuitySignal =
            Math.max(0, -this.runnerMemoryGrid[idx]) * 0.4 +
            Math.max(0, -this.runnerMemoryGrid[py * this.width + xLeft]) * 0.15 +
            Math.max(0, -this.runnerMemoryGrid[py * this.width + xRight]) * 0.15 +
            Math.max(0, -this.runnerMemoryGrid[yUp * this.width + px]) * 0.15 +
            Math.max(0, -this.runnerMemoryGrid[yDown * this.width + px]) * 0.15
          reinforcement += downwardReinforcementFactor * downwardness
          reinforcement += pathMemoryReinforcementFactor * accumulated
          reinforcement += continuityReinforcementFactor * continuitySignal * continuityBalanceScale
          if (wetnessConvergenceStrength > 0) {
            const lateralStepX = clamp(Math.round(-dy * invLen), -1, 1)
            const lateralStepY = clamp(Math.round(dx * invLen), -1, 1)
            if (lateralStepX !== 0 || lateralStepY !== 0) {
              const sampleAX = clamp(px + lateralStepX, 0, this.width - 1)
              const sampleAY = clamp(py + lateralStepY, 0, this.height - 1)
              const sampleBX = clamp(px - lateralStepX, 0, this.width - 1)
              const sampleBY = clamp(py - lateralStepY, 0, this.height - 1)
              const localWetnessSignal =
                Math.max(0, -this.runnerMemoryGrid[idx]) * 0.5 +
                Math.max(0, -this.trailGrid[idx]) * 0.35 +
                Math.max(0, -this.grid[idx]) * 0.15
              const sampleAWetnessSignal =
                Math.max(0, -this.runnerMemoryGrid[sampleAY * this.width + sampleAX]) * 0.5 +
                Math.max(0, -this.trailGrid[sampleAY * this.width + sampleAX]) * 0.35 +
                Math.max(0, -this.grid[sampleAY * this.width + sampleAX]) * 0.15
              const sampleBWetnessSignal =
                Math.max(0, -this.runnerMemoryGrid[sampleBY * this.width + sampleBX]) * 0.5 +
                Math.max(0, -this.trailGrid[sampleBY * this.width + sampleBX]) * 0.35 +
                Math.max(0, -this.grid[sampleBY * this.width + sampleBX]) * 0.15
              const convergenceSignal = Math.max(
                0,
                Math.max(sampleAWetnessSignal, sampleBWetnessSignal) - localWetnessSignal,
              )
              reinforcement += wetnessConvergenceStrength * Math.min(1, convergenceSignal) * convergenceBalanceScale
            }
          }
        }
        targetGrid[idx] -= s * radial * alongCore * directionalTaper * magnitude * accumulationLimiter * reinforcement
      }
    }

    this.markDirtyRect(minX, minY, maxX, maxY)
    this.stats.clearingMs += performance.now() - started
    this.stats.clearingOps += 1
  }

  disturbTrail(x1, y1, x2, y2, radius, strength = 1, options = {}) {
    this.stats.trailOps += 1
    const r = Math.max(0.42, radius)
    const s = clamp(strength, 0, 1)
    const trailMagnitude = options.trailMagnitude ?? 0.3
    const runnerMagnitude = options.runnerMagnitude ?? 0.2
    const gridMagnitude = options.gridMagnitude ?? 0.028
    const trailTaperStart = options.taperStart ?? 0.72
    const trailTaperEnd = options.taperEnd ?? 1
    const accumulationClamp = options.accumulationClamp ?? 0.52
    const runnerRadiusScale = options.runnerRadiusScale ?? 0.88
    const gridRadiusScale = options.gridRadiusScale ?? 0.78

    // Continuous ribbon deposition over the swept segment dominates visible runners.
    this.depositSegmentRibbon(x1, y1, x2, y2, r, s, this.trailGrid, trailMagnitude, {
      taperStart: trailTaperStart,
      taperEnd: trailTaperEnd,
      accumulationClamp,
    })
    this.depositSegmentRibbon(x1, y1, x2, y2, r * runnerRadiusScale, s, this.runnerMemoryGrid, runnerMagnitude, {
      taperStart: trailTaperStart * 0.98,
      taperEnd: trailTaperEnd,
      accumulationClamp: accumulationClamp * 0.82,
    })

    // Immediate field still receives a subtle trail imprint but is no longer dominant.
    this.depositSegmentRibbon(x1, y1, x2, y2, r * gridRadiusScale, s, this.grid, gridMagnitude, {
      taperStart: trailTaperStart * 0.95,
      taperEnd: trailTaperEnd,
      accumulationClamp: accumulationClamp * 1.2,
    })
  }

  toImageData(imageData, color, options = {}) {
    const r = color[0]
    const g = color[1]
    const b = color[2]
    const nextColorKey = `${r},${g},${b}`
    const data = imageData.data
    const { width, height, grid, trailGrid, runnerMemoryGrid, displayGrid } = this
    const invMaxWetness = 1 / this.options.maxWetness

    let fullField = Boolean(options.fullField)
    const colorChanged = this.imageColorKey !== nextColorKey
    const mustWriteRgb = !this.imageRgbInitialized || colorChanged
    if (mustWriteRgb) {
      fullField = true
    }

    const region = fullField ? createRect(0, 0, width - 1, height - 1) : this.imageDirtyRect
    if (!region) {
      return {
        dirtyRect: null,
        fullField,
        processedPixels: 0,
      }
    }

    // Render from a lightly smoothed field sample so swept occupancy reads as a lane instead of isolated nodes.
    const started = performance.now()
    for (let y = region.minY; y <= region.maxY; y += 1) {
      const yUp = y > 0 ? y - 1 : y
      const yDown = y < height - 1 ? y + 1 : y
      const row = y * width
      const rowUp = yUp * width
      const rowDown = yDown * width

      for (let x = region.minX; x <= region.maxX; x += 1) {
        const xLeft = x > 0 ? x - 1 : x
        const xRight = x < width - 1 ? x + 1 : x
        const idx = row + x
        // Composite weighting: bias toward ribbon continuity so swept channels stay visually connected between beads.
        const center = trailGrid[idx] * 1.14 + runnerMemoryGrid[idx] * 1.24 + grid[idx] * 0.18
        const left = trailGrid[row + xLeft] * 1.1 + runnerMemoryGrid[row + xLeft] * 1.2 + grid[row + xLeft] * 0.1
        const right = trailGrid[row + xRight] * 1.1 + runnerMemoryGrid[row + xRight] * 1.2 + grid[row + xRight] * 0.1
        const up = trailGrid[rowUp + x] * 1.1 + runnerMemoryGrid[rowUp + x] * 1.2 + grid[rowUp + x] * 0.1
        const down = trailGrid[rowDown + x] * 1.1 + runnerMemoryGrid[rowDown + x] * 1.2 + grid[rowDown + x] * 0.1
        const diagUL = trailGrid[rowUp + xLeft] * 1.06 + runnerMemoryGrid[rowUp + xLeft] * 1.14 + grid[rowUp + xLeft] * 0.08
        const diagUR = trailGrid[rowUp + xRight] * 1.06 + runnerMemoryGrid[rowUp + xRight] * 1.14 + grid[rowUp + xRight] * 0.08
        const diagDL = trailGrid[rowDown + xLeft] * 1.06 + runnerMemoryGrid[rowDown + xLeft] * 1.14 + grid[rowDown + xLeft] * 0.08
        const diagDR = trailGrid[rowDown + xRight] * 1.06 + runnerMemoryGrid[rowDown + xRight] * 1.14 + grid[rowDown + xRight] * 0.08
        const smoothDelta =
          center * 0.40 +
          (left + right + up + down) * 0.115 +
          (diagUL + diagUR + diagDL + diagDR) * 0.035
        const previousDisplay = displayGrid[idx]
        // Fresh sweep should register quickly, but keep enough hold so the lane stays open between head samples.
        const response = smoothDelta < previousDisplay ? 0.32 : 0.06
        const temporalDelta = previousDisplay + (smoothDelta - previousDisplay) * response
        displayGrid[idx] = temporalDelta

        // Under saturated fog, treat occupied path lanes as locally authoritative by lowering
        // the effective refill ceiling while wetness/path occupancy support is still present.
        const fogSaturation = clamp((this.baseWetness * invMaxWetness - 0.62) / 0.3, 0, 1)

        // Channel-only occupancy: derived from trail+runnerMemory fields only, not bead-local grid.
        // trailGrid recovers at rate 0.82 and runnerMemoryGrid at 0.56, vs grid at 1.4, so this
        // signal naturally outlasts bead-local suppression once the droplet moves on, and is
        // evaluated uniformly across the whole swept path, not concentrated at node positions.
        const trailCenter = trailGrid[idx] * 1.30 + runnerMemoryGrid[idx] * 1.42
        const trailNeighborSum =
          (trailGrid[row + xLeft] + trailGrid[row + xRight] + trailGrid[rowUp + x] + trailGrid[rowDown + x]) * 1.28 +
          (runnerMemoryGrid[row + xLeft] + runnerMemoryGrid[row + xRight] + runnerMemoryGrid[rowUp + x] + runnerMemoryGrid[rowDown + x]) * 1.38
        // Diagonal expansion: each trail/runnerMemory pixel now covers a full 3x3 band, not a thin cross.
        // This makes the channel signal spatially continuous between bead node positions.
        const trailDiagSum =
          (trailGrid[rowUp + xLeft] + trailGrid[rowUp + xRight] + trailGrid[rowDown + xLeft] + trailGrid[rowDown + xRight]) * 1.15 +
          (runnerMemoryGrid[rowUp + xLeft] + runnerMemoryGrid[rowUp + xRight] + runnerMemoryGrid[rowDown + xLeft] + runnerMemoryGrid[rowDown + xRight]) * 1.25
        const channelOccupancy = clamp(-(trailCenter * 0.50 + trailNeighborSum * 0.13 + trailDiagSum * 0.08), 0, 1.5)
        // Continuous response from zero: tiny occupancy always contributes, larger lanes saturate smoothly.
        const channelGate = channelOccupancy / (channelOccupancy + 0.2)
        // Under max fog the swept channel holds open more authoritatively than bead nodes alone.
        const channelHoldStrength = fogSaturation * channelGate * 1.68

        // Coherent lane support: when a runner lane is open, bias refill to fade down as a band
        // instead of letting lower-support edge pixels collapse ahead of the interior.
        const coherentChannelOccupancy = clamp(-(trailCenter * 0.42 + trailNeighborSum * 0.14 + trailDiagSum * 0.09), 0, 1.5)
        const coherentChannelGate = coherentChannelOccupancy / (coherentChannelOccupancy + 0.22)

        const localOccupancy = clamp(
          -(
            center * 0.52 +
            (left + right + up + down) * 0.07 +
            (diagUL + diagUR + diagDL + diagDR) * 0.03
          ),
          0,
          1.4,
        )
        const occupancySupport = clamp(Math.max(localOccupancy, -smoothDelta * 1.02, -previousDisplay * 0.84), 0, 1.4)
        const occupancyGate = occupancySupport / (occupancySupport + 0.3)
        // Channel is spatially primary: attenuate bead-local hold by channel dominance.
        // Where channelHoldStrength is near 1, beads contribute almost nothing, becoming embedded detail.
        const beadHoldStrength =
          fogSaturation * occupancyGate * (1.0 - clamp(channelHoldStrength, 0, 1) * 0.97) * 0.42
        const holdOpenStrength = clamp(channelHoldStrength + beadHoldStrength * (1 - channelGate) * 0.45, 0, 1.45)
        const coherentLaneHoldStrength = fogSaturation * coherentChannelGate * 1.42
        const coherentLaneSupport = channelGate
        const effectiveHoldOpenStrength = clamp(
          holdOpenStrength + (coherentLaneHoldStrength - holdOpenStrength) * coherentLaneSupport * 0.78,
          0,
          1.45,
        )

        const naturalWetness = clamp(this.baseWetness + temporalDelta, this.options.minWetness, this.options.maxWetness)
        const laneCeiling =
          this.baseWetness -
          (this.baseWetness - this.options.minWetness) * clamp(channelHoldStrength * 1.08 + effectiveHoldOpenStrength * 0.24, 0, 1.5)
        const wetness = effectiveHoldOpenStrength > 0
          ? Math.min(naturalWetness, clamp(laneCeiling, this.options.minWetness, this.options.maxWetness))
          : naturalWetness
        const normalized = wetness * invMaxWetness
        const softenedAlpha = clamp(normalized * 0.72 + Math.sqrt(normalized) * 0.28, 0, 1)
        const directNibble = clamp(-grid[idx] * 6.1, 0, 0.1)
        const localMicroSignal = Math.max(0, -(grid[idx] * 0.62 + trailGrid[idx] * 0.24 + runnerMemoryGrid[idx] * 0.22))
        const microPresence = localMicroSignal / (localMicroSignal + 0.0075)
        const microBite = microPresence * 0.092
        
        // Tie halo persistence to droplet presence, not just transient impact.
        // Include direct grid signal (droplet occupancy) so halo persists while droplet exists.
        const dropletPresence = Math.max(0, -grid[idx])
        const dropletPersistenceSignal = dropletPresence * 1.18 + Math.sqrt(dropletPresence) * 0.08
        const haloCoreSignal = Math.max(0, -(temporalDelta * 0.64 + previousDisplay * 0.78 + smoothDelta * 0.18))
        const haloEdgeSignal = Math.max(
          0,
          -(
            center * 0.12 +
            (left + right + up + down) * 0.025 +
            (diagUL + diagUR + diagDL + diagDR) * 0.012
          ),
        )
        // Enhanced haloSignal: core + edge + persistent droplet signal (tied to grid presence).
        const haloSignal = haloCoreSignal + haloEdgeSignal * 0.48 + localMicroSignal * 0.22 + dropletPersistenceSignal * 0.68
        const haloResponse = haloSignal / (haloSignal + 0.016)
        
        // Final-stage halo dominance: direct subtractive bite, independent of fog/channel scaling.
        const impactHaloClear = clamp(0.122 * haloResponse, 0, 0.19)
        const mistNibble = clamp(directNibble + microBite, 0, 0.17)
        const pixel = idx * 4

        if (mustWriteRgb) {
          data[pixel] = r
          data[pixel + 1] = g
          data[pixel + 2] = b
        }
        
        const fogAlpha = clamp(softenedAlpha - mistNibble * 0.86, 0, 1)
        
        // Fog slightly reinforces stationary droplets (except runners):
        // Where fog is high and droplet exists but runnerMemory is not dominant, boost local droplet signal.
        const isRunner = Math.abs(runnerMemoryGrid[idx]) > 0.08
        if (!isRunner && fogSaturation > 0.4 && Math.abs(grid[idx]) > 0.02) {
          // Lightweight coupling: fog density slightly amplifies existing droplet occupancy locally.
          const fogReinforcementFactor = clamp(fogSaturation * 0.14, 0, 0.18)
          grid[idx] -= Math.sign(grid[idx]) * Math.abs(grid[idx]) * fogReinforcementFactor
        }
        
        const finalAlpha = clamp(fogAlpha - impactHaloClear, 0, 1)
        data[pixel + 3] = Math.round(finalAlpha * 255)
      }
    }

    this.stats.imageMs += performance.now() - started
    this.stats.imagePixels += rectPixels(region)
    this.stats.imageFullField = fullField
    this.imageColorKey = nextColorKey
    this.imageRgbInitialized = true
    this.imageDirtyRect = null

    return {
      dirtyRect: {
        x: region.minX,
        y: region.minY,
        width: rectWidth(region),
        height: rectHeight(region),
      },
      fullField,
      processedPixels: rectPixels(region),
    }
  }

  getDisplayWetness() {
    return this.baseWetness
  }

  getRenderSurfaces() {
    return {
      width: this.width,
      height: this.height,
      baseWetness: this.baseWetness,
      grid: this.grid,
      trailGrid: this.trailGrid,
      runnerMemoryGrid: this.runnerMemoryGrid,
      displayGrid: this.displayGrid,
    }
  }
}
