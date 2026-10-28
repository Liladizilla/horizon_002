/**
 * Procedural vehicle meshes.
 *
 * Bodies are *lofted*: a set of cross-sections along the car's length, each a
 * rounded-rectangle profile with its own width, height, shoulder radius and
 * tumblehome, joined into a smooth quad grid with computed normals. That gives a
 * chamfered, panel-like body with wheel arches instead of an extruded slab, at a
 * few thousand triangles per car.
 *
 * Everything else is modelled too: arch liners, side skirts, bumpers with
 * grilles, glass with a separate clearcoat, mirror stalks, panel-gap seams,
 * multi-spoke wheels with brake discs and calipers, emissive light clusters and
 * an interior visible through the glass.
 */
import * as THREE from 'three';
import type { VehicleSpec } from '../vehicles/spec';
import type { VehicleSim } from '../physics/vehicle';
import { createCarMaterials } from './materials';
import type { SharedUniforms } from './materials';

export type PaintFinish = 'gloss' | 'metallic' | 'matte' | 'chrome' | 'pearl';

export interface CarAppearance {
  color: string;
  finish: PaintFinish;
  rimColor?: string;
  tint?: string;
}

interface SectionShape {
  /** 0 = rear, 1 = front */
  t: number;
  /** Half-width in metres */
  halfWidth: number;
  /** Bottom of the section (sill height) */
  bottom: number;
  /** Top of the section (roof / bonnet height) */
  top: number;
  /** Corner rounding, 0..1 of the smaller dimension */
  round: number;
  /** Roof inset (greenhouse tapers inboard) */
  inset: number;
}

// Must stay divisible by 4: the rounded-rect walk emits an equal number of
// points per corner so consecutive rings line up without twisting.
const PROFILE_POINTS = 24;

/** One closed rounded-rectangle cross-section, resampled to a fixed count. */
function sectionPolygon(s: SectionShape, out: THREE.Vector2[]) {
  const w = s.halfWidth;
  const h = s.top - s.bottom;
  const cy = (s.top + s.bottom) * 0.5;
  const r = Math.max(0.02, Math.min(w, h * 0.5) * s.round);
  // Rounded rect described as 4 arcs; we walk it with a fixed number of points
  // so vertices line up between sections and the loft does not twist.
  const corners: [number, number, number][] = [
    [w - r, cy + h * 0.5 - r, 0],
    [-(w - r), cy + h * 0.5 - r, Math.PI * 0.5],
    [-(w - r), cy - h * 0.5 + r, Math.PI],
    [w - r, cy - h * 0.5 + r, Math.PI * 1.5],
  ];
  const perCorner = PROFILE_POINTS / 4;
  let idx = 0;
  for (const [cx, cyy, start] of corners) {
    for (let i = 0; i < perCorner; i++) {
      const a = start + (i / perCorner) * (Math.PI * 0.5);
      const px = cx + Math.cos(a) * r;
      const py = cyy + Math.sin(a) * r;
      if (out[idx]) out[idx].set(px * (1 - s.inset), py);
      else out[idx] = new THREE.Vector2(px * (1 - s.inset), py);
      idx++;
    }
  }
  return out;
}

