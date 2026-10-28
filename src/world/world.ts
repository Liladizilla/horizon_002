import * as THREE from 'three';
import { ColliderDesc, RigidBodyDesc, type World as RapierWorld, type RigidBody } from '@dimforge/rapier3d-compat';
import { clamp, lerp, smoothstep } from '../core/math';
import type { SurfaceId } from '../core/types';
import { baseHeight, biomeWeights, biomeColor, WORLD_SIZE, SEA_LEVEL } from './terrain';
import { buildRoadNetwork, RoadGraph, type RoadField, type RoadInstance } from './roads';
import { generateChunkProps, CHUNK_SIZE, type PropInstance, type PropType } from './props';
import { buildPropGeometries, propMaterial, BUILDING_TINTS } from '../render/worldMeshes';
import type { MaterialSet } from '../render/materials';
import { mulberry32, hash2 } from '../core/rng';

export const BASE_RES = 8;
const BASE_N = Math.ceil(WORLD_SIZE / BASE_RES) + 1;
const HALF_WORLD = WORLD_SIZE / 2;

const PHYS_RES = 4;             // Rapier heightfield cell size
const PHYS_SUBDIV = CHUNK_SIZE / PHYS_RES; // 128
const VIS_NEAR_RES = 8;
const VIS_FAR_RES = 16;

const VIEW_RADIUS = 1150;       // chunks with visuals
const ROAD_LIFT = 0.09;         // road mesh sits this far above the height field
const PHYSICS_RADIUS = 620;     // chunks with collision

interface Chunk {
  cx: number; cz: number;
  mesh: THREE.Mesh | null;
  visRes: number;
  body: RigidBody | null;
  propMeshes: THREE.InstancedMesh[];
  propsLoaded: boolean;
  instanceList: PropInstance[];
  meshGroup: THREE.Group;
}

export interface WorldQuality {
  foliageDensity: number;
  shadows: boolean;
  anisotropy: number;
}

export class GameWorld {
  readonly field: RoadField;
  readonly graph: RoadGraph;
  private baseGrid: Float32Array;
  private scene: THREE.Scene;
  private materials: MaterialSet;
  /** Rapier world for car bodies and colliders (shared, authoritative). */
  readonly rapier: RapierWorld;
  private quality: WorldQuality;

  readonly chunks = new Map<string, Chunk>();
  private propGeometries: Record<PropType, THREE.BufferGeometry>;
  private roadMeshes: THREE.Mesh[] = [];
  private water: THREE.Mesh;
  private buildQueue: { cx: number; cz: number; dist: number }[] = [];

  /** Live wetness 0..1 used by the surface sampler. */
  wetness = 0;
  /** Height of the sea surface. */
  readonly seaLevel = SEA_LEVEL;

  private tmp: { dist: number; width: number; roadId: string | null } = { dist: Infinity, width: 0, roadId: null };

  constructor(scene: THREE.Scene, rapier: RapierWorld, materials: MaterialSet, quality: WorldQuality) {
    this.scene = scene;
    this.rapier = rapier;
    this.materials = materials;
    this.quality = quality;

    // --- base height grid (bilinear source for everything) ---
    this.baseGrid = new Float32Array(BASE_N * BASE_N);
    for (let j = 0; j < BASE_N; j++) {
      const z = j * BASE_RES - HALF_WORLD;
      for (let i = 0; i < BASE_N; i++) {
        const x = i * BASE_RES - HALF_WORLD;
        this.baseGrid[j * BASE_N + i] = baseHeight(x, z);
      }
    }

    this.field = buildRoadNetwork();
    this.graph = new RoadGraph(this.field);
    this.propGeometries = buildPropGeometries();

    this.buildRoadMeshes();

    // --- sea ---
    const waterGeo = new THREE.PlaneGeometry(WORLD_SIZE * 1.6, WORLD_SIZE * 1.6, 1, 1);
    waterGeo.rotateX(-Math.PI / 2);
    this.water = new THREE.Mesh(waterGeo, materials.water);
    this.water.position.y = SEA_LEVEL;
    this.water.receiveShadow = false;
    this.water.renderOrder = -1;
    scene.add(this.water);
  }

