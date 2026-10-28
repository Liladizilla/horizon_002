import { clamp, smoothstep, lerp } from '../core/math';
import type { SurfaceId } from '../core/types';
import { baseHeight, WORLD_SIZE, SEA_LEVEL } from './terrain';

export interface RoadDef {
  id: string;
  name: string;
  closed: boolean;
  surface: SurfaceId;
  width: number;          // metres, full width
  speedLimit: number;     // km/h, used for traffic and AI targets
  /** Catmull-Rom control points [x, z] */
  points: [number, number][];
  /** 0 = smooth highway, 1 = twisty */
  curviness: number;
}

/**
 * The authored road network. Junctions are created automatically wherever two
 * roads come within `JUNCTION_RADIUS` of each other, so the graph is always
 * connected exactly where the geometry meets.
 */
export const ROADS: RoadDef[] = [
  {
    id: 'festival-loop', name: 'Festival Circuit', closed: true, surface: 'asphaltDry', width: 11, speedLimit: 140, curviness: 0.5,
    points: [[80, 250], [430, 300], [700, 120], [660, -180], [380, -360], [40, -330], [-330, -230], [-560, 60], [-430, 330], [-120, 420]],
  },
  {
    id: 'coast-highway', name: 'Costa Highway', closed: false, surface: 'asphaltDry', width: 13, speedLimit: 180, curviness: 0.25,
    points: [[-560, 60], [-800, 480], [-1150, 620], [-1420, 420], [-1520, 60], [-1480, -320], [-1250, -620], [-900, -700], [-700, -640]],
  },
  {
    id: 'mountain-pass', name: 'Sierra Pass', closed: false, surface: 'asphaltDry', width: 10, speedLimit: 110, curviness: 0.85,
    points: [[-700, -640], [-420, -760], [-180, -720], [60, -900], [330, -1080], [560, -980], [700, -1180], [900, -1320], [1150, -1240], [1300, -1050]],
  },
  {
    id: 'desert-highway', name: 'Dune Highway', closed: false, surface: 'asphaltDry', width: 13, speedLimit: 200, curviness: 0.15,
    points: [[1300, -1050], [1480, -700], [1560, -300], [1500, 120], [1330, 470], [1100, 700], [820, 830]],
  },
  {
    id: 'farm-road', name: 'Valle Farm Road', closed: false, surface: 'asphaltDry', width: 9, speedLimit: 100, curviness: 0.55,
    points: [[-800, 480], [-880, 800], [-780, 1150], [-600, 1420], [-330, 1520], [-60, 1430], [140, 1250]],
  },
  {
    id: 'town-link', name: 'Avenida del Festival', closed: false, surface: 'asphaltDry', width: 10, speedLimit: 90, curviness: 0.4,
    points: [[140, 1250], [240, 900], [220, 620], [80, 420], [80, 250]],
  },
  {
    id: 'jungle-trail', name: 'Selva Trail', closed: false, surface: 'dirt', width: 7, speedLimit: 70, curviness: 0.9,
    points: [[-700, -640], [-950, -800], [-1180, -900], [-1420, -700], [-1500, -420], [-1480, -320]],
  },
  {
    id: 'rally-loop', name: 'Barro Rally Loop', closed: true, surface: 'gravel', width: 8, speedLimit: 90, curviness: 0.8,
    points: [[820, 830], [1080, 1080], [1420, 1150], [1660, 860], [1520, 560], [1180, 520], [940, 660]],
  },
  {
    id: 'canyon-track', name: 'Cañón Gravel', closed: false, surface: 'dirt', width: 8, speedLimit: 80, curviness: 0.75,
    points: [[1560, -300], [1720, -560], [1680, -860], [1480, -1080], [1300, -1050]],
  },
];

const JUNCTION_RADIUS = 34;

export interface RoadSample {
  x: number; z: number; y: number;
  dx: number; dz: number;      // unit tangent
  width: number;
  surface: SurfaceId;
  roadId: string;
  s: number;                   // distance along the road
  index: number;               // index within the road
}

export interface RoadInstance {
  def: RoadDef;
  samples: RoadSample[];
  length: number;
}

function catmullRom(p0: number[], p1: number[], p2: number[], p3: number[], t: number): number {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
}

