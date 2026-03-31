const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

/**
 * Phase 1 GPU-authoritative moisture field state container.
 * 
 * This is the first independent divergence for gpuFields runtime mode.
 * It maintains a single moisture field separate from SurfaceWetnessField,
 * establishing independent state authority without full GPU pipeline overhead.
 * 
 * Phase 1 scope:
 * - Authoritative moisture field evolution
 * - Condensation and recovery logic (independent of legacy path)
 * - Base state container only (no flow, disturbance, or optical fields yet)
 * - Simple Float32Array-based grid matching canvas resolution
 */
export class GpuFieldsState {
  constructor(width = 1, height = 1, options = {}) {
    this.simulationScale = clamp(options.simulationScale ?? 0.5, 0.1, 1)
    this.renderWidth = Math.max(1, width | 0)
    this.renderHeight = Math.max(1, height | 0)
    this.width = this.getScaledDimension(this.renderWidth)
    this.height = this.getScaledDimension(this.renderHeight)
    this.options = {
      initialMoisture: options.initialMoisture ?? 0.12,
      maxMoisture: options.maxMoisture ?? 0.36,
      condensationGain: options.condensationGain ?? 0.0024,
      recoveryRate: options.recoveryRate ?? 1.16,
      minMoisture: options.minMoisture ?? 0,
    }

    // Phase 1: single authoritative moisture field (Float32Array)
    this.moistureField = new Float32Array(this.width * this.height)
    this.moistureScratch = new Float32Array(this.width * this.height)
    
    // Initialize with base moisture level
    const initialMoisture = clamp(
      this.options.initialMoisture,
      this.options.minMoisture,
      this.options.maxMoisture,
    )
    for (let i = 0; i < this.moistureField.length; i++) {
      this.moistureField[i] = initialMoisture
    }

    this.frameId = 0
    this.displayMoisture = initialMoisture
    this.stats = {
      frameId: 0,
      updateMs: 0,
      moistureMean: initialMoisture,
      moistureMax: initialMoisture,
      moistureMin: initialMoisture,
    }
  }

  getScaledDimension(size) {
    return Math.max(1, Math.floor(Math.max(1, size | 0) * this.simulationScale))
  }

  mapRenderToSimulation(x = 0, y = 0) {
    const scaleX = this.width / Math.max(1, this.renderWidth)
    const scaleY = this.height / Math.max(1, this.renderHeight)
    return {
      x: x * scaleX,
      y: y * scaleY,
      scaleX,
      scaleY,
    }
  }

  beginFrame() {
    this.frameId += 1
    this.stats.frameId = this.frameId
  }

  /**
   * Phase 2: Seed moisture field from existing local spatial source (e.g., legacy displayGrid).
   * 
   * Instead of independent uniform condensation, gpuFields moisture now develops real per-pixel
   * structure by sampling from existing local inputs in the legacy pipeline.
   * This creates visible spatial variation without new fields or broad rewrites.
   * 
   * Called after legacy field updates to transfer spatial structure into GPU-resident state.
   * The moisture field will reflect local wetness variations at each pixel.
   */
  transferFromLegacyGrid(sourceGrid, baseWetness = 0, maxMoisture = 0.36) {
    const sourceWidth = Math.max(1, this.renderWidth | 0)
    const sourceHeight = Math.max(1, this.renderHeight | 0)
    if (!sourceGrid || sourceGrid.length !== sourceWidth * sourceHeight) {
      return
    }

    // Phase 2: Direct spatial mapping from legacy displayGrid into gpuFields moisture.
    // Each pixel's moisture becomes a function of legacy base + local grid value.
    // This preserves per-pixel structure while establishing independent authority.
    let moistureMean = 0
    let moistureMax = 0
    let moistureMin = maxMoisture

    for (let y = 0; y < this.height; y += 1) {
      const sourceY = Math.min(sourceHeight - 1, Math.max(0, Math.floor(((y + 0.5) * sourceHeight) / this.height)))
      const sourceRowOffset = sourceY * sourceWidth
      const rowOffset = y * this.width
      for (let x = 0; x < this.width; x += 1) {
        const sourceX = Math.min(sourceWidth - 1, Math.max(0, Math.floor(((x + 0.5) * sourceWidth) / this.width)))
        const i = rowOffset + x
        const legacyLocalWetness = sourceGrid[sourceRowOffset + sourceX]
      const legacyTotalWetness = clamp(baseWetness + legacyLocalWetness, 0, 1)
      // Map legacy wetness to gpuFields moisture namespace
      const moisture = legacyTotalWetness * maxMoisture
      this.moistureField[i] = moisture
      moistureMean += moisture
      moistureMax = Math.max(moistureMax, moisture)
      moistureMin = Math.min(moistureMin, moisture)
      }
    }

    // Update display moisture as field average
    moistureMean /= this.moistureField.length
    this.displayMoisture = moistureMean
    
    this.stats.moistureMean = moistureMean
    this.stats.moistureMax = moistureMax
    this.stats.moistureMin = moistureMin
  }