/** Sections per body style: how the car is built up along its length. */
function shapesFor(spec: VehicleSpec): SectionShape[] {
  const W = spec.width * 0.5;
  const L = spec.length;
  const ground = 0.16;
  const style = spec.bodyStyle;
  const base = (t: number, halfWidth: number, bottom: number, top: number, round: number, inset = 0): SectionShape =>
    ({ t, halfWidth, bottom, top, round, inset });
  switch (style) {
    case 'supercar':
      return [
        base(0.0, W * 0.72, ground + 0.10, 0.72, 0.55, 0.05),
        base(0.06, W * 0.92, ground + 0.02, 0.84, 0.5, 0.02),
        base(0.18, W, ground, 0.92, 0.42),
        base(0.36, W * 1.0, ground, 1.02, 0.4),
        base(0.5, W * 0.97, ground, 1.08, 0.4),
        base(0.62, W * 0.93, ground + 0.02, 0.96, 0.45),
        base(0.78, W * 0.95, ground + 0.02, 0.78, 0.5),
        base(0.92, W * 0.88, ground + 0.08, 0.68, 0.55, 0.04),
        base(1.0, W * 0.7, ground + 0.16, 0.6, 0.6, 0.08),
      ];
    case 'coupe':
    case 'muscle':
      return [
        base(0.0, W * 0.75, ground + 0.2, 0.9, 0.5, 0.04),
        base(0.05, W * 0.93, ground + 0.06, 1.0, 0.45),
        base(0.16, W, ground, 1.06, 0.4),
        base(0.32, W, ground, 1.12, 0.38),
        base(0.46, W * 0.99, ground, 1.18, 0.38),
        base(0.6, W * 0.96, ground, 1.1, 0.42),
        base(0.76, W * 0.97, ground, 1.0, 0.46),
        base(0.9, W * 0.92, ground + 0.05, 0.94, 0.5, 0.03),
        base(1.0, W * 0.78, ground + 0.14, 0.86, 0.55, 0.06),
      ];
    case 'hatch':
    case 'sedan':
      return [
        base(0.0, W * 0.78, ground + 0.16, 1.0, 0.45, 0.03),
        base(0.05, W * 0.95, ground + 0.04, 1.06, 0.4),
        base(0.16, W, ground, 1.12, 0.36),
        base(0.34, W, ground, 1.2, 0.34),
        base(0.5, W, ground, 1.26, 0.34),
        base(0.66, W * 0.98, ground, 1.22, 0.36),
        base(0.8, W * 0.97, ground + 0.02, 1.12, 0.4),
        base(0.92, W * 0.92, ground + 0.06, 1.04, 0.45, 0.02),
        base(1.0, W * 0.8, ground + 0.14, 0.96, 0.5, 0.05),
      ];
    case 'suv':
    case 'truck':
      return [
        base(0.0, W * 0.82, ground + 0.2, 1.3, 0.35),
        base(0.05, W * 0.97, ground + 0.06, 1.36, 0.32),
        base(0.16, W, ground, 1.42, 0.3),
        base(0.34, W, ground, 1.5, 0.28),
        base(0.5, W, ground, 1.52, 0.28),
        base(0.68, W * 0.99, ground, 1.46, 0.3),
        base(0.82, W * 0.97, ground + 0.04, 1.34, 0.34),
        base(0.93, W * 0.92, ground + 0.1, 1.24, 0.4, 0.02),
        base(1.0, W * 0.82, ground + 0.18, 1.16, 0.45, 0.04),
      ];
    case 'van':
      return [
        base(0.0, W * 0.8, ground + 0.18, 1.6, 0.3),
        base(0.04, W * 0.97, ground + 0.05, 1.68, 0.26),
        base(0.14, W, ground, 1.78, 0.24),
        base(0.4, W, ground, 1.82, 0.22),
        base(0.62, W, ground, 1.8, 0.22),
        base(0.78, W * 0.98, ground, 1.6, 0.28),
        base(0.9, W * 0.94, ground + 0.06, 1.28, 0.36),
        base(1.0, W * 0.84, ground + 0.14, 1.16, 0.42, 0.05),
      ];
    case 'buggy':
      return [
        base(0.0, W * 0.7, ground + 0.1, 0.8, 0.6),
        base(0.08, W * 0.9, ground, 0.9, 0.55),
        base(0.24, W, ground - 0.04, 1.0, 0.5),
        base(0.46, W, ground - 0.04, 1.06, 0.5),
        base(0.66, W * 0.98, ground, 0.96, 0.55),
        base(0.84, W * 0.9, ground + 0.04, 0.84, 0.6),
        base(1.0, W * 0.72, ground + 0.12, 0.74, 0.62),
      ];
    default:
      return [
        base(0.0, W * 0.8, ground + 0.14, 1.0, 0.45),
        base(0.06, W * 0.96, ground + 0.03, 1.1, 0.4),
        base(0.2, W, ground, 1.18, 0.36),
        base(0.5, W, ground, 1.22, 0.34),
        base(0.78, W * 0.98, ground, 1.12, 0.38),
        base(0.92, W * 0.92, ground + 0.06, 1.02, 0.44),
        base(1.0, W * 0.8, ground + 0.14, 0.94, 0.5),
      ];
  }
  void L;
}

