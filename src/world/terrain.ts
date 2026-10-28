import { clamp, smoothstep, lerp } from '../core/math';
import { fbm2, ridged2, valueNoise2 } from '../core/rng';

/**
 * Analytic terrain for the Horizon Drive map.
 *
 * The same function feeds the render mesh AND the Rapier heightfield, so what
 * you see is exactly what the wheels touch. Road corridors are flattened by
 * `applyRoadInfluence` (see world/roads.ts) so visual geometry and collision
 * geometry never disagree.
 */

export const WORLD_SIZE = 4096;      // metres
export const SEA_LEVEL = 0;
export const TERRAIN_RES = 4;        // physics heightfield cell size (m)

export type Biome = 'town' | 'coast' | 'desert' | 'jungle' | 'mountain' | 'farm' | 'volcanic' | 'sea';

export interface BiomeWeights {
  mountain: number; desert: number; jungle: number; farm: number; coast: number; volcanic: number; town: number;
}

/** Smooth region masks. All return 0..1. */
export function biomeWeights(x: number, z: number): BiomeWeights {
  const ne = clamp((x * 0.55 - z * 0.83) / 1500, 0, 1);          // north-east diagonal
  const mountain = smoothstep(0.30, 0.85, ne);
  const desert = smoothstep(500, 1300, x) * (1 - mountain * 0.55);
  const jungle = smoothstep(150, 850, -x) * smoothstep(150, 750, -z);
  const farm = smoothstep(350, 1000, z) * smoothstep(150, 800, -x) * (1 - desert);
  const coast = smoothstep(1250, 1950, -x);
  const volcanic = smoothstep(0.55, 0.95, ne) * smoothstep(600, 1300, x) * (1 - mountain * 0.4);
  const town = smoothstep(520, 240, Math.hypot(x - 80, z - 80));
  return { mountain, desert, jungle, farm, coast, volcanic, town };
}

export function dominantBiome(w: BiomeWeights): Biome {
  let best: Biome = 'jungle';
  let bestVal = 0;
  const entries: [Biome, number][] = [
    ['mountain', w.mountain], ['desert', w.desert], ['jungle', w.jungle],
    ['farm', w.farm], ['coast', w.coast], ['volcanic', w.volcanic], ['town', w.town],
  ];
  for (const [k, v] of entries) if (v > bestVal) { bestVal = v; best = k; }
  if (bestVal < 0.25) best = 'jungle';
  return best;
}

/**
 * Terrain height before road flattening. Sea level is y = 0.
 * Rolling countryside with a mountain range to the north-east, dunes and
 * canyons to the east, a river-cut jungle to the north-west, farmland to the
 * south-west and a coastline to the west.
 */
