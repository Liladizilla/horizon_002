/**
 * Procedurally generated PBR texture library.
 *
 * Everything the game renders is authored here at boot: no binary asset files,
 * no network requests. Each surface gets a *matched set* of maps — albedo,
 * normal and roughness — generated from the same height field, so the lighting
 * response agrees with the visible detail instead of being a flat colour with a
 * noise overlay.
 *
 * Generation is deterministic (seeded value noise) and tileable: every noise
 * source wraps at the texture border, so tiled ground never shows seams.
 */
import * as THREE from 'three';
import { mulberry32 } from '../core/rng';

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Periodic value noise on an integer lattice of `freq` cells, sampled in [0,1). */
function tileableValueNoise(size: number, freq: number, seed: number): Float32Array {
  const rnd = mulberry32(seed);
  const lattice = new Float32Array(freq * freq);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rnd();
  const out = new Float32Array(size * size);
  const scale = freq / size;
  for (let y = 0; y < size; y++) {
    const fy = y * scale;
    const y0 = Math.floor(fy);
    const ty = smooth(fy - y0);
    const y0i = ((y0 % freq) + freq) % freq;
    const y1i = (y0i + 1) % freq;
    for (let x = 0; x < size; x++) {
      const fx = x * scale;
      const x0 = Math.floor(fx);
      const tx = smooth(fx - x0);
      const x0i = ((x0 % freq) + freq) % freq;
      const x1i = (x0i + 1) % freq;
      const a = lattice[y0i * freq + x0i];
      const b = lattice[y0i * freq + x1i];
      const c = lattice[y1i * freq + x0i];
      const d = lattice[y1i * freq + x1i];
      const top = a + (b - a) * tx;
      const bottom = c + (d - c) * tx;
      out[y * size + x] = top + (bottom - top) * ty;
    }
  }
  return out;
}

