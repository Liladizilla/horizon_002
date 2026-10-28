import * as THREE from 'three';
import { VehicleSim } from '../physics/vehicle';
import { CarMesh, type CarAppearance } from '../render/carMesh';
import type { VehicleSpec } from '../vehicles/spec';
import type { CarControl, SurfaceSample } from '../core/types';
import { DEFAULT_ENVIRONMENT, type SimEnvironment } from '../physics/vehicle';
import { clamp } from '../core/math';

export interface ActorOptions {
  spec: VehicleSpec;
  appearance: CarAppearance;
  isPlayer: boolean;
  name: string;
  assists: ConstructorParameters<typeof VehicleSim>[2]['assists'];
  simDamage: boolean;
  surfaceSampler: (x: number, y: number, z: number, normalY: number) => SurfaceSample;
}

/** A car in the world: physics simulation + visual mesh + interpolation state. */
export class VehicleActor {
  sim: VehicleSim;
  mesh: CarMesh;
  name: string;
  isPlayer: boolean;
  controls: CarControl = { throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: false, shiftDown: false };

  private prevPos = new THREE.Vector3();
  private prevQuat = new THREE.Quaternion();
  private curPos = new THREE.Vector3();
  curQuat = new THREE.Quaternion();
  private hasState = false;

  /** Effects bookkeeping */
  smokeAccum = 0;
  skidAccum = 0;
  lastImpact = 0;
  engineLoadSmoothed = 0;

  constructor(world: ConstructorParameters<typeof VehicleSim>[0], params: ConstructorParameters<typeof VehicleSim>[1], opts: ActorOptions) {
    this.sim = new VehicleSim(world, params, {
      assists: opts.assists,
      simDamage: opts.simDamage,
      position: { x: 0, y: params.spec.cgHeight + 0.4, z: 0 },
      yaw: 0,
      surfaceSampler: opts.surfaceSampler,
      isPlayer: opts.isPlayer,
    });
    this.mesh = new CarMesh(opts.spec, opts.appearance);
    this.name = opts.name;
    this.isPlayer = opts.isPlayer;
    this.captureState();
  }

  get position() { return this.curPos; }
  get quaternion() { return this.curQuat; }

  place(x: number, y: number, z: number, yaw: number) {
    this.sim.resetTo(x, y, z, yaw);
    this.captureState();
    this.prevPos.copy(this.curPos);
    this.prevQuat.copy(this.curQuat);
  }

  /** Called after every fixed physics tick. */
  captureState() {
    const t = this.sim.body.translation();
    const r = this.sim.body.rotation();
    this.prevPos.copy(this.curPos);
    this.prevQuat.copy(this.curQuat);
    this.curPos.set(t.x, t.y, t.z);
    this.curQuat.set(r.x, r.y, r.z, r.w);
    if (!this.hasState) { this.prevPos.copy(this.curPos); this.prevQuat.copy(this.curQuat); this.hasState = true; }
  }

  /** Called once per rendered frame; `alpha` is the fraction into the next tick. */
  syncVisuals(dt: number, alpha: number, braking: number, headlightsOn: boolean) {
    this.mesh.group.position.lerpVectors(this.prevPos, this.curPos, alpha);
    this.mesh.group.quaternion.slerpQuaternions(this.prevQuat, this.curQuat, alpha);
    this.mesh.update(this.sim, { braking, headlightsOn, dt });
  }

  stepPhysics(dt: number, env: SimEnvironment = DEFAULT_ENVIRONMENT) {
    this.sim.step(dt, this.controls, env);
  }
}

export interface EffectHooks {
  spawnSmoke: (pos: THREE.Vector3, color: [number, number, number], size: number, life: number, vel: THREE.Vector3, grow?: number) => void;
  spawnSkid: (wheelIndex: number, pos: THREE.Vector3, normal: THREE.Vector3, width: number, intensity: number) => void;
  liftSkid: (wheelIndex: number) => void;
  spawnSparks: (pos: THREE.Vector3, count: number) => void;
}

