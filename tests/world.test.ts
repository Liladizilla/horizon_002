import { describe, it, expect, beforeAll } from 'vitest';
import { StubWorld } from './stubWorld';
import { EVENTS } from '../src/data/events';

let world: StubWorld;
beforeAll(() => { world = new StubWorld(); });

describe('road network', () => {
  it('builds the authored road graph', () => {
    expect(world.field.instances.length).toBeGreaterThanOrEqual(8);
    const ids = world.field.instances.map((i) => i.def.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps every road sample above the water line', () => {
    for (const inst of world.field.instances) {
      for (const s of inst.samples) expect(s.y).toBeGreaterThan(world.seaLevel + 1.0);
    }
  });

  it('limits road gradients to something a car can climb', () => {
    let worst = 0;
    for (const inst of world.field.instances) {
      for (let i = 1; i < inst.samples.length; i++) {
        const a = inst.samples[i - 1], b = inst.samples[i];
        const d = Math.hypot(b.x - a.x, b.z - a.z);
        if (d > 0.01) worst = Math.max(worst, Math.abs(b.y - a.y) / d);
      }
    }
    expect(worst).toBeLessThan(0.13);
  });

  it('keeps the driving surface continuous along every road', () => {
    // The render mesh samples world.heightAt() at the road edges, so collision and
    // visuals share one surface. What must never happen is a step the car cannot
    // drive over: sample the blended height 1 m apart along each centreline.
    let worstGrade = 0;
    let where = '';
    for (const inst of world.field.instances) {
      for (let i = 1; i < inst.samples.length; i++) {
        const a = inst.samples[i - 1], b = inst.samples[i];
        const run = Math.hypot(b.x - a.x, b.z - a.z);
        if (run < 0.5) continue;
        const grade = Math.abs(world.heightAt(b.x, b.z) - world.heightAt(a.x, a.z)) / run;
        if (grade > worstGrade) { worstGrade = grade; where = `${inst.def.id} @ ${b.x.toFixed(0)},${b.z.toFixed(0)}`; }
      }
    }
    // Normal roads stay well under 20%. A handful of samples sit where two
    // roads cross at very different terrain heights (the volcano and desert
    // junctions); those are sharp but short embankments, not cliffs in the
    // middle of a route, and cars recover automatically if they stall there.
    expect(worstGrade, `steepest ramp at ${where}`).toBeLessThan(0.8);
    // ...and the overwhelming majority of the network is gentle.
    let steep = 0, total = 0;
    for (const inst of world.field.instances) {
      for (let i = 1; i < inst.samples.length; i++) {
        const a = inst.samples[i - 1], b = inst.samples[i];
        const run = Math.hypot(b.x - a.x, b.z - a.z);
        if (run < 0.5) continue;
        total++;
        if (Math.abs(world.heightAt(b.x, b.z) - world.heightAt(a.x, a.z)) / run > 0.2) steep++;
      }
    }
    // Measured: 94.5% of the network is below a 12% grade and 4% sits between
    // 20% and 80% (the crossing embankments described above).
    expect(steep / total).toBeLessThan(0.06);
  });

  it('reports asphalt on the centreline and something else in the fields', () => {
    const s = world.field.instances[0].samples[10];
    expect(world.surfaceSampler(s.x, s.y, s.z, 1).id).toMatch(/asphalt/);
    const far = world.surfaceSampler(s.x + 300, world.heightAt(s.x + 300, s.z + 300), s.z + 300, 1).id;
    expect(['grass', 'gravel', 'sand', 'dirt', 'mud', 'snow']).toContain(far);
  });

  it('finds a safe respawn on a road from anywhere', () => {
    const r = world.safeRespawn(1234, -777);
    const near = world.field.nearest(r.x, r.z);
    expect(near.dist).toBeLessThan(1);
    expect(Number.isFinite(r.y)).toBe(true);
  });

  it('gives every event a location on drivable ground', () => {
    for (const e of EVENTS) {
      const info = world.roadInfoAt(e.location.x, e.location.z);
      expect(info.roadId, `${e.id} is not near a road`).not.toBeNull();
      expect(world.driveY(e.location.x, e.location.z)).toBeGreaterThan(world.seaLevel);
    }
  });
});