export function baseHeight(x: number, z: number): number {
  const w = biomeWeights(x, z);

  // Gentle continental roll (large features).
  let h = 7 + (fbm2(x * 0.00055, z * 0.00055, 4, 11) - 0.5) * 46;
  // Mid-scale hills.
  h += (fbm2(x * 0.0022, z * 0.0022, 4, 23) - 0.5) * 20 * (0.4 + w.jungle + w.farm * 0.6);
  // Fine detail.
  h += (fbm2(x * 0.014, z * 0.014, 3, 37) - 0.5) * 2.4;

  // ---- mountains: ridged noise, snow caps high up ----
  if (w.mountain > 0.001) {
    const r = ridged2(x * 0.0012, z * 0.0012, 5, 91);
    const ridge = Math.pow(r, 1.7);
    h += w.mountain * (ridge * 430 + 25);
  }

  // ---- desert: dunes ----
  if (w.desert > 0.001) {
    const dune = Math.sin(x * 0.0075 + fbm2(x * 0.002, z * 0.002, 2, 55) * 6.0) * 5.5;
    h += w.desert * (dune + 6 + (fbm2(x * 0.0009, z * 0.0009, 2, 57) - 0.5) * 30);
  }

  // ---- desert canyons: carve where a ridged field is low ----
  if (w.desert > 0.2) {
    const c = ridged2(x * 0.0032, z * 0.0032, 3, 77);
    const carve = smoothstep(0.55, 0.85, c);
    h -= (w.desert - 0.2) * carve * 26 * clamp(w.desert, 0, 1);
  }

  // ---- volcanic field: ash cones and a broad caldera ----
  if (w.volcanic > 0.01) {
    const cx = 1250, cz = -1050;
    const d = Math.hypot(x - cx, z - cz);
    const cone = Math.max(0, 1 - d / 620);
    h += w.volcanic * (Math.pow(cone, 1.6) * 210 - smoothstep(120, 40, d) * 45);
  }

  // ---- river through the jungle ----
  const riverX = -950 + Math.sin(z * 0.0032) * 260 + (fbm2(z * 0.002, 3.3, 2, 61) - 0.5) * 180;
  const riverDist = Math.abs(x - riverX);
  if (w.jungle > 0.02) {
    const channel = (1 - smoothstep(30, 130, riverDist)) * w.jungle;
    h = lerp(h, 1.5, channel * 0.92);
  }

  // ---- coastline: everything west of the shoreline sinks below sea level ----
  if (w.coast > 0.001) {
    const shore = -1720 + Math.sin(z * 0.0021) * 190 + (fbm2(z * 0.003, 1.7, 2, 71) - 0.5) * 120;
    const t = smoothstep(shore - 260, shore + 120, x); // 0 = out at sea, 1 = inland
    const seabed = lerp(-34, 2.0, t * t);
    h = lerp(h, seabed, clamp(w.coast * 1.1, 0, 1));
  }

  // ---- town plateau: flatten the festival hub ----
  if (w.town > 0.001) {
    h = lerp(h, 12, w.town * 0.85);
  }

  return h;
}

/** Surface colour used by the terrain vertex painter. */
export function biomeColor(x: number, z: number, height: number, slope: number): [number, number, number] {
  const w = biomeWeights(x, z);
  // These are *linear* diffuse albedos, in the range real ground covers
  // (~0.04 for dark grass up to ~0.7 for fresh snow). Authoring them brighter
  // makes the world look washed out once sun, sky and IBL are summed at
  // physically plausible light levels.
  const rock: [number, number, number] = [0.13, 0.12, 0.11];
  const sand: [number, number, number] = [0.34, 0.29, 0.19];
  const dirt: [number, number, number] = [0.15, 0.11, 0.07];
  const grass: [number, number, number] = [0.075, 0.14, 0.045];
  const jungleGrass: [number, number, number] = [0.045, 0.10, 0.035];
  const farm: [number, number, number] = [0.16, 0.19, 0.07];
  const snow: [number, number, number] = [0.62, 0.66, 0.72];
  const ash: [number, number, number] = [0.06, 0.055, 0.05];
  const townGround: [number, number, number] = [0.14, 0.14, 0.15];

  let c: [number, number, number] = grass;
  c = mix(c, jungleGrass, w.jungle);
  c = mix(c, sand, w.desert * 0.9);
  c = mix(c, farm, w.farm * 0.85);
  c = mix(c, sand, w.coast * 0.6);
  c = mix(c, townGround, w.town * 0.9);
  c = mix(c, ash, w.volcanic * 0.8);
  c = mix(c, rock, clamp((slope - 0.30) * 2.2, 0, 1));
  // Snow line with noisy boundary
  const snowLine = 250 + valueNoise2(x * 0.01, z * 0.01, 5) * 60;
  c = mix(c, snow, smoothstep(snowLine - 40, snowLine + 30, height) * clamp(w.mountain, 0, 1));
  // Wet sand near the water line
  if (height < 2.5) c = mix(c, [0.24, 0.22, 0.17], smoothstep(2.5, 0.4, height));
  // Slight per-vertex variation breaks up large flat areas.
  const n = valueNoise2(x * 0.09, z * 0.09, 9) * 0.05 - 0.025;
  return [clamp(c[0] + n, 0, 1), clamp(c[1] + n, 0, 1), clamp(c[2] + n, 0, 1)];
}

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  const k = clamp(t, 0, 1);
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

export function inPlayableArea(x: number, z: number): boolean {
  const half = WORLD_SIZE / 2 - 40;
  return Math.abs(x) < half && Math.abs(z) < half;
}
