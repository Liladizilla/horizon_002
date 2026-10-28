import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PropType } from '../world/props';

/** Adds a flat colour as a vertex-colour attribute. */
function paint(geo: THREE.BufferGeometry, color: THREE.Color, jitter = 0.06): THREE.BufferGeometry {
  // Normalise index state: three mixes indexed primitives (box, cylinder, cone)
  // with non-indexed ones (icosahedron), and mergeGeometries needs consistency.
  const g = geo.index ? geo.toNonIndexed() : geo;
  const count = g.attributes.position.count;
  const arr = new Float32Array(count * 3);
  const c = color.clone();
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
  const g = new THREE.CylinderGeometry(rt, rb, h, seg);
  g.translate(0, y, 0);
  return paint(g, new THREE.Color(color));
}
function cone(r: number, h: number, seg: number, color: number, y = 0) {
  const g = new THREE.ConeGeometry(r, h, seg);
  g.translate(0, y, 0);
  return paint(g, new THREE.Color(color));
}
function box(w: number, h: number, d: number, color: number, y = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(0, y, 0);
  return paint(g, new THREE.Color(color));
}
function ico(r: number, color: number, y = 0, detail = 0) {
  const g = new THREE.IcosahedronGeometry(r, detail);
  g.translate(0, y, 0);
  return paint(g, new THREE.Color(color));
}

/** Unit-scale prop geometries. Instance scale multiplies these. */
export function buildPropGeometries(): Record<PropType, THREE.BufferGeometry> {
  const pine = mergeGeometries([
    cyl(0.16, 0.26, 2.4, 6, 0x4a3626, 1.2),
    cone(1.75, 3.2, 7, 0x1f4023, 3.0),
    cone(1.35, 2.7, 7, 0x244a29, 4.4),
    cone(0.95, 2.2, 7, 0x2a5530, 5.6),
  ])!;
  const broad = mergeGeometries([
    cyl(0.18, 0.3, 2.6, 6, 0x4e3a28, 1.3),
    ico(1.9, 0x2f5c2a, 3.6, 1),
    ico(1.3, 0x376829, 4.6, 1),
  ])!;
  const palm = mergeGeometries([
    cyl(0.12, 0.22, 6.2, 6, 0x6b5638, 3.1),
    cone(2.1, 0.6, 6, 0x3d6b32, 6.2),
    cone(1.5, 0.5, 6, 0x4a7a36, 6.6),
  ])!;
  const cactus = mergeGeometries([
    cyl(0.34, 0.4, 2.6, 7, 0x3f6b3c, 1.3),
    cyl(0.16, 0.16, 1.1, 6, 0x3f6b3c, 1.9).translate(0.5, 0, 0).rotateZ(-0.5) as THREE.BufferGeometry,
  ])!;
  const rock = ico(1, 0x6d6a63, 0.5, 0);
  const bush = ico(0.7, 0x2c4a24, 0.5, 0);
  const building = (() => {
    const base = box(1.9, 1, 3.2, 0xffffff, 0.5);
    // keep white so per-instance colour tints the whole building
    return base;
  })();
  const barn = mergeGeometries([
    box(1.05, 1, 1.7, 0x8c3b2c, 0.5),
    cone(1.35, 0.5, 4, 0x5c4030, 1.05),
  ])!;
  const sign = mergeGeometries([
    cyl(0.05, 0.05, 2.2, 5, 0x8f8f8f, 1.1),
    box(1.5, 0.7, 0.08, 0x2b6cb0, 2.3),
  ])!;
  const fence = mergeGeometries([
    box(0.07, 1.1, 0.07, 0x6d5638, 0.55),
    box(2.0, 0.1, 0.06, 0x7d6440, 0.85),
    box(2.0, 0.1, 0.06, 0x7d6440, 0.45),
  ])!;
  const haybale = cyl(0.75, 0.75, 1.2, 8, 0xc9a94a, 0.75);
  const barrier = mergeGeometries([
    box(2.4, 0.5, 0.16, 0xe8e8e8, 0.75),
    box(0.16, 1.0, 0.16, 0x9a9a9a, 0.5),
  ])!;
  const speaker = mergeGeometries([
    cyl(0.08, 0.12, 3.2, 6, 0x2b2b30, 1.6),
    box(0.9, 1.2, 0.6, 0x1a1a1e, 3.4),
  ])!;
  return { treePine: pine, treeBroad: broad, palm, cactus, rock, bush, building, barn, sign, fence, haybale, barrier, speaker };
}

export function propMaterial(type: PropType): 'foliage' | 'rock' | 'building' {
  if (type === 'rock') return 'rock';
  if (type === 'building' || type === 'barn' || type === 'sign' || type === 'barrier' || type === 'speaker' || type === 'haybale' || type === 'fence') return 'building';
  return 'foliage';
}

export const BUILDING_TINTS = [0xd9cfc0, 0xc9b8a4, 0xb9c3c9, 0xe0d3bd, 0xa9a49a, 0xd4b98f, 0xcfd8d3];
