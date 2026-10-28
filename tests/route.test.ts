import { describe, it, expect, beforeAll } from 'vitest';
import { StubWorld } from './stubWorld';
import { buildRoute, nearestRouteDistance } from '../src/gameplay/route';
import { EVENTS } from '../src/data/events';

let world: StubWorld;
beforeAll(() => { world = new StubWorld(); });

describe('event routes', () => {
  it('builds a usable route for every event', () => {
    for (const def of EVENTS) {
      const route = buildRoute(world.asWorld(), def);
      expect(route.points.length, `${def.id} has too few points`).toBeGreaterThan(20);
      expect(route.length, `${def.id} is too short`).toBeGreaterThan(300);
      expect(route.gates.length, `${def.id} has too few gates`).toBeGreaterThanOrEqual(8);
      for (const p of route.points) {
        expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z), `${def.id} has a NaN point`).toBe(true);
      }
    }
  });

  it('keeps every gate above the water line and inside the map', () => {
    for (const def of EVENTS) {
      const route = buildRoute(world.asWorld(), def);
      for (const g of route.gates) {
        expect(world.driveY(g.x, g.z), `${def.id} gate under water at ${g.x},${g.z}`).toBeGreaterThan(world.seaLevel);
        expect(Math.abs(g.x)).toBeLessThan(2048);
        expect(Math.abs(g.z)).toBeLessThan(2048);
        expect(Math.hypot(g.dirX, g.dirZ)).toBeCloseTo(1, 3);
        expect(g.width).toBeGreaterThan(4);
      }
    }
  });

  it('spaces gates evenly and in order along the route', () => {
    const route = buildRoute(world.asWorld(), EVENTS.find((e) => e.id === 'festival-circuit')!);
    let prev = -1;
    for (const g of route.gates) {
      // distance from the start, measured along the polyline
      let best = Infinity, bestS = 0, s = 0;
      for (let i = 1; i < route.points.length; i++) {
        const a = route.points[i - 1], b = route.points[i];
        s += Math.hypot(b.x - a.x, b.z - a.z);
        const d = Math.hypot(b.x - g.x, b.z - g.z);
        if (d < best) { best = d; bestS = s; }
      }
      expect(best).toBeLessThan(12);
      expect(bestS).toBeGreaterThanOrEqual(prev - 1);
      prev = bestS;
    }
    expect(route.gates.length).toBeGreaterThan(20);
  });

  it('starts the car on the route facing the right way', () => {
    for (const def of EVENTS) {
      const route = buildRoute(world.asWorld(), def);
      const first = route.gates[0];
      const yawToNext = Math.atan2(route.points[6].x - route.points[0].x, route.points[6].z - route.points[0].z);
      expect(Math.abs(Math.atan2(first.dirX, first.dirZ) - yawToNext)).toBeLessThan(0.8);
      const delta = Math.abs(route.startYaw - yawToNext);
      expect(Math.min(delta, Math.abs(delta - Math.PI * 2))).toBeLessThan(0.4);
    }
  });

  it('measures distance from the route centreline', () => {
    const route = buildRoute(world.asWorld(), EVENTS[0]);
    const p = route.points[10];
    expect(nearestRouteDistance(route, p.x, p.z).dist).toBeLessThan(2);
    expect(nearestRouteDistance(route, p.x + 500, p.z + 500).dist).toBeGreaterThan(100);
  });
});