/** Lofts a closed tube of cross-sections into an indexed BufferGeometry. */
function loft(sections: SectionShape[], zFrom: number, zTo: number, scaleY: number, centerY: number): THREE.BufferGeometry {
  const rings: THREE.Vector2[][] = [];
  for (const s of sections) {
    const poly: THREE.Vector2[] = [];
    sectionPolygon(s, poly);
    rings.push(poly);
  }
  const n = PROFILE_POINTS;
  const positions: number[] = [];
  const uvs: number[] = [];
  for (let r = 0; r < rings.length; r++) {
    const s = sections[r];
    const z = zFrom + (zTo - zFrom) * s.t;
    for (let i = 0; i < n; i++) {
      const p = rings[r][i];
      positions.push(p.x, (p.y - centerY) * scaleY + centerY, z);
      uvs.push(i / n, s.t);
    }
  }
  const indices: number[] = [];
  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < n; i++) {
      const a = r * n + i;
      const b = r * n + ((i + 1) % n);
      const c = (r + 1) * n + i;
      const d = (r + 1) * n + ((i + 1) % n);
      indices.push(a, c, b, b, c, d);
    }
  }
  // Caps: fan from the centroid so the body is watertight.
  for (const [ringIdx, flip] of [[0, true], [rings.length - 1, false]] as [number, boolean][]) {
    const base = positions.length / 3;
    const s = sections[ringIdx];
    const z = zFrom + (zTo - zFrom) * s.t;
    let cy = 0;
    for (let i = 0; i < n; i++) cy += rings[ringIdx][i].y;
    cy = (cy / n - centerY) * scaleY + centerY;
    positions.push(0, cy, z);
    uvs.push(0.5, s.t);
    for (let i = 0; i < n; i++) {
      const a = ringIdx * n + i;
      const b = ringIdx * n + ((i + 1) % n);
      if (flip) indices.push(base, a, b);
      else indices.push(base, b, a);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** A single arched wheel opening (liner) so the body does not look see-through. */
function archLiner(radius: number, width: number, side: number): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(radius, radius, width, 14, 1, true, 0, Math.PI);
  geo.rotateZ(Math.PI / 2);
  geo.rotateY(Math.PI / 2);
  if (side < 0) geo.rotateY(Math.PI);
  return geo;
}

export class CarMesh {
  group = new THREE.Group();
  bodyGroup = new THREE.Group();
  wheels: THREE.Group[] = [];
  wheelSpinners: THREE.Group[] = [];
  brakeLights: THREE.MeshStandardMaterial[] = [];
  headLights: THREE.SpotLight[] = [];
  headLightMats: THREE.MeshStandardMaterial[] = [];
  paintMaterial: THREE.MeshPhysicalMaterial;
  glassMaterial: THREE.MeshPhysicalMaterial;
  spec: VehicleSpec;
  private wheelRadius: number;
  private steeringWheel: THREE.Object3D | null = null;
  private contactShadow: THREE.Mesh | null = null;
  private shared: SharedUniforms;

  constructor(spec: VehicleSpec, appearance: CarAppearance, shared: SharedUniforms) {
    this.spec = spec;
    this.shared = shared;
    this.wheelRadius = spec.bodyStyle === 'truck' || spec.bodyStyle === 'suv' || spec.bodyStyle === 'buggy' ? 0.42 : 0.34;
    const mats = createCarMaterials(appearance, shared);
    this.paintMaterial = mats.paint;
    this.glassMaterial = mats.glass;
    this.group.add(this.bodyGroup);
    this.buildContactShadow(spec);
    this.buildBody(spec, mats);
    this.buildWheels(spec, mats);
    this.buildInterior(spec, mats);
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
    });
  }

  /**
   * Contact shadow.
   *
   * The shadow cascades are 2048 px over 84 m, so the darkest, crispest place a
   * car touches the ground — right under the sills — is the one the map cannot
   * resolve. This is a soft multiply blob under the body that fades with speed
   * and ride height, which is what actually sells the car as sitting *on* the
   * road rather than floating above it.
   */
  private buildContactShadow(spec: VehicleSpec) {
    const w = spec.width * 1.12;
    const l = spec.length * 1.04;
    const geo = new THREE.PlaneGeometry(w, l);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uOpacity: { value: 0.62 },
        uSize: { value: new THREE.Vector2(w, l) },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        varying vec2 vUv;
        uniform float uOpacity;
        void main() {
          vec2 d = (vUv - 0.5) * 2.0;
          // Soft-edged ellipse: dense in the middle, gone at the bumper.
          float r = length(d * vec2(1.0, 0.72));
          float a = smoothstep(1.0, 0.15, r) * uOpacity;
          gl_FragColor = vec4(0.02, 0.02, 0.03, a);
        }
      `,
    });
    this.contactShadow = new THREE.Mesh(geo, mat);
    this.contactShadow.position.y = 0.045;
    this.contactShadow.renderOrder = 1;
    this.contactShadow.castShadow = false;
    this.contactShadow.receiveShadow = false;
    this.group.add(this.contactShadow);
  }

  private buildBody(spec: VehicleSpec, mats: ReturnType<typeof createCarMaterials>) {
    const L = spec.length;
    const H = spec.height;
    const shapes = shapesFor(spec);
    const ground = 0.16;

    // Body shell: lofted, then squashed slightly to sit on the wheels.
    const shellGeo = loft(shapes, -L * 0.5, L * 0.5, 1.0, ground);
    const shell = new THREE.Mesh(shellGeo, this.paintMaterial);
    this.bodyGroup.add(shell);

    // ---- wheel arches: dark liners + arch lips ------------------------------
    const halfTrack = spec.track * 0.5;
    const archR = this.wheelRadius * 1.16;
    for (const side of [-1, 1]) {
      for (const z of [spec.wheelbase * 0.5, -spec.wheelbase * 0.5]) {
        const liner = new THREE.Mesh(archLiner(archR, 0.3, side), mats.trim);
        liner.position.set(side * (halfTrack - 0.08), ground + this.wheelRadius * 0.02, z);
        this.bodyGroup.add(liner);
        // Arch lip: a thin torus segment in body colour reads as rolled metal.
        const lip = new THREE.Mesh(new THREE.TorusGeometry(archR, 0.028, 5, 16, Math.PI), this.paintMaterial);
        lip.position.set(side * (halfTrack + 0.01), ground + this.wheelRadius * 0.02, z);
        lip.rotation.y = Math.PI / 2;
        lip.rotation.z = Math.PI;
        this.bodyGroup.add(lip);
      }
    }

    // ---- glasshouse --------------------------------------------------------
    const cabinLen = L * (spec.bodyStyle === 'van' ? 0.56 : spec.bodyStyle === 'truck' ? 0.3 : 0.4);
    const cabinH = H * (spec.bodyStyle === 'van' ? 0.4 : 0.3);
    const cabinZ = L * (spec.bodyStyle === 'truck' ? 0.05 : spec.bodyStyle === 'supercar' ? -0.02 : 0.02);
    const cabinY = H * 0.62;
    // Windscreen: a trapezoid leaning back, then side glass and rear screen.
    const wsGeo = new THREE.BoxGeometry(spec.width * 0.74, cabinH * 1.15, 0.02);
    const wsPos = wsGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < wsPos.count; i++) {
      if (wsPos.getY(i) > 0) wsPos.setX(i, wsPos.getX(i) * 0.88);
    }
    wsGeo.computeVertexNormals();
    const windscreen = new THREE.Mesh(wsGeo, this.glassMaterial);
    windscreen.position.set(0, cabinY + cabinH * 0.5, cabinZ + cabinLen * 0.5);
    windscreen.rotation.x = -0.42;
    this.bodyGroup.add(windscreen);

    const rearGeo = wsGeo.clone();
    const rear = new THREE.Mesh(rearGeo, this.glassMaterial);
    rear.position.set(0, cabinY + cabinH * 0.5, cabinZ - cabinLen * 0.52);
    rear.rotation.x = 0.4;
    this.bodyGroup.add(rear);

    for (const side of [-1, 1]) {
      const sideGlass = new THREE.Mesh(new THREE.BoxGeometry(0.02, cabinH * 0.85, cabinLen * 0.94), this.glassMaterial);
      sideGlass.position.set(side * spec.width * 0.37, cabinY + cabinH * 0.46, cabinZ);
      this.bodyGroup.add(sideGlass);
      // Window frame / pillar
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.035, cabinH, 0.05), mats.trim);
      pillar.position.set(side * spec.width * 0.375, cabinY + cabinH * 0.5, cabinZ + cabinLen * 0.1);
      this.bodyGroup.add(pillar);
    }

    // Roof panel (body colour) — makes the greenhouse read as a real canopy.
    const roof = new THREE.Mesh(new THREE.BoxGeometry(spec.width * 0.66, 0.05, cabinLen * 0.95), this.paintMaterial);
    roof.position.set(0, cabinY + cabinH * 0.98, cabinZ);
    this.bodyGroup.add(roof);

    // ---- bumpers, grille, splitter ----------------------------------------
    const bumperZ = L * 0.5 - 0.06;
    const frontBumper = new THREE.Mesh(new THREE.BoxGeometry(spec.width * 0.96, H * 0.12, 0.14), this.paintMaterial);
    frontBumper.position.set(0, ground + H * 0.09, bumperZ);
    this.bodyGroup.add(frontBumper);
    const grille = new THREE.Mesh(new THREE.BoxGeometry(spec.width * 0.5, H * 0.055, 0.05), mats.trim);
    grille.position.set(0, ground + H * 0.14, bumperZ + 0.05);
    this.bodyGroup.add(grille);
    if (['supercar', 'coupe', 'muscle', 'hatch'].includes(spec.bodyStyle)) {
      const splitter = new THREE.Mesh(new THREE.BoxGeometry(spec.width * 0.98, 0.03, 0.22), mats.trim);
      splitter.position.set(0, ground + 0.015, bumperZ + 0.02);
      this.bodyGroup.add(splitter);
    }
    const rearBumper = new THREE.Mesh(new THREE.BoxGeometry(spec.width * 0.96, H * 0.12, 0.13), this.paintMaterial);
    rearBumper.position.set(0, ground + H * 0.09, -bumperZ);
    this.bodyGroup.add(rearBumper);
    const diffuser = new THREE.Mesh(new THREE.BoxGeometry(spec.width * 0.8, 0.04, 0.24), mats.trim);
    diffuser.position.set(0, ground + 0.03, -bumperZ - 0.02);
    this.bodyGroup.add(diffuser);

    // ---- side skirts + door seams -----------------------------------------
    for (const side of [-1, 1]) {
      const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, L * 0.42), mats.trim);
      skirt.position.set(side * spec.width * 0.49, ground + 0.05, 0);
      this.bodyGroup.add(skirt);
      const seam = new THREE.Mesh(new THREE.BoxGeometry(0.012, H * 0.24, 0.012), new THREE.MeshStandardMaterial({ color: 0x05070a, roughness: 0.9 }));
      seam.position.set(side * spec.width * 0.5, ground + H * 0.3, cabinZ + cabinLen * 0.42);
      this.bodyGroup.add(seam);
    }

    // ---- lights ------------------------------------------------------------
    const lightY = ground + H * 0.34;
    const headMat = new THREE.MeshPhysicalMaterial({
      color: 0xdfe9ff, emissive: 0xfff2d0, emissiveIntensity: 0.35,
      roughness: 0.05, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.02,
      envMapIntensity: 1.6,
    });
    this.headLightMats.push(headMat);
    const tailMat = new THREE.MeshPhysicalMaterial({
      color: 0x34060a, emissive: 0xff2013, emissiveIntensity: 0.5,
      roughness: 0.12, metalness: 0.0, clearcoat: 1, clearcoatRoughness: 0.05,
      envMapIntensity: 1.2,
    });
    this.brakeLights.push(tailMat);

    for (const side of [-1, 1]) {
      // Headlight: shallow lens sitting in the front corner.
      const head = new THREE.Mesh(new THREE.BoxGeometry(spec.width * 0.22, H * 0.075, 0.07), headMat);
      head.position.set(side * spec.width * 0.3, lightY + H * 0.06, bumperZ - 0.01);
      head.rotation.y = side * 0.06;
      this.bodyGroup.add(head);
      const headTrim = new THREE.Mesh(new THREE.BoxGeometry(spec.width * 0.24, H * 0.09, 0.03), mats.trim);
      headTrim.position.set(side * spec.width * 0.3, lightY + H * 0.06, bumperZ - 0.045);
      this.bodyGroup.add(headTrim);

      // Tail: a slim light bar plus a lower reflector.
      const tail = new THREE.Mesh(new THREE.BoxGeometry(spec.width * 0.26, H * 0.055, 0.06), tailMat);
      tail.position.set(side * spec.width * 0.29, lightY + H * 0.1, -bumperZ + 0.01);
      this.bodyGroup.add(tail);

      // Mirrors with stalks.
      const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.1, 6), mats.trim);
      stalk.rotation.z = side * Math.PI / 2.6;
      stalk.position.set(side * spec.width * 0.5, cabinY + cabinH * 0.42, cabinZ + cabinLen * 0.46);
      this.bodyGroup.add(stalk);
      const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.075, 0.1), this.paintMaterial);
      mirror.position.set(side * spec.width * 0.57, cabinY + cabinH * 0.44, cabinZ + cabinLen * 0.44);
      mirror.rotation.y = side * 0.12;
      this.bodyGroup.add(mirror);
    }

    // ---- spoiler / roll cage ----------------------------------------------
    if (['supercar', 'coupe', 'hatch', 'muscle'].includes(spec.bodyStyle) && spec.aero.downforceRear > 0.05) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(spec.width * 0.84, 0.035, 0.26), this.paintMaterial);
      wing.position.set(0, H * 0.66, -L * 0.46);
      wing.rotation.x = -0.08;
      this.bodyGroup.add(wing);
      for (const side of [-1, 1]) {
        const strut = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.2, 0.06), mats.trim);
        strut.position.set(side * spec.width * 0.3, H * 0.56, -L * 0.46);
        this.bodyGroup.add(strut);
      }
    }
    if (spec.bodyStyle === 'buggy') {
      const cageMat = mats.chrome;
      for (const side of [-1, 1]) {
        const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, H * 0.7, 8), cageMat);
        bar.position.set(side * spec.width * 0.4, H * 0.66, -L * 0.05);
        bar.rotation.x = 0.1;
        this.bodyGroup.add(bar);
      }
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, spec.width * 0.8, 8), cageMat);
      top.rotation.z = Math.PI / 2;
      top.position.set(0, H * 1.0, -L * 0.05);
      this.bodyGroup.add(top);
    }

    // ---- exhausts ----------------------------------------------------------
    for (const side of [-1, 1]) {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.18, 10), mats.chrome);
      pipe.rotation.x = Math.PI / 2;
      pipe.position.set(side * spec.width * 0.2, ground + 0.1, -L * 0.5 + 0.02);
      this.bodyGroup.add(pipe);
    }

    // ---- headlight projections --------------------------------------------
    for (const side of [-1, 1]) {
      const spot = new THREE.SpotLight(0xfff3d8, 0, 110, Math.PI / 7.5, 0.55, 1.4);
      spot.position.set(side * spec.width * 0.3, lightY, L * 0.48);
      spot.target.position.set(side * spec.width * 0.3, -1.2, L * 0.5 + 34);
      spot.castShadow = false;
      this.bodyGroup.add(spot, spot.target);
      this.headLights.push(spot);
    }
  }

  private buildWheels(spec: VehicleSpec, mats: ReturnType<typeof createCarMaterials>) {
    const r = this.wheelRadius;
    const tyreMat = mats.tyre;
    const rimMat = mats.rim;
    const discMat = new THREE.MeshStandardMaterial({ color: 0x6e6a66, metalness: 0.85, roughness: 0.42 });
    const caliperMat = new THREE.MeshStandardMaterial({ color: 0xb3311f, metalness: 0.3, roughness: 0.5 });

    for (let i = 0; i < 4; i++) {
      const isFront = i < 2;
      const halfTrack = spec.track / 2 * 0.97;
      const z = isFront ? spec.wheelbase / 2 : -spec.wheelbase / 2;
      const width = isFront ? spec.tires.widthFront : spec.tires.widthRear;
      const spinner = new THREE.Group();

      // Tyre: a proper torus-like profile — square shoulders, rounded sidewalls.
      const tyreGeo = new THREE.CylinderGeometry(r, r, width, 24, 1);
      tyreGeo.rotateZ(Math.PI / 2);
      const tread = new THREE.Mesh(tyreGeo, tyreMat);
      spinner.add(tread);
      for (const side of [-1, 1]) {
        const sidewall = new THREE.Mesh(new THREE.TorusGeometry(r * 0.82, width * 0.22, 6, 24), tyreMat);
        sidewall.position.x = side * width * 0.42;
        sidewall.rotation.y = Math.PI / 2;
        spinner.add(sidewall);
      }
      // Tread blocks: subtle relief that catches the light as the wheel spins.
      for (let b = 0; b < 18; b++) {
        const a = (b / 18) * Math.PI * 2;
        const block = new THREE.Mesh(new THREE.BoxGeometry(width * 0.92, 0.028, r * 0.16), tyreMat);
        block.position.set(0, Math.cos(a) * r * 0.99, Math.sin(a) * r * 0.99);
        block.rotation.x = -a;
        spinner.add(block);
      }

      // Rim: barrel + face + spokes.
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.72, r * 0.72, width * 0.86, 22, 1, true), rimMat);
      barrel.rotation.z = Math.PI / 2;
      spinner.add(barrel);
      const face = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.7, r * 0.7, 0.02, 22), rimMat);
      face.rotation.z = Math.PI / 2;
      face.position.x = width * 0.36;
      spinner.add(face);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.2, r * 0.24, 0.08, 12), rimMat);
      hub.rotation.z = Math.PI / 2;
      hub.position.x = width * 0.42;
      spinner.add(hub);
      for (let s = 0; s < 5; s++) {
        const a = (s / 5) * Math.PI * 2;
        for (const offset of [-0.16, 0.16]) {
          const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.045, r * 0.62, 0.05), rimMat);
          spoke.position.set(width * 0.3, Math.cos(a + offset) * r * 0.36, Math.sin(a + offset) * r * 0.36);
          spoke.rotation.x = -(a + offset);
          spinner.add(spoke);
        }
      }
      // Brake disc + caliper (do not spin with the rim face).
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.6, r * 0.6, 0.024, 20), discMat);
      disc.rotation.z = Math.PI / 2;
      disc.position.x = -width * 0.05;
      spinner.add(disc);
      const caliper = new THREE.Mesh(new THREE.BoxGeometry(0.06, r * 0.3, r * 0.16), caliperMat);
      caliper.position.set(-width * 0.05, r * 0.42, 0);
      spinner.add(caliper);

      const wheelGroup = new THREE.Group();
      wheelGroup.position.set(i % 2 === 0 ? -halfTrack : halfTrack, 0, z);
      wheelGroup.add(spinner);
      this.wheels.push(wheelGroup);
      this.wheelSpinners.push(spinner);
      this.group.add(wheelGroup);
    }
  }

  private buildInterior(spec: VehicleSpec, mats: ReturnType<typeof createCarMaterials>) {
    const H = spec.height;
    const dark = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.88, metalness: 0.05 });
    const dash = new THREE.Mesh(new THREE.BoxGeometry(spec.width * 0.7, 0.14, 0.3), dark);
    dash.position.set(0, H * 0.44, spec.length * 0.13);
    this.bodyGroup.add(dash);

    // Chassis tunnel + seats, visible through the side glass.
    const tunnel = new THREE.Mesh(new THREE.BoxGeometry(spec.width * 0.3, 0.16, spec.length * 0.5), dark);
    tunnel.position.set(0, H * 0.3, 0);
    this.bodyGroup.add(tunnel);

    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x0f1114, roughness: 0.62 });
    const sw = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.024, 8, 20), wheelMat);
    sw.position.set(-spec.width * 0.2, H * 0.47, spec.length * 0.1);
    sw.rotation.x = -0.32;
    this.bodyGroup.add(sw);
    this.steeringWheel = sw;

    for (const side of [-1, 1]) {
      const seatBase = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 0.44), dark);
      seatBase.position.set(side * spec.width * 0.2, H * 0.36, -spec.length * 0.03);
      this.bodyGroup.add(seatBase);
      const seatBack = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 0.1), dark);
      seatBack.position.set(side * spec.width * 0.2, H * 0.5, -spec.length * 0.14);
      seatBack.rotation.x = 0.14;
      this.bodyGroup.add(seatBack);
    }
    void mats;
  }

  /** Sync visuals to the physics state: wheel travel, steering, brake lights. */
  update(sim: VehicleSim, opts: { braking: number; headlightsOn: boolean; dt: number }) {
    const spec = this.spec;
    for (let i = 0; i < 4; i++) {
      const w = sim.wheels[i];
      const group = this.wheels[i];
      const mountY = w.local.y;
      const suspLen = w.contact ? w.suspLen : spec.suspension.maxLength;
      group.position.y = mountY - suspLen + (w.contact ? 0 : -0.02);
      group.rotation.y = w.steer;
      this.wheelSpinners[i].rotation.x = w.spinAngle;
    }
    if (this.steeringWheel) this.steeringWheel.rotation.z = -sim.wheels[0].steer * 4.2;
    if (this.contactShadow) {
      const contacts = sim.wheels.reduce((n, w) => n + (w.contact ? 1 : 0), 0);
      // Fades out as wheels leave the ground, dims slightly at speed (the sun
      // shadow blob spreads and softens rather than darkens).
      const load = contacts / 4;
      const speed = Math.min(1, Math.abs(sim.readout.speedKmh) / 180);
      const mat = this.contactShadow.material as THREE.ShaderMaterial;
      mat.uniforms.uOpacity.value = 0.62 * load * (1 - speed * 0.35);
      this.contactShadow.visible = load > 0.01;
    }
    const brakeIntensity = 0.4 + opts.braking * 3.2;
    for (const m of this.brakeLights) m.emissiveIntensity = brakeIntensity;
    for (const s of this.headLights) s.intensity = opts.headlightsOn ? 30 : 0;
    for (const m of this.headLightMats) m.emissiveIntensity = opts.headlightsOn ? 2.2 : 0.3;
  }

  setPaint(color: string, finish: PaintFinish) {
    this.paintMaterial.color.set(color);
    this.paintMaterial.metalness = finish === 'matte' ? 0.2 : finish === 'chrome' ? 1 : 0.62;
    this.paintMaterial.roughness = finish === 'matte' ? 0.62 : finish === 'chrome' ? 0.05 : finish === 'metallic' ? 0.24 : 0.17;
    this.paintMaterial.clearcoat = finish === 'matte' ? 0.2 : 1;
  }

  dispose() {
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
  }
}