/** Resample a road into evenly spaced centreline samples. */
export function buildRoadInstance(def: RoadDef, step = 5): RoadInstance {
  const pts = def.points.map(([x, z]) => [x, z]);
  const n = pts.length;
  const ctrl: number[][] = [];
  if (def.closed) {
    for (let i = 0; i < n; i++) ctrl.push(pts[i]);
  } else {
    ctrl.push(pts[0]);
    for (const p of pts) ctrl.push(p);
    ctrl.push(pts[n - 1]);
  }
  const samples: RoadSample[] = [];
  const segments = def.closed ? n : n - 1;
  let s = 0;
  let prev: { x: number; z: number } | null = null;
  for (let i = 0; i < segments; i++) {
    const p0 = def.closed ? pts[(i - 1 + n) % n] : (i - 1 < 0 ? pts[0] : pts[i - 1]);
    const p1 = def.closed ? pts[i] : pts[i];
    const p2 = def.closed ? pts[(i + 1) % n] : pts[i + 1];
    const p3 = def.closed ? pts[(i + 2) % n] : (i + 2 > n - 1 ? pts[n - 1] : pts[i + 2]);
    // Segment length estimate for even spacing
    const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const count = Math.max(2, Math.ceil(segLen / step));
    for (let k = 0; k < count; k++) {
      const t = k / count;
      const x = catmullRom([p0[0], 0], [p1[0], 0], [p2[0], 0], [p3[0], 0], t);
      const z = catmullRom([p0[1], 0], [p1[1], 0], [p2[1], 0], [p3[1], 0], t);
      if (prev) s += Math.hypot(x - prev.x, z - prev.z);
      prev = { x, z };
      samples.push({ x, z, y: 0, dx: 0, dz: 1, width: def.width, surface: def.surface, roadId: def.id, s, index: samples.length });
    }
  }
  if (def.closed) {
    const first = samples[0];
    if (prev) s += Math.hypot(first.x - prev.x, first.z - prev.z);
  }
  // Tangents
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i === 0 ? (def.closed ? samples.length - 1 : 0) : i - 1];
    const b = samples[i === samples.length - 1 ? (def.closed ? 0 : samples.length - 1) : i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    samples[i].dx = dx / len;
    samples[i].dz = dz / len;
  }
  return { def, samples, length: s };
}

/** Max gradient along a road, as a fraction (0.11 ~= 11%). */
const MAX_ROAD_GRADE = 0.11;

/**
 * Road heights: start from the raw terrain, smooth along the road, then limit
 * the gradient so no road becomes an impossible ramp.
 */
export function assignRoadHeights(inst: RoadInstance) {
  const { samples, def } = inst;
  const raw = samples.map((p) => baseHeight(p.x, p.z));
  // Moving average (box filter, two passes) for a drivable profile.
  const pass = (arr: number[], radius: number) => {
    const out = new Array(arr.length).fill(0);
    const n = arr.length;
    for (let i = 0; i < n; i++) {
      let sum = 0, count = 0;
      for (let k = -radius; k <= radius; k++) {
        let idx = i + k;
        if (def.closed) idx = ((idx % n) + n) % n;
        else if (idx < 0 || idx >= n) continue;
        sum += arr[idx]; count++;
      }
      out[i] = sum / count;
    }
    return out;
  };
  let h = pass(pass(raw, 6), 6);
  // Gradient limiting: walk forward then backward.
  const flat = pass(raw, 1);
  h = h.map((v, i) => v * 0.75 + flat[i] * 0.25);
  for (let iter = 0; iter < 4; iter++) {
    for (let i = 1; i < h.length; i++) {
      const d = Math.hypot(samples[i].x - samples[i - 1].x, samples[i].z - samples[i - 1].z);
      const maxDelta = d * MAX_ROAD_GRADE;
      h[i] = clamp(h[i], h[i - 1] - maxDelta, h[i - 1] + maxDelta);
    }
    for (let i = h.length - 2; i >= 0; i--) {
      const d = Math.hypot(samples[i + 1].x - samples[i].x, samples[i + 1].z - samples[i].z);
      const maxDelta = d * MAX_ROAD_GRADE;
      h[i] = clamp(h[i], h[i + 1] - maxDelta, h[i + 1] + maxDelta);
    }
    if (def.closed) {
      // average the seam
      const seam = (h[0] + h[h.length - 1]) * 0.5;
      h[0] = seam; h[h.length - 1] = seam;
    }
  }
  // No road may run under the sea: where the raw terrain is below the water
  // line the road becomes an embankment (the terrain is blended up to it, so
  // the visual mesh and the collision heightfield agree).
  const minRoadY = SEA_LEVEL + 1.8;
  let raised = false;
  for (let i = 0; i < h.length; i++) {
    if (h[i] < minRoadY) { h[i] = minRoadY; raised = true; }
  }
  if (raised) {
    // Re-limit the gradient so the new embankment ramps stay drivable.
    for (let iter = 0; iter < 6; iter++) {
      for (let i = 1; i < h.length; i++) {
        const d = Math.hypot(samples[i].x - samples[i - 1].x, samples[i].z - samples[i - 1].z);
        const maxDelta = d * MAX_ROAD_GRADE;
        h[i] = clamp(h[i], h[i - 1] - maxDelta, h[i - 1] + maxDelta);
      }
      for (let i = h.length - 2; i >= 0; i--) {
        const d = Math.hypot(samples[i + 1].x - samples[i].x, samples[i + 1].z - samples[i].z);
        const maxDelta = d * MAX_ROAD_GRADE;
        h[i] = clamp(h[i], h[i + 1] - maxDelta, h[i + 1] + maxDelta);
      }
      for (let i = 0; i < h.length; i++) if (h[i] < minRoadY) h[i] = minRoadY;
    }
  }

  for (let i = 0; i < samples.length; i++) samples[i].y = h[i];
}

