const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const lerp = (from, to, t) => from + (to - from) * t
const randomRange = (min, max) => min + Math.random() * (max - min)
const randomFromRangeOption = (value) => {
  if (Array.isArray(value)) {
    return randomRange(value[0], value[1])
  }
  return value
}

class SpatialGridNeighborLookup {
  constructor(cellSize = 28) {
    this.cellSize = cellSize
    this.width = 1
    this.height = 1
    this.cells = new Map()
  }

  resize(width, height) {
    this.width = Math.max(1, Math.floor(width))
    this.height = Math.max(1, Math.floor(height))
    this.clear()
  }

  clear() {
    this.cells.clear()
  }

  key(cx, cy) {
    return `${cx}:${cy}`
  }

  insert(index, x, y) {
    const cx = Math.floor(x / this.cellSize)
    const cy = Math.floor(y / this.cellSize)
    const key = this.key(cx, cy)
    const bucket = this.cells.get(key)
    if (bucket) {
      bucket.push(index)
      return
    }
    this.cells.set(key, [index])
  }

  query(x, y, radius) {
    const minX = Math.floor((x - radius) / this.cellSize)
    const maxX = Math.floor((x + radius) / this.cellSize)
    const minY = Math.floor((y - radius) / this.cellSize)
    const maxY = Math.floor((y + radius) / this.cellSize)
    const indices = []

    for (let cy = minY; cy <= maxY; cy += 1) {
      for (let cx = minX; cx <= maxX; cx += 1) {
        const bucket = this.cells.get(this.key(cx, cy))
        if (!bucket) {
          continue
        }
        for (const index of bucket) {
          indices.push(index)
        }
      }
    }

    return indices
  }
}

class DropletEntityModel {
  constructor(id, x, y, mass, velocity, spread, seed = Math.random() * Math.PI * 2) {
    this.id = id
    this.x = x
    this.y = y
    this.mass = mass
    this.velocity = { x: velocity.x, y: velocity.y }
    this.spread = spread
    this.seed = seed
    this.age = 0
    this.dead = false

    this.trail = {
      distanceAccumulator: 0,
      splitCooldown: 0,
      wakeAccumulator: randomRange(0, 4),
      intensity: 1,
      childCount: 0,
    }

    // RaindropFX-like cadence: each drop periodically picks a new drift state,
    // which creates organic stop/start motion instead of constant wobble.
    this.motion = {
      shiftX: 0,
      brake: 0.9,
      nextShiftIn: 0,
    }
  }

  get radius() {
    return clamp(Math.sqrt(this.mass) * 2.05 + this.spread * 0.7, 1.5, 15)
  }

  toState() {
    return {
      id: this.id,
      x: this.x,
      y: this.y,
      mass: this.mass,
      velocity: { x: this.velocity.x, y: this.velocity.y },
      spread: this.spread,
      trail: {
        intensity: this.trail.intensity,
        childCount: this.trail.childCount,
      },
      radius: this.radius,
      age: this.age,
    }
  }

