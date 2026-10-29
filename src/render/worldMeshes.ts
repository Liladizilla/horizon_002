/**
 * Prop geometry.
 *
 * Everything here is generated in code at boot, but the shapes are built the way
 * you would model them by hand rather than by stacking primitives:
 *
 *  - trees are grown: a recursive limb solver emits tapered tubes along curved
 *    paths, and foliage is attached to the *twigs* (needle sprays on conifers,
 *    lumpy leaf clusters on broadleaves) so the silhouette has gaps and layering
 *    instead of reading as a cone or a ball;
 *  - buildings are assembled from parts — recessed window openings with frames
 *    and sills, a cornice per storey, a pitched roof with overhanging eaves and
 *    gable ends, a door with an awning, a chimney;
 *  - rocks are displaced icosahedra with two octaves of noise plus flat faces
 *    for a fractured, geological read.
 *
 * Two fidelity tiers are produced per prop: `hi` for chunks near the player and
 * `lo` for the rest, because a detailed tree instanced ~1 400 times across the
 * streamed ring would be millions of triangles.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PropType } from '../world/props';
import { mulberry32 } from '../core/rng';

export interface PropGeometryPair {
  hi: THREE.BufferGeometry;
  lo: THREE.BufferGeometry;
}

type RGB = [number, number, number];

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** Planar UVs so textured materials (concrete, bark) have something to sample. */
function withUv(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (!g.attributes.uv) {
    const pos = g.attributes.position as THREE.BufferAttribute;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      // Cheap triplanar-ish projection: fine for props, avoids stretching.
      uv[i * 2] = (pos.getX(i) + pos.getZ(i)) * 0.28;
      uv[i * 2 + 1] = pos.getY(i) * 0.28;
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  if (!g.attributes.color) paint(g, [1, 1, 1], 0);
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

/** Adds a flat (or jittered) colour as the vertex-colour attribute. */
function paint(geo: THREE.BufferGeometry, color: number | RGB, jitter = 0.08): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const count = g.attributes.position.count;
  const arr = new Float32Array(count * 3);
  const c: RGB = typeof color === 'number'
    ? [(color >> 16 & 255) / 255, (color >> 8 & 255) / 255, (color & 255) / 255]
    : color;
  const tmp = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const j = 1 - jitter + Math.random() * jitter * 2;
    // Vertex colours are consumed as linear values, so convert from sRGB.
    tmp.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
    arr[i * 3 + 0] = tmp.r * j;
    arr[i * 3 + 1] = tmp.g * j;
    arr[i * 3 + 2] = tmp.b * j;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function box(w: number, h: number, d: number, color: number | RGB, jitter = 0.05) {
  return paint(new THREE.BoxGeometry(w, h, d), color, jitter);
}

function cyl(rt: number, rb: number, h: number, seg: number, color: number | RGB, jitter = 0.06) {
  return paint(new THREE.CylinderGeometry(rt, rb, h, seg, 1), color, jitter);
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts.map(withUv));
  if (!merged) throw new Error('prop merge failed');
  return merged;
}

/** Tapered tube through a polyline — used for every limb, branch and twig. */
function tube(path: THREE.Vector3[], radii: number[], sides: number, color: number | RGB, jitter = 0.1): THREE.BufferGeometry {
  const rings: THREE.Vector3[][] = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < path.length; i++) {
    const prev = path[Math.max(0, i - 1)];
    const next = path[Math.min(path.length - 1, i + 1)];
    const tangent = new THREE.Vector3().subVectors(next, prev).normalize();
    // Any vector not parallel to the tangent gives a stable frame.
    const ref = Math.abs(tangent.dot(up)) > 0.94 ? new THREE.Vector3(1, 0, 0) : up;
    const side = new THREE.Vector3().crossVectors(tangent, ref).normalize();
    const other = new THREE.Vector3().crossVectors(tangent, side).normalize();
    const ring: THREE.Vector3[] = [];
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      ring.push(new THREE.Vector3()
        .copy(path[i])
        .addScaledVector(side, Math.cos(a) * radii[i])
        .addScaledVector(other, Math.sin(a) * radii[i]));
    }
    rings.push(ring);
  }
  const positions: number[] = [];
  const push = (v: THREE.Vector3) => positions.push(v.x, v.y, v.z);
  for (let i = 0; i < rings.length - 1; i++) {
    for (let s = 0; s < sides; s++) {
      const a = rings[i][s];
      const b = rings[i][(s + 1) % sides];
      const c = rings[i + 1][s];
      const d = rings[i + 1][(s + 1) % sides];
      push(a); push(b); push(c);
      push(b); push(d); push(c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return paint(geo, color, jitter);
}

interface LimbOptions {
  spread: number;
  upBias: number;
  childLen: number;
  childRad: number;
  depth: number;
  curve: number;
  seed: number;
  color: number | RGB;
  sides: number;
  /** Called at every terminal twig: where leaves are attached. */
  onTip?: (tip: THREE.Vector3, dir: THREE.Vector3, depth: number) => void;
  out: THREE.BufferGeometry[];
}

/** Recursive limb solver: grows a curved, tapering branch and its children. */
function grow(
  start: THREE.Vector3,
  dir: THREE.Vector3,
  length: number,
  radius: number,
  o: LimbOptions,
  rnd: () => number,
) {
  const segments = Math.max(2, 4 - o.depth);
  const path: THREE.Vector3[] = [start.clone()];
  const radii: number[] = [radius];
  const cur = start.clone();
  const d = dir.clone();
  for (let i = 1; i <= segments; i++) {
    // Curve the limb and bias it upward or outward as it grows.
    d.x += (rnd() - 0.5) * o.curve;
    d.z += (rnd() - 0.5) * o.curve;
    d.y += o.upBias * 0.12;
    d.normalize();
    cur.addScaledVector(d, length / segments);
    path.push(cur.clone());
    radii.push(radius * (1 - (i / (segments + 1)) * 0.75));
  }
  o.out.push(tube(path, radii, o.sides, o.color, 0.14));

  if (o.depth <= 0) {
    o.onTip?.(cur.clone(), d.clone(), 0);
    return;
  }
  const children = o.depth >= 2 ? 3 : 2;
  for (let c = 0; c < children; c++) {
    const angle = (c / children) * Math.PI * 2 + rnd() * 0.9;
    const tilt = o.spread * (0.65 + rnd() * 0.6);
    const nd = new THREE.Vector3(
      d.x + Math.cos(angle) * tilt,
      d.y + (rnd() - 0.3) * 0.35,
      d.z + Math.sin(angle) * tilt,
    ).normalize();
    const nextLen = length * o.childLen * (0.82 + rnd() * 0.3);
    const nextRad = radius * o.childRad;
    if (nextLen < 0.16) continue;
    grow(cur, nd, nextLen, nextRad, { ...o, depth: o.depth - 1 }, rnd);
  }
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

/** Flattened needle spray: a squashed cone gives a soft, layered canopy mass. */
function spray(len: number, wide: number, color: number, tilt: THREE.Vector3): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(wide, len, 6, 1);
  g.scale(1, 1, 0.55);
  // Point the spray along the twig, with a slight droop.
  const dir = tilt.clone().normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  const m = new THREE.Matrix4().makeRotationFromQuaternion(q);
  m.setPosition(0, len * 0.42, 0);
  g.applyMatrix4(m);
  return paint(g, color, 0.18);
}

function conifer(seed: number) {
  const rnd = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  const trunkLen = 2.4;
  const trunkTop = new THREE.Vector3(0, trunkLen, 0);

  // Trunk: slightly tapered and gently curved, not a perfect cylinder.
  const trunkPath = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.03, trunkLen * 0.4, 0.02), new THREE.Vector3(-0.02, trunkLen * 0.75, 0), trunkTop];
  parts.push(tube(trunkPath, [0.19, 0.15, 0.1, 0.06], 7, 0x3b2a1c, 0.16));

  // Whorls of downswept branches up the trunk: the classic conifer layering.
  const whorls = 6;
  for (let w = 0; w < whorls; w++) {
    const t = 0.3 + (w / (whorls - 1)) * 0.68;
    const y = trunkLen * t;
    const count = 4 - Math.floor(w / 2);
    const len = 2.5 * (1 - t * 0.72) + 0.25;
    for (let c = 0; c < count; c++) {
      const a = (c / count) * Math.PI * 2 + w * 0.7 + rnd() * 0.5;
      const dir = new THREE.Vector3(Math.cos(a), -0.12 + rnd() * 0.18, Math.sin(a)).normalize();
      const start = new THREE.Vector3(0, y, 0);
      // Branch tube plus needle sprays along it.
      const end = start.clone().addScaledVector(dir, len);
      const mid = start.clone().addScaledVector(dir, len * 0.5).add(new THREE.Vector3(0, len * 0.05, 0));
      parts.push(tube([start, mid, end], [0.045, 0.03, 0.016], 5, 0x40301f, 0.14));
      for (let s = 0; s < 3; s++) {
        const f = 0.35 + s * 0.3;
        const p = start.clone().lerp(end, f);
        const sp = spray(0.95 - s * 0.12, 0.42 - s * 0.05, 0x2f5a30, dir.clone().add(new THREE.Vector3(0, 0.5, 0)));
        sp.translate(p.x, p.y, p.z);
        parts.push(sp);
      }
    }
  }
  // Leader shoot at the crown.
  const top = spray(1.5, 0.4, 0x356237, new THREE.Vector3(0, 1, 0));
  top.translate(trunkTop.x, trunkTop.y, trunkTop.z);
  parts.push(top);
  return merge(parts);
}