// ---------------------------------------------------------------------------
// Road field: fast nearest-road lookups for terrain blending and surface type
// ---------------------------------------------------------------------------

const GRID_RES = 8; // metres
const GRID_N = Math.ceil(WORLD_SIZE / GRID_RES) + 1;
const HALF = WORLD_SIZE / 2;

interface CellInfo { dist: number; y: number; yNear: number; width: number; surface: SurfaceId; roadId: string; wSum: number; ySum: number }

export class RoadField {
  instances: RoadInstance[] = [];
  private grid: (CellInfo | null)[] = new Array(GRID_N * GRID_N).fill(null);
  private hash = new Map<number, number[]>();
  private hashCell = 40;
  private allSamples: RoadSample[] = [];

  constructor(instances: RoadInstance[]) {
    this.instances = instances;
    for (const inst of instances) {
      assignRoadHeights(inst);
      for (const s of inst.samples) this.allSamples.push(s);
    }
    this.reconcileHeights();
    this.rasterise();
    this.smoothCorridorHeights();
    this.buildHash();
  }

  private rasterise() {
    const radius = 26;
    const cells = Math.ceil(radius / GRID_RES) + 1;
    for (const s of this.allSamples) {
      const gx = Math.round((s.x + HALF) / GRID_RES);
      const gz = Math.round((s.z + HALF) / GRID_RES);
      for (let ix = gx - cells; ix <= gx + cells; ix++) {
        if (ix < 0 || ix >= GRID_N) continue;
        for (let iz = gz - cells; iz <= gz + cells; iz++) {
          if (iz < 0 || iz >= GRID_N) continue;
          const idx = iz * GRID_N + ix;
          const cx = ix * GRID_RES - HALF, cz = iz * GRID_RES - HALF;
          const d = Math.hypot(cx - s.x, cz - s.z);
          if (d > radius) continue;
          const w = (1 - d / radius) ** 3;
          if (w <= 0) continue;
          const cur = this.grid[idx];
          if (!cur) {
            this.grid[idx] = {
              dist: d, y: s.y, yNear: s.y, width: s.width, surface: s.surface,
              roadId: s.roadId, wSum: w, ySum: s.y * w,
            };
          } else {
            cur.wSum += w;
            cur.ySum += s.y * w;
            cur.y = cur.ySum / cur.wSum;
            if (d < cur.dist) {
              cur.dist = d; cur.width = s.width; cur.surface = s.surface; cur.roadId = s.roadId; cur.yNear = s.y;
            }
          }
        }
      }
    }
  }

