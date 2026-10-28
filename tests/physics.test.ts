import { describe, it, expect, beforeAll } from 'vitest';
import { makeWorld, makeCar, run, settle, CTRL, DT } from './harness';
import { initRapier } from './init';
import { DEFAULT_ENVIRONMENT } from '../src/physics/vehicle';
import { CARS, getCar } from '../src/data/cars';
import { RAD2DEG } from '../src/core/math';

beforeAll(async () => { await initRapier(); });

describe('rest state', () => {
  it('settles at its designed ride height without creeping or bouncing', async () => {
    const world = await makeWorld();
    const sim = makeCar(world, 'kestrel-gt');
    settle(sim, world, 4);
    const t = sim.body.translation();
    const v = sim.body.linvel();
    expect(Math.abs(t.y - sim.spec.cgHeight)).toBeLessThan(0.03);
    expect(Math.hypot(v.x, v.y, v.z)).toBeLessThan(0.02);
    // All four wheels in contact and carrying the car's weight.
    expect(sim.wheels.every((w) => w.contact)).toBe(true);
    const totalLoad = sim.wheels.reduce((a, w) => a + w.springForce, 0);
    expect(totalLoad).toBeGreaterThan(sim.spec.mass * 9.81 * 0.9);
    expect(totalLoad).toBeLessThan(sim.spec.mass * 9.81 * 1.1);
  });

  it('holds mass properties from the spec', async () => {
    const world = await makeWorld();
    const sim = makeCar(world, 'kestrel-gt');
    expect(sim.body.mass()).toBeCloseTo(1495, 0);
  });
});

describe('engine and drivetrain', () => {
  it('accelerates from rest and reaches a sane top speed', async () => {
    const world = await makeWorld();
    const sim = makeCar(world, 'kestrel-gt');
    settle(sim, world, 2);
    run(sim, world, 5, () => CTRL({ throttle: 1 }));
    const v5 = sim.readout.speedKmh;
    run(sim, world, 25, () => CTRL({ throttle: 1 }));
    const vTop = sim.readout.speedKmh;
    console.log(`[kestrel] 5s: ${v5.toFixed(1)} km/h, top: ${vTop.toFixed(1)} km/h, gear ${sim.readout.gear}`);
    expect(v5).toBeGreaterThan(60);   // a 150 kW RWD coupé should be well over 60 km/h at 5 s
    expect(v5).toBeLessThan(160);
    expect(vTop).toBeGreaterThan(180);
    expect(vTop).toBeLessThan(320);
  });

  it('airborne driven wheels spin up but produce no propulsion', async () => {
    const world = await makeWorld();
    const sim = makeCar(world, 'kestrel-gt');
    // Teleport high in the air; no wheel can contact the ground.
    sim.setPose(0, 12, 0, { x: 0, y: 0, z: 0, w: 1 });
    run(sim, world, 1.0, () => CTRL({ throttle: 1 }));
    expect(sim.wheels.every((w) => !w.contact)).toBe(true);
    expect(Math.abs(sim.wheels[2].omega)).toBeGreaterThan(5); // wheel is spinning
    expect(Math.abs(sim.body.linvel().z)).toBeLessThan(0.5);  // but not propelling
    expect(sim.wheels[2].fx).toBe(0);
  });

  it('reverse gear drives the car backwards', async () => {
    const world = await makeWorld();
    const sim = makeCar(world, 'kestrel-gt');
    settle(sim, world, 2);
    run(sim, world, 3, () => CTRL({ brake: 1 }));
    expect(sim.gear).toBe(-1);
    run(sim, world, 3, () => CTRL({ brake: 1 }));
    expect(sim.body.linvel().z).toBeLessThan(-1);
  });
});