function broadleaf(seed: number) {
  const rnd = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  const leaves: THREE.BufferGeometry[] = [];
  const trunkLen = 2.1;

  const trunkPath = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.05, trunkLen * 0.5, 0.03), new THREE.Vector3(0, trunkLen, 0)];
  parts.push(tube(trunkPath, [0.24, 0.17, 0.13], 7, 0x453321, 0.16));

  // Three to four scaffold limbs, each recursively branching.
  const limbs = 3;
  for (let i = 0; i < limbs; i++) {
    const a = (i / limbs) * Math.PI * 2 + rnd();
    const dir = new THREE.Vector3(Math.cos(a) * 0.75, 1, Math.sin(a) * 0.75).normalize();
    grow(new THREE.Vector3(0, trunkLen * 0.92, 0), dir, 1.7, 0.1, {
      spread: 0.72,
      upBias: 0.5,
      childLen: 0.72,
      childRad: 0.62,
      depth: 2,
      curve: 0.24,
      seed,
      color: 0x4a3724,
      sides: 5,
      out: parts,
      onTip: (tip, dirn) => {
        // Leaf cluster: several offset blobs, so the canopy edge is lumpy.
        for (let b = 0; b < 4; b++) {
          const r = 0.42 + rnd() * 0.34;
          const blob = new THREE.IcosahedronGeometry(r, 0);
          const p = blob.attributes.position as THREE.BufferAttribute;
          for (let v = 0; v < p.count; v++) {
            const k = 0.72 + rnd() * 0.56;
            p.setXYZ(v, p.getX(v) * k, p.getY(v) * k * 0.8, p.getZ(v) * k);
          }
          blob.computeVertexNormals();
          blob.translate(
            tip.x + dirn.x * 0.3 + (rnd() - 0.5) * 0.5,
            tip.y + dirn.y * 0.3 + (rnd() - 0.2) * 0.4,
            tip.z + dirn.z * 0.3 + (rnd() - 0.5) * 0.5,
          );
          leaves.push(paint(blob, b % 2 ? 0x3f7a33 : 0x35682c, 0.22));
        }
      },
    }, rnd);
  }
  return merge([...parts, ...leaves]);
}

