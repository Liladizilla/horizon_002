/**
 * Prop geometry.
 *
 * Every prop is authored here at unit scale and instanced per chunk. The shapes
 * are deliberately multi-part — layered canopies, curved palm trunks, displaced
 * rock, buildings with window bands and a roof overhang — because a single
 * primitive silhouette is what makes procedural scenery look like placeholders.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PropType } from '../world/props';
import { mulberry32 } from '../core/rng';

/** Adds a flat colour as a vertex-colour attribute (multiplied over the map). */
function paint(geo: THREE.BufferGeometry, color: number, jitter = 0.08): THREE.BufferGeometry {
  // mergeGeometries needs a consistent index state, so flatten everything.
  const g = geo.index ? geo.toNonIndexed() : geo;
  const count = g.attributes.position.count;
  const arr = new Float32Array(count * 3);
  const c = new THREE.Color(color);
  // Slight per-vertex variation: real foliage/bark is never one flat tone.
  for (let i = 0; i < count; i++) {
    const j = 1 - jitter + Math.random() * jitter * 2;
    arr[i * 3 + 0] = c.r * j;
    arr[i * 3 + 1] = c.g * j;
    arr[i * 3 + 2] = c.b * j;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function cyl(rt: number, rb: number, h: number, seg: number, color: number, y = 0) {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1);
  g.translate(0, y, 0);
  return paint(g, color);
}

function cone(r: number, h: number, seg: number, color: number, y = 0) {
  const g = new THREE.ConeGeometry(r, h, seg, 1);
  g.translate(0, y, 0);
  return paint(g, color, 0.12);
}

function box(w: number, h: number, d: number, color: number, y = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(0, y, 0);
  return paint(g, color, 0.04);
}

function ico(r: number, color: number, y = 0, detail = 1) {
  const g = new THREE.IcosahedronGeometry(r, detail);
  g.translate(0, y, 0);
  return paint(g, color, 0.12);
}

/** Deterministic vertex displacement: turns an icosahedron into a rock. */
function displace(geo: THREE.BufferGeometry, amount: number, seed: number): THREE.BufferGeometry {
  const rnd = mulberry32(seed);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const cache = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    let d = cache.get(key);
    if (d === undefined) {
      d = 1 + (rnd() - 0.5) * amount;
      cache.set(key, d);
    }
    pos.setXYZ(i, x * d, y * d * 0.82, z * d);
  }
  geo.computeVertexNormals();
  return geo;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts);
  if (!merged) throw new Error('prop merge failed');
  return merged;
}