  /**
   * Roads that pass close to each other must agree on height, otherwise the
   * terrain blend has to choose between two surfaces tens of metres apart and
   * produces a cliff along the road. Each pass pulls nearby samples of
   * *different* roads towards a common height, then the per-road grade limit is
   * re-applied so no road becomes an illegal ramp.
   */
  private reconcileHeights() {
    const cellSize = 44;
    type Entry = { inst: RoadInstance; i: number };
    const cells = new Map<number, Entry[]>();
    const key = (cx: number, cz: number) => (cx * 83492791) ^ (cz * 29833);
    const push = (e: Entry) => {
      const arr = cells.get(key(Math.floor(e.inst.samples[e.i].x / cellSize), Math.floor(e.inst.samples[e.i].z / cellSize)));
      if (arr) arr.push(e); else cells.set(key(Math.floor(e.inst.samples[e.i].x / cellSize), Math.floor(e.inst.samples[e.i].z / cellSize)), [e]);
    };
    this.instances.forEach((inst) => inst.samples.forEach((_, i) => push({ inst, i })));

    // Split every road profile into a smooth base and a local detail. Only the
    // base is reconciled between roads: pulling single samples would be undone
    // by the grade limiter, which (correctly) keeps each road locally smooth.
    const radius = 40;
    const bases = new Map<RoadInstance, number[]>();
    const details = new Map<RoadInstance, number[]>();
    for (const inst of this.instances) {
      const n = inst.samples.length;
      const base = new Array<number>(n);
      for (let i = 0; i < n; i++) {
        let sum = 0, count = 0;
        for (let k = -radius; k <= radius; k++) {
          let idx = i + k;
          if (inst.def.closed) idx = ((idx % n) + n) % n;
          else if (idx < 0 || idx >= n) continue;
          sum += inst.samples[idx].y; count++;
        }
        base[i] = sum / count;
      }
      bases.set(inst, base);
      details.set(inst, inst.samples.map((s, i) => s.y - base[i]));
    }

    for (let pass = 0; pass < 10; pass++) {
      const next = new Map<RoadInstance, number[]>();
      for (const inst of this.instances) next.set(inst, bases.get(inst)!.slice());
      for (const inst of this.instances) {
        const base = bases.get(inst)!;
        const out = next.get(inst)!;
        for (let i = 0; i < inst.samples.length; i++) {
          const s = inst.samples[i];
          const cx = Math.floor(s.x / cellSize), cz = Math.floor(s.z / cellSize);
          let sum = 0, wsum = 0;
          for (let ix = -1; ix <= 1; ix++) {
            for (let iz = -1; iz <= 1; iz++) {
              const arr = cells.get(key(cx + ix, cz + iz));
              if (!arr) continue;
              for (const e of arr) {
                if (e.inst === inst) continue;
                const o = e.inst.samples[e.i];
                const d = Math.hypot(o.x - s.x, o.z - s.z);
                if (d > cellSize) continue;
                const w = 1 - d / cellSize;
                sum += bases.get(e.inst)![e.i] * w;
                wsum += w;
              }
            }
          }
          if (wsum > 1e-4) out[i] = base[i] * 0.25 + (sum / wsum) * 0.75;
        }
      }
      for (const [inst, arr] of next) bases.set(inst, arr);
    }

    for (const inst of this.instances) {
      const base = bases.get(inst)!, detail = details.get(inst)!;
      for (let i = 0; i < inst.samples.length; i++) inst.samples[i].y = base[i] + detail[i];
      this.limitInstanceGrades(inst);
    }

    this.taperCrossings(cells, cellSize);
  }