  // ------------------------------------------------------------- sampling
  private baseAt(x: number, z: number): number {
    const fx = (x + HALF_WORLD) / BASE_RES;
    const fz = (z + HALF_WORLD) / BASE_RES;
    const i0 = clamp(Math.floor(fx), 0, BASE_N - 2);
    const j0 = clamp(Math.floor(fz), 0, BASE_N - 2);
    const tx = clamp(fx - i0, 0, 1), tz = clamp(fz - j0, 0, 1);
    const a = this.baseGrid[j0 * BASE_N + i0];
    const b = this.baseGrid[j0 * BASE_N + i0 + 1];
    const c = this.baseGrid[(j0 + 1) * BASE_N + i0];
    const d = this.baseGrid[(j0 + 1) * BASE_N + i0 + 1];
    return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
  }

  /** Terrain height including road corridors. The single source of truth. */
  heightAt(x: number, z: number): number {
    let h = this.baseAt(x, z);
    const rc = this.field.heightContribution(x, z);
    if (rc.blend > 0.001) h = lerp(h, rc.y, rc.blend);
    // Keep the playable area above the sea floor so cars never sink into an abyss.
    return Math.max(h, -3.2);
  }

  /**
   * Height a car should be placed at. On a road corridor the road surface mesh
   * can sit a few centimetres above the blended terrain, so the higher of the
   * two is used to avoid spawning inside the road collider.
   */
  driveY(x: number, z: number): number {
    const h = this.heightAt(x, z);
    const road = this.field.nearest(x, z);
    if (road.sample && road.dist < road.sample.width * 0.55) return Math.max(h, road.sample.y);
    return h;
  }

  /** Surface sampler bound into every vehicle. */
  surfaceSampler = (x: number, y: number, z: number, normalY: number) => {
    const road = this.field.surfaceAt(x, z, y, normalY);
    if (road.onRoad > 0.45) return { id: road.surface, wetness: this.wetness };
    if (y < SEA_LEVEL + 0.6) return { id: 'water' as SurfaceId, wetness: 1 };
    const w = biomeWeights(x, z);
    let id: SurfaceId = 'grass';
    if (y > 240 + (Math.sin(x * 0.01) + Math.cos(z * 0.013)) * 12) id = 'snow';
    else if (w.desert > 0.35) id = 'sand';
    else if (w.coast > 0.4 && y < 6) id = 'sand';
    else if (w.volcanic > 0.45) id = 'gravel';
    else if (w.mountain > 0.5 && normalY < 0.8) id = 'gravel';
    else if (w.farm > 0.45) id = 'grass';
    if (normalY < 0.72) id = 'gravel';
    return { id, wetness: this.wetness };
  };

  roadInfoAt(x: number, z: number) {
    const n = this.field.nearest(x, z);
    const s = n.sample;
    this.tmp.dist = n.dist;
    this.tmp.width = s ? s.width : 0;
    this.tmp.roadId = s ? s.roadId : null;
    return this.tmp;
  }

  /** True when the point is on a drivable road surface. */
  onRoad(x: number, z: number, tolerance = 0): boolean {
    const info = this.roadInfoAt(x, z);
    return info.roadId !== null && info.dist < info.width * 0.5 + tolerance;
  }

  /** Nearest road sample with heading, for spawning and resets. */
  nearestRoad(x: number, z: number) {
    return this.field.nearest(x, z);
  }

