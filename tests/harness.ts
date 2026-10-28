import { World, RigidBodyDesc, ColliderDesc } from '@dimforge/rapier3d-compat';
import { initRapier } from './init';
import { VehicleSim, DEFAULT_ENVIRONMENT } from '../src/physics/vehicle';
import { getCar } from '../src/data/cars';
import { resolveParams, defaultTuning } from '../src/vehicles/tuning';
import { blankUpgrades } from '../src/core/save';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import type { CarControl } from '../src/core/types';
import type { SurfaceSampler } from '../src/physics/vehicle';

export const DT = 1 / 120;

/** Flat frictionless-ish road plane for isolated vehicle tests. */
export async function makeWorld(gravity = -9.81) {
  await initRapier();
  const world = new World({ x: 0, y: gravity, z: 0 });
  world.timestep = DT;
  const ground = world.createRigidBody(RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  world.createCollider(ColliderDesc.cuboid(20000, 0.5, 20000).setFriction(1.2), ground);
  return world;
}

export function makeCar(
  world: World,
  id = 'kestrel-gt',
  opts: { assists?: Partial<typeof DEFAULT_SETTINGS.assist>; simDamage?: boolean; surfaceSampler?: SurfaceSampler; upgrades?: Parameters<typeof resolveParams>[1] } = {},
) {
  const spec = getCar(id);
  const params = resolveParams(spec, opts.upgrades ?? blankUpgrades(), defaultTuning());
  const sim = new VehicleSim(world, params, {
    assists: { ...DEFAULT_SETTINGS.assist, ...(opts.assists ?? {}) },
    simDamage: opts.simDamage ?? false,
    position: { x: 0, y: spec.cgHeight + 0.06, z: 0 },
    yaw: 0,
    surfaceSampler: opts.surfaceSampler,
  });
  return sim;
}

export const CTRL = (o: Partial<CarControl> = {}): CarControl => ({
  throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: false, shiftDown: false, ...o,
});

export function run(
  sim: VehicleSim,
  world: World,
  seconds: number,
  control: (t: number, sim: VehicleSim) => CarControl,
  env = DEFAULT_ENVIRONMENT,
) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    sim.step(DT, control(i * DT, sim), env);
    world.step();
  }
  return sim;
}

export function settle(sim: VehicleSim, world: World, seconds = 3) {
  return run(sim, world, seconds, () => CTRL());
}