/** Fractal sum of tileable value noise. Frequencies stay powers of two so it wraps. */
function fbm(size: number, octaves: number, baseFreq: number, seed: number, gain = 0.5, lacunarity = 2): Float32Array {
  const out = new Float32Array(size * size);
  let amp = 1;
  let total = 0;
  let freq = baseFreq;
  for (let o = 0; o < octaves; o++) {
    const layer = tileableValueNoise(size, Math.max(1, Math.round(freq)), seed + o * 7919);
    for (let i = 0; i < out.length; i++) out[i] += layer[i] * amp;
    total += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/** Ridged noise: good for cracks, veins and rock strata. */
function ridged(size: number, octaves: number, baseFreq: number, seed: number): Float32Array {
  const out = new Float32Array(size * size);
  let amp = 1;
  let total = 0;
  let freq = baseFreq;
  for (let o = 0; o < octaves; o++) {
    const layer = tileableValueNoise(size, Math.max(1, Math.round(freq)), seed + o * 3571);
    for (let i = 0; i < out.length; i++) out[i] += (1 - Math.abs(layer[i] * 2 - 1)) * amp;
    total += amp;
    amp *= 0.55;
    freq *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------------------------------------------------------------------------
// Height -> maps
// ---------------------------------------------------------------------------

function canvasFrom(size: number) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return { canvas: c, ctx: c.getContext('2d')! };
}

function finishTexture(canvas: HTMLCanvasElement, srgb: boolean, aniso: number): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = aniso;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Sobel-derivative normal map from a height field.
 * `strength` is in height-units per texel; higher = more pronounced relief.
 */
function normalMapFrom(height: Float32Array, size: number, strength: number, aniso: number): THREE.CanvasTexture {
  const { canvas, ctx } = canvasFrom(size);
  const img = ctx.createImageData(size, size);
  const at = (x: number, y: number) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx =
        at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1) -
        at(x + 1, y - 1) - 2 * at(x + 1, y) - at(x + 1, y + 1);
      const dy =
        at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1) -
        at(x - 1, y + 1) - 2 * at(x, y + 1) - at(x + 1, y + 1);
      let nx = dx * strength;
      let ny = dy * strength;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      img.data[i] = Math.round((nx * 0.5 + 0.5) * 255);
      img.data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      img.data[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finishTexture(canvas, false, aniso);
}

/** Albedo from a per-texel colour callback driven by the height/noise fields. */
function albedoFrom(
  size: number,
  shade: (x: number, y: number, i: number) => [number, number, number],
  aniso: number,
): THREE.CanvasTexture {
  const { canvas, ctx } = canvasFrom(size);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const [r, g, b] = shade(x, y, i);
      img.data[i * 4] = Math.round(clamp01(r) * 255);
      img.data[i * 4 + 1] = Math.round(clamp01(g) * 255);
      img.data[i * 4 + 2] = Math.round(clamp01(b) * 255);
      img.data[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finishTexture(canvas, true, aniso);
}

/**
 * Roughness map: 1 = fully rough, 0 = mirror. Note three multiplies the map by
 * `material.roughness`, so these values must be roughness, not gloss — a "gloss"
 * map here makes tarmac behave like a wet mirror.
 */
function glossFrom(size: number, gloss: (x: number, y: number, i: number) => number, aniso: number): THREE.CanvasTexture {
  const { canvas, ctx } = canvasFrom(size);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const v = Math.round(clamp01(gloss(x, y, i)) * 255);
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finishTexture(canvas, false, aniso);
}

export interface SurfaceMaps {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
  /** Mean height, used to keep tiling from jumping at LOD borders. */
  size: number;
}

// ---------------------------------------------------------------------------
// Asphalt
// ---------------------------------------------------------------------------

/**
 * Road surface: chipped aggregate, tar seams, hairline cracks and polished tyre
 * tracks. `u` runs across the carriageway so the wear sits where the wheels go.
 */
export function makeAsphaltMaps(aniso = 8): SurfaceMaps {
  const size = 1024;
  const aggregate = fbm(size, 5, 96, 1301, 0.55, 2);      // fine chips
  const patches = fbm(size, 3, 7, 4409, 0.6, 2);          // tar patch repairs
  const cracks = ridged(size, 4, 14, 8811);               // hairline cracking
  const wear = fbm(size, 2, 6, 2213, 0.5, 2);

  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size;
      const track = Math.exp(-((u - 0.3) ** 2) / 0.0016) + Math.exp(-((u - 0.7) ** 2) / 0.0016);
      const chip = Math.pow(aggregate[i], 1.5);
      const crack = Math.pow(cracks[i], 6);
      height[i] = chip * 0.55 - crack * 0.5 - track * 0.08 + patches[i] * 0.15 + wear[i] * 0.08;
    }
  }

  const map = albedoFrom(size, (x, y, i) => {
    const u = x / size;
    const track = Math.exp(-((u - 0.3) ** 2) / 0.0016) + Math.exp(-((u - 0.7) ** 2) / 0.0016);
    // Sparse bright aggregate: only the top of the noise field gets to be a
    // visible stone, otherwise the road reads as gravel.
    const chip = Math.pow(aggregate[i], 3.2);
    const crack = Math.pow(cracks[i], 7);
    const base = 0.26 + chip * 0.14 + patches[i] * 0.05 + wear[i] * 0.025;
    const v = base * (1 - track * 0.18) * (1 - crack * 0.45);
    // Very slight blue-grey cast, like aged bitumen.
    return [v * 0.98, v, v * 1.05];
  }, aniso);

  const normalMap = normalMapFrom(height, size, 1.4, aniso);

  const roughnessMap = glossFrom(size, (x, y, i) => {
    const u = x / size;
    const track = Math.exp(-((u - 0.3) ** 2) / 0.0016) + Math.exp(-((u - 0.7) ** 2) / 0.0016);
    // Polished tracks are smoother (glossier); fresh chips are rough.
    // Mostly rough: polished wheel tracks are slightly smoother than the open
    // surface, cracks and patches rougher.
    const roughness = 0.82 - track * 0.22 + Math.pow(cracks[i], 6) * 0.12 + patches[i] * 0.08 + Math.pow(aggregate[i], 3.2) * 0.1;
    return roughness;
  }, aniso);

  map.repeat.set(1, 1);
  return { map, normalMap, roughnessMap, size };
}

// ---------------------------------------------------------------------------
// Gravel / dirt
// ---------------------------------------------------------------------------

export function makeGravelMaps(aniso = 8): SurfaceMaps {
  const size = 512;
  const stones = fbm(size, 4, 40, 5501, 0.6, 2);
  const large = fbm(size, 3, 9, 3307);
  const dust = fbm(size, 4, 20, 991);
  const height = new Float32Array(size * size);
  for (let i = 0; i < height.length; i++) {
    height[i] = Math.pow(stones[i], 1.3) * 0.8 + large[i] * 0.3 + dust[i] * 0.15;
  }
  const map = albedoFrom(size, (x, y, i) => {
    const stone = Math.pow(stones[i], 1.4);
    const v = 0.22 + stone * 0.28 + dust[i] * 0.08;
    const warm = 1.02 + large[i] * 0.12;
    return [v * warm, v * 0.94, v * 0.82];
  }, aniso);
  return { map, normalMap: normalMapFrom(height, size, 3.0, aniso), roughnessMap: glossFrom(size, (x, y, i) => 0.78 + Math.pow(stones[i], 2) * 0.2, aniso), size };
}

export function makeDirtMaps(aniso = 8): SurfaceMaps {
  const size = 512;
  const grain = fbm(size, 5, 30, 7717, 0.55);
  const ruts = fbm(size, 2, 5, 1213, 0.5);
  const height = new Float32Array(size * size);
  for (let i = 0; i < height.length; i++) height[i] = grain[i] * 0.7 + ruts[i] * 0.35;
  const map = albedoFrom(size, (x, y, i) => {
    const v = 0.085 + grain[i] * 0.09 + ruts[i] * 0.045;
    return [v * 1.12, v * 0.94, v * 0.74];
  }, aniso);
  return { map, normalMap: normalMapFrom(height, size, 2.0, aniso), roughnessMap: glossFrom(size, (x, y, i) => 0.85 + grain[i] * 0.12, aniso), size };
}

// ---------------------------------------------------------------------------
// Ground detail (blended in the terrain shader)
// ---------------------------------------------------------------------------

export interface DetailMaps {
  albedo: THREE.CanvasTexture;
  normal: THREE.CanvasTexture;
}

function grassDetail(aniso: number): DetailMaps {
  const size = 512;
  const clumps = fbm(size, 4, 24, 611, 0.55);
  const blades = ridged(size, 3, 90, 4229);      // vertical-ish streaks read as blades
  const height = new Float32Array(size * size);
  for (let i = 0; i < height.length; i++) height[i] = blades[i] * 0.6 + clumps[i] * 0.5;
  const albedo = albedoFrom(size, (x, y, i) => {
    const b = Math.pow(blades[i], 1.5);
    // Near-neutral luminance detail: the *hue* comes from the biome vertex
    // colour, so a saturated detail map would multiply into neon grass.
    const v = 0.16 + b * 0.14 + clumps[i] * 0.05;
    return [v * 0.92, v, v * 0.82];
  }, aniso);
  return { albedo, normal: normalMapFrom(height, size, 2.2, aniso) };
}

function rockDetail(aniso: number): DetailMaps {
  const size = 512;
  const strata = fbm(size, 3, 8, 8821, 0.6);
  const cracks = ridged(size, 4, 22, 3313);
  const height = new Float32Array(size * size);
  for (let i = 0; i < height.length; i++) height[i] = strata[i] * 0.8 - Math.pow(cracks[i], 5) * 0.9;
  const albedo = albedoFrom(size, (x, y, i) => {
    const v = 0.15 + strata[i] * 0.1 - Math.pow(cracks[i], 6) * 0.06;
    return [v * 1.02, v, v * 0.95];
  }, aniso);
  return { albedo, normal: normalMapFrom(height, size, 3.6, aniso) };
}

function sandDetail(aniso: number): DetailMaps {
  const size = 512;
  const ripples = fbm(size, 3, 6, 1709, 0.4);
  const grain = fbm(size, 5, 120, 9091, 0.5);
  const height = new Float32Array(size * size);
  for (let i = 0; i < height.length; i++) {
    height[i] = Math.sin((ripples[i] * 6 + grain[i] * 2) * Math.PI * 2) * 0.25 + grain[i] * 0.6;
  }
  const albedo = albedoFrom(size, (x, y, i) => {
    const v = 0.2 + grain[i] * 0.12 + ripples[i] * 0.05;
    return [v * 1.06, v, v * 0.9];
  }, aniso);
  return { albedo, normal: normalMapFrom(height, size, 1.6, aniso) };
}

export interface GroundDetails {
  grass: DetailMaps;
  rock: DetailMaps;
  sand: DetailMaps;
}

export function makeGroundDetails(aniso = 8): GroundDetails {
  return { grass: grassDetail(aniso), rock: rockDetail(aniso), sand: sandDetail(aniso) };
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Fine hex-ish flake pattern for metallic paint clearcoat. */
export function makeFlakeNormal(aniso = 4): THREE.CanvasTexture {
  const size = 256;
  const height = fbm(size, 2, 64, 2027, 0.6);
  return normalMapFrom(height, size, 0.55, aniso);
}

/** Tiling fbm, single channel, used for cloud shadows and puddle masks. */
export function makeNoiseHeight(size = 256, seed = 1337): Float32Array {
  return fbm(size, 5, 4, seed, 0.55);
}

export function makeCloudTexture(aniso = 2): THREE.CanvasTexture {
  const size = 512;
  const base = fbm(size, 6, 4, 5501, 0.55);
  const detail = fbm(size, 5, 16, 2207, 0.5);
  const { canvas, ctx } = canvasFrom(size);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    // Higher contrast toward the top of the cloud so crowns read as lit.
    const v = clamp01(Math.pow(clamp01(base[i] * 1.35 - 0.42 + detail[i] * 0.28), 1.25));
    const c = Math.round(v * 255);
    img.data[i * 4] = c;
    img.data[i * 4 + 1] = c;
    img.data[i * 4 + 2] = c;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return finishTexture(canvas, false, aniso);
}

/** Rough concrete/plaster for buildings, with panel lines. */
export function makeConcreteMaps(aniso = 4): SurfaceMaps {
  const size = 512;
  const grain = fbm(size, 5, 48, 4409, 0.5);
  const stains = fbm(size, 3, 6, 811, 0.6);
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      // Panel joints every quarter of the tile, like precast cladding.
      const px = Math.min(x % (size / 4), size / 4 - (x % (size / 4))) / (size / 4);
      const py = Math.min(y % (size / 4), size / 4 - (y % (size / 4))) / (size / 4);
      const joint = Math.min(px, py) < 0.012 ? -0.5 : 0;
      height[i] = grain[i] * 0.5 + stains[i] * 0.2 + joint;
    }
  }
  const map = albedoFrom(size, (x, y, i) => {
    const px = Math.min(x % (size / 4), size / 4 - (x % (size / 4))) / (size / 4);
    const py = Math.min(y % (size / 4), size / 4 - (y % (size / 4))) / (size / 4);
    const joint = Math.min(px, py) < 0.012 ? 0.55 : 1;
    const v = (0.42 + grain[i] * 0.16 - stains[i] * 0.1) * joint;
    return [v, v * 0.99, v * 0.96];
  }, aniso);
  return { map, normalMap: normalMapFrom(height, size, 1.6, aniso), roughnessMap: glossFrom(size, (x, y, i) => 0.75 + grain[i] * 0.2, aniso), size };
}

/** Foliage: leaf clusters with alpha-free colour variation (used with vertex colours). */
export function makeFoliageMaps(aniso = 4): SurfaceMaps {
  const size = 512;
  const leaves = fbm(size, 5, 40, 3301, 0.6);
  const clumps = fbm(size, 3, 8, 6607, 0.55);
  const height = new Float32Array(size * size);
  for (let i = 0; i < height.length; i++) height[i] = Math.pow(leaves[i], 1.2) * 0.8 + clumps[i] * 0.3;
  const map = albedoFrom(size, (x, y, i) => {
    const v = 0.5 + leaves[i] * 0.5;
    return [v * 0.86, v, v * 0.7];
  }, aniso);
  return { map, normalMap: normalMapFrom(height, size, 2.0, aniso), roughnessMap: glossFrom(size, (x, y, i) => 0.72 + leaves[i] * 0.24, aniso), size };
}