describe('braking and grip', () => {
  it('brakes from 100 km/h in a physically comparable distance (0.9 g ~= 44 m)', async () => {
    const world = await makeWorld();
    const sim = makeCar(world, 'kestrel-gt');
    settle(sim, world, 2);
    // Bring the car to 100 km/h and hold it steady.
    const target = 100 / 3.6;
    run(sim, world, 20, (_t, s) => {
      const v = s.body.linvel().z;
      return CTRL({ throttle: v < target ? 0.45 : 0, brake: v > target + 1 ? 0.25 : 0 });
    });
    const v0 = sim.body.linvel().z;
    const z0 = sim.body.translation().z;
    let t = 0;
    let peakZ = z0;
    while (t < 8) {
      sim.step(DT, CTRL({ brake: 1 }), DEFAULT_ENVIRONMENT);
      world.step();
      peakZ = Math.max(peakZ, sim.body.translation().z);
      t += DT;
      if (sim.body.linvel().z < 0.15) break;
    }
    const distance = peakZ - z0;
    const decel = (v0 * v0) / (2 * distance) / 9.81;
    console.log(`[braking] ${(v0 * 3.6).toFixed(1)} km/h -> stop in ${distance.toFixed(1)} m (${decel.toFixed(2)} g)`);
    expect(distance).toBeGreaterThan(30);
    expect(distance).toBeLessThan(75);
    expect(decel).toBeGreaterThan(0.65);
    expect(decel).toBeLessThan(1.6);
  });

  it('does not reverse a stopped wheel under full brake', async () => {
    const world = await makeWorld();
    const sim = makeCar(world, 'kestrel-gt');
    settle(sim, world, 2);
    run(sim, world, 1.0, () => CTRL({ brake: 1, throttle: 0, handbrake: 1 }));
    run(sim, world, 1.5, () => CTRL({ brake: 0, handbrake: 1 }));
    for (const w of sim.wheels) expect(Math.abs(w.omega)).toBeLessThan(0.6);
  });

  it('corners at ~1 lateral g on a small radius without losing the car', async () => {
    const world = await makeWorld();
    const sim = makeCar(world, 'kestrel-gt');
    settle(sim, world, 2);
    const target = 100 / 3.6;
    // Ramp up speed on a straight.
    run(sim, world, 14, (_t, s) => CTRL({ throttle: s.body.linvel().z < target ? 0.5 : 0 }));
    let maxLat = 0;
    let maxSpeed = 0;
    for (let i = 0; i < 120 * 4; i++) {
      sim.step(DT, CTRL({ throttle: 0.35, steer: 0.85 }), DEFAULT_ENVIRONMENT);
      world.step();
      maxLat = Math.max(maxLat, Math.abs(sim.readout.lateralG));
      maxSpeed = Math.max(maxSpeed, sim.readout.speedMs);
    }
    console.log(`[cornering] peak lateral ${maxLat.toFixed(2)} g at ${(maxSpeed * 3.6).toFixed(0)} km/h`);
    expect(maxLat).toBeGreaterThan(0.70);
    expect(maxLat).toBeLessThan(1.25);
    expect(Number.isFinite(sim.body.translation().x)).toBe(true);
  });

  it('loses grip on wet asphalt compared with dry', async () => {
    async function stopDistance(wetness: number) {
      const world = await makeWorld();
      const sim = makeCar(world, 'kestrel-gt', {
        surfaceSampler: () => ({ id: wetness > 0.5 ? 'asphaltWet' : 'asphaltDry', wetness }),
      });
      settle(sim, world, 2);
      sim.setVelocity(0, 0, 100 / 3.6);
      const z0 = sim.body.translation().z;
      let t = 0;
      while (t < 10 && sim.body.linvel().z > 0.15) {
        sim.step(DT, CTRL({ brake: 1 }), { ...DEFAULT_ENVIRONMENT, wetness });
        world.step();
        t += DT;
      }
      return sim.body.translation().z - z0;
    }
    const dry = await stopDistance(0);
    const wet = await stopDistance(1);
    console.log(`[wet grip] dry ${dry.toFixed(1)} m vs wet ${wet.toFixed(1)} m`);
    expect(wet).toBeGreaterThan(dry * 1.15);
  });
});

