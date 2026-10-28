import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { makeWorld, makeCar, CTRL } from './harness';
import { AIDriver } from '../src/gameplay/ai';
import type { Route } from '../src/gameplay/route';
import { StubWorld } from './stubWorld';
import type { VehicleActor } from '../src/gameplay/vehicleActor';

const DT = 1 / 120;

/** A closed loop of road, 6 m sampled, on flat ground 300 m from the origin. */
function syntheticRoute(): Route {
  const points = [];
  const cx = 0, cz = 1400;
  const radius = 120;
  for (let i = 0; i < 126; i++) {
    const a = (i / 126) * Math.PI * 2;
    points.push({ x: cx + Math.cos(a) * radius, y: 0, z: cz + Math.sin(a) * radius });
  }
  const gates = points.filter((_, i) => i % 31 === 0).map((p, i) => ({
    x: p.x, y: 0, z: p.z,
    dirX: -Math.sin((i * 31 / 126) * Math.PI * 2), dirZ: Math.cos((i * 31 / 126) * Math.PI * 2),
    width: 12, index: i,
  }));
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  return { points, gates, length, start: points[0], startYaw: Math.PI / 2, isLoop: true };
}

let stub: StubWorld;
beforeAll(() => { stub = new StubWorld(); });

describe('AI driver', () => {
  it('drives a closed circuit on its own physics', async () => {
    const world = await makeWorld();
    const sim = makeCar(world, 'kestrel-gt');
    const route = syntheticRoute();
    const driver = new AIDriver({ skill: 0.9, aggression: 0.5, laneBias: 0, reactionTime: 0.05 });
    driver.setRoute(route);
    sim.resetTo(route.points[0].x, 0.6, route.points[0].z, Math.PI / 2);
    await new Promise((r) => setTimeout(r, 0));

    // The driver only needs position/quaternion/readout, so a thin stand-in is
    // enough to exercise exactly the code the game runs.
    const actor = {
      position: new THREE.Vector3(route.points[0].x, 0.6, route.points[0].z),
      curQuat: new THREE.Quaternion(),
      sim,
      controls: CTRL(),
    } as unknown as VehicleActor;

    let maxSpeed = 0, offRoute = 0;
    for (let i = 0; i < 120 * 45; i++) {
      actor.position.set(sim.body.translation().x, sim.body.translation().y, sim.body.translation().z);
      const q = sim.body.rotation();
      actor.curQuat.set(q.x, q.y, q.z, q.w);
      sim.step(DT, driver.update(DT, actor, stub.asWorld(), []), {
        gravity: 9.81, airDensity: 1.225, windX: 0, windZ: 0, wetness: 0,
        ambientTempC: 22, enableTireTemp: true, enableTireWear: false,
      });
      world.step();
      maxSpeed = Math.max(maxSpeed, sim.readout.speedKmh);
      const p = sim.body.translation();
      const d = Math.abs(Math.hypot(p.x - 0, p.z - 1400) - 120);
      if (d > 14) offRoute++;
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
    // It has to actually drive, stay on the road and finish without NaN.
    expect(maxSpeed).toBeGreaterThan(60);
    expect(offRoute / (120 * 45)).toBeLessThan(0.25);
  });

  it('brakes for corners instead of holding full throttle', async () => {
    const world = await makeWorld();
    const sim = makeCar(world, 'kestrel-gt');
    const route = syntheticRoute();
    const driver = new AIDriver({ skill: 0.95, aggression: 0.2, laneBias: 0, reactionTime: 0.02 });
    driver.setRoute(route);
    sim.resetTo(route.points[0].x, 0.6, route.points[0].z, Math.PI / 2);
    const actor = {
      position: new THREE.Vector3(route.points[0].x, 0.6, route.points[0].z),
      curQuat: new THREE.Quaternion(), sim, controls: CTRL(),
    } as unknown as VehicleActor;
    let sawBrake = false, sawLift = false;
    for (let i = 0; i < 120 * 40; i++) {
      actor.position.set(sim.body.translation().x, sim.body.translation().y, sim.body.translation().z);
      const q = sim.body.rotation();
      actor.curQuat.set(q.x, q.y, q.z, q.w);
      const c = driver.update(DT, actor, stub.asWorld(), []);
      if (c.brake > 0.05) sawBrake = true;
      if (c.throttle < 0.5) sawLift = true;
      sim.step(DT, c, {
        gravity: 9.81, airDensity: 1.225, windX: 0, windZ: 0, wetness: 0,
        ambientTempC: 22, enableTireTemp: true, enableTireWear: false,
      });
      world.step();
    }
    expect(sawLift || sawBrake).toBe(true);
    expect(sim.readout.speedKmh).toBeGreaterThan(30);
  });
});