function palm(seed: number) {
  const rnd = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  // Trunk: stacked slightly-offset segments read as a real palm's ringed bend.
  const segs = 9;
  let x = 0;
  let y = 0;
  const pts: THREE.Vector3[] = [new THREE.Vector3(0, 0, 0)];
  const radii: number[] = [0.24];
  for (let i = 0; i < segs; i++) {
    x += Math.sin(i * 0.42) * 0.13;
    y += 0.86;
    pts.push(new THREE.Vector3(x, y, 0));
    radii.push(0.22 - i * 0.014);
  }
  parts.push(tube(pts, radii, 8, 0x6c5638, 0.13));
  // Ring detail at each joint.
  for (let i = 1; i < pts.length - 1; i++) {
    const ring = new THREE.TorusGeometry(radii[i] + 0.015, 0.035, 4, 10);
    ring.rotateX(Math.PI / 2);
    ring.translate(pts[i].x, pts[i].y, pts[i].z);
    parts.push(paint(ring, 0x5c482f, 0.1));
  }
  // Fronds: a curved spine with leaflets either side.
  const top = pts[pts.length - 1];
  const fronds = 9;
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + rnd() * 0.4;
    const droop = 0.35 + rnd() * 0.5;
    const dir = new THREE.Vector3(Math.cos(a), 0.5 - droop * 0.7, Math.sin(a)).normalize();
    const len = 2.6 + rnd() * 0.8;
    const spine: THREE.Vector3[] = [];
    for (let s = 0; s <= 5; s++) {
      const t = s / 5;
      const p = top.clone().addScaledVector(dir, len * t);
      p.y -= droop * len * t * t * 0.55;
      spine.push(p);
    }
    parts.push(tube(spine, spine.map((_, i) => 0.05 * (1 - i / 7)), 4, 0x4a6b32, 0.1));
    // Leaflets along the spine, angled outward and slightly up.
    for (let s = 1; s < spine.length; s++) {
      const t = s / (spine.length - 1);
      const base = spine[s];
      const tangent = new THREE.Vector3().subVectors(spine[Math.min(s + 1, spine.length - 1)], spine[s - 1]).normalize();
      const side = new THREE.Vector3(-tangent.z, 0.35, tangent.x).normalize();
      for (const sign of [-1, 1]) {
        const leaflet = new THREE.ConeGeometry(0.16, 0.85 * (1 - t * 0.4), 4, 1);
        leaflet.scale(1, 1, 0.32);
        const q = new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          side.clone().multiplyScalar(sign).add(tangent.clone().multiplyScalar(0.55)).normalize(),
        );
        leaflet.applyQuaternion(q);
        leaflet.translate(base.x, base.y, base.z);
        parts.push(paint(leaflet, s % 2 ? 0x3f7a33 : 0x4a8a3a, 0.18));
      }
    }
  }
  return merge(parts);
}