const SURFACE_FX: Record<string, { color: [number, number, number]; smoke: boolean; skid: boolean; sparks: boolean }> = {
  asphaltDry: { color: [0.82, 0.82, 0.86], smoke: true, skid: true, sparks: false },
  asphaltWet: { color: [0.86, 0.90, 0.95], smoke: false, skid: true, sparks: false },
  concrete: { color: [0.85, 0.85, 0.85], smoke: true, skid: true, sparks: false },
  kerb: { color: [0.85, 0.8, 0.8], smoke: true, skid: true, sparks: false },
  gravel: { color: [0.62, 0.58, 0.5], smoke: false, skid: false, sparks: true },
  dirt: { color: [0.48, 0.4, 0.3], smoke: false, skid: false, sparks: false },
  grass: { color: [0.32, 0.42, 0.24], smoke: false, skid: false, sparks: false },
  sand: { color: [0.82, 0.74, 0.55], smoke: false, skid: false, sparks: false },
  mud: { color: [0.28, 0.22, 0.16], smoke: false, skid: false, sparks: false },
  snow: { color: [0.95, 0.97, 1.0], smoke: false, skid: false, sparks: false },
  water: { color: [0.75, 0.85, 0.92], smoke: false, skid: false, sparks: false },
};

/**
 * Emits particles and skid marks from the physical state of the tyres.
 * Everything is driven by measured slip and surface, never by "throttle pressed".
 */
export function emitVehicleEffects(actor: VehicleActor, dt: number, hooks: EffectHooks, density: number, cameraPos: THREE.Vector3) {
  const sim = actor.sim;
  const speed = sim.readout.speedMs;
  let maxUtil = 0;
  for (let i = 0; i < 4; i++) {
    const w = sim.wheels[i];
    if (!w.contact) { hooks.liftSkid(i); continue; }
    const slipSpeed = Math.abs(w.slipRatio) * Math.abs(sim.readout.forwardSpeedMs) + Math.abs(Math.sin(w.slipAngle)) * speed;
    const intensity = clamp((slipSpeed - 2.2) / 9, 0, 1) * clamp(w.load / 3000, 0.3, 1.4);
    maxUtil = Math.max(maxUtil, w.utilisation);
    const fx = SURFACE_FX[w.surfaceId] ?? SURFACE_FX.asphaltDry;

    if (fx.skid && intensity > 0.05) {
      hooks.spawnSkid(i, w.contactPoint, w.contactNormal, w.spec.width * 1.0, intensity);
    } else {
      hooks.liftSkid(i);
    }

    // Particles: bounded by distance to camera and by the density setting.
    const distToCam = w.contactPoint.distanceTo(cameraPos);
    const near = distToCam < 90;
    if (!near) continue;
    actor.smokeAccum += dt * intensity * 55 * density;
    if (actor.smokeAccum >= 1) {
      const n = Math.min(4, Math.floor(actor.smokeAccum));
      actor.smokeAccum -= n;
      for (let k = 0; k < n; k++) {
        const vel = new THREE.Vector3(
          (Math.random() - 0.5) * 2.2 - actor.sim.body.linvel().x * 0.12,
          0.8 + Math.random() * 1.4,
          (Math.random() - 0.5) * 2.2 - actor.sim.body.linvel().z * 0.12,
        );
        hooks.spawnSmoke(
          w.contactPoint.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.4, 0.16, (Math.random() - 0.5) * 0.4)),
          fx.color, 0.55 + Math.random() * 0.5, 1.1 + Math.random() * 0.9, vel, 2.6,
        );
      }
    }
    // Loose-surface roost: gravel/sand/grass thrown backwards even without slip
    if (['gravel', 'dirt', 'sand', 'mud', 'grass', 'snow'].includes(w.surfaceId) && speed > 6) {
      actor.skidAccum += dt * clamp(speed / 14, 0, 1) * 22 * density;
      if (actor.skidAccum >= 1) {
        actor.skidAccum -= 1;
        const back = new THREE.Vector3(0, 0, -1).applyQuaternion(actor.curQuat);
        hooks.spawnSmoke(
          w.contactPoint.clone(),
          fx.color, 0.22 + Math.random() * 0.3, 0.55 + Math.random() * 0.5,
          back.multiplyScalar(-speed * 0.22).add(new THREE.Vector3((Math.random() - 0.5) * 1.6, 1.4 + Math.random(), (Math.random() - 0.5) * 1.6)),
          1.8,
        );
      }
    }
  }
  // Exhaust pops under load
  actor.engineLoadSmoothed = actor.engineLoadSmoothed * 0.94 + sim.readout.throttle * 0.06;
}

export { DEFAULT_ENVIRONMENT };
