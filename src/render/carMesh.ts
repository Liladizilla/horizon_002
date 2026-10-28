import * as THREE from 'three';
import type { VehicleSpec } from '../vehicles/spec';
import type { VehicleSim } from '../physics/vehicle';

export type PaintFinish = 'gloss' | 'metallic' | 'matte' | 'chrome' | 'pearl';

export interface CarAppearance {
  color: string;
  finish: PaintFinish;
  rimColor?: string;
  tint?: string;
}

/**
 * Procedural car body.
 *
 * Rather than shipping heavy glTF assets (which the brief forbids depending on
 * from a remote server), every vehicle is generated from its own dimensions and
 * body style. The silhouette comes from an extruded side profile, which gives a
 * recognisable, readable car for a few hundred triangles per part.
 */
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

  constructor(spec: VehicleSpec, appearance: CarAppearance) {
    this.spec = spec;
    this.wheelRadius = spec.bodyStyle === 'truck' || spec.bodyStyle === 'suv' || spec.bodyStyle === 'buggy' ? 0.42 : 0.34;

    this.paintMaterial = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(appearance.color),
      metalness: appearance.finish === 'matte' ? 0.15 : appearance.finish === 'chrome' ? 1.0 : 0.55,
      roughness: appearance.finish === 'matte' ? 0.72 : appearance.finish === 'chrome' ? 0.06 : appearance.finish === 'metallic' ? 0.28 : 0.22,
      clearcoat: appearance.finish === 'matte' ? 0.15 : 1.0,
      clearcoatRoughness: appearance.finish === 'matte' ? 0.5 : 0.06,
      envMapIntensity: 1.15,
    });
    this.glassMaterial = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(appearance.tint ?? 0x0b1015),
      metalness: 0.1, roughness: 0.06, transparent: true, opacity: 0.55,
      transmission: 0.25, ior: 1.45, envMapIntensity: 1.2,
    });

    this.group.add(this.bodyGroup);
    this.buildBody(spec);
    this.buildWheels(spec);
    this.buildInterior(spec);
    this.group.castShadow = true;
  }

  private profileFor(style: VehicleSpec['bodyStyle']): [number, number][] {
    // [z along length (0 = rear, 1 = front), y height] in normalised units
    switch (style) {
      case 'supercar': return [[0.02, 0.30], [0.12, 0.40], [0.5, 0.42], [0.72, 0.46], [0.88, 0.40], [0.99, 0.30], [0.99, 0.18], [0.55, 0.15], [0.02, 0.18]];
      case 'coupe': return [[0.02, 0.32], [0.1, 0.44], [0.45, 0.47], [0.68, 0.50], [0.9, 0.44], [0.99, 0.34], [0.99, 0.2], [0.5, 0.17], [0.02, 0.2]];
      case 'muscle': return [[0.02, 0.34], [0.1, 0.46], [0.5, 0.48], [0.72, 0.47], [0.92, 0.42], [0.99, 0.34], [0.99, 0.2], [0.5, 0.18], [0.02, 0.2]];
      case 'hatch': return [[0.02, 0.36], [0.06, 0.48], [0.5, 0.5], [0.75, 0.5], [0.93, 0.44], [0.99, 0.34], [0.99, 0.2], [0.5, 0.17], [0.02, 0.2]];
      case 'sedan': return [[0.02, 0.34], [0.08, 0.46], [0.35, 0.47], [0.62, 0.48], [0.88, 0.44], [0.99, 0.34], [0.99, 0.2], [0.5, 0.18], [0.02, 0.2]];
      case 'suv': return [[0.02, 0.38], [0.06, 0.52], [0.5, 0.54], [0.85, 0.52], [0.95, 0.44], [0.99, 0.32], [0.99, 0.22], [0.5, 0.2], [0.02, 0.22]];
      case 'truck': return [[0.02, 0.36], [0.06, 0.5], [0.4, 0.52], [0.6, 0.52], [0.75, 0.5], [0.95, 0.46], [0.99, 0.34], [0.99, 0.22], [0.5, 0.2], [0.02, 0.22]];
      case 'van': return [[0.02, 0.38], [0.04, 0.55], [0.6, 0.56], [0.9, 0.54], [0.98, 0.42], [0.99, 0.3], [0.99, 0.22], [0.5, 0.2], [0.02, 0.22]];
      case 'buggy': return [[0.02, 0.32], [0.2, 0.40], [0.6, 0.42], [0.85, 0.38], [0.99, 0.3], [0.99, 0.2], [0.5, 0.16], [0.02, 0.2]];
      default: return [[0.02, 0.32], [0.1, 0.44], [0.5, 0.46], [0.9, 0.42], [0.99, 0.32], [0.99, 0.2], [0.5, 0.17], [0.02, 0.2]];
    }
  }

  private buildBody(spec: VehicleSpec) {
    const L = spec.length, W = spec.width, H = spec.height;
    const profile = this.profileFor(spec.bodyStyle);
    const shape = new THREE.Shape();
    // Draw in (z, y) space using x = z coordinate, y = height, then rotate.
    shape.moveTo(profile[0][0] * L, profile[0][1] * H);
    for (let i = 1; i < profile.length; i++) shape.lineTo(profile[i][0] * L - L * 0.5, profile[i][1] * H);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: W * 0.94, bevelEnabled: true, bevelSize: 0.07, bevelThickness: 0.06, bevelSegments: 2, curveSegments: 4,
    });
    geo.rotateY(Math.PI / 2);
    geo.translate(W * 0.47, 0, 0);
    geo.center();
    geo.computeVertexNormals();
    const shell = new THREE.Mesh(geo, this.paintMaterial);
    shell.castShadow = true;
    shell.receiveShadow = true;
    this.bodyGroup.add(shell);

    // ---- greenhouse / cabin ----
    const cabinLen = L * (spec.bodyStyle === 'van' ? 0.62 : spec.bodyStyle === 'truck' ? 0.34 : 0.42);
    const cabinH = H * (spec.bodyStyle === 'van' ? 0.42 : 0.34);
    const cabinZ = L * (spec.bodyStyle === 'truck' ? 0.13 : 0.04);
    const cabin = new THREE.BoxGeometry(W * 0.82, cabinH, cabinLen);
    // taper the roof
    const pos = cabin.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > 0) {
        pos.setX(i, pos.getX(i) * 0.82);
        pos.setZ(i, pos.getZ(i) * 0.78);
      }
    }
    cabin.translate(0, H * 0.5 + cabinH * 0.12, cabinZ);
    cabin.computeVertexNormals();
    const cabinMesh = new THREE.Mesh(cabin, this.glassMaterial);
    cabinMesh.castShadow = true;
    this.bodyGroup.add(cabinMesh);

    // Roof panel in body colour above the glass
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(W * 0.68, 0.05, cabinLen * 0.72),
      this.paintMaterial,
    );
    roof.position.set(0, H * 0.5 + cabinH * 1.02, cabinZ - cabinLen * 0.02);
    roof.castShadow = true;
    this.bodyGroup.add(roof);

    // ---- lights ----
    const lightY = H * (spec.bodyStyle === 'supercar' ? 0.42 : 0.40);
    const headMat = new THREE.MeshStandardMaterial({ color: 0xf6f8ff, emissive: 0xfff3d0, emissiveIntensity: 0.7, roughness: 0.2 });
    this.headLightMats.push(headMat);
    for (const sx of [-1, 1]) {
      const head = new THREE.Mesh(new THREE.BoxGeometry(W * 0.2, H * 0.09, 0.09), headMat);
      head.position.set(sx * W * 0.31, lightY, L * 0.48);
      this.bodyGroup.add(head);

      const tailMat = new THREE.MeshStandardMaterial({ color: 0x4a0a0a, emissive: 0xff1a12, emissiveIntensity: 0.5, roughness: 0.3 });
      this.brakeLights.push(tailMat);
      const tail = new THREE.Mesh(new THREE.BoxGeometry(W * 0.22, H * 0.08, 0.07), tailMat);
      tail.position.set(sx * W * 0.31, lightY, -L * 0.49);
      this.bodyGroup.add(tail);

      // mirrors
      const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.07, 0.09), this.paintMaterial);
      mirror.position.set(sx * W * 0.55, H * 0.62, L * 0.16);
      this.bodyGroup.add(mirror);
    }

    // ---- spoiler for performance cars ----
    if (['supercar', 'coupe', 'hatch', 'muscle'].includes(spec.bodyStyle) && spec.aero.downforceRear > 0.05) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(W * 0.82, 0.05, 0.28), this.paintMaterial);
      wing.position.set(0, H * 0.62, -L * 0.46);
      wing.castShadow = true;
      this.bodyGroup.add(wing);
      for (const sx of [-1, 1]) {
        const strut = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.22, 0.06), new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.5 }));
        strut.position.set(sx * W * 0.3, H * 0.52, -L * 0.46);
        this.bodyGroup.add(strut);
      }
    }

    // ---- exhausts ----
    const exhaustMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 1, roughness: 0.35 });
    for (const sx of [-1, 1]) {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.22, 8), exhaustMat);
      pipe.rotation.x = Math.PI / 2;
      pipe.position.set(sx * W * 0.22, H * 0.22, -L * 0.5);
      this.bodyGroup.add(pipe);
    }

    // ---- roll cage for buggy ----
    if (spec.bodyStyle === 'buggy') {
      const cageMat = new THREE.MeshStandardMaterial({ color: 0x2a2c30, metalness: 0.7, roughness: 0.4 });
      for (const sx of [-1, 1]) {
        const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, H * 0.75, 6), cageMat);
        bar.position.set(sx * W * 0.4, H * 0.65, -L * 0.05);
        this.bodyGroup.add(bar);
      }
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, W * 0.8, 6), cageMat);
      top.rotation.z = Math.PI / 2;
      top.position.set(0, H * 1.0, -L * 0.05);
      this.bodyGroup.add(top);
    }

    // ---- headlight spot lights (night only, enabled by the game) ----
    for (const sx of [-1, 1]) {
      const spot = new THREE.SpotLight(0xfff3d8, 0, 95, Math.PI / 7, 0.45, 1.6);
      spot.position.set(sx * W * 0.3, lightY, L * 0.5);
      spot.target.position.set(sx * W * 0.3, -0.6, L * 0.5 + 26);
      spot.castShadow = false;
      this.bodyGroup.add(spot);
      this.bodyGroup.add(spot.target);
      this.headLights.push(spot);
    }
  }

  private buildWheels(spec: VehicleSpec) {
    const r = this.wheelRadius;
    const width = spec.tires.widthRear * 1.05;
    const tyreMat = new THREE.MeshStandardMaterial({ color: 0x14151a, roughness: 0.92, metalness: 0.02 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xc9ccd2, metalness: 0.95, roughness: 0.22 });
    const brakeMat = new THREE.MeshStandardMaterial({ color: 0x1b1b1e, metalness: 0.4, roughness: 0.7 });

    for (let i = 0; i < 4; i++) {
      const halfTrack = spec.track / 2 * 0.97;
      const z = i < 2 ? spec.wheelbase / 2 : -spec.wheelbase / 2;
      const isFront = i < 2;
      const tyre = new THREE.Mesh(new THREE.CylinderGeometry(r, r, isFront ? spec.tires.widthFront : spec.tires.widthRear, 18, 1), tyreMat);
      tyre.rotation.z = Math.PI / 2;
      tyre.castShadow = true;
      const spinner = new THREE.Group();
      spinner.add(tyre);

      const rim = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.66, r * 0.66, width * 0.92, 14, 1), rimMat);
      rim.rotation.z = Math.PI / 2;
      spinner.add(rim);
      // spokes make rotation legible
      for (let s = 0; s < 5; s++) {
        const spoke = new THREE.Mesh(new THREE.BoxGeometry(width * 0.9, r * 0.09, r * 1.15), rimMat);
        spoke.rotation.x = (s / 5) * Math.PI;
        spinner.add(spoke);
      }
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.6, r * 0.6, 0.03, 12), brakeMat);
      disc.rotation.z = Math.PI / 2;
      spinner.add(disc);

      const wheelGroup = new THREE.Group();
      wheelGroup.position.set(i % 2 === 0 ? -halfTrack : halfTrack, 0, z);
      wheelGroup.add(spinner);
      this.wheels.push(wheelGroup);
      this.wheelSpinners.push(spinner);
      this.group.add(wheelGroup);
    }
  }

  private buildInterior(spec: VehicleSpec) {
    const H = spec.height;
    const dash = new THREE.Mesh(
      new THREE.BoxGeometry(spec.width * 0.78, 0.16, 0.34),
      new THREE.MeshStandardMaterial({ color: 0x22242a, roughness: 0.85 }),
    );
    dash.position.set(0, H * 0.3, spec.length * 0.14);
    this.bodyGroup.add(dash);

    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.7 });
    const sw = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.026, 6, 14), wheelMat);
    sw.position.set(-spec.width * 0.22, H * 0.34, spec.length * 0.1);
    sw.rotation.x = -0.35;
    this.bodyGroup.add(sw);
    this.steeringWheel = sw;

    const seatMat = new THREE.MeshStandardMaterial({ color: 0x1d1f24, roughness: 0.9 });
    for (const sx of [-1, 1]) {
      const seat = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.68, 0.16), seatMat);
      seat.position.set(sx * spec.width * 0.22, H * 0.28, -spec.length * 0.06);
      seat.rotation.x = 0.16;
      this.bodyGroup.add(seat);
    }
  }

  /** Sync visuals to the physics state: wheel travel, steering, brake lights. */
  update(sim: VehicleSim, opts: { braking: number; headlightsOn: boolean; dt: number }) {
    const spec = this.spec;
    for (let i = 0; i < 4; i++) {
      const w = sim.wheels[i];
      const group = this.wheels[i];
      // Suspension travel: wheel centre relative to the body.
      const mountY = w.local.y;
      const suspLen = w.contact ? w.suspLen : spec.suspension.maxLength;
      group.position.y = mountY - suspLen + (w.contact ? 0 : -0.02);
      group.rotation.y = w.steer;
      this.wheelSpinners[i].rotation.x = w.spinAngle;
    }
    if (this.steeringWheel) this.steeringWheel.rotation.z = -sim.wheels[0].steer * 4.2;
    const brakeIntensity = 0.35 + opts.braking * 2.4;
    for (const m of this.brakeLights) m.emissiveIntensity = brakeIntensity;
    for (const s of this.headLights) s.intensity = opts.headlightsOn ? 26 : 0;
    for (const m of this.headLightMats) m.emissiveIntensity = opts.headlightsOn ? 1.6 : 0.25;
  }

  setPaint(color: string, finish: PaintFinish) {
    this.paintMaterial.color.set(color);
    this.paintMaterial.metalness = finish === 'matte' ? 0.15 : finish === 'chrome' ? 1 : 0.55;
    this.paintMaterial.roughness = finish === 'matte' ? 0.72 : finish === 'chrome' ? 0.06 : finish === 'metallic' ? 0.28 : 0.22;
    this.paintMaterial.clearcoat = finish === 'matte' ? 0.15 : 1;
  }

  dispose() {
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
  }
}