function cactus(seed: number) {
  const rnd = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  // Ribbed trunk: fluted cross-section from a low-sided tube.
  const trunk: THREE.Vector3[] = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.04, 1.4, 0.02), new THREE.Vector3(0.02, 2.8, 0)];
  parts.push(tube(trunk, [0.34, 0.3, 0.24], 12, 0x3f6b34, 0.14));
  // Arms: rise, bend and continue upward.
  const arms = 2 + Math.floor(rnd() * 2);
  for (let i = 0; i < arms; i++) {
    const a = (i / arms) * Math.PI * 2 + rnd();
    const dir = new THREE.Vector3(Math.cos(a), 0.2, Math.sin(a)).normalize();
    const y0 = 0.7 + rnd() * 1.1;
    const elbow = new THREE.Vector3(0, y0, 0).addScaledVector(dir, 0.55);
    const tip = elbow.clone().add(new THREE.Vector3(0, 0.85 + rnd() * 0.5, 0));
    parts.push(tube([new THREE.Vector3(0, y0, 0), elbow, tip], [0.17, 0.15, 0.12], 9, 0x437034, 0.14));
  }
  // Spines: tiny cones, cheap but they catch the light.
  for (let s = 0; s < 40; s++) {
    const y = rnd() * 2.6;
    const a = rnd() * Math.PI * 2;
    const r = 0.3 - y * 0.02;
    const spike = new THREE.ConeGeometry(0.015, 0.11, 3, 1);
    spike.translate(Math.cos(a) * r, y, Math.sin(a) * r);
    parts.push(paint(spike, 0xd9cba4, 0.2));
  }
  return merge(parts);
}

function bush(seed: number) {
  const rnd = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 9; i++) {
    const r = 0.28 + rnd() * 0.32;
    const blob = new THREE.IcosahedronGeometry(r, 1);
    const p = blob.attributes.position as THREE.BufferAttribute;
    for (let v = 0; v < p.count; v++) {
      const k = 0.7 + rnd() * 0.6;
      p.setXYZ(v, p.getX(v) * k, p.getY(v) * k * 0.8, p.getZ(v) * k);
    }
    blob.computeVertexNormals();
    blob.translate((rnd() - 0.5) * 0.9, 0.18 + rnd() * 0.5, (rnd() - 0.5) * 0.9);
    parts.push(paint(blob, i % 3 === 0 ? 0x35632a : i % 3 === 1 ? 0x2c5524 : 0x3d6f30, 0.22));
  }
  return merge(parts);
}

// ---------------------------------------------------------------------------
// Rocks
// ---------------------------------------------------------------------------

