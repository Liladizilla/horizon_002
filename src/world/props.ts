import { mulberry32, hash2 } from '../core/rng';
import { clamp } from '../core/math';
import { biomeWeights } from './terrain';

export interface PropInstance {
  x: number; y: number; z: number;
  scale: number;
  rotation: number;
  type: PropType;
  tilt?: number;
}

export type PropType = 'treePine' | 'treeBroad' | 'palm' | 'cactus' | 'rock' | 'bush' | 'building' | 'barn' | 'sign' | 'fence' | 'haybale' | 'barrier' | 'speaker';

export interface PropCollider {
  x: number; y: number; z: number;
  halfExtents?: [number, number, number];
  radius?: number;
  height?: number;
  kind: 'box' | 'cylinder';
  type: PropType;
}

export interface ChunkProps {
  instances: PropInstance[];
  colliders: PropCollider[];
}

export const CHUNK_SIZE = 512;

/**
 * Deterministic prop scattering for one chunk. The seed is derived from the
 * chunk coordinates, so a chunk always regenerates identically after being
 * unloaded and reloaded.
 */
export function generateChunkProps(
  cx: number,
  cz: number,
  heightAt: (x: number, z: number) => number,
  roadDistAt: (x: number, z: number) => { dist: number; width: number; roadId: string | null },
  density = 0.8,
): ChunkProps {
  const seed = Math.floor(hash2(cx, cz, 7717) * 4294967295);
  const rnd = mulberry32(seed);
  const instances: PropInstance[] = [];
  const colliders: PropCollider[] = [];
  const originX = cx * CHUNK_SIZE;
  const originZ = cz * CHUNK_SIZE;

  const tryPlace = (type: PropType, count: number, maxSlope: number, minRoadDist: number, scaleRange: [number, number], collider: boolean) => {
    const placed = Math.floor(count * clamp(density, 0.1, 1));
    for (let i = 0; i < placed; i++) {
      const x = originX + rnd() * CHUNK_SIZE;
      const z = originZ + rnd() * CHUNK_SIZE;
      const y = heightAt(x, z);
      if (y < 1.0) continue; // water
      const hx = heightAt(x + 3, z) - y;
      const hz = heightAt(x, z + 3) - y;
      const slope = Math.hypot(hx, hz) / 3;
      if (slope > maxSlope) continue;
      const road = roadDistAt(x, z);
      if (road.dist < minRoadDist + road.width * 0.5) continue;
      const scale = scaleRange[0] + rnd() * (scaleRange[1] - scaleRange[0]);
      instances.push({ x, y, z, scale, rotation: rnd() * Math.PI * 2, type, tilt: (rnd() - 0.5) * 0.08 });
      if (collider) {
        if (type === 'building' || type === 'barn') {
          const w = type === 'barn' ? 5 : 3.4 * scale;
          const h = type === 'barn' ? 4.5 : 4.2 * scale;
          const d = type === 'barn' ? 8 : 5.5 * scale;
          colliders.push({ x, y: y + h / 2, z, halfExtents: [w, h / 2, d], kind: 'box', type });
        } else if (type === 'rock') {
          colliders.push({ x, y: y + scale * 0.45, z, radius: scale * 0.85, height: scale * 0.9, kind: 'cylinder', type });
        } else {
          colliders.push({ x, y: y + scale * 2.2, z, radius: Math.max(0.28, scale * 0.22), height: scale * 4.4, kind: 'cylinder', type });
        }
      }
    }
  };

  const w = biomeWeights(originX + CHUNK_SIZE / 2, originZ + CHUNK_SIZE / 2);

  // Forest density by biome
  const pineCount = Math.round(220 * (w.mountain * 1.1 + w.jungle * 0.5 + 0.15));
  const broadCount = Math.round(200 * (w.jungle * 1.4 + w.farm * 0.4 + 0.1));
  tryPlace('treePine', pineCount, 0.55, 6, [0.8, 1.5], true);
  tryPlace('treeBroad', broadCount, 0.5, 6, [0.8, 1.6], true);
  if (w.coast > 0.25) tryPlace('palm', 40, 0.35, 5, [0.8, 1.3], true);
  if (w.desert > 0.3) tryPlace('cactus', 45, 0.4, 5, [0.7, 1.4], true);
  tryPlace('rock', Math.round(70 * (w.mountain * 1.4 + w.desert * 0.8 + 0.3)), 0.75, 4, [0.5, 2.4], true);
  tryPlace('bush', Math.round(120 * (w.jungle + w.farm + w.desert * 0.5 + 0.2)), 0.6, 4, [0.5, 1.2], false);

  // Town buildings on a loose grid so the hub reads as a town.
  if (w.town > 0.25) {
    const grid = 34;
    for (let gx = 0; gx < CHUNK_SIZE / grid; gx++) {
      for (let gz = 0; gz < CHUNK_SIZE / grid; gz++) {
        if (rnd() > 0.62) continue;
        const x = originX + gx * grid + rnd() * 8;
        const z = originZ + gz * grid + rnd() * 8;
        const road = roadDistAt(x, z);
        if (road.dist < 13) continue;
        const y = heightAt(x, z);
        if (y < 1.2) continue;
        instances.push({ x, y, z, scale: 0.8 + rnd() * 0.9, rotation: Math.floor(rnd() * 4) * Math.PI / 2, type: 'building' });
        const s = instances[instances.length - 1].scale;
        colliders.push({ x, y: y + 4.2 * s / 2, z, halfExtents: [3.4 * s, 4.2 * s / 2, 5.5 * s], kind: 'box', type: 'building' });
      }
    }
    tryPlace('speaker', 6, 0.3, 8, [0.9, 1.2], false);
  }

  if (w.farm > 0.35) {
    tryPlace('haybale', 26, 0.3, 6, [0.8, 1.1], false);
    tryPlace('fence' as PropType, 40, 0.35, 5, [0.9, 1.1], false);
  }

  // Barns: rare, hand-placed landmark feel (one per ~2x2 chunk area).
  if (w.town < 0.2 && rnd() > 0.86) {
    const x = originX + CHUNK_SIZE * 0.3 + rnd() * CHUNK_SIZE * 0.4;
    const z = originZ + CHUNK_SIZE * 0.3 + rnd() * CHUNK_SIZE * 0.4;
    const road = roadDistAt(x, z);
    const y = heightAt(x, z);
    if (y > 2 && road.dist > 25 && road.dist < 220) {
      instances.push({ x, y, z, scale: 1, rotation: Math.floor(rnd() * 4) * Math.PI / 2, type: 'barn' });
      colliders.push({ x, y: y + 2.6, z, halfExtents: [5, 2.6, 8], kind: 'box', type: 'barn' });
    }
  }

  return { instances, colliders };
}
