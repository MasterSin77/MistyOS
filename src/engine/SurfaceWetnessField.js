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
      trailRecoveryRate: 0.52,
      runnerMemoryRecoveryRate: 0.34,
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

        // Exact-zero cells are a no-op for recovery integration, so skip math early.
        if (prevGrid === 0 && prevTrail === 0 && prevRunner === 0) {
          continue
        }

        this.grid[idx] += (0 - this.grid[idx]) * recovery
        this.trailGrid[idx] += (0 - this.trailGrid[idx]) * trailRecovery
        this.runnerMemoryGrid[idx] += (0 - this.runnerMemoryGrid[idx]) * runnerRecovery
        this.runnerMemoryGrid[idx] = Math.max(this.runnerMemoryMinClamp, this.runnerMemoryGrid[idx])

        if (
          Math.abs(this.grid[idx] - prevGrid) > dirtyThreshold ||
          Math.abs(this.trailGrid[idx] - prevTrail) > dirtyThreshold ||
          Math.abs(this.runnerMemoryGrid[idx] - prevRunner) > dirtyThreshold
        ) {
          includePointBounds(changedBounds, x, y)
        }

        const activity =
          Math.max(
            Math.abs(this.grid[idx]),
            Math.abs(this.trailGrid[idx]),
            Math.abs(this.runnerMemoryGrid[idx]),
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
    this.imageDirtyRect = unionRect(this.imageDirtyRect, region)
    this.stats.diffusionMs += performance.now() - started
    this.stats.diffusionPixels += rectPixels(region) * passCount
    this.stats.diffusionFullField = fullField
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
    const pointScale = 0.16 + clamp((r - 2) * 0.05, 0, 0.12)

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
    const dx = x2 - x1
    const dy = y2 - y1
    const len2 = Math.max(0.0001, dx * dx + dy * dy)
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
        targetGrid[idx] -= s * radial * alongCore * directionalTaper * magnitude * accumulationLimiter
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
    const trailMagnitude = options.trailMagnitude ?? 0.26
    const runnerMagnitude = options.runnerMagnitude ?? 0.16
    const gridMagnitude = options.gridMagnitude ?? 0.05
    const trailTaperStart = options.taperStart ?? 0.72
    const trailTaperEnd = options.taperEnd ?? 1
    const accumulationClamp = options.accumulationClamp ?? 0.6
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

    // Render from a lightly smoothed field sample so point deposits are not visible as circles.
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
        // Composite weighting: keep runners continuous, but let immediate head clears remain visibly round.
        const center = trailGrid[idx] + runnerMemoryGrid[idx] * 1.02 + grid[idx] * 0.24
        const left = trailGrid[row + xLeft] + runnerMemoryGrid[row + xLeft] * 1.02 + grid[row + xLeft] * 0.18
        const right = trailGrid[row + xRight] + runnerMemoryGrid[row + xRight] * 1.02 + grid[row + xRight] * 0.18
        const up = trailGrid[rowUp + x] + runnerMemoryGrid[rowUp + x] * 1.02 + grid[rowUp + x] * 0.18
        const down = trailGrid[rowDown + x] + runnerMemoryGrid[rowDown + x] * 1.02 + grid[rowDown + x] * 0.18
        const diagUL = trailGrid[rowUp + xLeft] + runnerMemoryGrid[rowUp + xLeft] * 1.02 + grid[rowUp + xLeft] * 0.16
        const diagUR = trailGrid[rowUp + xRight] + runnerMemoryGrid[rowUp + xRight] * 1.02 + grid[rowUp + xRight] * 0.16
        const diagDL = trailGrid[rowDown + xLeft] + runnerMemoryGrid[rowDown + xLeft] * 1.02 + grid[rowDown + xLeft] * 0.16
        const diagDR = trailGrid[rowDown + xRight] + runnerMemoryGrid[rowDown + xRight] * 1.02 + grid[rowDown + xRight] * 0.16
        const smoothDelta =
          center * 0.46 +
          (left + right + up + down) * 0.102 +
          (diagUL + diagUR + diagDL + diagDR) * 0.033
        const previousDisplay = displayGrid[idx]
        // Faster response to fresh clearing helps preserve visible head impacts.
        const response = smoothDelta < previousDisplay ? 0.17 : 0.05
        const temporalDelta = previousDisplay + (smoothDelta - previousDisplay) * response
        displayGrid[idx] = temporalDelta
        const wetness = clamp(this.baseWetness + temporalDelta, this.options.minWetness, this.options.maxWetness)
        const normalized = wetness * invMaxWetness
        const softenedAlpha = clamp(normalized * 0.72 + Math.sqrt(normalized) * 0.28, 0, 1)
        const pixel = idx * 4

        if (mustWriteRgb) {
          data[pixel] = r
          data[pixel + 1] = g
          data[pixel + 2] = b
        }
        data[pixel + 3] = Math.round(softenedAlpha * 255)
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
}