function rockGeometry(detail: number, seed: number) {
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const rnd = mulberry32(seed);
  const cache = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    let k = cache.get(key);
    if (k === undefined) {
      // Two octaves + a coarse facet term: boulders erode into planes, not noise.
      const coarse = Math.sin(x * 2.7 + z * 1.9) * 0.12 + Math.cos(y * 3.1 + x * 1.1) * 0.1;
      k = 1 + coarse + (rnd() - 0.5) * 0.34;
      cache.set(key, k);
    }
    pos.setXYZ(i, x * k, y * k * 0.72, z * k);
  }
  geo.computeVertexNormals();
  const g = paint(geo, 0x6a6560, 0.2);
  g.translate(0, 0.3, 0);
  return g;
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

interface BuildingOptions {
  width: number;
  depth: number;
  floors: number;
  floorHeight: number;
  roof: 'flat' | 'pitched';
  shopfront: boolean;
  seed: number;
}

/**
 * A real facade: the wall is a slab, windows are separate panes set *into* it
 * with a frame and a sill, each storey gets a cornice band, and the roof is
 * either a parapet or a pitched gable with overhanging eaves.
 */
function building(o: BuildingOptions) {
  const rnd = mulberry32(o.seed);
  const parts: THREE.BufferGeometry[] = [];
  const wall: RGB = [0.92, 0.9, 0.86];
  const trim = 0xf1ece0;
  const glass = 0x22303a;
  const h = o.floors * o.floorHeight;
  const W = o.width, D = o.depth;

  parts.push(box(W, h, D, wall, 0.03).translate(0, h / 2, 0));
  // Plinth: a slightly wider, darker base course.
  parts.push(box(W + 0.12, 0.42, D + 0.12, 0x8f8a80, 0.04).translate(0, 0.21, 0));

  // Corner quoins / pilasters give the corners some weight.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(box(0.16, h, 0.16, trim, 0.03).translate(sx * (W / 2 - 0.02), h / 2, sz * (D / 2 - 0.02)));
    }
  }

  const winW = 0.62;
  const winH = 0.95;
  const cols = Math.max(1, Math.floor(W / 1.35));
  for (let f = 0; f < o.floors; f++) {
    const y = f * o.floorHeight + o.floorHeight * 0.52;
    // Cornice band at each floor line.
    if (f > 0) parts.push(box(W + 0.1, 0.09, D + 0.1, trim, 0.02).translate(0, f * o.floorHeight, 0));
    for (let c = 0; c < cols; c++) {
      const x = -W / 2 + (c + 0.5) * (W / cols);
      const groundFloor = f === 0;
      if (groundFloor && o.shopfront && c === Math.floor(cols / 2)) continue; // door goes here
      const ww = groundFloor && o.shopfront ? winW * 1.6 : winW;
      const wh = groundFloor && o.shopfront ? winH * 1.35 : winH;
      // Front and back faces.
      for (const sz of [-1, 1]) {
        const z = sz * (D / 2);
        // Recessed pane, then a frame around it and a sill under it.
        parts.push(box(ww, wh, 0.05, glass, 0.02).translate(x, y, z + sz * 0.012));
        parts.push(box(ww + 0.16, 0.09, 0.16, trim, 0.02).translate(x, y + wh / 2 + 0.04, z + sz * 0.04));
        parts.push(box(ww + 0.18, 0.07, 0.18, trim, 0.02).translate(x, y - wh / 2 - 0.02, z + sz * 0.05));
        for (const sx of [-1, 1]) {
          parts.push(box(0.09, wh + 0.18, 0.14, trim, 0.02).translate(x + sx * (ww / 2 + 0.045), y, z + sz * 0.035));
        }
        // Muntin: turns a dark rectangle into a window.
        parts.push(box(ww, 0.05, 0.04, trim, 0.02).translate(x, y, z + sz * 0.04));
        parts.push(box(0.05, wh, 0.04, trim, 0.02).translate(x, y, z + sz * 0.04));
      }
    }
    // Side windows, sparser.
    if (D > 2.2) {
      for (const sx of [-1, 1]) {
        const x = sx * (W / 2);
        parts.push(box(0.05, winH, winW, glass, 0.02).translate(x + sx * 0.012, y, 0));
        parts.push(box(0.16, 0.08, winW + 0.18, trim, 0.02).translate(x + sx * 0.05, y - winH / 2 - 0.02, 0));
      }
    }
  }

  // Door + awning on the front face.
  const doorW = 0.95, doorH = 1.85;
  parts.push(box(doorW + 0.18, doorH + 0.14, 0.09, trim, 0.02).translate(0, (doorH + 0.14) / 2, D / 2 + 0.03));
  parts.push(box(doorW, doorH, 0.07, 0x3a2a22, 0.06).translate(0, doorH / 2 + 0.06, D / 2 + 0.09));
  parts.push(box(0.06, 0.06, 0.08, 0xd8c48a, 0.02).translate(doorW * 0.32, doorH * 0.5, D / 2 + 0.12));
  if (rnd() > 0.35) {
    // Striped awning: alternating slats, tilted out from the wall.
    for (let s = 0; s < 7; s++) {
      const slat = box(doorW * 1.9 / 7, 0.05, 0.62, s % 2 ? 0xc4553c : 0xeee6d8, 0.02);
      slat.rotateX(-0.34);
      slat.translate(-doorW * 0.95 + (s + 0.5) * (doorW * 1.9 / 7), doorH + 0.42, D / 2 + 0.28);
      parts.push(slat);
    }
  }

  if (o.roof === 'pitched') {
    const rise = 1.1 + rnd() * 0.5;
    const half = W / 2 + 0.32; // eaves overhang
    const slope = Math.atan2(rise, half);
    for (const sx of [-1, 1]) {
      const panel = box(Math.hypot(half, rise), 0.13, D + 0.7, 0x6d5546, 0.07);
      panel.rotateZ(-sx * slope);
      panel.translate(sx * half * 0.5, h + rise * 0.5, 0);
      parts.push(panel);
    }
    // Gable ends.
    for (const sz of [-1, 1]) {
      const gable = new THREE.CylinderGeometry(0, 1, 1, 3, 1);
      gable.scale(1, 1, 1);
      const tri = paint(gable, wall, 0.03);
      // A 3-sided cylinder standing on its axis makes a prism; rotate it so the
      // triangular face is visible from the gable side.
      tri.rotateZ(Math.PI / 2);
      tri.rotateY(Math.PI / 2);
      tri.scale(half * 0.98, 0.06, rise * 0.98);
      tri.translate(0, h + rise * 0.02, sz * (D / 2 - 0.05));
      parts.push(tri);
    }
    // Ridge cap.
    parts.push(box(0.22, 0.14, D + 0.72, 0x574437, 0.05).translate(0, h + rise, 0));
    // Chimney.
    if (rnd() > 0.4) {
      const cx = (rnd() - 0.5) * W * 0.5;
      parts.push(box(0.42, 1.0, 0.42, 0x8a6b58, 0.06).translate(cx, h + rise + 0.35, (rnd() - 0.5) * D * 0.4));
    }
  } else {
    // Parapet with a coping stone.
    const ph = 0.5;
    for (const sz of [-1, 1]) {
      parts.push(box(W + 0.2, ph, 0.16, wall, 0.03).translate(0, h + ph / 2, sz * (D / 2 + 0.02)));
    }
    for (const sx of [-1, 1]) {
      parts.push(box(0.16, ph, D + 0.2, wall, 0.03).translate(sx * (W / 2 + 0.02), h + ph / 2, 0));
    }
    parts.push(box(W + 0.3, 0.08, D + 0.3, trim, 0.02).translate(0, h + ph, 0));
    parts.push(box(W, 0.12, D, 0x5d5a55, 0.03).translate(0, h + 0.06, 0));
  }
  return merge(parts);
}

