import * as THREE from 'three';
import { clamp, lerp, wrapAngle } from '../core/math';
import type { CarControl } from '../core/types';
import type { GameWorld } from '../world/world';
import type { VehicleActor } from './vehicleActor';
import type { Route } from './route';

export interface AISettings {
  /** 0..1 - lower skill means slower corner targets and more mistakes. */
  skill: number;
  aggression: number;
  /** metres of lateral offset from the racing line (overtaking). */
  laneBias: number;
  reactionTime: number;
}

const NEUTRAL: CarControl = { throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: false, shiftDown: false };

/**
 * Pure-pursuit driver.
 *
 * Produces *inputs* only - throttle, brake and steering - so the AI cars run
 * through exactly the same physics as the player. There are no teleports and no
 * hidden power multipliers; difficulty only changes how close to the limit the
 * driver aims to drive.
 */
export class AIDriver {
  settings: AISettings;
  private route: Route | null = null;
  private routeIndex = 0;
  private steerState = 0;
  private stuckTimer = 0;
  private reverseTimer = 0;
  private reactionAccum = 0;
  private cachedTarget = 0;
  /** extra lateral offset used when this driver is overtaking */
  laneBias = 0;
  /** set to true when the car should be recovered to the route */
  needsRecovery = false;

  constructor(settings: AISettings) {
    this.settings = settings;
  }

  setRoute(route: Route) {
    this.route = route;
    this.routeIndex = 0;
  }

  /** Nearest route index to a world position (route is monotonic, so search locally). */
  private advanceRouteIndex(pos: THREE.Vector3) {
    if (!this.route) return;
    const pts = this.route.points;
    let best = this.routeIndex, bestD = Infinity;
    const window = 60;
    for (let k = -6; k < window; k++) {
      const i = (this.routeIndex + k + pts.length) % pts.length;
      const p = pts[i];
      const d = (p.x - pos.x) ** 2 + (p.z - pos.z) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    this.routeIndex = best;
  }

  update(dt: number, actor: VehicleActor, world: GameWorld, others: { pos: THREE.Vector3; speed: number }[]): CarControl {
    if (!this.route) return NEUTRAL;
    const pos = actor.position;
    this.advanceRouteIndex(pos);
    const pts = this.route.points;
    const speed = actor.sim.readout.speedMs;

    // ---- look-ahead point (pure pursuit) ----
    const lookDist = clamp(6 + speed * 0.85, 8, 55);
    let idx = this.routeIndex;
    let travelled = 0;
    while (travelled < lookDist) {
      const a = pts[idx % pts.length];
      const b = pts[(idx + 1) % pts.length];
      travelled += Math.hypot(b.x - a.x, b.z - a.z);
      idx++;
    }
    const targetPoint = pts[idx % pts.length];
    const lateral = this.laneBias + this.settings.laneBias;
    const prevP = pts[this.routeIndex % pts.length];
    const nextP = pts[(idx + 1) % pts.length];
    const dirX = nextP.x - prevP.x, dirZ = nextP.z - prevP.z;
    const dirLen = Math.hypot(dirX, dirZ) || 1;
    const offsetX = (-dirZ / dirLen) * lateral;
    const offsetZ = (dirX / dirLen) * lateral;

    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(actor.curQuat);
    const toTarget = new THREE.Vector3(targetPoint.x + offsetX - pos.x, 0, targetPoint.z + offsetZ - pos.z);
    const distance = toTarget.length();
    toTarget.normalize();
    const heading = Math.atan2(fwd.x, fwd.z);
    const targetHeading = Math.atan2(toTarget.x, toTarget.z);
    const angleError = wrapAngle(targetHeading - heading);

    // Steering: proportional with a small integral to hold a line.
    const steerGain = lerp(1.1, 1.9, this.settings.skill);
    this.steerState = clamp(angleError * steerGain, -1, 1);
    // Reduce steering authority at speed like a real rack.
    this.steerState *= clamp(1.35 - speed / 120, 0.45, 1);

    // ---- speed target from curvature ahead ----
    this.reactionAccum += dt;
    if (this.reactionAccum >= Math.max(0.02, this.settings.reactionTime)) {
      this.reactionAccum = 0;
      let maxCurvature = 0;
      let accum = 0;
      let i = this.routeIndex;
      while (accum < 130) {
        const a = pts[i % pts.length];
        const b = pts[(i + 3) % pts.length];
        const c = pts[(i + 6) % pts.length];
        const abx = b.x - a.x, abz = b.z - a.z;
        const bcx = c.x - b.x, bcz = c.z - b.z;
        const cross = Math.abs(abx * bcz - abz * bcx);
        const denom = Math.hypot(abx, abz) * Math.hypot(bcx, bcz) * Math.hypot(c.x - a.x, c.z - a.z);
        const curvature = denom > 1e-4 ? (2 * cross) / denom : 0;
        maxCurvature = Math.max(maxCurvature, curvature);
        accum += Math.hypot(abx, abz) + Math.hypot(bcx, bcz);
        i += 3;
      }
      const gripEstimate = 9.8 * lerp(0.72, 1.15, this.settings.skill);
      // v = sqrt(a / k) for a constant-radius corner
      const cornerSpeed = maxCurvature > 1e-4 ? Math.sqrt(gripEstimate / maxCurvature) : 90;
      this.cachedTarget = clamp(cornerSpeed * lerp(0.78, 1.02, this.settings.skill), 8, 110);
    }

    // ---- traffic / rival avoidance ----
    let blocked = false;
    const ahead = new THREE.Vector3(pos.x + fwd.x * 11, 0, pos.z + fwd.z * 11);
    for (const o of others) {
      const d = Math.hypot(o.pos.x - pos.x, o.pos.z - pos.z);
      if (d < 1.2) continue;
      const relX = o.pos.x - pos.x, relZ = o.pos.z - pos.z;
      const along = relX * fwd.x + relZ * fwd.z;
      const side = relX * fwd.z - relZ * fwd.x;
      if (along > 0 && along < 16 && Math.abs(side) < 3.2) {
        blocked = true;
        this.steerState = clamp(this.steerState - Math.sign(side || 1) * 0.45, -1, 1);
      }
      void ahead;
    }

    let targetSpeed = this.cachedTarget;
    if (blocked) targetSpeed = Math.min(targetSpeed, speed * 0.82);
    // Occasional lift / small mistakes keep a "human" feel at lower skill.
    if (this.settings.skill < 0.9 && Math.random() < (1 - this.settings.skill) * dt * 0.6) {
      targetSpeed *= 0.75;
    }

    const speedError = targetSpeed - speed;
    let throttle = clamp(speedError * 0.32, 0, 1);
    let brake = clamp(-speedError * 0.22, 0, 1);
    // Throttle commitment out of corners (aggression)
    if (Math.abs(angleError) < 0.25 && speed < targetSpeed * 1.1) throttle = Math.max(throttle, this.settings.aggression * 0.85);

    // ---- recovery ----
    const offRoute = this.nearestRouteDistance(pos) > 26;
    this.stuckTimer = speed < 1.4 ? this.stuckTimer + dt : 0;
    if (this.reverseTimer > 0) {
      this.reverseTimer -= dt;
      return { ...NEUTRAL, brake: 1, steer: -Math.sign(this.steerState) };
    }
    if (this.stuckTimer > 2.2) {
      this.reverseTimer = 1.1;
      this.stuckTimer = 0;
    }
    if (offRoute) { throttle = Math.min(throttle, 0.75); this.steerState = clamp(angleError * 1.6, -1, 1); }
    this.needsRecovery = offRoute && speed < 2.5;

    return {
      throttle, brake, steer: this.steerState, handbrake: 0,
      shiftUp: false, shiftDown: false,
    };
  }

  private nearestRouteDistance(pos: THREE.Vector3): number {
    if (!this.route) return 0;
    let best = Infinity;
    for (let k = -10; k < 40; k++) {
      const p = this.route.points[(this.routeIndex + k + this.route.points.length) % this.route.points.length];
      best = Math.min(best, Math.hypot(p.x - pos.x, p.z - pos.z));
    }
    return best;
  }
}

// ---------------------------------------------------------------------------
// Civilian traffic
// ---------------------------------------------------------------------------

export interface TrafficTarget {
  x: number;
  z: number;
  speedLimit: number;
}

/**
 * Lane-following civilian traffic. Same physics as everything else, but the
 * driver is deliberately conservative: it keeps right, brakes for obstacles and
 * never exceeds the road's speed limit by much.
 */
export class TrafficDriver {
  laneOffset: number;
  speedFactor: number;
  private target: THREE.Vector3 | null = null;
  private stuckTimer = 0;