  /**
   * Phase 3: Direct upstream condensation authorship.
   * 
   * Applies condensation and optional local spatial input DIRECTLY to gpuFields moisture,
   * eliminating dependency on legacy displayGrid transfer. This is the primary author path
   * in gpuFields mode.
   * 
   * Optionally accepts localSpatialInput (e.g., from a local condensation event or
   * spatial bias field) to create per-pixel variation without relying on legacy output.
   * 
   * If no spatial input provided, behaves like updateMoisture (uniform condensation + recovery).
   * If spatial input provided, blends local boost into per-pixel condensation, creating
   * structure from gpuFields upstream logic rather than legacy copied state.
   */
  applyDirectCondensation(dt = 0.016, localSpatialInput = null, localSpatialGain = 0.5) {
    const start = performance.now()
    
    const gain = dt * this.options.condensationGain
    const recovery = this.options.recoveryRate * dt
    const maxMoisture = this.options.maxMoisture
    const minMoisture = this.options.minMoisture
    const moistureRange = Math.max(0.0001, maxMoisture - minMoisture)
    const previousField = this.moistureScratch
    const downwardTransferRate = clamp(dt * 0.9, 0, 0.05)
    const saturationCap = minMoisture + (maxMoisture - minMoisture) * 0.86
    const capRedistributionRate = clamp(dt * 0.7, 0, 0.06)
    const evaporationRate = clamp(0.01, 0, 0.08)

    for (let i = 0; i < this.moistureField.length; i++) {
      let m = this.moistureField[i]
      const previous = previousField && previousField.length === this.moistureField.length ? previousField[i] : m
      const recentDrop = clamp((previous - m) / moistureRange, 0, 1)
      const persistenceSuppression = clamp((recentDrop / (recentDrop + 0.2)) * 0.65, 0, 0.65)
      const effectiveGain = gain * (1 - persistenceSuppression)
      
      // Apply condensation gain (base refill)
      m += effectiveGain
      
      // Apply optional local spatial input (e.g., condensation hotspot, local deposit)
      // This creates per-pixel structure without depending on legacy grid
      if (localSpatialInput && localSpatialInput[i] != null) {
        const localBoost = localSpatialInput[i] * localSpatialGain
        m += localBoost
      }
      
      // Apply recovery decay (reduces moisture back toward minimum)
      m -= recovery * m

      // Mild uniform evaporation toward baseline to prevent long-horizon saturation.
      m -= (m - minMoisture) * evaporationRate * dt
      
      // Clamp to valid range
      m = clamp(m, minMoisture, maxMoisture)
      
      this.moistureField[i] = m
    }

    // Soft cap limiter: near saturation, bleed a small fraction of excess to local neighbors.
    // Conservative update: moved amount is subtracted from source and added to neighbors.
    if (capRedistributionRate > 0 && this.width > 1 && this.height > 1) {
      const width = this.width
      const height = this.height
      const field = this.moistureField
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const idx = y * width + x
          const source = field[idx]
          const excess = Math.max(0, source - saturationCap)
          if (excess <= 0) {
            continue
          }

          const moveBudget = excess * capRedistributionRate
          if (moveBudget <= 0.000001) {
            continue
          }

          const leftIdx = x > 0 ? idx - 1 : -1
          const rightIdx = x < width - 1 ? idx + 1 : -1
          const upIdx = y > 0 ? idx - width : -1
          const downIdx = y < height - 1 ? idx + width : -1

          const leftCap = leftIdx >= 0 ? Math.max(0, saturationCap - field[leftIdx]) : 0
          const rightCap = rightIdx >= 0 ? Math.max(0, saturationCap - field[rightIdx]) : 0
          const upCap = upIdx >= 0 ? Math.max(0, saturationCap - field[upIdx]) : 0
          const downCap = downIdx >= 0 ? Math.max(0, saturationCap - field[downIdx]) : 0
          const capacitySum = leftCap + rightCap + upCap + downCap
          if (capacitySum <= 0) {
            continue
          }

          const moveAmount = Math.min(moveBudget, excess)
          let moved = 0

          if (leftCap > 0) {
            const transfer = moveAmount * (leftCap / capacitySum)
            field[leftIdx] = clamp(field[leftIdx] + transfer, minMoisture, maxMoisture)
            moved += transfer
          }
          if (rightCap > 0) {
            const transfer = moveAmount * (rightCap / capacitySum)
            field[rightIdx] = clamp(field[rightIdx] + transfer, minMoisture, maxMoisture)
            moved += transfer
          }
          if (upCap > 0) {
            const transfer = moveAmount * (upCap / capacitySum)
            field[upIdx] = clamp(field[upIdx] + transfer, minMoisture, maxMoisture)
            moved += transfer
          }
          if (downCap > 0) {
            const transfer = moveAmount * (downCap / capacitySum)
            field[downIdx] = clamp(field[downIdx] + transfer, minMoisture, maxMoisture)
            moved += transfer
          }

          if (moved > 0) {
            field[idx] = clamp(source - moved, minMoisture, maxMoisture)
          }
        }
      }
    }

    // Subtle local downward redistribution for early channel continuity.
    // Conservative transfer: each moved amount is removed from source and added to neighbor below.
    if (downwardTransferRate > 0 && this.height > 1) {
      const width = this.width
      const field = this.moistureField
      for (let y = this.height - 2; y >= 0; y -= 1) {
        const rowOffset = y * width
        const belowOffset = rowOffset + width
        for (let x = 0; x < width; x += 1) {
          const idx = rowOffset + x
          const belowIdx = belowOffset + x
          const source = field[idx]
          const below = field[belowIdx]
          const available = Math.max(0, source - minMoisture)
          const capacity = Math.max(0, maxMoisture - below)
          const baseTransfer = Math.min(available, capacity) * downwardTransferRate
          const channelBias = 1 + clamp((source - below) / moistureRange, 0, 1) * 0.35
          const transfer = Math.min(baseTransfer * channelBias, available, capacity)
          if (transfer <= 0) {
            continue
          }
          field[idx] = source - transfer
          field[belowIdx] = below + transfer
        }
      }
    }

    // Lateral cohesion pass: weak horizontal exchange to widen channels into coherent bands.
    // Conservative transfer between neighbors only; vertical transport remains dominant.
    const lateralTransferRate = clamp(dt * 0.35, 0, 0.02)
    if (lateralTransferRate > 0 && this.width > 1) {
      const width = this.width
      const field = this.moistureField
      for (let y = 0; y < this.height; y += 1) {
        const rowOffset = y * width
        for (let x = 0; x < width - 1; x += 1) {
          const leftIdx = rowOffset + x
          const rightIdx = leftIdx + 1
          const left = field[leftIdx]
          const right = field[rightIdx]
          const diff = left - right
          if (Math.abs(diff) <= 0.000001) {
            continue
          }

          const destination = diff > 0 ? right : left
          const destinationDryness = clamp((saturationCap - destination) / moistureRange, 0, 1)
          const destinationIdx = diff > 0 ? rightIdx : leftIdx
          const destinationY = y
          const aboveIdx = destinationY > 0 ? destinationIdx - width : -1
          const belowIdx = destinationY < this.height - 1 ? destinationIdx + width : -1
          const aboveDryness = aboveIdx >= 0 ? clamp((saturationCap - field[aboveIdx]) / moistureRange, 0, 1) : 0
          const belowDryness = belowIdx >= 0 ? clamp((saturationCap - field[belowIdx]) / moistureRange, 0, 1) : 0
          const verticalContinuity = destinationDryness * Math.max(aboveDryness, belowDryness)
          const lateralDamping = 1 - clamp(verticalContinuity * 0.45, 0, 0.45)
          const lateralBias = 1 + destinationDryness * 0.28
          const transferBase = Math.abs(diff) * lateralTransferRate * lateralBias * lateralDamping
          if (diff > 0) {
            const available = Math.max(0, left - minMoisture)
            const capacity = Math.max(0, maxMoisture - right)
            const transfer = Math.min(transferBase, available, capacity)
            if (transfer > 0) {
              field[leftIdx] = left - transfer
              field[rightIdx] = right + transfer
            }
          } else {
            const available = Math.max(0, right - minMoisture)
            const capacity = Math.max(0, maxMoisture - left)
            const transfer = Math.min(transferBase, available, capacity)
            if (transfer > 0) {
              field[rightIdx] = right - transfer
              field[leftIdx] = left + transfer
            }
          }
        }
      }
    }

    // Diagonal continuity pass: weak diagonal routing for channel connectivity around bends.
    // Conservative transfer: moisture can route to lower-left or lower-right when those diagonals
    // are significantly drier than the straight-down destination, maintaining continua without
    // creating separate flow field. Transfer rate is 3-4x weaker than downward transport.
    const diagonalTransferRate = clamp(dt * 0.2, 0, 0.015)
    if (diagonalTransferRate > 0 && this.width > 2 && this.height > 1) {
      const width = this.width
      const field = this.moistureField
      for (let y = 0; y < this.height - 1; y += 1) {
        const rowOffset = y * width
        const belowRowOffset = rowOffset + width
        for (let x = 1; x < width - 1; x += 1) {
          const idx = rowOffset + x
          const source = field[idx]
          const available = Math.max(0, source - minMoisture)
          if (available <= 0.000001) {
            continue
          }

          const downIdx = belowRowOffset + x
          const downValue = field[downIdx]
          const downSaturation = clamp((downValue - minMoisture) / moistureRange, 0, 1)

          const diagonalLeftIdx = belowRowOffset + (x - 1)
          const diagonalLeftValue = field[diagonalLeftIdx]
          const diagonalLeftSaturation = clamp((diagonalLeftValue - minMoisture) / moistureRange, 0, 1)

          const diagonalRightIdx = belowRowOffset + (x + 1)
          const diagonalRightValue = field[diagonalRightIdx]
          const diagonalRightSaturation = clamp((diagonalRightValue - minMoisture) / moistureRange, 0, 1)

          // Route diagonally only if that diagonal is notably underfull while down is more saturated
          const routeToLeft = diagonalLeftSaturation < downSaturation - 0.08
          const routeToRight = diagonalRightSaturation < downSaturation - 0.08

          if (!routeToLeft && !routeToRight) {
            continue
          }

          const moveBase = available * diagonalTransferRate

          if (routeToLeft && !routeToRight) {
            const leftCapacity = Math.max(0, maxMoisture - diagonalLeftValue)
            const transfer = Math.min(moveBase, available * 0.15, leftCapacity)
            if (transfer > 0) {
              field[idx] = clamp(source - transfer, minMoisture, maxMoisture)
              field[diagonalLeftIdx] = clamp(diagonalLeftValue + transfer, minMoisture, maxMoisture)
            }
          } else if (routeToRight && !routeToLeft) {
            const rightCapacity = Math.max(0, maxMoisture - diagonalRightValue)
            const transfer = Math.min(moveBase, available * 0.15, rightCapacity)
            if (transfer > 0) {
              field[idx] = clamp(source - transfer, minMoisture, maxMoisture)
              field[diagonalRightIdx] = clamp(diagonalRightValue + transfer, minMoisture, maxMoisture)
            }
          } else {
            // Both diagonals are drier than down: split transfer proportionally by capacity
            const leftCapacity = Math.max(0, maxMoisture - diagonalLeftValue)
            const rightCapacity = Math.max(0, maxMoisture - diagonalRightValue)
            const capacitySum = leftCapacity + rightCapacity
            if (capacitySum > 0) {
              const maxAvailable = available * 0.15
              const leftTransfer = moveBase * (leftCapacity / capacitySum)
              const rightTransfer = moveBase * (rightCapacity / capacitySum)
              const totalTransfer = Math.min(leftTransfer + rightTransfer, maxAvailable)
              if (totalTransfer > 0) {
                const scaleFactor = totalTransfer / (leftTransfer + rightTransfer)
                const actualLeft = leftTransfer * scaleFactor
                const actualRight = rightTransfer * scaleFactor
                field[idx] = clamp(source - actualLeft - actualRight, minMoisture, maxMoisture)
                field[diagonalLeftIdx] = clamp(diagonalLeftValue + actualLeft, minMoisture, maxMoisture)
                field[diagonalRightIdx] = clamp(diagonalRightValue + actualRight, minMoisture, maxMoisture)
              }
            }
          }
        }
      }
    }

    // Outlier smoothing pass: reduce isolated single-pixel noise while preserving channel edges.
    // Conservative neighborhood blending for pixels that deviate sharply from their 3x3 context.
    // Only affects outliers (|deviation| > threshold); established channels are preserved via bounded gate.
    // Mass is conserved locally: removed moisture is distributed back to neighbors proportionally.
    const outlierSmoothingRate = clamp(dt * 0.5, 0, 0.008)
    const outlierThreshold = moistureRange * 0.12 // Only smooth if deviation > 12% of range
    if (outlierSmoothingRate > 0 && this.width > 2 && this.height > 2) {
      const width = this.width
      const field = this.moistureField
      for (let y = 1; y < this.height - 1; y += 1) {
        const rowOffset = y * width
        const upRowOffset = rowOffset - width
        const downRowOffset = rowOffset + width
        for (let x = 1; x < width - 1; x += 1) {
          const idx = rowOffset + x
          const pixel = field[idx]

          // Compute 3x3 neighborhood average (8 surrounding pixels)
          const n0 = field[upRowOffset + x - 1]
          const n1 = field[upRowOffset + x]
          const n2 = field[upRowOffset + x + 1]
          const n3 = field[idx - 1]
          const n4 = field[idx + 1]
          const n5 = field[downRowOffset + x - 1]
          const n6 = field[downRowOffset + x]
          const n7 = field[downRowOffset + x + 1]
          const neighborSum = n0 + n1 + n2 + n3 + n4 + n5 + n6 + n7
          const neighborAvg = neighborSum / 8

          // Check if this pixel is an outlier; if not, skip
          const delta = pixel - neighborAvg
          if (Math.abs(delta) <= outlierThreshold) {
            continue
          }

          // Gate: do not smooth if the pixel is part of an established dry channel
          // Established channels have low absolute values relative to saturation
          const pixelSaturation = clamp((pixel - minMoisture) / moistureRange, 0, 1)
          const neighborSaturation = clamp((neighborAvg - minMoisture) / moistureRange, 0, 1)
          // If the pixel is drier than neighbors and is already quite dry, preserve it as a channel edge
          if (delta < 0 && pixelSaturation < 0.2) {
            continue
          }

          // This is a smoothable outlier: nudge it toward the neighborhood average
          // Conservative rate: move only a fraction per frame
          const moveAmount = Math.abs(delta) * outlierSmoothingRate
          const correction = moveAmount * Math.sign(delta)
          if (Math.abs(correction) <= 0.000001) {
            continue
          }

          // Apply correction to pixel
          const smoothedPixel = clamp(pixel - correction, minMoisture, maxMoisture)
          const actualCorrection = pixel - smoothedPixel
          if (Math.abs(actualCorrection) <= 0.000001) {
            continue
          }

          // Preserve mass locally: distribute the correction back to neighbors proportionally.
          // If pixel lost moisture (correction > 0), distribute it to neighbors; if pixel gained,
          // collect from neighbors. Weight redistribution by neighbor's deficit/surfeit.
          const redistribution = actualCorrection / 8 // Split evenly among 8 neighbors
          const neighborIndices = [
            upRowOffset + x - 1, upRowOffset + x, upRowOffset + x + 1,
            idx - 1,                             idx + 1,
            downRowOffset + x - 1, downRowOffset + x, downRowOffset + x + 1
          ]

          for (let ni = 0; ni < 8; ni++) {
            const nIdx = neighborIndices[ni]
            if (actualCorrection > 0) {
              // Pixel lost moisture: give to neighbors
              field[nIdx] = clamp(field[nIdx] + redistribution, minMoisture, maxMoisture)
            } else {
              // Pixel gained moisture: take from neighbors
              field[nIdx] = clamp(field[nIdx] - redistribution, minMoisture, maxMoisture)
            }
          }

          field[idx] = smoothedPixel
        }
      }
    }

    // Velocity continuity bias pass: reinforce established downstream channels via local momentum.
    // For each pixel, identify which of the three downward destinations (down, down-left, down-right)
    // is driest, and apply a small bonus transfer toward that direction to amplify carving along
    // the path of least resistance. This acts as a "velocity bias" without a separate flow field.
    // Transfer rate is very small and mass-conservative; only activated when path choice is clear.
    const velocityContinuityRate = clamp(dt * 0.2, 0, 0.006)
    const continuityThreshold = moistureRange * 0.09 // Path is established if dryness difference > 9% of range
    if (velocityContinuityRate > 0 && this.width > 2 && this.height > 1) {
      const width = this.width
      const field = this.moistureField
      for (let y = 0; y < this.height - 1; y += 1) {
        const rowOffset = y * width
        const belowRowOffset = rowOffset + width
        for (let x = 1; x < width - 1; x += 1) {
          const idx = rowOffset + x
          const source = field[idx]
          const available = Math.max(0, source - minMoisture)
          if (available <= 0.001) {
            continue
          }

          // Examine three downstream destinations
          const down = field[belowRowOffset + x]
          const downLeft = field[belowRowOffset + (x - 1)]
          const downRight = field[belowRowOffset + (x + 1)]

          // Find driest destination and range of dryness
          const minDown = Math.min(down, downLeft, downRight)
          const maxDown = Math.max(down, downLeft, downRight)
          const range = maxDown - minDown

          // Only apply bias if there's a clear established path (range > threshold)
          if (range < continuityThreshold) {
            continue
          }

          // Calculate saturation of driest path to determine bias strength
          const dryness = clamp((minDown - minMoisture) / moistureRange, 0, 1)
          const biasStrength = (1 - dryness) * 0.1 // Path-bias scales with remaining dry capacity

          // Apply transfer toward driest direction
          const biasAmount = available * velocityContinuityRate * biasStrength

          let targetIdx = -1
          let maxCap = 0
          if (minDown === down) {
            targetIdx = belowRowOffset + x
            maxCap = Math.max(0, maxMoisture - down)
          } else if (minDown === downLeft) {
            targetIdx = belowRowOffset + (x - 1)
            maxCap = Math.max(0, maxMoisture - downLeft)
          } else {
            targetIdx = belowRowOffset + (x + 1)
            maxCap = Math.max(0, maxMoisture - downRight)
          }

          if (targetIdx >= 0 && maxCap > 0) {
            const transfer = Math.min(biasAmount, available * 0.015, maxCap)
            if (transfer > 0.000001) {
              field[idx] = clamp(field[idx] - transfer, minMoisture, maxMoisture)
              field[targetIdx] = clamp(field[targetIdx] + transfer, minMoisture, maxMoisture)
            }
          }
        }
      }
    }

    let moistureMean = 0
    let moistureMax = minMoisture
    let moistureMin = maxMoisture
    for (let i = 0; i < this.moistureField.length; i++) {
      const m = this.moistureField[i]
      moistureMean += m
      moistureMax = Math.max(moistureMax, m)
      moistureMin = Math.min(moistureMin, m)
    }

    // Update display moisture as field average
    moistureMean /= this.moistureField.length
    this.displayMoisture = moistureMean

    this.stats.updateMs = performance.now() - start
    this.stats.moistureMean = moistureMean
    this.stats.moistureMax = moistureMax
    this.stats.moistureMin = moistureMin

    return this.displayMoisture
  }

  /**
   * Phase 4: Local disturbance writer (droplet head clear event).
   * 
   * Applies localized moisture reduction (clear/disturbance) directly to the GPU moisture field.
   * This is the first real spatial event writer, allowing gpuFields to respond to droplet impacts
   * with local interruption of ambient growth.
   * 
   * Used for droplet head clearing: where a droplet impacts and spreads, moisture is reduced
   * with radial falloff, creating visible responsive structure.
   * 
   * Mirrors legacy SurfaceWetnessField.clearArea() falloff curve for spatial coherence.
   * 
   * Parameters:
   * - cx, cy: center position in grid space
   * - radius: radial extent of clear zone
   * - strength: amplitude of moisture reduction (0-1)
   */
  applyLocalClear(cx = 0, cy = 0, radius = 1, strength = 0.5) {
    const mapped = this.mapRenderToSimulation(cx, cy)
    const cxScaled = mapped.x
    const cyScaled = mapped.y
    const radiusScale = (mapped.scaleX + mapped.scaleY) * 0.5
    const r = Math.max(0.5, radius * radiusScale)
    const s = clamp(strength, 0, 1)
    const minX = Math.max(0, Math.floor(cxScaled - r))
    const maxX = Math.min(this.width - 1, Math.ceil(cxScaled + r))
    const minY = Math.max(0, Math.floor(cyScaled - r))
    const maxY = Math.min(this.height - 1, Math.ceil(cyScaled + r))
    const invR = 1 / r

    // Use similar falloff curve as legacy clearArea for spatial coherence
    const pointScale = 0.24 + clamp((r - 1.5) * 0.06, 0, 0.16)

    for (let py = minY; py <= maxY; py += 1) {
      const dy = py - cyScaled
      for (let px = minX; px <= maxX; px += 1) {
        const dx = px - cxScaled
        const distance = Math.hypot(dx, dy)
        if (distance > r) {
          continue
        }

        const edge = clamp(1 - distance * invR, 0, 1)
        const falloff = edge * edge * (3 - 2 * edge)
        const headCore = clamp(1 - distance * invR * 1.35, 0, 1)
        const idx = py * this.width + px
        const blendedHeadFalloff = falloff * 0.74 + headCore * headCore * 0.26
        
        // Reduce moisture at impact point
        this.moistureField[idx] -= s * blendedHeadFalloff * pointScale
        this.moistureField[idx] = clamp(
          this.moistureField[idx],
          this.options.minMoisture,
          this.options.maxMoisture,
        )
      }
    }
  }

  applyTrailCarve(x1 = 0, y1 = 0, x2 = 0, y2 = 0, radius = 1, strength = 0.5, options = {}) {
    const p1 = this.mapRenderToSimulation(x1, y1)
    const p2 = this.mapRenderToSimulation(x2, y2)
    const x1Scaled = p1.x
    const y1Scaled = p1.y
    const x2Scaled = p2.x
    const y2Scaled = p2.y
    const radiusScaleAverage = (p1.scaleX + p1.scaleY) * 0.5
    const radiusScale = clamp(options.gridRadiusScale ?? 0.78, 0.35, 1.5)
    const r = Math.max(0.42, radius * radiusScale * radiusScaleAverage)
    const s = clamp(strength, 0, 1)
    const taperStart = clamp(options.taperStart ?? 0.72, 0.25, 1.3)
    const taperEnd = clamp(options.taperEnd ?? 1, 0.25, 1.35)
    const accumulationClamp = Math.max(0.02, options.accumulationClamp ?? 0.52)
    const trailMagnitude = Math.max(0, options.trailMagnitude ?? 0.3)
    const runnerMagnitude = Math.max(0, options.runnerMagnitude ?? 0.2)
    const gridMagnitude = Math.max(0, options.gridMagnitude ?? 0.028)
    const carveMagnitude = clamp(
      Math.max(gridMagnitude * 1.6, runnerMagnitude * 0.34, trailMagnitude * 0.18),
      0.01,
      0.22,
    )
    const dx = x2Scaled - x1Scaled
    const dy = y2Scaled - y1Scaled
    const len2 = Math.max(0.0001, dx * dx + dy * dy)
    const minX = Math.max(0, Math.floor(Math.min(x1Scaled, x2Scaled) - r - 1))
    const maxX = Math.min(this.width - 1, Math.ceil(Math.max(x1Scaled, x2Scaled) + r + 1))
    const minY = Math.max(0, Math.floor(Math.min(y1Scaled, y2Scaled) - r - 1))
    const maxY = Math.min(this.height - 1, Math.ceil(Math.max(y1Scaled, y2Scaled) + r + 1))
    const invR = 1 / r
    const minMoisture = this.options.minMoisture
    const maxMoisture = this.options.maxMoisture
    const moistureRange = Math.max(0.0001, maxMoisture - minMoisture)

    for (let py = minY; py <= maxY; py += 1) {
      for (let px = minX; px <= maxX; px += 1) {
        const relX = px - x1Scaled
        const relY = py - y1Scaled
        const t = clamp((relX * dx + relY * dy) / len2, 0, 1)
        const projX = x1Scaled + dx * t
        const projY = y1Scaled + dy * t
        const dist = Math.hypot(px - projX, py - projY)
        if (dist > r) {
          continue
        }

        const edge = clamp(1 - dist * invR, 0, 1)
        const radial = edge * edge * (3 - 2 * edge)
        const alongCore = 0.78 + (1 - Math.abs(t - 0.5) * 2) * 0.12
        const directionalTaper = taperStart + (taperEnd - taperStart) * t
        const idx = py * this.width + px
        const removed = clamp((maxMoisture - this.moistureField[idx]) / moistureRange, 0, 1)
        const accumulationLimiter = clamp(1 - removed / accumulationClamp, 0.2, 1)
        const carveAmount = s * radial * alongCore * directionalTaper * carveMagnitude * accumulationLimiter * moistureRange

        this.moistureField[idx] = clamp(
          this.moistureField[idx] - carveAmount,
          minMoisture,
          maxMoisture,
        )
      }
    }
  }

  getRenderStabilizedMoistureField(response = 0.34) {
    const source = this.moistureField
    const scratch = this.moistureScratch
    if (!source || !scratch || source.length !== scratch.length) {
      return source
    }

    const minMoisture = this.options.minMoisture
    const maxMoisture = this.options.maxMoisture
    const baseResponse = clamp(response, 0.2, 0.65)

    // Seed render buffer from authoritative state for first live frame to avoid startup darkening.
    if (this.frameId <= 1) {
      for (let i = 0; i < source.length; i += 1) {
        scratch[i] = source[i]
      }
      return scratch
    }

    for (let i = 0; i < source.length; i += 1) {
      const current = source[i]
      const previous = scratch[i]
      const delta = current - previous
      // Fast response on strong local impulses, gentler blend for micro-variance.
      const impulseBoost = Math.abs(delta) > 0.12 ? 0.22 : 0
      const alpha = clamp(baseResponse + impulseBoost, 0.2, 0.8)
      scratch[i] = clamp(previous + delta * alpha, minMoisture, maxMoisture)
    }

    return scratch
  }

  /**
   * Phase 1 Update: Condensation-like logic applied to independent moisture field.
   * 
   * Mimics SurfaceWetnessField.addCondensation() behavior but operates on
   * GPU-resident state. Base implementation:
   * - Apply condensation gain (refill-like)
   * - Apply recovery decay
   * - Clamp to valid range
   * - Update display moisture (simplified representation of field)
   * 
   * Does NOT yet include:
   * - Flow/advection
   * - Disturbance/write-wipe
   * - Optical derivatives
   * - Surface interaction coupling
   *
   * NOTE: In Phase 2+, this uniform update is replaced by transferFromLegacyGrid()
   * to give moisture real spatial structure from local sources.
   */
  updateMoisture(dt = 0.016) {
    const start = performance.now()
    
    const gain = dt * this.options.condensationGain
    const recovery = this.options.recoveryRate * dt
    const maxMoisture = this.options.maxMoisture
    const minMoisture = this.options.minMoisture

    // Phase 1 update: simple gain + decay on independent field
    let moistureMean = 0
    let moistureMax = minMoisture
    let moistureMin = maxMoisture

    for (let i = 0; i < this.moistureField.length; i++) {
      let m = this.moistureField[i]
      
      // Apply condensation gain (adds moisture)
      m += gain
      
      // Apply recovery decay (reduces moisture back toward minimum)
      m -= recovery * m
      
      // Clamp to valid range
      m = clamp(m, minMoisture, maxMoisture)
      
      this.moistureField[i] = m
      moistureMean += m
      moistureMax = Math.max(moistureMax, m)
      moistureMin = Math.min(moistureMin, m)
    }

    // Update display moisture as field average
    moistureMean /= this.moistureField.length
    this.displayMoisture = moistureMean

    this.stats.updateMs = performance.now() - start
    this.stats.moistureMean = moistureMean
    this.stats.moistureMax = moistureMax
    this.stats.moistureMin = moistureMin

    return this.displayMoisture
  }

  /**
   * Get current display moisture (simplified field representation).
   * In Phase 1, this is the mean of the field.
   * Future phases will compute proper optical derivatives.
   */
  getDisplayMoisture() {
    return this.displayMoisture
  }

  /**
   * Resize internal grids when canvas dimensions change.
   */
  resize(width, height) {
    const nextRenderWidth = Math.max(1, width | 0)
    const nextRenderHeight = Math.max(1, height | 0)
    const nextWidth = this.getScaledDimension(nextRenderWidth)
    const nextHeight = this.getScaledDimension(nextRenderHeight)

    if (
      this.renderWidth === nextRenderWidth &&
      this.renderHeight === nextRenderHeight &&
      this.width === nextWidth &&
      this.height === nextHeight
    ) {
      return
    }

    this.renderWidth = nextRenderWidth
    this.renderHeight = nextRenderHeight
    this.width = nextWidth
    this.height = nextHeight
    
    const oldMoisture = this.moistureField
    const initialMoisture = this.displayMoisture || this.options.initialMoisture

    this.moistureField = new Float32Array(this.width * this.height)
    this.moistureScratch = new Float32Array(this.width * this.height)

    // Initialize resized field with current display moisture level
    for (let i = 0; i < this.moistureField.length; i++) {
      this.moistureField[i] = clamp(
        initialMoisture,
        this.options.minMoisture,
        this.options.maxMoisture,
      )
    }
  }

  /**
   * Get field stats for diagnostics and A/B validation.
   */
  getStats() {
    return {
      ...this.stats,
      simulationScale: this.simulationScale,
      renderResolution: `${this.renderWidth}x${this.renderHeight}`,
      fieldResolution: `${this.width}x${this.height}`,
      fieldSize: this.moistureField.length,
    }
  }
}
