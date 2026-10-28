import { describe, it, expect, beforeAll } from 'vitest';
import { StubWorld, fakeActor } from './stubWorld';
import { RaceSession, ChallengeSession } from '../src/gameplay/race';
import { EVENT_BY_ID } from '../src/data/events';
import type { VehicleActor } from '../src/gameplay/vehicleActor';
import * as THREE from 'three';

let world: StubWorld;
beforeAll(() => { world = new StubWorld(); });

const racers = [
  { id: 'player', name: 'You', isPlayer: true },
  { id: 'ai0', name: 'A. Vega', isPlayer: false },
  { id: 'ai1', name: 'M. Okoro', isPlayer: false },
];

/** Drives a fake car along the route polyline at a fixed speed. */
function walker(race: RaceSession, speed: number) {
  const pts = race.route.points;
  const actor = fakeActor(new THREE.Vector3(pts[0].x, 0, pts[0].z), { speedMs: speed });
  const g0 = race.route.gates[0];
  // Start 15 m behind the line so the first gate plane can be crossed.
  actor.position.set(pts[0].x - g0.dirX * 15, 0, pts[0].z - g0.dirZ * 15);
  let i = 0, t = 0;
  return {
    actor,
    step(dt: number) {
      const a = pts[i % pts.length], b = pts[(i + 1) % pts.length];
      const seg = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      t += (speed * dt) / seg;
      while (t >= 1) { t -= 1; i++; }
      const p = pts[i % pts.length], q = pts[(i + 1) % pts.length];
      actor.position.set(p.x + (q.x - p.x) * t, 0, p.z + (q.z - p.z) * t);
      const yaw = Math.atan2(q.x - p.x, q.z - p.z);
      actor.curQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    },
  };
}

describe('race session', () => {
  it('runs a countdown before the clock starts', () => {
    const race = new RaceSession(EVENT_BY_ID['festival-circuit'], world.asWorld(), racers);
    expect(race.state).toBe('countdown');
    for (let i = 0; i < 120; i++) race.update(1 / 120, new Map());
    expect(race.state).toBe('countdown');
    for (let i = 0; i < 400; i++) race.update(1 / 120, new Map());
    expect(race.state).toBe('running');
    expect(race.time).toBeGreaterThan(0);
  });

  it('detects gate crossings at 150 km/h without skipping checkpoints', () => {
    const race = new RaceSession(EVENT_BY_ID['festival-circuit'], world.asWorld(), racers);
    race.countdown = 0;
    race.update(1 / 120, new Map());
    const w = walker(race, 42);
    const map = new Map<string, VehicleActor>([['player', w.actor as unknown as VehicleActor]]);
    const seen: number[] = [];
    for (let i = 0; i < 120 * 40; i++) {
      w.step(1 / 120);
      race.update(1 / 120, map);
      const gate = race.progress.get('player')!.gate;
      if (seen[seen.length - 1] !== gate) seen.push(gate);
    }
    expect(seen.length).toBeGreaterThan(4);
    // Gates are hit in order with no jumps (a skipped gate would show as +2).
    for (let i = 1; i < seen.length; i++) {
      const d = seen[i] - seen[i - 1];
      expect(d === 1 || d < 0, `gate jumped by ${d}`).toBe(true);
    }
    expect(race.progress.get('player')!.totalTime).toBeCloseTo(40, 0);
  });

  it('orders racers by route progress', () => {
    const race = new RaceSession(EVENT_BY_ID['festival-circuit'], world.asWorld(), racers);
    race.countdown = 0;
    const fast = walker(race, 45), mid = walker(race, 30), slow = walker(race, 12);
    const map = new Map<string, VehicleActor>([
      ['player', mid.actor as unknown as VehicleActor],
      ['ai0', fast.actor as unknown as VehicleActor],
      ['ai1', slow.actor as unknown as VehicleActor],
    ]);
    for (let i = 0; i < 120 * 30; i++) {
      fast.step(1 / 120); mid.step(1 / 120); slow.step(1 / 120);
      race.update(1 / 120, map);
    }
    const order = race.standings().map((s) => s.id);
    expect(order).toEqual(['ai0', 'player', 'ai1']);
    expect(race.playerPosition()).toBe(2);
    expect(race.progress.get('ai0')!.progress).toBeGreaterThan(race.progress.get('player')!.progress);
  });

  it('finishes a solo racer and publishes results', () => {
    const race = new RaceSession(EVENT_BY_ID['festival-sprint'], world.asWorld(), [{ id: 'player', name: 'You', isPlayer: true }]);
    race.countdown = 0;
    const w = walker(race, 60);
    const map = new Map<string, VehicleActor>([['player', w.actor as unknown as VehicleActor]]);
    for (let i = 0; i < 120 * 120 && race.state !== 'finished'; i++) {
      w.step(1 / 120);
      race.update(1 / 120, map);
    }
    expect(race.state).toBe('finished');
    expect(race.progress.get('player')!.finished).toBe(true);
    expect(race.results.length).toBe(1);
    expect(race.results[0].position).toBe(1);
    const hud = race.hud();
    expect(hud.total).toBe(1);
    expect(hud.time).toBeGreaterThan(0);
  });

  it('flags a car driving the wrong way', () => {
    const race = new RaceSession(EVENT_BY_ID['festival-circuit'], world.asWorld(), racers);
    race.countdown = 0;
    const actor = fakeActor(new THREE.Vector3(race.route.gates[0].x, 0, race.route.gates[0].z), { speedMs: 20 });
    // Face against the route direction.
    actor.curQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-race.route.gates[0].dirX, -race.route.gates[0].dirZ));
    const map = new Map<string, VehicleActor>([['player', actor as unknown as VehicleActor]]);
    for (let i = 0; i < 30; i++) race.update(1 / 60, map);
    expect(race.progress.get('player')!.wrongWay).toBe(true);
    expect(race.hud().objective).toBe('WRONG WAY');
  });
});

describe('challenge sessions', () => {
  it('scores a drift challenge inside the zone', () => {
    const ch = new ChallengeSession(EVENT_BY_ID['drift-zone'], world.asWorld());
    const start = ch.route.points[0];
    const actor = fakeActor(new THREE.Vector3(start.x, 0, start.z), { speedMs: 20 });
    Object.assign(actor.sim.readout, { drifting: true, driftScoreRate: 120, speedKmh: 72, wheelsAirborne: 0 });
    for (let i = 0; i < 120; i++) ch.update(1 / 120, actor as unknown as VehicleActor);
    expect(ch.state.score).toBeGreaterThan(50);
    expect(ch.state.message).toBe('DRIFT ZONE');
  });

  it('times out when the clock runs out', () => {
    const ch = new ChallengeSession(EVENT_BY_ID['speed-trap'], world.asWorld());
    const actor = fakeActor(new THREE.Vector3(9999, 0, 9999));
    for (let i = 0; i < 120 * 95; i++) ch.update(1 / 120, actor as unknown as VehicleActor);
    expect(ch.state.active).toBe(false);
    expect(ch.success).toBe(false);
  });
});