/** Unit-scale prop geometries. Instance scale multiplies these. */
export function buildPropGeometries(): Record<PropType, THREE.BufferGeometry> {
  // ---- conifer: trunk + five tapering canopy layers, slightly irregular -----
  const pineParts: THREE.BufferGeometry[] = [cyl(0.13, 0.24, 3.0, 7, 0x3d2c1d, 1.5)];
  const pineLayers: [number, number, number, number][] = [
    [1.9, 2.6, 2.4, 0x1d3a20],
    [1.6, 2.4, 3.5, 0x224228],
    [1.25, 2.1, 4.5, 0x27502c],
    [0.9, 1.8, 5.4, 0x2c5832],
    [0.55, 1.4, 6.2, 0x316038],
  ];
  pineLayers.forEach(([r, h, y, c]) => pineParts.push(cone(r, h, 8, c, y)));
  const pine = merge(pineParts);

  // ---- broadleaf: trunk with two limbs, five clustered crowns ---------------
  const broadParts: THREE.BufferGeometry[] = [
    cyl(0.16, 0.3, 2.8, 7, 0x42321f, 1.4),
    cyl(0.09, 0.12, 1.6, 5, 0x42321f, 2.6).rotateZ(0.4).translate(0.3, 0.4, 0),
    cyl(0.09, 0.12, 1.5, 5, 0x42321f, 2.4).rotateZ(-0.45).translate(-0.28, 0.5, 0.1),
  ];
  const crowns: [number, number, number, number, number][] = [
    [1.55, 0.2, 3.9, 0.2, 0x2b5226],
    [1.25, -1.0, 3.5, -0.4, 0x315c28],
    [1.2, 1.0, 3.6, 0.5, 0x2f5727],
    [1.0, 0.1, 4.7, -0.2, 0x37632c],
    [0.85, -0.4, 3.2, 1.0, 0x27491f],
  ];
  crowns.forEach(([r, x, y, z, c]) => broadParts.push(ico(r, c, y, 1).translate(x, 0, z)));
  const broad = merge(broadParts);

  // ---- palm: segmented curved trunk + fronds --------------------------------
  const palmParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 6; i++) {
    const seg = cyl(0.16 - i * 0.012, 0.2 - i * 0.012, 1.25, 6, 0x6a5535, 0.6);
    seg.rotateZ(Math.sin(i * 0.6) * 0.09);
    seg.translate(Math.sin(i * 0.55) * 0.22, i * 1.15, 0);
    palmParts.push(seg);
  }
  for (let f = 0; f < 7; f++) {
    const a = (f / 7) * Math.PI * 2;
    const frond = new THREE.ConeGeometry(0.42, 3.2, 5, 1);
    frond.scale(1, 0.22, 1);
    frond.rotateZ(Math.PI / 2.15);
    frond.rotateY(a);
    frond.translate(Math.cos(a) * 1.4, 7.2 + Math.sin(a * 2) * 0.2, Math.sin(a) * 1.4);
    palmParts.push(paint(frond, f % 2 ? 0x3f6f31 : 0x487a36, 0.14));
  }
  const palm = merge(palmParts);

  // ---- cactus --------------------------------------------------------------
  const cactus = merge([
    cyl(0.3, 0.36, 2.8, 8, 0x3a6236, 1.4),
    cyl(0.14, 0.16, 1.2, 6, 0x3a6236, 2.0).rotateZ(-0.55).translate(0.46, 0, 0),
    cyl(0.14, 0.16, 1.0, 6, 0x3a6236, 1.7).rotateZ(0.6).translate(-0.4, 0, 0),
    cyl(0.12, 0.13, 0.7, 6, 0x40703b, 2.6).translate(0.78, 0, 0),
  ]);

  // ---- rock: displaced icosahedron, two size classes -----------------------
  const rock = paint(displace(new THREE.IcosahedronGeometry(1, 1), 0.55, 991), 0x5c5852, 0.18).translate(0, 0.35, 0);

  const bush = merge([
    ico(0.62, 0x27421f, 0.45, 1).translate(0.2, 0, 0),
    ico(0.5, 0x2f4d24, 0.4, 1).translate(-0.3, 0, 0.15),
    ico(0.42, 0x35562a, 0.55, 1).translate(0.05, 0, -0.3),
  ]);

  // ---- buildings: walls, window bands, parapet, door ----------------------
  const buildingParts: THREE.BufferGeometry[] = [
    box(1.9, 1, 3.2, 0xffffff, 0.5),               // walls (tinted per instance)
    box(2.05, 0.07, 3.35, 0xf2f0ea, 1.02),         // roof slab / eave
    box(1.2, 0.5, 0.08, 0x2a3138, 0.35).translate(0, 0, 1.61), // shopfront glass
  ];
  // Window bands on all four faces, dark glass so they read against the walls.
  for (let floor = 0; floor < 3; floor++) {
    const y = 1.35 + floor * 0.95;
    buildingParts.push(box(1.3, 0.34, 0.06, 0x1e252c, y).translate(0, 0, 1.6));
    buildingParts.push(box(1.3, 0.34, 0.06, 0x1e252c, y).translate(0, 0, -1.6));
    buildingParts.push(box(0.06, 0.34, 1.2, 0x1e252c, y).translate(0.96, 0, 0));
    buildingParts.push(box(0.06, 0.34, 1.2, 0x1e252c, y).translate(-0.96, 0, 0));
  }
  const building = merge(buildingParts);

  const barn = merge([
    box(1.05, 1, 1.7, 0x8a3a2b, 0.5),
    paint(new THREE.ConeGeometry(1.5, 0.55, 4, 1), 0x4e372a, 0.06).rotateY(Math.PI / 4).translate(0, 1.28, 0),
    box(0.6, 0.55, 0.06, 0x33251c, 0.3).translate(0, 0, 0.87),
  ]);

  const sign = merge([
    cyl(0.05, 0.05, 2.4, 6, 0x8f8f8f, 1.2),
    box(1.6, 0.75, 0.07, 0x27618f, 2.5),
    box(1.45, 0.16, 0.02, 0xe8eef5, 2.62).translate(0, 0, 0.05),
  ]);

  const fence = merge([
    box(0.07, 1.2, 0.07, 0x6d5638, 0.6),
    box(2.0, 0.09, 0.05, 0x7d6440, 0.9),
    box(2.0, 0.09, 0.05, 0x7d6440, 0.45),
    box(0.05, 1.0, 0.02, 0x8a7148, 0.68).translate(0.8, 0, 0),
    box(0.05, 1.0, 0.02, 0x8a7148, 0.68).translate(0.4, 0, 0),
    box(0.05, 1.0, 0.02, 0x8a7148, 0.68).translate(-0.4, 0, 0),
    box(0.05, 1.0, 0.02, 0x8a7148, 0.68).translate(-0.8, 0, 0),
  ]);

  const haybale = merge([
    cyl(0.72, 0.72, 1.15, 12, 0xc7a94c, 0.72).rotateZ(Math.PI / 2),
    cyl(0.74, 0.74, 0.08, 12, 0xa88f3e, 0.72).rotateZ(Math.PI / 2),
  ]);

  const barrier = merge([
    box(2.4, 0.42, 0.14, 0xdcdcd6, 0.8),
    box(0.5, 0.42, 0.16, 0xc23b2b, 0.8).translate(0.7, 0, 0),
    box(0.14, 1.0, 0.14, 0x8d8d8d, 0.5).translate(-1.0, 0, 0),
    box(0.14, 1.0, 0.14, 0x8d8d8d, 0.5).translate(1.0, 0, 0),
  ]);

  const speaker = merge([
    cyl(0.07, 0.1, 3.4, 6, 0x2b2b30, 1.7),
    box(1.0, 1.35, 0.62, 0x17181c, 3.6),
    cyl(0.28, 0.28, 0.1, 10, 0x3c3d42, 3.7).rotateX(Math.PI / 2).translate(0, 0, 0.33),
  ]);

  return { treePine: pine, treeBroad: broad, palm, cactus, rock, bush, building, barn, sign, fence, haybale, barrier, speaker };
}

export function propMaterial(type: PropType): 'foliage' | 'rock' | 'building' {
  if (type === 'rock') return 'rock';
  if (type === 'building' || type === 'barn' || type === 'sign' || type === 'barrier' || type === 'speaker' || type === 'haybale' || type === 'fence') return 'building';
  return 'foliage';
}

export const BUILDING_TINTS = [0xd9cfc0, 0xc9b8a4, 0xb9c3c9, 0xe0d3bd, 0xa9a49a, 0xd4b98f, 0xcfd8d3];