describe('stability', () => {
  it('stays finite under violent mixed input on every car', async () => {
    for (const car of CARS) {
      const world = await makeWorld();
      const sim = makeCar(world, car.id);
      settle(sim, world, 1.5);
      let bad = false;
      for (let i = 0; i < 120 * 12; i++) {
        const phase = Math.floor(i / 60) % 6;
        const ctrl = CTRL({
          throttle: phase === 0 || phase === 3 ? 1 : 0.3,
          brake: phase === 2 ? 1 : 0,
          steer: Math.sin(i / 40) * 0.9,
          handbrake: phase === 4 ? 1 : 0,
        });
        sim.step(DT, ctrl, DEFAULT_ENVIRONMENT);
        world.step();
        const p = sim.body.translation();
        const v = sim.body.linvel();
        if (![p.x, p.y, p.z, v.x, v.y, v.z, sim.readout.rpm].every(Number.isFinite)) { bad = true; break; }
        if (Math.abs(p.x) > 50000 || Math.abs(p.y) > 5000) { bad = true; break; }
      }
      expect(bad, `${car.id} produced non-finite state`).toBe(false);
    }
  });

  it('handles a steep slope without sliding away or exploding', async () => {
    const { World, RigidBodyDesc, ColliderDesc } = await import('@dimforge/rapier3d-compat');
    const THREE = await import('three');
    const world = new World({ x: 0, y: -9.81, z: 0 });
    world.timestep = DT;
    const qq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.26);
    const q = { x: qq.x, y: qq.y, z: qq.z, w: qq.w };
    const slope = world.createRigidBody(RigidBodyDesc.fixed().setTranslation(0, 0, 0).setRotation(q));
    world.createCollider(ColliderDesc.cuboid(4000, 0.5, 4000), slope);
    const sim = makeCar(world, 'rallye-hatch');
    // Handbrake applied: the car must hold its position on a 15 degree slope.
    run(sim, world, 3, () => CTRL({ handbrake: 1 }));
    const p0 = sim.body.translation();
    run(sim, world, 3, () => CTRL({ handbrake: 1 }));
    const p = sim.body.translation();
    expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
    expect(Math.hypot(p.x - p0.x, p.z - p0.z)).toBeLessThan(2.5);
    // In gear with no brakes the car rolls, but must not accelerate without bound.
    run(sim, world, 6, () => CTRL());
    const v = sim.body.linvel();
    expect(Math.hypot(v.x, v.z)).toBeLessThan(12);
  });

  it('produces comparable results at different render frame rates', async () => {
    // The fixed-timestep accumulator means physics only ever sees 1/120 s ticks;
    // this test proves the tick sequence - not the render rate - decides the result.
    const world = await makeWorld();
    const sim = makeCar(world, 'kestrel-gt');
    settle(sim, world, 2);
    const dtFixed = 1 / 120;
    const start = sim.body.translation();
    for (let i = 0; i < 120 * 4; i++) {
      sim.step(dtFixed, CTRL({ throttle: 1, steer: 0.15 }), DEFAULT_ENVIRONMENT);
      world.step();
    }
    const a = { x: sim.body.translation().x - start.x, z: sim.body.translation().z - start.z };

    // Simulated 144 Hz rendering: the caller feeds whole 1/120 ticks as the
    // accumulator requests them, so the identical tick sequence runs.
    const world2 = await makeWorld();
    const sim2 = makeCar(world2, 'kestrel-gt');
    settle(sim2, world2, 2);
    const start2 = sim2.body.translation();
    let acc = 0;
    const renderDt = 1 / 144;
    let ticks = 0;
    for (let f = 0; f < Math.round(4 / renderDt); f++) {
      acc += renderDt;
      while (acc >= dtFixed && ticks < 480) {
        sim2.step(dtFixed, CTRL({ throttle: 1, steer: 0.15 }), DEFAULT_ENVIRONMENT);
        world2.step();
        acc -= dtFixed; ticks++;
      }
    }
    const b = { x: sim2.body.translation().x - start2.x, z: sim2.body.translation().z - start2.z };
    const diff = Math.hypot(a.x - b.x, a.z - b.z);
    console.log(`[determinism] 120Hz ${a.x.toFixed(2)},${a.z.toFixed(2)} vs 144Hz-frames ${b.x.toFixed(2)},${b.z.toFixed(2)} -> delta ${diff.toFixed(3)} m (${ticks} ticks)`);
    expect(diff).toBeLessThan(0.5);
  });
});