function barn(seed: number) {
  const rnd = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  const W = 2.4, D = 4.0, H = 2.2;
  // Timber cladding: vertical planks rather than one red box.
  const planks = 12;
  for (let i = 0; i < planks; i++) {
    const shade = 0x7d3327 + (i % 3) * 0x070301;
    parts.push(box(W / planks - 0.01, H, D, shade, 0.05).translate(-W / 2 + (i + 0.5) * (W / planks), H / 2, 0));
  }
  // Corner posts and a big double door.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) parts.push(box(0.16, H, 0.16, 0x4d2a20, 0.04).translate(sx * W / 2, H / 2, sz * D / 2));
  }
  parts.push(box(1.2, 1.5, 0.08, 0x3a241b, 0.05).translate(0, 0.75, D / 2 + 0.04));
  parts.push(box(0.06, 1.5, 0.1, 0x8d6a3f, 0.03).translate(0, 0.75, D / 2 + 0.1));
  // Gambrel-ish roof: two shallow panels plus a ridge.
  const rise = 0.95;
  for (const sx of [-1, 1]) {
    const panel = box(Math.hypot(W / 2 + 0.3, rise), 0.12, D + 0.6, 0x4a3a2e, 0.08);
    panel.rotateZ(-sx * Math.atan2(rise, W / 2 + 0.3));
    panel.translate(sx * (W / 4 + 0.15), H + rise * 0.47, 0);
    parts.push(panel);
  }
  parts.push(box(0.18, 0.12, D + 0.6, 0x3d3026, 0.05).translate(0, H + rise, 0));
  return merge(parts);
}