  integrate(dt, sim, trailEvents, spawnQueue) {
    const previous = { x: this.x, y: this.y }
    this.age += dt
    const massFactor = clamp(Math.sqrt(this.mass), 0.45, 3.2)

    this.motion.nextShiftIn -= dt
    if (this.motion.nextShiftIn <= 0) {
      const pauseChance = clamp(sim.options.motionPauseChance, 0, 1)
      const paused = Math.random() < pauseChance
      const shiftMagnitude = randomFromRangeOption(sim.options.xShifting)
      const direction = Math.random() < 0.5 ? -1 : 1

      this.motion.shiftX = paused ? 0 : direction * shiftMagnitude
      this.motion.brake = paused ? randomRange(0.92, 0.98) : randomFromRangeOption(sim.options.motionBrake)
      this.motion.nextShiftIn = Math.max(0.02, randomFromRangeOption(sim.options.motionInterval))
    }

    const verticalBias = clamp(this.velocity.y / 220, 0.1, 1)
    const gravity = sim.options.gravity + massFactor * sim.options.massGravityScale
    const fallSpeedNorm = clamp(this.velocity.y / sim.options.maxVelocityY, 0, 1)
    const targetShiftX = this.motion.shiftX * this.velocity.y * sim.options.lateralDriftScale

    this.velocity.y = clamp(this.velocity.y + gravity * dt, sim.options.minVelocityY, sim.options.maxVelocityY)
    this.velocity.x = lerp(this.velocity.x, targetShiftX, clamp(dt * sim.options.motionLerp, 0, 1))
    this.velocity.x *= 1 - dt * sim.options.horizontalDamping * verticalBias * this.motion.brake
    this.velocity.x += Math.sin(this.age * 0.85 + this.seed * 0.6) * fallSpeedNorm * sim.options.sideMotion * 0.03
    this.velocity.y *= 1 - dt * sim.options.verticalResistance

    this.spread = clamp(this.spread + dt * sim.options.spreadGrowth + this.velocity.y * 0.0011 + massFactor * 0.012, 0.2, 5.2)

    this.x += this.velocity.x * dt
    this.y += this.velocity.y * dt

    const distance = Math.hypot(this.x - previous.x, this.y - previous.y)
    this.trail.distanceAccumulator += distance * (0.8 + massFactor * 0.3)
    this.trail.wakeAccumulator += distance
    this.trail.splitCooldown = Math.max(0, this.trail.splitCooldown - dt)
    this.trail.intensity = clamp(0.32 + this.mass * 0.1 + this.velocity.y * 0.0048, 0.3, 1.35)

    if (this.trail.wakeAccumulator >= sim.options.wakeSpacing) {
      this.trail.wakeAccumulator = 0
      trailEvents.push({
        type: 'wake',
        parentId: this.id,
        from: previous,
        to: { x: this.x, y: this.y },
        radius: clamp(this.radius * sim.options.trailRadiusScale * (0.55 + massFactor * 0.24), 1, 9.8),
        strength: clamp(this.trail.intensity * 0.74, 0.2, 0.92),
      })
    }

    if (
      this.trail.distanceAccumulator >= sim.options.trailDistance &&
      this.trail.splitCooldown === 0 &&
      this.mass > sim.options.splitMinMass
    ) {
      this.trail.distanceAccumulator = 0
      this.trail.splitCooldown = randomFromRangeOption(sim.options.motionInterval) * randomRange(0.7, 1.35)

      const childMass = clamp(this.mass * sim.options.trailDropSize * (0.72 + Math.random() * 0.42), 0.15, this.mass * 0.4)
      this.mass -= childMass
      this.trail.childCount += 1

      const nx = distance > 0 ? (this.x - previous.x) / distance : 0
      const ny = distance > 0 ? (this.y - previous.y) / distance : 1
      const behind = this.radius * randomRange(0.8, 1.45)
      const jitter = sim.options.trailSpread * (Math.random() - 0.5)
      spawnQueue.push({
        x: previous.x - nx * behind + jitter,
        y: previous.y - ny * behind + (Math.random() - 0.5) * sim.options.trailSpread,
        mass: childMass,
        velocity: {
          x: this.velocity.x * sim.options.velocitySpread + (Math.random() - 0.5) * sim.options.sideMotion * 0.55,
          y: this.velocity.y * sim.options.velocitySpread * randomRange(0.72, 0.9),
        },
        spread: clamp(this.spread * randomRange(0.58, 0.74), 0.2, 2.8),
      })

      trailEvents.push({
        type: 'split',
        parentId: this.id,
        from: previous,
        to: { x: this.x, y: this.y },
        radius: clamp(this.radius * (0.52 + massFactor * 0.12), 1, 6),
        strength: clamp(0.55 + massFactor * 0.12, 0.5, 1),
      })
    }

    if (sim.options.evaporate) {
      this.mass = Math.max(0, this.mass - dt * sim.options.shrinkRate)
      this.spread = Math.max(0.1, this.spread - dt * sim.options.spreadDecay)
      if (this.mass <= sim.options.minMass) {
        this.dead = true
      }
    }

    if (this.y > sim.height + 42 || this.x < -42 || this.x > sim.width + 42) {
      this.dead = true
    }
  }
}