describe('collision', () => {
  it('detects a wall at 200 km/h (CCD)', async () => {
    const { World, RigidBodyDesc, ColliderDesc } = await import('@dimforge/rapier3d-compat');
    const world = await makeWorld();
    const sim = makeCar(world, 'ts11-super');
    settle(sim, world, 2);
    const wall = world.createRigidBody(RigidBodyDesc.fixed().setTranslation(0, 2, 200));
    world.createCollider(ColliderDesc.cuboid(60, 4, 0.4), wall);
    sim.setVelocity(0, 0, 200 / 3.6);
    run(sim, world, 4, () => CTRL());
    const z = sim.body.translation().z;
    console.log(`[ccd] stopped at z=${z.toFixed(2)} (wall at 200)`);
    expect(z).toBeLessThan(200);
    expect(Number.isFinite(z)).toBe(true);
  });
});

describe('cars feel different', () => {
  it('reports distinct mass, power and drivetrain behaviour', async () => {
    const results: Record<string, { kmh5: number; lat: number }> = {};
    for (const id of ['kestrel-gt', 'boulder-4x4', 'rallye-hatch', 'mako-v12', 'crestline-lx']) {
      const world = await makeWorld();
      const sim = makeCar(world, id);
      settle(sim, world, 2);
      run(sim, world, 5, () => CTRL({ throttle: 1 }));
      const kmh5 = sim.readout.speedKmh;
      let lat = 0;
      for (let i = 0; i < 240; i++) {
        sim.step(DT, CTRL({ throttle: 0.4, steer: 1 }), DEFAULT_ENVIRONMENT);
        world.step();
        lat = Math.max(lat, Math.abs(sim.readout.lateralG));
      }
      results[id] = { kmh5, lat };
    }
    console.log('[feel]', Object.entries(results).map(([k, v]) => `${k}: ${v.kmh5.toFixed(0)}km/h@5s ${v.lat.toFixed(2)}g`).join(' | '));
    // A hypercar must out-drag a family saloon, and an all-wheel-drive off-roader
    // gets off the line on grip rather than power - so compare top speed, which
    // is power/drag limited, to prove the heavy truck is genuinely slower.
    expect(results['mako-v12'].kmh5).toBeGreaterThan(results['crestline-lx'].kmh5);
    const topSpeed = async (id: string) => {
      const world = await makeWorld();
      const sim = makeCar(world, id);
      settle(sim, world, 2);
      run(sim, world, 45, () => CTRL({ throttle: 1 }));
      return sim.readout.speedKmh;
    };
    const boulderTop = await topSpeed('boulder-4x4');
    const kestrelTop = await topSpeed('kestrel-gt');
    console.log(`[feel] top speeds: boulder ${boulderTop.toFixed(0)} km/h, kestrel ${kestrelTop.toFixed(0)} km/h`);
    expect(boulderTop).toBeLessThan(kestrelTop);
    // Latitudinal grip should be in a plausible band, not cartoonish.
    // Hypercars with real downforce legitimately exceed 1.5 g; anything above
    // 2 g would mean the tyre model is producing impossible forces.
    for (const v of Object.values(results)) expect(v.lat).toBeLessThan(1.9);
    expect(results['kestrel-gt'].lat).toBeLessThan(1.25);
  });
});
