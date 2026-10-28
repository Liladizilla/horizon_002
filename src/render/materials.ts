import * as THREE from 'three';
import { mulberry32 } from '../core/rng';

function canvas(size: number) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  return { c, ctx: c.getContext('2d')! };
}

/** Fine grain detail texture used on terrain and asphalt to break up flat colour. */
export function makeNoiseTexture(size = 256, contrast = 0.22, tint: [number, number, number] = [1, 1, 1]): THREE.Texture {
  const { c, ctx } = canvas(size);
  const img = ctx.createImageData(size, size);
  const rnd = mulberry32(1337);
  for (let i = 0; i < size * size; i++) {
    const n = 1 - contrast * 0.5 + rnd() * contrast;
    img.data[i * 4 + 0] = Math.min(255, 255 * n * tint[0]);
    img.data[i * 4 + 1] = Math.min(255, 255 * n * tint[1]);
    img.data[i * 4 + 2] = Math.min(255, 255 * n * tint[2]);
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // A few darker speckles
  ctx.globalAlpha = 0.35;
  for (let i = 0; i < size * 1.2; i++) {
    const r = 0.5 + rnd() * 2.2;
    ctx.fillStyle = rnd() > 0.5 ? '#000' : '#fff';
    ctx.beginPath();
    ctx.arc(rnd() * size, rnd() * size, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

/** Asphalt: dark noise plus painted lane markings running along V. */
export function makeRoadTexture(): THREE.Texture {
  const size = 512;
  const { c, ctx } = canvas(size);
  // Straight sRGB values: aggregate is dark (0.06-0.10 linear), so the base is
  // much darker than a "grey" UI swatch would suggest.
  ctx.fillStyle = '#26272a';
  ctx.fillRect(0, 0, size, size);
  const rnd = mulberry32(4242);
  for (let i = 0; i < 22000; i++) {
    const v = 26 + rnd() * 48;
    ctx.fillStyle = `rgba(${v},${v},${v + 4},${0.25 + rnd() * 0.4})`;
    ctx.fillRect(rnd() * size, rnd() * size, 1 + rnd() * 2, 1 + rnd() * 2);
  }
  // subtle darker tyre tracks
  const grad = ctx.createLinearGradient(0, 0, size, 0);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.28, 'rgba(0,0,0,0.18)');
  grad.addColorStop(0.5, 'rgba(0,0,0,0)');
  grad.addColorStop(0.72, 'rgba(0,0,0,0.18)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

export function makeDirtTexture(): THREE.Texture {
  const size = 256;
  const { c, ctx } = canvas(size);
  ctx.fillStyle = '#4a3c2a';
  ctx.fillRect(0, 0, size, size);
  const rnd = mulberry32(99);
  for (let i = 0; i < 14000; i++) {
    const v = rnd();
    ctx.fillStyle = v > 0.5 ? `rgba(92,76,54,0.45)` : `rgba(46,36,24,0.45)`;
    ctx.fillRect(rnd() * size, rnd() * size, 1 + rnd() * 3, 1 + rnd() * 3);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

export interface MaterialSet {
  terrain: THREE.MeshStandardMaterial;
  asphalt: THREE.MeshStandardMaterial;
  dirt: THREE.MeshStandardMaterial;
  gravel: THREE.MeshStandardMaterial;
  markings: THREE.MeshStandardMaterial;
  water: THREE.MeshStandardMaterial;
  foliage: THREE.MeshLambertMaterial;
  rock: THREE.MeshStandardMaterial;
  building: THREE.MeshStandardMaterial;
  foliageDepth?: THREE.MeshLambertMaterial;
}

export function createMaterials(quality: { anisotropic: number }): MaterialSet {
  const detail = makeNoiseTexture(256, 0.3);
  detail.repeat.set(28, 28);
  detail.anisotropy = quality.anisotropic;

  const road = makeRoadTexture();
  road.repeat.set(1, 1);
  const dirt = makeDirtTexture();

  return {
    terrain: new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.94, metalness: 0.0, map: detail, dithering: true,
    }),
    // polygonOffset keeps the thin road ribbons and markings from z-fighting the
    // terrain grid they are laid over.
    asphalt: new THREE.MeshStandardMaterial({
      color: 0xffffff, map: road, roughness: 0.72, metalness: 0.02,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    }),
    dirt: new THREE.MeshStandardMaterial({
      color: 0x6f5b42, map: dirt, roughness: 0.95,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    }),
    gravel: new THREE.MeshStandardMaterial({
      color: 0x7d756a, map: dirt, roughness: 0.98,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    }),
    markings: new THREE.MeshStandardMaterial({
      color: 0xe8e6dd, roughness: 0.55,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
    }),
    water: new THREE.MeshStandardMaterial({ color: 0x1c4a63, roughness: 0.08, metalness: 0.35, transparent: true, opacity: 0.86 }),
    foliage: new THREE.MeshLambertMaterial({ vertexColors: true }),
    rock: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true }),
    building: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.05 }),
  };
}
