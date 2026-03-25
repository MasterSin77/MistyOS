import { REGION_IDS } from './model'

const QUADRANT_CENTERS = {
  q1: { x: 0.25, y: 0.25 },
  q2: { x: 0.75, y: 0.25 },
  q3: { x: 0.25, y: 0.75 },
  q4: { x: 0.75, y: 0.75 },
}

export function createFourQuadrantRegionModel(options = {}) {
  const softness = Number.isFinite(options.softness) ? options.softness : 0.42

  return {
    id: 'four-soft-quadrants',
    softness,
    regionIds: REGION_IDS,
    sampleInfluence(regionId, uv) {
      if (regionId === 'global') {
        return 1
      }
      const center = QUADRANT_CENTERS[regionId]
      if (!center) {
        return 0
      }

      const dx = uv.x - center.x
      const dy = uv.y - center.y
      const distance = Math.sqrt(dx * dx + dy * dy)
      const radius = 0.62
      const edge0 = radius * (1 - softness)
      const edge1 = radius
      return smoothstep(edge1, edge0, distance)
    },
  }
}

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}
