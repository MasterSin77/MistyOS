import { div, mul, plus, vec2, Vector2 } from "@sardinefish/zogra-renderer";
import { random, randomRange } from "./random";
import { CollisionGrid, RaindropSimulator } from "./simulator";
import { lerp, Time } from "./utils";

export class RainDrop
{
    pos: vec2;
    density: number = 1;
    velocity: vec2 = vec2.zero();
    spread: vec2;
    destroied = false;
    parent?: RainDrop;
    grid?: CollisionGrid;
    gridIdx?: number;

    /** True while this drop is in runner state (reduced resistance, set by split). */
    isRunner = false;
    /** Seconds remaining in runner state. */
    runnerTimeRemaining = 0;
    /** Frames remaining before this drop can participate in a merge again. */
    mergeCooldownFrames = 0;

    private _mass: number = 0;
    private _size: vec2 = vec2.zero();
    private simulator: RaindropSimulator;
    private resistance = 0;
    private shifting = 0;
    private lastTrailPos: vec2;
    private nextTrailDistance: number;

    private nextRandomTime = 0;

    constructor(simulator: RaindropSimulator, pos: vec2, size: number, density = 1)
    {
        this.pos = pos;
        this.simulator = simulator;
        this.density = density;

        this.lastTrailPos = pos.clone();
        this.nextTrailDistance = randomRange(...simulator.options.trailDistance);

        this.spread = vec2(simulator.options.initialSpread);

        this.mass = (size * density) ** 2;
    }

    get mass() { return this._mass; }
    set mass(m: number)
    {
        this._mass = m;
        const sqrtM = Math.sqrt(m) / this.density;
        this._size.x = (this.spread.x + 1) * sqrtM;
        this._size.y = (this.spread.y + 1) * sqrtM;
        // this._size = mul(plus(this.spread, vec2.one()), Math.sqrt(m));
    }
    
    get size(): vec2
    {
        return this._size;
    }

    get mergeDistance()
    {
        return this.size.x * (1 + this.spread.x) * 0.16 * this.simulator.options.colliderSize;
    }

    get options() { return this.simulator.options }

    updateRaindrop(time: Time)
    {
        if (this.nextRandomTime <= time.total)
        {
            this.nextRandomTime = time.total + randomRange(...this.simulator.options.motionInterval)
            this.randomMotion();
        }

        // Runner persistence timer: tick down and clear runner state when expired
        if (this.isRunner && this.runnerTimeRemaining > 0) {
            this.runnerTimeRemaining -= time.dt;
            if (this.runnerTimeRemaining <= 0) {
                this.isRunner = false;
                this.runnerTimeRemaining = 0;
            }
        }

        // Optional runner termination by mass threshold
        if (this.isRunner && this.simulator.options.runnerTerminationMassThreshold && this.simulator.options.runnerTerminationMassThreshold > 0) {
            if (this.mass < this.simulator.options.runnerTerminationMassThreshold) {
                this.isRunner = false;
                this.runnerTimeRemaining = 0;
            }
        }

        // Trail drops (parent !== undefined) can use a separate evaporate rate
        const evaporateRate = (this.parent !== undefined && this.simulator.options.trailEvaporate !== undefined)
            ? this.simulator.options.trailEvaporate
            : this.simulator.options.evaporate;
        this.mass -= evaporateRate * time.dt;

        // Piecewise gravity multiplier by drop size (first matching band wins)
        let gravityMultiplier = 1;
        const bands = this.options.velocityGravityBands;
        if (bands && bands.length > 0) {
            for (const band of bands) {
                if (this.size.x <= band.maxSize) {
                    gravityMultiplier = band.multiplier;
                    break;
                }
            }
        }
        const force = this.options.gravity * gravityMultiplier * this.mass - this.resistance;
        const acceleration = force / this.mass;
        this.velocity.y -= acceleration * time.dt;
        if (this.velocity.y > 0)
            this.velocity.y = 0;
        this.velocity.x = Math.abs(this.velocity.y) * this.shifting;
        this.pos.x += this.velocity.x * time.dt;
        this.pos.y += this.velocity.y * time.dt;
        // this.pos.plus(mul(this.velocity, vec2(time.dt)));

        const spreadByVelocity = this.simulator.options.velocitySpread * 2 * Math.atan(Math.abs(this.velocity.y * 0.005)) / Math.PI;
        this.spread.y = Math.max(this.spread.y, spreadByVelocity);
        // Trail drops can use a separate shrink rate
        const shrinkRateEff = (this.parent !== undefined && this.simulator.options.trailShrinkRate !== undefined)
            ? this.simulator.options.trailShrinkRate
            : this.simulator.options.shrinkRate;
        this.spread.x *= Math.pow(shrinkRateEff, time.dt);
        this.spread.y *= Math.pow(shrinkRateEff, time.dt);
        // this.spread.y +=  Math.abs(this.velocity.y) * 0.0001;

        if (Vector2.distanceSquared(this.lastTrailPos, this.pos) > this.nextTrailDistance * this.nextTrailDistance)
        {
            this.split();
        }
    }

    split()
    {
        // return;
        const massThreshold = this.simulator.options.runnerSplitMassThreshold ?? 1000;
        if (this.mass < massThreshold)
            return;
        const splitProb = this.simulator.options.runnerSplitProbability ?? 1;
        if (splitProb < 1 && Math.random() >= splitProb)
            return;
        let size = this.size.x * randomRange(...this.simulator.options.trailDropSize);
        const pos = plus(vec2(randomRange(-5, 5), this.size.y / 4), this.pos);
        let trailDrop = this.simulator.spawner.spawn(pos.clone(), size, this.simulator.options.trailDropDensity);
        trailDrop.spread = vec2(0.1, Math.abs(this.velocity.y) * 0.01 * this.options.trailSpread);
        trailDrop.parent = this;
        this.mass -= trailDrop.mass;
        this.simulator.add(trailDrop);
        this.lastTrailPos = this.pos.clone();
        this.nextTrailDistance = randomRange(...this.simulator.options.trailDistance);

        // Mark this (parent) drop as a runner after a successful split
        const persistMin = this.simulator.options.runnerPersistenceMin ?? 0;
        const persistMax = this.simulator.options.runnerPersistenceMax ?? 0;
        if (persistMax > 0) {
            this.isRunner = true;
            this.runnerTimeRemaining = persistMin + Math.random() * (persistMax - persistMin);
        }
    }

    randomMotion()
    {
        // Runner drops get reduced resistance (higher effective speed)
        const speedMultiplier = (this.isRunner && this.simulator.options.runnerSpeedMultiplier !== undefined)
            ? this.simulator.options.runnerSpeedMultiplier
            : 1;
        const maxResistance = lerp(...this.simulator.options.spawnSize, 1 - this.simulator.options.slipRate) ** 2 * 4 / speedMultiplier;
        this.resistance = randomRange(0, 1) * this.options.gravity * maxResistance;
        this.shifting = random() * randomRange(...this.simulator.options.xShifting);
    }

    merge(target: RainDrop)
    {
        const selfMomentum = mul(this.velocity, this.mass);
        const targetMomentum = mul(target.velocity, target.mass);
        const momentum = plus(selfMomentum, targetMomentum);
        this.mass += target.mass;
        this.velocity = div(momentum, this.mass);

        // Apply optional post-merge growth boost
        if (this.simulator.options.postMergeGrowthMultiplier && this.simulator.options.postMergeGrowthMultiplier > 1) {
            this.velocity = mul(this.velocity, this.simulator.options.postMergeGrowthMultiplier);
        }
    }
}