class SpawnController {
  constructor(options) {
    this.options = options
    this.accumulator = 0
    this.recentSpawnXs = []
  }

  reset() {
    this.accumulator = 0
    this.recentSpawnXs.length = 0
  }

  pickSpawnX(sim) {
    const minGap = clamp(sim.width * 0.06, 24, 72)
    const edgePadding = clamp(sim.width * 0.02, 5, 20)
    let best = randomRange(edgePadding, sim.width - edgePadding)
    let bestDistance = -1

    for (let i = 0; i < 5; i += 1) {
      const candidate = randomRange(edgePadding, sim.width - edgePadding)
      let nearest = Number.POSITIVE_INFINITY

      for (const previousX of this.recentSpawnXs) {
        nearest = Math.min(nearest, Math.abs(candidate - previousX))
      }

      if (nearest > bestDistance) {
        bestDistance = nearest
        best = candidate
      }

      if (nearest >= minGap) {
        best = candidate
        break
      }
    }

    this.recentSpawnXs.push(best)
    if (this.recentSpawnXs.length > 20) {
      this.recentSpawnXs.shift()
    }

    return best
  }

  update(sim, dt) {
    const area = sim.width * sim.height
    const densityLimit = Math.floor(clamp(area * this.options.spawnDensity, 14, this.options.spawnLimit))
    if (sim.droplets.length >= densityLimit) {
      return
    }

    const interval = this.options.spawnInterval / clamp(sim.width / 520, 0.9, 1.4)
    this.accumulator += dt

    while (this.accumulator >= interval && sim.droplets.length < densityLimit) {
      this.accumulator -= interval

      const spawnX = this.pickSpawnX(sim)
      const mass = this.options.spawnSize[0] + Math.random() * (this.options.spawnSize[1] - this.options.spawnSize[0])
      const massFactor = clamp(Math.sqrt(mass), 0.45, 3.2)

      sim.addDroplet(
        sim.createDroplet({
          x: spawnX,
          y: -10 - Math.random() * 34,
          mass,
          velocity: {
            x: (Math.random() - 0.5) * this.options.sideMotion * 0.22,
            y: this.options.minVelocityY + randomRange(4, 14) + massFactor * 1.4,
          },
          spread: 0.55 + Math.random() * 0.95,
        }),
      )
    }
  }
}

class SimulationManager {
  constructor(options = {}) {
    this.options = {
      spawnInterval: 0.22,
      spawnSize: [1.1, 4.1],
      spawnLimit: 96,
      spawnDensity: 0.00016,
      gravity: 76,
      massGravityScale: 20,
      sideMotion: 7,
      lateralDriftScale: 1,
      motionInterval: [0.1, 0.4],
      xShifting: [0, 0.1],
      motionPauseChance: 0.34,
      motionBrake: [0.72, 0.9],
      motionLerp: 6.5,
      wakeSpacing: 7,
      trailDistance: 15,
      trailDropSize: 0.12,
      trailSpread: 4.4,
      trailRadiusScale: 1.04,
      velocitySpread: 0.56,
      shrinkRate: 0.028,
      spreadGrowth: 0.11,
      spreadDecay: 0.08,
      minMass: 0.08,
      splitMinMass: 1.2,
      minVelocityY: 8,
      maxVelocityY: 225,
      horizontalDamping: 0.42,
      verticalResistance: 0.08,
      evaporate: true,
      ...options,
    }

    this.width = 1
    this.height = 1
    this.nextId = 1
    this.droplets = []
    this.grid = new SpatialGridNeighborLookup(30)
    this.spawner = new SpawnController(this.options)
  }

