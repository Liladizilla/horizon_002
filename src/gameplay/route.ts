import type { GameWorld } from '../world/world';
import type { EventDef } from '../data/events';

export interface RoutePoint { x: number; y: number; z: number }
export interface RouteGate { x: number; y: number; z: number; dirX: number; dirZ: number; width: number; index: number }

export interface Route {
  points: RoutePoint[];
  gates: RouteGate[];
  length: number;
  start: RoutePoint;
  startYaw: number;
  isLoop: boolean;
}

function densify(points: RoutePoint[], step: number): RoutePoint[] {
  if (points.length < 2) return points.slice();
  const out: RoutePoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.round(d / step));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return out;
}

/**
 * Builds the driving route for an event from the road network.
 * Circuits follow a single closed road; sprints path through the road graph.
 */
export function buildRoute(world: GameWorld, def: EventDef): Route {
  const inst = world.field.instances.find((i) => i.def.id === def.roadId) ?? world.field.instances[0];
  const samples = inst.samples;
  let points: RoutePoint[] = [];

  if (def.type === 'circuit' || (inst.def.closed && def.type !== 'sprint')) {
    const startIdx = Math.floor(def.startFraction * samples.length) % samples.length;
    const count = Math.max(8, Math.floor(def.lengthFraction * samples.length));
    for (let k = 0; k <= count; k++) {
      const s = samples[(startIdx + k) % samples.length];
      points.push({ x: s.x, y: s.y, z: s.z });
    }
  } else {
    const startIdx = Math.floor(def.startFraction * samples.length);
    const startSample = samples[Math.min(startIdx, samples.length - 1)];
    const destInst = def.toRoadId ? world.field.instances.find((i) => i.def.id === def.toRoadId) : null;
    const destSample = destInst ? destInst.samples[destInst.samples.length - 1] : samples[samples.length - 1];
    const path = world.graph.findPath(startSample, destSample);
    if (path.length > 1) {
      points = world.graph.pathToPoints(path);
    } else {
      // Fall back to following the road itself.
      for (let k = startIdx; k < samples.length; k++) points.push({ x: samples[k].x, y: samples[k].y, z: samples[k].z });
      if (destInst) for (const s of destInst.samples) points.push({ x: s.x, y: s.y, z: s.z });
    }
  }

  // A sprint whose source and destination roads meet at the same junction can
  // produce a degenerate path (a few metres). In that case author the stage
  // explicitly: run the source road to the junction, then the destination road
  // away from it, so the event is a real point-to-point.
  const polyLength = (pts: RoutePoint[]) => {
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    return d;
  };
  if (polyLength(points) < 400) {
    const destInst2 = def.toRoadId ? world.field.instances.find((i) => i.def.id === def.toRoadId) : null;
    const destSamples = (destInst2 ?? inst).samples;
    const anchor = destSamples[destSamples.length - 1] ?? samples[samples.length - 1];
    const nearestIdx = (list: typeof samples, pt: { x: number; z: number }) => {
      let best = Infinity, bi = 0;
      list.forEach((s, i) => {
        const d = (s.x - pt.x) ** 2 + (s.z - pt.z) ** 2;
        if (d < best) { best = d; bi = i; }
      });
      return bi;
    };
    const jIdx = nearestIdx(samples, anchor);
    // Walk the source road from its far end towards the junction.
    const srcOrder = jIdx < samples.length / 2 ? samples.slice().reverse() : samples.slice();
    const srcEnd = nearestIdx(srcOrder, anchor);
    const stageA = srcOrder.slice(0, Math.min(srcOrder.length, srcEnd + 1));
    const stageB: typeof samples = [];
    if (destInst2) {
      const dJ = nearestIdx(destSamples, samples[jIdx]);
      const destOrder = dJ < destSamples.length / 2 ? destSamples.slice().reverse() : destSamples.slice();
      const startCut = nearestIdx(destOrder, samples[jIdx]);
      stageB.push(...destOrder.slice(startCut));
    }
    points = [...stageA, ...stageB].map((s) => ({ x: s.x, y: s.y, z: s.z }));
  }

  points = densify(points, 6);
  if (points.length < 2) {
    points = [{ x: def.location.x, y: world.heightAt(def.location.x, def.location.z), z: def.location.z },
      { x: def.location.x + 100, y: world.heightAt(def.location.x + 100, def.location.z), z: def.location.z }];
  }

  // Cumulative length and gates.
  let length = 0;
  const cum: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    cum.push(length);
  }
  const gateCount = Math.max(3, Math.round(length / def.checkpointSpacing));
  const gates: RouteGate[] = [];
  for (let g = 0; g < gateCount; g++) {
    const target = (g / gateCount) * length;
    let idx = 1;
    while (idx < cum.length - 1 && cum[idx] < target) idx++;
    const p = points[idx];
    const next = points[Math.min(idx + 3, points.length - 1)];
    const prev = points[Math.max(0, idx - 1)];
    const dx = next.x - prev.x, dz = next.z - prev.z;
    const len = Math.hypot(dx, dz) || 1;
    gates.push({ x: p.x, y: p.y, z: p.z, dirX: dx / len, dirZ: dz / len, width: 26, index: g });
  }

  const startPoint = points[0];
  const look = points[Math.min(4, points.length - 1)];
  const startYaw = Math.atan2(look.x - startPoint.x, look.z - startPoint.z);

  return { points, gates, length, start: startPoint, startYaw, isLoop: inst.def.closed && def.type !== 'sprint' };
}

/** Distance along a route to the nearest point (used for progress fallbacks). */
export function nearestRouteDistance(route: Route, x: number, z: number): { index: number; dist: number } {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < route.points.length; i++) {
    const p = route.points[i];
    const d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return { index: best, dist: Math.sqrt(bestD) };
}