  // ------------------------------------------------------------- roads mesh
  private buildRoadMeshes() {
    const groups: Record<string, { positions: number[]; normals: number[]; uvs: number[]; indices: number[] }> = {};
    const markingPositions: number[] = [];
    const markingIndices: number[] = [];

    for (const inst of this.field.instances) {
      const surface = inst.def.surface;
      const key = surface === 'asphaltDry' ? 'asphalt' : surface === 'gravel' ? 'gravel' : 'dirt';
      const g = groups[key] ??= { positions: [], normals: [], uvs: [], indices: [] };
      const halfW = inst.def.width / 2;
      const baseIndex = g.positions.length / 3;

      // The ribbon is sampled across its width, not just at the edges: the
      // terrain mesh is built on a coarser grid than the road, so a two-vertex
      // chord would sink below the terrain wherever the corridor has camber or
      // a crest. Every vertex sits on the same height field the collision mesh
      // uses, plus a small lift, so the visible road and the surface the tyres
      // raycast against describe the same shape.
      const SPAN = [-1, -0.55, 0, 0.55, 1];
      for (let i = 0; i < inst.samples.length; i++) {
        const s = inst.samples[i];
        const nx = -s.dz, nz = s.dx; // left normal
        for (const f of SPAN) {
          const px = s.x + nx * halfW * f;
          const pz = s.z + nz * halfW * f;
          g.positions.push(px, this.heightAt(px, pz) + ROAD_LIFT, pz);
          g.normals.push(0, 1, 0);
          g.uvs.push((f + 1) * 0.5, s.s / 8);
        }
        if (i > 0) {
          const rowA = baseIndex + (i - 1) * SPAN.length;
          const rowB = baseIndex + i * SPAN.length;
          for (let k = 0; k < SPAN.length - 1; k++) {
            g.indices.push(rowA + k, rowA + k + 1, rowB + k, rowA + k + 1, rowB + k + 1, rowB + k);
          }
        }
      }

      // Centre line markings for asphalt roads
      if (key === 'asphalt') {
        const step = 4;
        for (let i = 0; i < inst.samples.length - step; i += step * 2) {
          const s = inst.samples[i];
          const s2 = inst.samples[Math.min(i + step, inst.samples.length - 1)];
          const nx = -s.dz, nz = s.dx;
          const w = 0.09;
          const y1 = this.heightAt(s.x, s.z) + ROAD_LIFT + 0.02;
          const y2 = this.heightAt(s2.x, s2.z) + ROAD_LIFT + 0.02;
          const b = markingPositions.length / 3;
          markingPositions.push(
            s.x + nx * w, y1, s.z + nz * w,
            s.x - nx * w, y1, s.z - nz * w,
            s2.x + nx * w, y2, s2.z + nz * w,
            s2.x - nx * w, y2, s2.z - nz * w,
          );
          markingIndices.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
        }
      }
    }

    const materialFor = (key: string) => (key === 'asphalt' ? this.materials.asphalt : key === 'gravel' ? this.materials.gravel : this.materials.dirt);
    for (const [key, g] of Object.entries(groups)) {
      if (g.positions.length === 0) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(g.positions, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.normals, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uvs, 2));
      geo.setIndex(g.indices);
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, materialFor(key));
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.scene.add(mesh);
      this.roadMeshes.push(mesh);
    }

    if (markingPositions.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(markingPositions, 3));
      geo.setIndex(markingIndices);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, this.materials.markings);
      mesh.matrixAutoUpdate = false;
      this.scene.add(mesh);
      this.roadMeshes.push(mesh);
    }
  }

  // ------------------------------------------------------------- streaming
  private chunkKey(cx: number, cz: number) { return `${cx},${cz}`; }

  update(playerPos: THREE.Vector3, budgetMs = 6) {
    const start = performance.now();
    const pcx = Math.floor(playerPos.x / CHUNK_SIZE);
    const pcz = Math.floor(playerPos.z / CHUNK_SIZE);
    const maxChunkRadius = Math.ceil(VIEW_RADIUS / CHUNK_SIZE);

    // Queue missing chunks, nearest first.
    const wanted: { cx: number; cz: number; dist: number }[] = [];
    for (let dx = -maxChunkRadius; dx <= maxChunkRadius; dx++) {
      for (let dz = -maxChunkRadius; dz <= maxChunkRadius; dz++) {
        const cx = pcx + dx, cz = pcz + dz;
        const centerX = (cx + 0.5) * CHUNK_SIZE, centerZ = (cz + 0.5) * CHUNK_SIZE;
        const dist = Math.hypot(centerX - playerPos.x, centerZ - playerPos.z);
        if (dist > VIEW_RADIUS + CHUNK_SIZE * 0.75) continue;
        if (!this.chunks.has(this.chunkKey(cx, cz))) wanted.push({ cx, cz, dist });
      }
    }
    wanted.sort((a, b) => a.dist - b.dist);
    for (const w of wanted) {
      if (performance.now() - start > budgetMs) break;
      this.loadChunk(w.cx, w.cz);
    }

    // Unload distant chunks.
    for (const [key, chunk] of this.chunks) {
      const centerX = (chunk.cx + 0.5) * CHUNK_SIZE, centerZ = (chunk.cz + 0.5) * CHUNK_SIZE;
      const dist = Math.hypot(centerX - playerPos.x, centerZ - playerPos.z);
      if (dist > VIEW_RADIUS + CHUNK_SIZE * 1.6) this.unloadChunk(key, chunk);
      else this.updateChunkLod(chunk, dist);
    }
  }

  /** Pre-build every chunk that the player can see from a start position. */
  preload(center: THREE.Vector3, onProgress?: (p: number) => void) {
    const pcx = Math.floor(center.x / CHUNK_SIZE);
    const pcz = Math.floor(center.z / CHUNK_SIZE);
    const radius = Math.ceil(VIEW_RADIUS / CHUNK_SIZE);
    const list: { cx: number; cz: number; dist: number }[] = [];
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const cx = pcx + dx, cz = pcz + dz;
        const dist = Math.hypot((cx + 0.5) * CHUNK_SIZE - center.x, (cz + 0.5) * CHUNK_SIZE - center.z);
        if (dist <= VIEW_RADIUS + CHUNK_SIZE * 0.75) list.push({ cx, cz, dist });
      }
    }
    list.sort((a, b) => a.dist - b.dist);
    list.forEach((c, i) => {
      this.loadChunk(c.cx, c.cz);
      onProgress?.((i + 1) / list.length);
    });
  }

  private loadChunk(cx: number, cz: number) {
    const key = this.chunkKey(cx, cz);
    if (this.chunks.has(key)) return;
    const chunk: Chunk = {
      cx, cz, mesh: null, visRes: 0, body: null, propMeshes: [], propsLoaded: false,
      instanceList: [], meshGroup: new THREE.Group(),
    };
    this.chunks.set(key, chunk);
    this.buildChunkMesh(chunk, VIS_NEAR_RES);
    this.buildChunkProps(chunk);
    this.buildChunkCollider(chunk);
    this.scene.add(chunk.meshGroup);
  }

  private unloadChunk(key: string, chunk: Chunk) {
    if (chunk.mesh) { chunk.mesh.geometry.dispose(); chunk.meshGroup.remove(chunk.mesh); chunk.mesh = null; }
    for (const m of chunk.propMeshes) { m.dispose(); chunk.meshGroup.remove(m); }
    chunk.propMeshes.length = 0;
    if (chunk.body) { this.rapier.removeRigidBody(chunk.body); chunk.body = null; }
    this.scene.remove(chunk.meshGroup);
    this.chunks.delete(key);
  }

  private updateChunkLod(chunk: Chunk, dist: number) {
    const wantRes = dist < 620 ? VIS_NEAR_RES : VIS_FAR_RES;
    if (wantRes !== chunk.visRes) this.buildChunkMesh(chunk, wantRes);
    const wantPhysics = dist < PHYSICS_RADIUS;
    if (wantPhysics && !chunk.body) this.buildChunkCollider(chunk);
    else if (!wantPhysics && chunk.body) { this.rapier.removeRigidBody(chunk.body); chunk.body = null; }
  }

  // --------------------------------------------------------------- terrain
  private buildChunkMesh(chunk: Chunk, res: number) {
    if (chunk.mesh) { chunk.mesh.geometry.dispose(); chunk.meshGroup.remove(chunk.mesh); }
    const n = Math.floor(CHUNK_SIZE / res) + 1;
    const originX = chunk.cx * CHUNK_SIZE;
    const originZ = chunk.cz * CHUNK_SIZE;
    const positions = new Float32Array(n * n * 3);
    const colors = new Float32Array(n * n * 3);
    const uvs = new Float32Array(n * n * 2);
    const indices: number[] = [];

    const heights = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        heights[j * n + i] = this.heightAt(originX + i * res, originZ + j * res);
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const idx = j * n + i;
        const x = originX + i * res, z = originZ + j * res;
        const y = heights[idx];
        positions[idx * 3] = x; positions[idx * 3 + 1] = y; positions[idx * 3 + 2] = z;
        const hL = heights[j * n + Math.max(0, i - 1)];
        const hR = heights[j * n + Math.min(n - 1, i + 1)];
        const hD = heights[Math.max(0, j - 1) * n + i];
        const hU = heights[Math.min(n - 1, j + 1) * n + i];
        const slope = Math.hypot((hR - hL) / (2 * res), (hU - hD) / (2 * res));
        const c = biomeColor(x, z, y, slope);
        colors[idx * 3] = c[0]; colors[idx * 3 + 1] = c[1]; colors[idx * 3 + 2] = c[2];
        uvs[idx * 2] = (x + HALF_WORLD) / 40;
        uvs[idx * 2 + 1] = (z + HALF_WORLD) / 40;
      }
    }
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i, b = j * n + i + 1, c = (j + 1) * n + i, d = (j + 1) * n + i + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(geo, this.materials.terrain);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    chunk.mesh = mesh;
    chunk.visRes = res;
    chunk.meshGroup.add(mesh);
  }

  /** Rapier heightfield built from the exact same sampling function. */
  private buildChunkCollider(chunk: Chunk) {
    if (chunk.body) return;
    // One cell of overlap on every side: neighbouring heightfields then share a
    // strip of geometry, so a fast car can never slip through the seam between
    // two chunks. (Without the margin, borders meet edge-to-edge only.)
    const n = PHYS_SUBDIV + 2;
    const span = n * PHYS_RES;
    const heights = new Float32Array((n + 1) * (n + 1));
    const originX = chunk.cx * CHUNK_SIZE;
    const originZ = chunk.cz * CHUNK_SIZE;
    const startX = originX - PHYS_RES;
    const startZ = originZ - PHYS_RES;
    const centerX = startX + span / 2;
    const centerZ = startZ + span / 2;
    // Rapier indexes heights[i * (n+1) + j] with i along local X and j along local Z.
    for (let i = 0; i <= n; i++) {
      const x = startX + i * PHYS_RES;
      for (let j = 0; j <= n; j++) {
        const z = startZ + j * PHYS_RES;
        heights[i * (n + 1) + j] = this.heightAt(x, z);
      }
    }
    const body = this.rapier.createRigidBody(
      RigidBodyDesc.fixed().setTranslation(centerX, 0, centerZ),
    );
    this.rapier.createCollider(
      ColliderDesc.heightfield(n, n, heights, { x: span, y: 1, z: span })
        .setFriction(1.0)
        .setRestitution(0.05)
        .setCollisionGroups(0x00010007),
      body,
    );
    chunk.body = body;
    // Prop colliders ride on the same chunk body.
    for (const prop of chunk.instanceList) {
      if (!['treePine', 'treeBroad', 'palm', 'rock', 'building', 'barn', 'cactus'].includes(prop.type)) continue;
      const s = prop.scale;
      const isTree = prop.type.startsWith('tree') || prop.type === 'palm' || prop.type === 'cactus';
      if (isTree) {
        this.rapier.createCollider(
          ColliderDesc.cylinder(s * 2.2, Math.max(0.25, s * 0.24))
            .setTranslation(prop.x - centerX, prop.y + s * 2.2, prop.z - centerZ)
            .setFriction(0.8),
          body,
        );
      } else if (prop.type === 'rock') {
        this.rapier.createCollider(
          ColliderDesc.ball(s * 0.9)
            .setTranslation(prop.x - centerX, prop.y + s * 0.4, prop.z - centerZ)
            .setFriction(0.9),
          body,
        );
      } else {
        const w = prop.type === 'barn' ? 5 : 3.4 * s;
        const h = prop.type === 'barn' ? 5 : 4.2 * s;
        const d = prop.type === 'barn' ? 8 : 5.5 * s;
        this.rapier.createCollider(
          ColliderDesc.cuboid(w, h / 2, d)
            .setTranslation(prop.x - centerX, prop.y + h / 2, prop.z - centerZ)
            .setFriction(0.7),
          body,
        );
      }
    }
  }

  // ----------------------------------------------------------------- props
  private buildChunkProps(chunk: Chunk) {
    if (chunk.propsLoaded) return;
    const data = generateChunkProps(
      chunk.cx, chunk.cz,
      (x, z) => this.heightAt(x, z),
      (x, z) => this.roadInfoAt(x, z),
      this.quality.foliageDensity,
    );
    chunk.instanceList = data.instances;
    chunk.propsLoaded = true;

    const byType = new Map<PropType, PropInstance[]>();
    for (const inst of data.instances) {
      const arr = byType.get(inst.type);
      if (arr) arr.push(inst); else byType.set(inst.type, [inst]);
    }
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const rnd = mulberry32(Math.floor(hash2(chunk.cx, chunk.cz, 7717) * 4294967295));

    for (const [type, list] of byType) {
      const geo = this.propGeometries[type];
      if (!geo) continue;
      const matKey = propMaterial(type);
      const material = matKey === 'rock' ? this.materials.rock : matKey === 'building' ? this.materials.building : this.materials.foliage;
      const mesh = new THREE.InstancedMesh(geo, material, list.length);
      mesh.castShadow = this.quality.shadows && type !== 'bush';
      mesh.receiveShadow = false;
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(p.tilt ?? 0, p.rotation, (p.tilt ?? 0) * 0.5);
        const s = p.scale;
        if (type === 'building') dummy.scale.set(s, s * (1 + (p.scale % 0.7)), s);
        else dummy.scale.set(s, s, s);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        if (type === 'building' || type === 'barn') {
          color.setHex(BUILDING_TINTS[Math.floor(rnd() * BUILDING_TINTS.length)]);
          mesh.setColorAt(i, color);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.frustumCulled = true;
      mesh.computeBoundingSphere();
      chunk.propMeshes.push(mesh);
      chunk.meshGroup.add(mesh);
    }
  }

  // ----------------------------------------------------------------- misc
  setWetness(w: number) {
    this.wetness = w;
    // Wet asphalt looks darker and shinier.
    const t = clamp(w, 0, 1);
    this.materials.asphalt.color.setRGB(1 - t * 0.45, 1 - t * 0.45, 1 - t * 0.42);
    this.materials.asphalt.roughness = lerp(0.72, 0.16, t);
    this.materials.asphalt.metalness = lerp(0.02, 0.28, t);
    this.materials.terrain.color.setRGB(1 - t * 0.12, 1 - t * 0.12, 1 - t * 0.12);
  }

  /** World-space bounds check and a safe respawn pose nearest the given point. */
  safeRespawn(x: number, z: number): { x: number; y: number; z: number; yaw: number } {
    const road = this.field.nearest(x, z);
    if (road.sample) {
      const s = road.sample;
      return { x: s.x, y: this.driveY(s.x, s.z) + 0.5, z: s.z, yaw: Math.atan2(s.dx, s.dz) };
    }
    return { x, y: this.driveY(x, z) + 0.5, z, yaw: 0 };
  }

  dispose() {
    for (const [key, chunk] of this.chunks) this.unloadChunk(key, chunk);
    for (const m of this.roadMeshes) { m.geometry.dispose(); this.scene.remove(m); }
    this.scene.remove(this.water);
    this.water.geometry.dispose();
  }
}