  /**
   * Where two roads cross at different heights, ramp both towards a shared
   * height over a long stretch of each road. Without this the corridor blend has
   * to jump tens of metres at the crossing; with it, the two roads meet on a
   * gentle grade like a real interchange.
   */
  private taperCrossings(cells: Map<number, { inst: RoadInstance; i: number }[]>, cellSize: number) {
    const key = (cx: number, cz: number) => (cx * 83492791) ^ (cz * 29833);
    const spread = 140; // samples (~400 m of road) each way
    for (const inst of this.instances) {
      const n = inst.samples.length;
      const target = new Float64Array(n);
      const weight = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const s = inst.samples[i];
        target[i] = s.y;
        const cx = Math.floor(s.x / cellSize), cz = Math.floor(s.z / cellSize);
        let best = Infinity, bestY = s.y;
        for (let ix = -1; ix <= 1; ix++) {
          for (let iz = -1; iz <= 1; iz++) {
            const arr = cells.get(key(cx + ix, cz + iz));
            if (!arr) continue;
            for (const e of arr) {
              if (e.inst === inst) continue;
              const o = e.inst.samples[e.i];
              const d = Math.hypot(o.x - s.x, o.z - s.z);
              if (d < best) { best = d; bestY = o.y; }
            }
          }
        }
        if (best < 70) {
          const k = smoothstep(70, 8, best);
          target[i] = s.y + (bestY - s.y) * 0.5;
          weight[i] = k;
        }
      }
      // Spread the correction along the road so the grade stays gentle.
      const smooth = (arr: Float64Array) => {
        const out = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          let sum = 0, count = 0;
          for (let k = -spread; k <= spread; k++) {
            let idx = i + k;
            if (inst.def.closed) idx = ((idx % n) + n) % n;
            else if (idx < 0 || idx >= n) continue;
            sum += arr[idx]; count++;
          }
          out[i] = sum / count;
        }
        return out;
      };
      const tS = smooth(target);
      const wS = smooth(weight);
      for (let i = 0; i < n; i++) {
        const a = clamp(wS[i] * 4, 0, 1);
        if (a > 0.001) inst.samples[i].y = inst.samples[i].y * (1 - a) + tS[i] * a;
      }
      this.limitInstanceGrades(inst);
    }
  }

  /** Gradient limit along a single road; also lifts it above the water line. */
  private limitInstanceGrades(inst: RoadInstance) {
    const h = inst.samples.map((s) => Math.max(s.y, SEA_LEVEL + 1.8));
    for (let iter = 0; iter < 3; iter++) {
      for (let i = 1; i < h.length; i++) {
        const d = Math.hypot(inst.samples[i].x - inst.samples[i - 1].x, inst.samples[i].z - inst.samples[i - 1].z);
        const maxDelta = Math.max(0.05, d * MAX_ROAD_GRADE);
        h[i] = clamp(h[i], h[i - 1] - maxDelta, h[i - 1] + maxDelta);
      }
      for (let i = h.length - 2; i >= 0; i--) {
        const d = Math.hypot(inst.samples[i + 1].x - inst.samples[i].x, inst.samples[i + 1].z - inst.samples[i].z);
        const maxDelta = Math.max(0.05, d * MAX_ROAD_GRADE);
        h[i] = clamp(h[i], h[i + 1] - maxDelta, h[i + 1] + maxDelta);
      }
      for (let i = 0; i < h.length; i++) h[i] = Math.max(h[i], SEA_LEVEL + 1.8);
    }
    for (let i = 0; i < h.length; i++) inst.samples[i].y = h[i];
  }

  /**
   * Neighbouring grid cells can belong to different roads at very different
   * heights (switchbacks, a canyon road under a ridge road). Bilinear blending
   * would then produce a vertical cliff along the road, so the height channel is
   * gradient-limited to something a car can actually drive. Cells belonging to a
   * single road never move: the limit is far above the 11% road grade limit.
   */
  /**
   * Light diffusion of the corridor height channel. Two roads that meet at
   * different heights blend into a short ramp instead of a step; cells that
   * belong to a single road are barely touched (their neighbours agree to
   * within one grade step).
   */
  private smoothCorridorHeights() {
    for (let iter = 0; iter < 40; iter++) {
      for (let iz = 0; iz < GRID_N; iz++) {
        for (let ix = 0; ix < GRID_N; ix++) {
          const c = this.grid[iz * GRID_N + ix];
          if (!c) continue;
          let sum = 0, n = 0;
          if (ix > 0) { const o = this.grid[iz * GRID_N + ix - 1]; if (o) { sum += o.y; n++; } }
          if (ix + 1 < GRID_N) { const o = this.grid[iz * GRID_N + ix + 1]; if (o) { sum += o.y; n++; } }
          if (iz > 0) { const o = this.grid[(iz - 1) * GRID_N + ix]; if (o) { sum += o.y; n++; } }
          if (iz + 1 < GRID_N) { const o = this.grid[(iz + 1) * GRID_N + ix]; if (o) { sum += o.y; n++; } }
          if (n) c.y = c.y * 0.55 + (sum / n) * 0.45;
        }
      }
    }
  }

  /** Kept for reference: the weighted rasterisation already keeps the grid smooth. */
  private limitGridGradients() {
    const maxDelta = 2.5; // metres between adjacent 8 m cells (~31% grade)
    for (let iter = 0; iter < 64; iter++) {
      let changed = false;
      for (let iz = 0; iz < GRID_N; iz++) {
        for (let ix = 0; ix < GRID_N; ix++) {
          const a = this.grid[iz * GRID_N + ix];
          if (!a) continue;
          const right = ix + 1 < GRID_N ? this.grid[iz * GRID_N + ix + 1] : null;
          const down = iz + 1 < GRID_N ? this.grid[(iz + 1) * GRID_N + ix] : null;
          for (const b of [right, down]) {
            if (!b) continue;
            const d = a.y - b.y;
            if (Math.abs(d) > maxDelta) {
              const fix = (Math.abs(d) - maxDelta) * 0.5 * Math.sign(d);
              a.y -= fix; b.y += fix;
              changed = true;
            }
          }
        }
      }
      if (!changed) break;
    }
  }

  private buildHash() {
    for (let i = 0; i < this.allSamples.length; i++) {
      const s = this.allSamples[i];
      const key = this.key(Math.floor(s.x / this.hashCell), Math.floor(s.z / this.hashCell));
      const arr = this.hash.get(key);
      if (arr) arr.push(i); else this.hash.set(key, [i]);
    }
  }

  private key(cx: number, cz: number) { return cx * 73856093 ^ cz * 19349663; }

  private sampleGrid(x: number, z: number): CellInfo | null {
    const fx = (x + HALF) / GRID_RES, fz = (z + HALF) / GRID_RES;
    const x0 = Math.floor(fx), z0 = Math.floor(fz);
    const tx = fx - x0, tz = fz - z0;
    const at = (ix: number, iz: number) => {
      if (ix < 0 || iz < 0 || ix >= GRID_N || iz >= GRID_N) return null;
      return this.grid[iz * GRID_N + ix];
    };
    const a = at(x0, z0), b = at(x0 + 1, z0), c = at(x0, z0 + 1), d = at(x0 + 1, z0 + 1);
    if (!a && !b && !c && !d) return null;
    const pick = a ?? b ?? c ?? d!;
    const lerpField = (sel: (ci: CellInfo | null) => number) => {
      const aa = a ? sel(a) : sel(pick), bb = b ? sel(b) : sel(pick);
      const cc = c ? sel(c) : sel(pick), dd = d ? sel(d) : sel(pick);
      return lerp(lerp(aa, bb, tx), lerp(cc, dd, tx), tz);
    };
    return {
      dist: lerpField((ci) => ci!.dist),
      y: lerpField((ci) => ci!.y),
      yNear: lerpField((ci) => ci!.yNear),
      width: lerpField((ci) => ci!.width),
      surface: pick.surface,
      roadId: pick.roadId,
      wSum: 0,
      ySum: 0,
    };
  }

  /** Nearest road centreline distance; used for surfaces and VFX. */
  nearest(x: number, z: number): { dist: number; sample: RoadSample | null } {
    const cx = Math.floor(x / this.hashCell), cz = Math.floor(z / this.hashCell);
    let best = Infinity, bestIdx = -1;
    for (let ix = -1; ix <= 1; ix++) {
      for (let iz = -1; iz <= 1; iz++) {
        const arr = this.hash.get(this.key(cx + ix, cz + iz));
        if (!arr) continue;
        for (const i of arr) {
          const s = this.allSamples[i];
          const d = (s.x - x) ** 2 + (s.z - z) ** 2;
          if (d < best) { best = d; bestIdx = i; }
        }
      }
    }
    if (bestIdx < 0) {
      // Nothing in the local hash cells (far out in the fields or at sea):
      // coarse scan, then refine around the best hit. Only reached off-road.
      let coarseBest = Infinity, coarseIdx = -1;
      for (let i = 0; i < this.allSamples.length; i += 6) {
        const s = this.allSamples[i];
        const d = (s.x - x) ** 2 + (s.z - z) ** 2;
        if (d < coarseBest) { coarseBest = d; coarseIdx = i; }
      }
      if (coarseIdx < 0) return { dist: Infinity, sample: null };
      for (let i = Math.max(0, coarseIdx - 8); i < Math.min(this.allSamples.length, coarseIdx + 8); i++) {
        const s = this.allSamples[i];
        const d = (s.x - x) ** 2 + (s.z - z) ** 2;
        if (d < coarseBest) { coarseBest = d; coarseIdx = i; }
      }
      return { dist: Math.sqrt(coarseBest), sample: this.allSamples[coarseIdx] };
    }
    return { dist: Math.sqrt(best), sample: this.allSamples[bestIdx] };
  }

  /** Surface at a world position, blending the road corridor into the terrain. */
  surfaceAt(x: number, z: number, y: number, normalY: number): { surface: SurfaceId; onRoad: number } {
    const cell = this.sampleGrid(x, z);
    const base: SurfaceId = y < 1.2 ? 'water' : 'grass';
    if (!cell) return { surface: base, onRoad: 0 };
    const halfW = cell.width * 0.5;
    const onRoad = 1 - smoothstep(halfW - 0.8, halfW + 3.5, cell.dist);
    if (onRoad > 0.5) return { surface: cell.surface, onRoad };
    // Off-road: steep ground becomes rougher surface type
    if (normalY < 0.82) return { surface: 'gravel', onRoad };
    return { surface: base, onRoad };
  }

  heightContribution(x: number, z: number): { blend: number; y: number } {
    const cell = this.sampleGrid(x, z);
    if (!cell) return { blend: 0, y: 0 };
    const halfW = cell.width * 0.5;
    const inner = halfW + 1.0;
    const outer = halfW + 9;
    const blend = 1 - smoothstep(inner, outer, cell.dist);
    // Inside the carriageway the surface follows the nearest road's own profile
    // (so a road is never buried by a different road's embankment); outside it
    // eases into the blended corridor height.
    const onRoad = 1 - smoothstep(halfW - 0.5, halfW + 2.5, cell.dist);
    // Trust the nearest road's own profile only when it agrees with the blended
    // neighbourhood. Where two roads overlap at very different heights the
    // override fades out, so the surface ramps instead of forming a cliff.
    // The carriageway always follows its own road profile; the surrounding
    // embankment/cut blends into the shared corridor height. Where two roads
    // overlap at different heights this reads as a cutting wall beside the
    // road rather than a ramp across it.
    // The corridor height is the shared, smoothed field. Forcing the nearest
    // road's own profile here was tried and reverted: where two roads cross at
    // different heights it turned the crossing into a step, whereas the shared
    // field keeps one continuous, drivable surface for the mesh *and* the
    // collision heightfield (both are built from heightAt()).
    const y = cell.y;
    void onRoad;
    return { blend, y };
  }
}

