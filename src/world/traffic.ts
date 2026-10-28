import * as THREE from 'three';
import type { World as RapierWorld } from '@dimforge/rapier3d-compat';
import { clamp } from '../core/math';
import { TrafficDriver } from '../gameplay/ai';
import { VehicleActor } from '../gameplay/vehicleActor';
import type { SharedUniforms } from '../render/materials';
import { resolveParams, defaultTuning } from '../vehicles/tuning';
import { blankUpgrades } from '../core/save';
import { getCar, CARS } from '../data/cars';
import type { GameWorld } from './world';
import type { AssistSettings } from '../core/settings';
import type { SurfaceSampler } from '../physics/vehicle';
import { mulberry32 } from '../core/rng';

const TRAFFIC_CARS = ['crestline-lx', 'terrano-pickup', 'meltvan', 'boulder-4x4', 'kestrel-gt'];
const COLORS = ['#c9d1d9', '#2a6fb0', '#8a1f2e', '#e8e3d6', '#1e1f22', '#4a7a55', '#b8863a', '#6d6f78'];

interface TrafficEntry {
  actor: VehicleActor;
  driver: TrafficDriver;
  dir: number;
  roadId: string;
}

/**
 * Civilian traffic. Nearby cars are simulated with the same rigid-body physics
 * as the player; they are spawned ahead of the player and recycled when far
 * away, which keeps the active count small and the frame time predictable.
 */
export class TrafficManager {
  entries: TrafficEntry[] = [];
  maxCars = 7;
  private assists: AssistSettings;
  private sampler: SurfaceSampler;
  private shared: SharedUniforms;
  private scene: THREE.Scene;
  private rapier: RapierWorld;
  private rnd = mulberry32(8821);
  enabled = true;
  spawnRadius = 260;
  despawnRadius = 420;
  private spawnTimer = 0;

  constructor(
    scene: THREE.Scene,
    rapier: RapierWorld,
    assists: AssistSettings,
    sampler: SurfaceSampler,
    shared: SharedUniforms,
  ) {
    this.scene = scene;
    this.rapier = rapier;
    this.assists = { ...assists, autoGears: true };
    this.sampler = sampler;
    this.shared = shared;
  }

  private spawn(world: GameWorld, playerPos: THREE.Vector3) {
    const instances = world.field.instances;
    // Only roads near the player are candidates, otherwise random sampling over
    // the whole map almost never lands inside the spawn ring.
    const near: { inst: (typeof instances)[number]; idx: number; dist: number }[] = [];
    for (const inst of instances) {
      let best = Infinity, bi = 0;
      for (let i = 0; i < inst.samples.length; i += 4) {
        const s = inst.samples[i];
        const d = Math.hypot(s.x - playerPos.x, s.z - playerPos.z);
        if (d < best) { best = d; bi = i; }
      }
      if (best < this.spawnRadius + 220) near.push({ inst, idx: bi, dist: best });
    }
    if (!near.length) return;
    for (let attempt = 0; attempt < 40; attempt++) {
      const pick = near[Math.floor(this.rnd() * near.length)];
      const inst = pick.inst;
      const jitter = Math.floor((this.rnd() - 0.5) * 160);
      const sample = inst.samples[clamp(pick.idx + jitter, 0, inst.samples.length - 1)];
      const dist = Math.hypot(sample.x - playerPos.x, sample.z - playerPos.z);
      if (dist < 70 || dist > this.spawnRadius) continue;
      const carId = TRAFFIC_CARS[Math.floor(this.rnd() * TRAFFIC_CARS.length)];
      const spec = getCar(carId);
      const params = resolveParams(spec, blankUpgrades(), defaultTuning());
      const dir = this.rnd() > 0.5 ? 1 : -1;
      const yaw = Math.atan2(sample.dx * dir, sample.dz * dir);
      const laneOffset = 2.4;
      const rightX = sample.dz, rightZ = -sample.dx;
      const x = sample.x + rightX * laneOffset * dir;
      const z = sample.z + rightZ * laneOffset * dir;
      const y = world.driveY(x, z) + spec.cgHeight + 0.25;
      const actor = new VehicleActor(this.rapier, params, {
        spec, appearance: { color: COLORS[Math.floor(this.rnd() * COLORS.length)], finish: 'gloss' },
        isPlayer: false, name: 'Traffic', assists: this.assists, simDamage: true, surfaceSampler: this.sampler,
        shared: this.shared,
      });
      actor.place(x, y, z, yaw);
      actor.sim.body.setLinvel({ x: sample.dx * dir * 11, y: 0, z: sample.dz * dir * 11 }, true);
      this.scene.add(actor.mesh.group);
      this.entries.push({ actor, driver: new TrafficDriver(laneOffset, 0.9 + this.rnd() * 0.25), dir, roadId: inst.def.id });
      return;
    }
  }

  update(dt: number, world: GameWorld, playerPos: THREE.Vector3, obstacles: THREE.Vector3[], playerFar = false) {
    if (!this.enabled) { this.clear(); return; }
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && this.entries.length < this.maxCars && !playerFar) {
      this.spawnTimer = 0.6;
      this.spawn(world, playerPos);
    }
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      const d = e.actor.position.distanceTo(playerPos);
      if (d > this.despawnRadius) {
        this.scene.remove(e.actor.mesh.group);
        e.actor.mesh.dispose();
        e.actor.sim.dispose(this.rapier);
        this.entries.splice(i, 1);
        continue;
      }
      // Nearest obstacle ahead of this car
      let blocked: THREE.Vector3 | null = null;
      for (const o of obstacles) {
        const dist = o.distanceTo(e.actor.position);
        if (dist < 14) { blocked = o; break; }
      }
      e.actor.controls = e.driver.update(dt, e.actor, world, blocked);
    }
  }

  stepPhysics(dt: number, env: Parameters<VehicleActor['stepPhysics']>[1]) {
    for (const e of this.entries) e.actor.stepPhysics(dt, env);
  }

  syncVisuals(dt: number, alpha: number, isNight: boolean) {
    for (const e of this.entries) e.actor.syncVisuals(dt, alpha, e.actor.controls.brake, isNight);
  }

  clear() {
    for (const e of this.entries) {
      this.scene.remove(e.actor.mesh.group);
      e.actor.mesh.dispose();
      e.actor.sim.dispose(this.rapier);
    }
    this.entries.length = 0;
  }

  get actors() { return this.entries.map((e) => e.actor); }
}

export { CARS };