// ---------------------------------------------------------------------------
// Street furniture
// ---------------------------------------------------------------------------

function signPost() {
  return merge([
    cyl(0.045, 0.055, 2.3, 8, 0x9a9a9a, 0.05).translate(0, 1.15, 0),
    box(1.5, 0.72, 0.06, 0x27618f, 0.03).translate(0, 2.35, 0),
    box(1.34, 0.1, 0.02, 0xe8eef5, 0.02).translate(0, 2.5, 0.04),
    box(1.34, 0.06, 0.02, 0xe8eef5, 0.02).translate(0, 2.2, 0.04),
    box(0.06, 0.72, 0.02, 0xe8eef5, 0.02).translate(-0.4, 2.35, 0.04),
    box(0.06, 0.72, 0.02, 0xe8eef5, 0.02).translate(0.42, 2.35, 0.04),
  ]);
}

function fenceSection() {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(box(0.09, 1.15, 0.09, 0x6d5638, 0.06).translate(-1, 0.575, 0));
  parts.push(box(2.0, 0.08, 0.05, 0x7d6440, 0.04).translate(0, 0.9, 0));
  parts.push(box(2.0, 0.08, 0.05, 0x7d6440, 0.04).translate(0, 0.42, 0));
  for (let i = 0; i < 7; i++) {
    const x = -0.9 + i * 0.3;
    parts.push(box(0.11, 1.0, 0.025, 0x8a7148, 0.05).translate(x, 0.6, 0.03));
  }
  return merge(parts);
}

function haybale() {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(cyl(0.72, 0.72, 1.1, 16, 0xbfa04a, 0.1).rotateX(Math.PI / 2));
  // Binding twine.
  for (const x of [-0.36, 0.36]) {
    const band = new THREE.TorusGeometry(0.73, 0.02, 4, 20);
    band.rotateY(Math.PI / 2);
    band.translate(x, 0, 0);
    parts.push(paint(band, 0x8b7a3c, 0.05));
  }
  return merge(parts);
}

function barrier() {
  return merge([
    box(0.12, 0.9, 0.12, 0x8d8d8d, 0.05).translate(-1, 0.45, 0),
    box(0.12, 0.9, 0.12, 0x8d8d8d, 0.05).translate(1, 0.45, 0),
    box(2.3, 0.34, 0.1, 0xdedbd2, 0.04).translate(0, 0.86, 0),
    box(0.4, 0.34, 0.12, 0xc23b2b, 0.04).translate(-0.55, 0.86, 0),
    box(0.4, 0.34, 0.12, 0xc23b2b, 0.04).translate(0.55, 0.86, 0),
  ]);
}

/** Roadside delineator: white post, red reflector band, black base. */
function delineator() {
  return merge([
    box(0.1, 0.16, 0.1, 0x2b2b2b, 0.04).translate(0, 0.08, 0),
    box(0.075, 0.86, 0.075, 0xece9e1, 0.03).translate(0, 0.59, 0),
    box(0.082, 0.1, 0.082, 0xc0392b, 0.03).translate(0, 0.94, 0),
  ]);
}

/** Utility pole with a crossarm, insulators and a diagonal brace. */
function utilityPole() {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(cyl(0.13, 0.18, 8.4, 8, 0x5d4a36, 0.1).translate(0, 4.2, 0));
  parts.push(box(1.9, 0.12, 0.13, 0x6b563f, 0.06).translate(0, 7.9, 0));
  for (const x of [-0.72, 0, 0.72]) {
    parts.push(cyl(0.06, 0.08, 0.2, 6, 0x2f3b44, 0.05).translate(x, 8.06, 0));
  }
  // Brace from the pole to the crossarm.
  const brace = box(0.07, 1.15, 0.07, 0x6b563f, 0.05);
  brace.rotateZ(0.62);
  brace.translate(0.42, 7.32, 0);
  parts.push(brace);
  return merge(parts);
}