export function buildRoadNetwork(): RoadField {
  const instances = ROADS.map((def) => buildRoadInstance(def));
  return new RoadField(instances);
}

// ---------------------------------------------------------------------------
// Graph + routing
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: number;
  x: number; z: number; y: number;
  edges: { to: number; cost: number; roadId: string; surface: SurfaceId; width: number }[];
  junction: boolean;
  roadIds: Set<string>;
}

export class RoadGraph {
  nodes: GraphNode[] = [];
  private byRoad = new Map<string, RoadGraphNodeIndex[]>();

  constructor(field: RoadField) {
    // Build a node for every road sample, then join nearby samples of different
    // roads into junctions.
    const nodeOf = new Map<string, number>();
    for (const inst of field.instances) {
      const list: RoadGraphNodeIndex[] = [];
      for (let i = 0; i < inst.samples.length; i++) {
        const s = inst.samples[i];
        const id = this.nodes.length;
        this.nodes.push({ id, x: s.x, z: s.z, y: s.y, edges: [], junction: false, roadIds: new Set([inst.def.id]) });
        list.push({ nodeId: id, sampleIndex: i });
        nodeOf.set(`${inst.def.id}:${i}`, id);
      }
      this.byRoad.set(inst.def.id, list);
      // intra-road edges
      for (let i = 0; i < inst.samples.length; i++) {
        const a = list[i].nodeId;
        const nextIdx = i + 1 < inst.samples.length ? i + 1 : (inst.def.closed ? 0 : -1);
        if (nextIdx < 0) continue;
        const b = list[nextIdx].nodeId;
        const A = this.nodes[a], B = this.nodes[b];
        const cost = Math.hypot(A.x - B.x, A.z - B.z);
        this.connect(a, b, cost, inst.def.id, inst.def.surface, inst.def.width);
      }
    }
    // Join roads: for each pair of samples from different roads within radius.
    const cellSize = JUNCTION_RADIUS;
    const grid = new Map<number, number[]>();
    const gkey = (x: number, z: number) => Math.floor(x / cellSize) * 92837111 ^ Math.floor(z / cellSize) * 689287499;
    for (const n of this.nodes) {
      const k = gkey(n.x, n.z);
      const arr = grid.get(k);
      if (arr) arr.push(n.id); else grid.set(k, [n.id]);
    }
    for (const n of this.nodes) {
      const cx = Math.floor(n.x / cellSize), cz = Math.floor(n.z / cellSize);
      for (let ix = -1; ix <= 1; ix++) {
        for (let iz = -1; iz <= 1; iz++) {
          const arr = grid.get(gkey(cx * cellSize + ix * cellSize, cz * cellSize + iz * cellSize));
          if (!arr) continue;
          for (const oid of arr) {
            if (oid <= n.id) continue;
            const o = this.nodes[oid];
            if (o.roadIds.has([...n.roadIds][0]) && o.roadIds.size === n.roadIds.size) continue;
            const sameRoad = [...n.roadIds].some((r) => o.roadIds.has(r));
            if (sameRoad && Math.hypot(o.x - n.x, o.z - n.z) > 0.1) {
              // Same road touching itself (closed loop) - allow but keep cost real
            }
            const d = Math.hypot(o.x - n.x, o.z - n.z);
            if (d > JUNCTION_RADIUS) continue;
            if (sameRoad && d < 1) continue;
            this.connect(n.id, o.id, d + 4, 'junction', 'asphaltDry', 10);
            this.connect(o.id, n.id, d + 4, 'junction', 'asphaltDry', 10);
            n.junction = true; o.junction = true;
            for (const r of o.roadIds) n.roadIds.add(r);
            for (const r of n.roadIds) o.roadIds.add(r);
          }
        }
      }
    }
  }

