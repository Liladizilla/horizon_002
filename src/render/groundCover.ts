/**
 * Ground cover.
 *
 * Terrain can be perfectly normal-mapped and still read as a flat green field,
 * because at eye height the thing that gives a field its scale is the near-field
 * scatter of grass, weeds and scrub. This layer is a single instanced draw of
 * crossed alpha-cutout cards that lives in a moving disc around the camera:
 *
 *  - placement is a hashed jittered grid, so it is deterministic and needs no
 *    per-chunk bookkeeping; the disc re-centres when the camera has moved a few
 *    metres, which is cheaper than streaming cover per chunk;
 *  - density falls off toward the rim so the boundary of the disc is not a
 *    visible circle;
 *  - tufts are skipped on roads, on steep slopes, under water and in bare rock
 *    or sand, using the same surface queries the tyres use;
 *  - the cards wind-sway in the vertex shader, scaled by quality, and are drawn
 *    with `alphaTest` so no sorting or per-frame blending cost is incurred.
 */
import * as THREE from 'three';
import { mulberry32 } from '../core/rng';
import { makeGrassTuftTexture } from './textures';
import type { SharedUniforms } from './materials';

export interface CoverPlacement {
  heightAt: (x: number, z: number) => number;
  /** True where cover must not grow: tarmac, shoulders, water, bare rock. */
  isBare: (x: number, z: number, y: number) => boolean;
  /** Optional rejection reason, for telemetry only. */
  bareReason?: (x: number, z: number, y: number) => string | null;
  /** Biome tint in linear RGB, so tufts match the ground they grow out of. */
  tintAt: (x: number, z: number) => [number, number, number];
}

export interface CoverOptions {
  radius: number;
  density: number;
  sway: number;
  shared: SharedUniforms;
}

const MAX_INSTANCES = 9000;
const CELL = 1.25;

/** One crossed-card tuft: three quads at 60° with upward normals. */
function tuftGeometry(): THREE.BufferGeometry {
  const planes: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const w = 0.42;
  const h = 0.42;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI;
    const dx = Math.cos(a) * w;
    const dz = Math.sin(a) * w;
    const b = planes.length / 3;
    // Two triangles forming a quad standing on the ground plane.
    planes.push(-dx, 0, -dz, dx, 0, dz, dx, h, dz, -dx, h, -dz);
    // Flat-up normals: cards lit like the ground beneath them instead of
    // going black when seen edge-on.
    for (let k = 0; k < 4; k++) normals.push(0, 1, 0);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(planes, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

export class GroundCover {
  readonly mesh: THREE.InstancedMesh;
  private opts: CoverOptions;
  private lastX = Number.POSITIVE_INFINITY;
  private lastZ = Number.POSITIVE_INFINITY;
  private placed = 0;
  /** Wall-clock cost of the last rebuild, for the perf/regression probes. */
  lastRebuildMs = 0;
  /** Why candidates were rejected, for the visual/perf probes. */
  rejections: Record<string, number> = {};

  constructor(opts: CoverOptions) {
    this.opts = opts;
    // NOTE: no `vertexColors` here. Instance colour is applied through
    // USE_INSTANCING_COLOR, which three enables from `instanceColor` alone; the
    // flag would additionally declare a per-vertex `color` attribute that this
    // geometry does not have, and unbound attributes read as black.
    const material = new THREE.MeshStandardMaterial({
      map: makeGrassTuftTexture(256),
      alphaTest: 0.42,
      side: THREE.DoubleSide,
      roughness: 0.92,
      metalness: 0,
      envMapIntensity: 0.35,
    });
    // Per-instance sway phase + wind displacement in the vertex shader.
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = opts.shared.time;
      shader.uniforms.uSway = { value: opts.sway };
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform float uTime;
           uniform float uSway;
           attribute float aPhase;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           // Bend the card, not the instance: displacement grows with height so
           // the roots stay planted.
           float bend = sin(uTime * 1.7 + aPhase) * 0.5 + sin(uTime * 2.9 + aPhase * 2.1) * 0.25;
           float lift = clamp(transformed.y / 0.42, 0.0, 1.0);
           transformed.x += bend * uSway * lift * lift;
           transformed.z += bend * uSway * 0.45 * lift * lift;`,
        );
    };
    material.customProgramCacheKey = () => 'hd-ground-cover-v1';

    const geo = tuftGeometry();
    const phase = new Float32Array(MAX_INSTANCES);
    const rnd = mulberry32(4242);
    for (let i = 0; i < MAX_INSTANCES; i++) phase[i] = rnd() * Math.PI * 2;
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));

    this.mesh = new THREE.InstancedMesh(geo, material, MAX_INSTANCES);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // The disc follows the camera, so its bounds change every rebuild.
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 0;
  }

  /** Rebuilds the disc when the camera has moved far enough to notice. */
  update(camX: number, camZ: number, place: CoverPlacement, force = false) {
    if (!force && Math.hypot(camX - this.lastX, camZ - this.lastZ) < 6) return;
    this.lastX = camX;
    this.lastZ = camZ;
    const t0 = performance.now();
    this.rebuild(camX, camZ, place);
    this.lastRebuildMs = performance.now() - t0;
  }

  private rebuild(camX: number, camZ: number, place: CoverPlacement) {
    const { radius, density } = this.opts;
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    let n = 0;
    const cells = Math.ceil(radius / CELL);
    const rnd = mulberry32(90210);
    for (let iz = -cells; iz <= cells && n < MAX_INSTANCES; iz++) {
      for (let ix = -cells; ix <= cells && n < MAX_INSTANCES; ix++) {
        // Hashed jitter inside each cell: stable per cell, no visible grid.
        const h1 = Math.sin(ix * 127.1 + iz * 311.7) * 43758.5453;
        const h2 = Math.sin(ix * 269.5 + iz * 183.3) * 41337.1234;
        const jx = (h1 - Math.floor(h1)) - 0.5;
        const jz = (h2 - Math.floor(h2)) - 0.5;
        const x = camX + (ix + jx) * CELL;
        const z = camZ + (iz + jz) * CELL;
        const dist = Math.hypot(x - camX, z - camZ);
        if (dist > radius) continue;
        // Fade density out with distance so the disc edge is not a ring.
        const falloff = 1 - Math.min(1, dist / radius) ** 1.6;
        if (rnd() > density * falloff) continue;
        const y = place.heightAt(x, z);
        if (place.isBare(x, z, y)) {
          const why = place.bareReason?.(x, z, y);
          if (why) this.rejections[why] = (this.rejections[why] ?? 0) + 1;
          continue;
        }
        const scale = 0.55 + rnd() * 0.55;
        dummy.position.set(x, y - 0.02, z);
        dummy.rotation.set(0, rnd() * Math.PI, 0);
        dummy.scale.set(scale, scale * (0.8 + rnd() * 0.6), scale);
        dummy.updateMatrix();
        this.mesh.setMatrixAt(n, dummy.matrix);
        const tint = place.tintAt(x, z);
        // Brighten and slightly desaturate relative to the ground so the blades
        // read as new growth rather than decals.
        // Slightly lighter than the ground so blades catch the sun, but nowhere
        // near the blown-out stalks a bigger multiplier produced.
        color.setRGB(
          Math.min(1, tint[0] * 0.55 + 0.05),
          Math.min(1, tint[1] * 0.6 + 0.06),
          Math.min(1, tint[2] * 0.5 + 0.03),
        );
        this.mesh.setColorAt(n, color);
        n++;
      }
    }
    this.mesh.count = n;
    this.placed = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  get instanceCount() { return this.placed; }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