  constructor(laneOffset = 2.6, speedFactor = 0.85) {
    this.laneOffset = laneOffset;
    this.speedFactor = speedFactor;
  }

  update(dt: number, actor: VehicleActor, world: GameWorld, blockedBy: THREE.Vector3 | null): CarControl {
    const pos = actor.position;
    const info = world.roadInfoAt(pos.x, pos.z);
    const nearest = world.nearestRoad(pos.x, pos.z);
    if (!nearest.sample) return { ...NEUTRAL, brake: 0.4 };

    // Look ahead along the road using the sample's tangent.
    const aheadDist = clamp(12 + actor.sim.readout.speedMs * 0.9, 14, 40);
    const s = nearest.sample;
    // Keep right of the centreline (the map uses right-hand traffic).
    const rightX = s.dz, rightZ = -s.dx;
    const tx = s.x + s.dx * aheadDist + rightX * this.laneOffset;
    const tz = s.z + s.dz * aheadDist + rightZ * this.laneOffset;
    this.target = new THREE.Vector3(tx, 0, tz);

    const toTarget = new THREE.Vector3(tx - pos.x, 0, tz - pos.z).normalize();
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(actor.curQuat);
    const angleError = wrapAngle(Math.atan2(toTarget.x, toTarget.z) - Math.atan2(fwd.x, fwd.z));
    let steer = clamp(angleError * 1.5, -1, 1);

    // Obstacle braking
    let brake = 0;
    if (blockedBy) {
      const rel = new THREE.Vector3(blockedBy.x - pos.x, 0, blockedBy.z - pos.z);
      const along = rel.dot(fwd);
      if (along > 0 && along < 16) brake = clamp((16 - along) / 14, 0.1, 1);
    }
    if (info.dist > info.width * 0.5 + 3) {
      // drifted off the road: slow down and steer back
      brake = Math.max(brake, 0.35);
    }
    const targetSpeed = Math.min(s.width > 0 ? nearest.sample.width : 10, 20) * 0 +
      (world.onRoad(pos.x, pos.z) ? this.speedFactor * 26 : 8);
    const speed = actor.sim.readout.speedMs;
    const throttle = clamp((targetSpeed - speed) * 0.4, 0, 0.85);
    if (Math.abs(angleError) > 0.9) steer = Math.sign(angleError);
    this.stuckTimer = speed < 0.6 ? this.stuckTimer + dt : 0;
    if (this.stuckTimer > 4) { brake = 1; }
    void dt;
    return { throttle, brake, steer, handbrake: 0, shiftUp: false, shiftDown: false };
  }
}
