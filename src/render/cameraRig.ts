import * as THREE from 'three';
import { clamp, damp, lerp } from '../core/math';

export type CameraMode = 'chase' | 'chaseNear' | 'hood' | 'bumper' | 'cockpit' | 'drone' | 'photo';

export const CAMERA_MODES: CameraMode[] = ['chase', 'chaseNear', 'hood', 'bumper', 'cockpit', 'drone'];

export interface CameraTarget {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  speed: number;
  forwardSpeed: number;
  surfaceRoughness: number;
  drifting: boolean;
}

/**
 * Chase / hood / bumper / cockpit / drone cameras.
 * Positions are smoothed with frame-rate independent damping and clamped above
 * the terrain so the camera cannot sink into the ground.
 */
export class CameraRig {
  camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'chase';
  private currentPos = new THREE.Vector3(0, 8, -12);
  private currentLook = new THREE.Vector3();
  private velocity = new THREE.Vector3();
  private baseFov = 62;
  private shakeAmount = 0;
  private shakeSettings = 0.6;
  private positionLift = 0;
  photoFree = { yaw: 0, pitch: -0.2, distance: 8, target: new THREE.Vector3() };

  constructor(camera: THREE.PerspectiveCamera, fov: number) {
    this.camera = camera;
    this.baseFov = fov;
  }

  setShake(settings: number, reducedMotion: boolean) {
    this.shakeSettings = reducedMotion ? 0 : settings;
  }

  cycle() {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.mode = CAMERA_MODES[(i + 1) % CAMERA_MODES.length];
  }

  addShake(amount: number) { this.shakeAmount = clamp(this.shakeAmount + amount, 0, 1.4); }

  update(dt: number, t: CameraTarget, heightAt: (x: number, z: number) => number) {
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(t.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(t.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(t.quaternion);
    const speedKmh = t.speed * 3.6;

    let desiredPos = new THREE.Vector3();
    let lookAt = new THREE.Vector3();
    let fov = this.baseFov;
    let posRate = 9;
    let lookRate = 12;

    switch (this.mode) {
      case 'chase': {
        const dist = 7.2 + clamp(speedKmh / 220, 0, 1) * 2.4;
        const height = 2.55 + clamp(speedKmh / 260, 0, 1) * 0.35;
        // Lag the camera yaw so drifting reads well.
        desiredPos.copy(t.position).addScaledVector(fwd, -dist).addScaledVector(up, height);
        lookAt.copy(t.position).addScaledVector(fwd, 9).addScaledVector(up, 1.1);
        fov = this.baseFov + clamp(speedKmh / 300, 0, 1) * 9;
        posRate = 7.5;
        break;
      }
      case 'chaseNear': {
        const dist = 5.0;
        desiredPos.copy(t.position).addScaledVector(fwd, -dist).addScaledVector(up, 1.9);
        lookAt.copy(t.position).addScaledVector(fwd, 8).addScaledVector(up, 1.0);
        fov = this.baseFov + 3 + clamp(speedKmh / 300, 0, 1) * 8;
        posRate = 10;
        break;
      }
      case 'hood': {
        desiredPos.copy(t.position).addScaledVector(fwd, 0.55).addScaledVector(up, 1.18).addScaledVector(right, -0.32);
        lookAt.copy(desiredPos).addScaledVector(fwd, 24).addScaledVector(up, -0.6);
        fov = this.baseFov + 4;
        posRate = 40; lookRate = 40;
        break;
      }
      case 'bumper': {
        desiredPos.copy(t.position).addScaledVector(fwd, 2.0).addScaledVector(up, 0.55);
        lookAt.copy(desiredPos).addScaledVector(fwd, 24);
        fov = this.baseFov + 8;
        posRate = 60; lookRate = 60;
        break;
      }
      case 'cockpit': {
        desiredPos.copy(t.position).addScaledVector(fwd, 0.12).addScaledVector(up, 1.02).addScaledVector(right, -0.36);
        lookAt.copy(desiredPos).addScaledVector(fwd, 20).addScaledVector(up, -0.3);
        fov = this.baseFov;
        posRate = 60; lookRate = 60;
        break;
      }
      case 'drone': {
        desiredPos.copy(t.position).addScaledVector(fwd, -14).addScaledVector(up, 12);
        lookAt.copy(t.position).addScaledVector(fwd, 5);
        fov = this.baseFov - 8;
        posRate = 3.2; lookRate = 5;
        break;
      }
      case 'photo': {
        const cp = Math.cos(this.photoFree.pitch), sp = Math.sin(this.photoFree.pitch);
        const d = this.photoFree.distance;
        desiredPos.set(
          this.photoFree.target.x + Math.sin(this.photoFree.yaw) * cp * d,
          this.photoFree.target.y + sp * d,
          this.photoFree.target.z + Math.cos(this.photoFree.yaw) * cp * d,
        );
        lookAt.copy(this.photoFree.target);
        fov = this.baseFov;
        posRate = 200; lookRate = 200;
        break;
      }
    }

    // Terrain clamp
    const groundY = heightAt(desiredPos.x, desiredPos.z) + 0.9;
    if (desiredPos.y < groundY) desiredPos.y = groundY;

    if (posRate >= 40) {
      this.currentPos.copy(desiredPos);
    } else {
      this.currentPos.x = damp(this.currentPos.x, desiredPos.x, posRate, dt);
      this.currentPos.y = damp(this.currentPos.y, desiredPos.y, posRate * 1.2, dt);
      this.currentPos.z = damp(this.currentPos.z, desiredPos.z, posRate, dt);
    }
    this.currentLook.lerp(lookAt, 1 - Math.exp(-lookRate * dt));

    // Camera shake: speed, rough surfaces and impacts
    const speedShake = clamp((t.speed - 25) / 80, 0, 1) * 0.25;
    const roughShake = t.surfaceRoughness * clamp(t.speed / 30, 0, 1) * 0.5;
    const target = (speedShake + roughShake) * this.shakeSettings + this.shakeAmount;
    this.velocity.set(
      (Math.sin(performance.now() * 0.031) + Math.sin(performance.now() * 0.071)) * 0.5,
      (Math.sin(performance.now() * 0.043) + Math.sin(performance.now() * 0.089)) * 0.5,
      0,
    ).multiplyScalar(target * 0.09);
    this.shakeAmount = Math.max(0, this.shakeAmount - dt * 1.6);

    this.camera.position.copy(this.currentPos).add(this.velocity);
    this.camera.lookAt(this.currentLook);
    // A touch of roll for drift feel
    if (this.mode === 'chase' || this.mode === 'chaseNear') {
      const roll = clamp(-t.forwardSpeed * 0.0002, -0.05, 0.05) + (t.drifting ? 0.02 : 0);
      this.camera.rotateZ(roll);
    }
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = lerp(this.camera.fov, fov, 1 - Math.exp(-4 * dt));
      this.camera.updateProjectionMatrix();
    }
    void this.positionLift;
  }
}