  resize(width, height) {
    this.width = Math.max(1, Math.floor(width))
    this.height = Math.max(1, Math.floor(height))
    this.grid.resize(this.width, this.height)
    this.droplets = this.droplets.filter((drop) => !drop.dead)
  }

  reset() {
    this.droplets.length = 0
    this.spawner.reset()
  }

  createDroplet({ x, y, mass, velocity, spread }) {
    return new DropletEntityModel(this.nextId++, x, y, mass, velocity, spread)
  }

  addDroplet(droplet) {
    this.droplets.push(droplet)
  }

  rebuildGrid() {
    this.grid.clear()
    for (let i = 0; i < this.droplets.length; i += 1) {
      const d = this.droplets[i]
      if (d.dead) {
        continue
      }
      this.grid.insert(i, d.x, d.y)
    }
  }

  mergeDroplets() {
    for (let i = 0; i < this.droplets.length; i += 1) {
      const a = this.droplets[i]
      if (!a || a.dead) {
        continue
      }

      const massRange = clamp(Math.sqrt(a.mass) * 2.4, 2, 10)
      const range = a.radius + massRange
      const neighbors = this.grid.query(a.x, a.y, range)

      for (const j of neighbors) {
        if (j <= i) {
          continue
        }

        const b = this.droplets[j]
        if (!b || b.dead) {
          continue
        }

        const dx = b.x - a.x
        const dy = b.y - a.y
        const distance = Math.hypot(dx, dy)
        const mergeThreshold = (a.radius + b.radius) * clamp(0.52 + (Math.sqrt(a.mass) + Math.sqrt(b.mass)) * 0.055, 0.56, 0.92)

        if (distance > mergeThreshold) {
          continue
        }

        const combinedMass = a.mass + b.mass
        if (combinedMass <= 0) {
          continue
        }

        a.x = (a.x * a.mass + b.x * b.mass) / combinedMass
        a.y = (a.y * a.mass + b.y * b.mass) / combinedMass
        a.velocity.x = (a.velocity.x * a.mass + b.velocity.x * b.mass) / combinedMass
        a.velocity.y = (a.velocity.y * a.mass + b.velocity.y * b.mass) / combinedMass
        a.velocity.y = clamp(a.velocity.y + Math.sqrt(combinedMass) * 0.7, this.options.minVelocityY, this.options.maxVelocityY)
        a.spread = clamp((a.spread + b.spread) * 0.6, 0.2, 5.2)
        a.mass = combinedMass
        a.trail.intensity = clamp(Math.max(a.trail.intensity, b.trail.intensity) + 0.12, 0.35, 1.35)

        b.dead = true
      }
    }
  }

  update(dt, { enabled = true, width = this.width, height = this.height } = {}) {
    this.resize(width, height)

    if (!enabled) {
      this.reset()
      return { droplets: [], trails: [] }
    }

    this.spawner.update(this, dt)

    const trailEvents = []
    const spawnQueue = []

    for (const droplet of this.droplets) {
      if (droplet.dead) {
        continue
      }
      droplet.integrate(dt, this, trailEvents, spawnQueue)
    }

    for (const child of spawnQueue) {
      this.addDroplet(this.createDroplet(child))
    }

    this.rebuildGrid()
    this.mergeDroplets()

    this.droplets = this.droplets.filter((drop) => !drop.dead)

    return {
      droplets: this.droplets.map((drop) => drop.toState()),
      trails: trailEvents,
    }
  }
}

export class RaindropSimulation {
  constructor(options = {}) {
    this.manager = new SimulationManager(options)
  }

  resize(width, height) {
    this.manager.resize(width, height)
  }

  reset() {
    this.manager.reset()
  }

  update(dt, context) {
    return this.manager.update(dt, context)
  }
}