function speaker() {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(cyl(0.07, 0.1, 3.2, 8, 0x2b2b30, 0.05).translate(0, 1.6, 0));
  parts.push(box(1.0, 1.3, 0.6, 0x17181c, 0.04).translate(0, 3.4, 0));
  for (let i = 0; i < 2; i++) {
    parts.push(cyl(0.26 - i * 0.08, 0.26 - i * 0.08, 0.08, 14, 0x3d3e44, 0.05).rotateX(Math.PI / 2).translate(0, 3.4 + (i === 0 ? 0.28 : -0.28), 0.32));
  }
  return merge(parts);
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export function buildPropGeometries(): Record<PropType, PropGeometryPair> {
  const coniferHi = conifer(1301);
  const coniferLo = merge([
    tube([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 3, 0)], [0.16, 0.08], 5, 0x3b2a1c),
    paint(new THREE.ConeGeometry(1.5, 5.2, 7, 1), 0x2f5a30, 0.2).translate(0, 3.2, 0),
  ]);

  const broadHi = broadleaf(7717);
  const broadLo = merge([
    tube([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 2.6, 0)], [0.2, 0.1], 5, 0x453321),
    paint(new THREE.IcosahedronGeometry(1.7, 0), 0x3a6f30, 0.2).translate(0, 3.6, 0),
  ]);

  const palmHi = palm(4409);
  const palmLo = merge([
    tube([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.4, 6.5, 0)], [0.2, 0.12], 6, 0x6c5638),
    paint(new THREE.ConeGeometry(1.7, 0.7, 7, 1), 0x3f7a33, 0.2).translate(0.4, 6.7, 0),
  ]);

  const cactusHi = cactus(8811);
  const cactusLo = merge([
    cyl(0.24, 0.32, 2.8, 8, 0x3f6b34, 0.12).translate(0, 1.4, 0),
    cyl(0.12, 0.14, 1.1, 6, 0x437034, 0.12).rotateZ(-0.5).translate(0.45, 1.5, 0),
  ]);

  const rockHi = rockGeometry(3, 991);
  const rockLo = rockGeometry(0, 991);
  const bushHi = bush(3301);
  const bushLo = paint(new THREE.IcosahedronGeometry(0.6, 0), 0x35632a, 0.2);

  const housePitched = building({ width: 3.0, depth: 2.6, floors: 2, floorHeight: 1.5, roof: 'pitched', shopfront: false, seed: 21 });
  const housePitched2 = building({ width: 2.6, depth: 2.2, floors: 1, floorHeight: 1.6, roof: 'pitched', shopfront: false, seed: 77 });
  const shopBlock = building({ width: 3.4, depth: 3.0, floors: 3, floorHeight: 1.45, roof: 'flat', shopfront: true, seed: 45 });

  const barnHi = barn(551);
  const signHi = signPost();
  const fenceHi = fenceSection();
  const haybaleHi = haybale();
  const barrierHi = barrier();
  const speakerHi = speaker();

  return {
    treePine: { hi: coniferHi, lo: coniferLo },
    treeBroad: { hi: broadHi, lo: broadLo },
    palm: { hi: palmHi, lo: palmLo },
    cactus: { hi: cactusHi, lo: cactusLo },
    rock: { hi: rockHi, lo: rockLo },
    bush: { hi: bushHi, lo: bushLo },
    building: { hi: shopBlock, lo: housePitched },
    barn: { hi: barnHi, lo: housePitched2 },
    sign: { hi: signHi, lo: signHi },
    fence: { hi: fenceHi, lo: fenceHi },
    haybale: { hi: haybaleHi, lo: haybaleHi },
    barrier: { hi: barrierHi, lo: barrierHi },
    speaker: { hi: speakerHi, lo: speakerHi },
    delineator: { hi: delineator(), lo: delineator() },
    pole: { hi: utilityPole(), lo: utilityPole() },
  };
}

export function propMaterial(type: PropType): 'foliage' | 'rock' | 'building' {
  if (type === 'rock') return 'rock';
  if (type === 'building' || type === 'barn' || type === 'sign' || type === 'barrier' || type === 'speaker' || type === 'haybale' || type === 'fence' || type === 'delineator' || type === 'pole') return 'building';
  return 'foliage';
}

export const BUILDING_TINTS = [0xd9cfc0, 0xc9b8a4, 0xb9c3c9, 0xe0d3bd, 0xa9a49a, 0xd4b98f, 0xcfd8d3];