  private connect(a: number, b: number, cost: number, roadId: string, surface: SurfaceId, width: number) {
    const A = this.nodes[a];
    if (A.edges.some((e) => e.to === b)) return;
    A.edges.push({ to: b, cost, roadId, surface, width });
  }

  /** A* between the nodes closest to two world positions. */
  findPath(from: { x: number; z: number }, to: { x: number; z: number }): number[] {
    const start = this.nearestNode(from.x, from.z);
    const goal = this.nearestNode(to.x, to.z);
    if (start < 0 || goal < 0) return [];
    const open = new Set<number>([start]);
    const cameFrom = new Map<number, number>();
    const g = new Map<number, number>([[start, 0]]);
    const f = new Map<number, number>([[start, this.heuristic(start, goal)]]);
    while (open.size) {
      let current = -1, bestF = Infinity;
      for (const id of open) { const v = f.get(id) ?? Infinity; if (v < bestF) { bestF = v; current = id; } }
      if (current === goal) {
        const path = [current];
        while (cameFrom.has(current)) { current = cameFrom.get(current)!; path.push(current); }
        return path.reverse();
      }
      open.delete(current);
      for (const e of this.nodes[current].edges) {
        const tentative = (g.get(current) ?? Infinity) + e.cost;
        if (tentative < (g.get(e.to) ?? Infinity)) {
          cameFrom.set(e.to, current);
          g.set(e.to, tentative);
          f.set(e.to, tentative + this.heuristic(e.to, goal));
          open.add(e.to);
        }
      }
      if (g.size > 40000) break; // safety valve
    }
    return [];
  }

  private heuristic(a: number, b: number) {
    const A = this.nodes[a], B = this.nodes[b];
    return Math.hypot(A.x - B.x, A.z - B.z);
  }

  nearestNode(x: number, z: number): number {
    let best = -1, bestD = Infinity;
    for (const n of this.nodes) {
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bestD) { bestD = d; best = n.id; }
    }
    return best;
  }

  /** Downsample a node path into a polyline for GPS / AI. */
  pathToPoints(path: number[]): { x: number; y: number; z: number }[] {
    return path.map((id) => ({ x: this.nodes[id].x, y: this.nodes[id].y, z: this.nodes[id].z }));
  }
}

interface RoadGraphNodeIndex { nodeId: number; sampleIndex: number }
