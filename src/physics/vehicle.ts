import * as THREE from 'three';
import { Ray, RigidBodyDesc, ColliderDesc } from '@dimforge/rapier3d-compat';
import type { Collider, RigidBody, World as RapierWorld } from '@dimforge/rapier3d-compat';
import { clamp, damp, lerp, smoothstep, KMH_PER_MS, RAD2DEG, wrapAngle } from '../core/math';
import type { CarControl, SurfaceSample } from '../core/types';
import { SURFACES, resolveSurface, type SurfaceDef } from '../core/surfaces';
import type { AssistSettings } from '../core/settings';
import { COMPOUNDS } from '../data/compounds';
import type { VehicleParams } from '../vehicles/tuning';
import { makeWheels, torqueAtRpm, deriveMassProperties, type VehicleSpec, type WheelSpec } from '../vehicles/spec';
import { computeTireForce, makeTireOutputs, tempGripMultiplier, updateTireTemp, type TireOutputs } from '../vehicles/tire';

export interface SimEnvironment {
  gravity: number;
  /** kg/m^3 */
  airDensity: number;
  windX: number;
  windZ: number;
  wetness: number;
  ambientTempC: number;
  enableTireTemp: boolean;
  enableTireWear: boolean;
}
export const DEFAULT_ENVIRONMENT: SimEnvironment = {
  gravity: 9.81, airDensity: 1.225, windX: 0, windZ: 0, wetness: 0, ambientTempC: 22,
  enableTireTemp: true, enableTireWear: true,
};

/** Surface lookup supplied by the world (roads -> asphalt, fields -> grass ...). */
export type SurfaceSampler = (x: number, y: number, z: number, normalY: number) => SurfaceSample;

const sampleAsphalt: SurfaceSampler = () => ({ id: 'asphaltDry', wetness: 0 });

export interface WheelState {
  spec: WheelSpec;
  local: THREE.Vector3;
  omega: number;          // rad/s about the wheel axle (+ = forward roll)
  steer: number;          // rad
  spinAngle: number;      // accumulated for visuals
  suspLen: number;        // mount -> ground distance along the ray
  compression: number;    // m
  contact: boolean;
  contactPoint: THREE.Vector3;
  contactNormal: THREE.Vector3;
  wheelCenter: THREE.Vector3;
  surface: SurfaceDef;
  surfaceId: string;
  wetness: number;
  load: number;           // N
  fx: number;             // N along wheel forward
  fy: number;             // N along wheel lateral
  slipRatio: number;
  slipAngle: number;
  utilisation: number;
  temperature: number;
  wear: number;           // 0..1 (1 = fully worn)
  driveTorque: number;
  brakeTorque: number;
  absMod: number;
  tcMod: number;
  airborneTime: number;
  camber: number;
  /** debug: last spring force */
  springForce: number;
}

export interface VehicleSnapshot {
  p: [number, number, number];
  q: [number, number, number, number];
  v: [number, number, number];
  av: [number, number, number];
  omega: [number, number, number, number];
  gear: number;
  engineOmega: number;
  damageEngine: number;
  damageSteer: number;
  wheelGrip: [number, number, number, number];
  turbo: number;
}

export interface VehicleReadout {
  speedMs: number;
  forwardSpeedMs: number;
  speedKmh: number;
  rpm: number;
  gear: number;
  shifting: boolean;
  engineTorque: number;
  driveTorque: number;
  throttle: number;
  brake: number;
  wheelsAirborne: number;
  maxSlipAngle: number;
  utilisation: number;
  lateralG: number;
  longitudinalG: number;
  drifting: boolean;
  driftScoreRate: number;
  surface: SurfaceDef;
  revLimiter: boolean;
  damage: { engine: number; steering: number; wheelGrip: [number, number, number, number] };
}

export interface VehicleOptions {
  assists: AssistSettings;
  simDamage: boolean;
  position?: THREE.Vector3Like;
  yaw?: number;
  surfaceSampler?: SurfaceSampler;
  collisionGroups?: number;
  isPlayer?: boolean;
}

const WHEEL_INERTIA = 1.25; // kg m^2, ~22 kg wheel of ~0.34 m radius
const AIR_DENSITY_REF = 1.225;

/**
 * Rigid-body vehicle simulation.
 *
 * Structure per fixed tick:
 *   1. steer angles (speed sensitive lock + optional counter-steer assist)
 *   2. engine -> gearbox -> differential -> per wheel drive torque
 *   3. per wheel: filtered raycast -> spring/damper/anti-roll -> tyre slip ->
 *      tyre force -> implicit wheel-spin integration -> brake/ABS/TCS
 *   4. aero drag, downforce, rolling resistance
 *
 * Every force is applied through Rapier at a world point; the chassis is never
 * teleported while driving. Units are SI throughout.
 */
export class VehicleSim {
  params: VehicleParams;
  spec: VehicleSpec;
  body: RigidBody;
  collider: Collider;
  wheels: WheelState[] = [];
  controls: AssistSettings;
  simDamage: boolean;
  surfaceSampler: SurfaceSampler;
  isPlayer: boolean;

  gear = 1;                 // -1 reverse, 0 neutral, 1..N
  engineOmega = 0;          // rad/s
  shiftTimer = 0;
  private shiftQueued = 0;
  private limiterTimer = 0;
  turboState = 0;
  private autoShiftCooldown = 0;
  private reverseHold = 0;

  damage = { engine: 0, steering: 0, wheelGrip: [1, 1, 1, 1] as [number, number, number, number] };

  private quat = new THREE.Quaternion();
  private pos = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private angVel = new THREE.Vector3();
  private fwd = new THREE.Vector3();
  private rightV = new THREE.Vector3();
  private upV = new THREE.Vector3();
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private tmpC = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private rayOrigin = new THREE.Vector3();
  private rayDir = new THREE.Vector3();
  private tireOut: TireOutputs = makeTireOutputs();

  private mountHeights: number[] = [];
  private staticCompression: number[] = [];
  private wheelInertia = WHEEL_INERTIA;

  private lastForwardSpeed = 0;
  private lastLateralSpeed = 0;
  private prevForwardSpeed = 0;
  private prevLateralSpeed = 0;
  private lateralForce = 0;
  private impactCooldown = 0;
  private airborneAny = false;
  private driftActive = false;
  private prevYawRate = 0;
  private odometer = 0;

  readout: VehicleReadout;
  /** set when the drivetrain is damaged and starts to misfire */
  misfire = 0;

  constructor(world: RapierWorld, params: VehicleParams, opts: VehicleOptions) {
    this.params = params;
    this.spec = params.spec;
    this.controls = opts.assists;
    this.simDamage = opts.simDamage;
    this.surfaceSampler = opts.surfaceSampler ?? sampleAsphalt;
    this.isPlayer = opts.isPlayer ?? false;

    const spec = this.spec;
    const wheelSpecs = makeWheels(spec);
    const cornerMass = params.mass / 4;

    // Geometry: the body's origin is the centre of gravity, at cgHeight above
    // the road in the static attitude. Derive suspension mount heights from the
    // authored spring rates so the car settles at that ride height.
    const fixedSprings: number[] = [];
    for (const w of wheelSpecs) {
      const isFront = w.z > 0;
      const k0 = isFront ? params.springFront : params.springRear;
      const staticComp = (cornerMass * 9.81) / k0;
      const maxStatic = 0.62 * spec.suspension.travel;
      const k = staticComp > maxStatic ? k0 * (staticComp / maxStatic) : k0;
      fixedSprings.push(k);
      this.staticCompression.push((cornerMass * 9.81) / k);
    }
    // Persist the normalised springs (the authored values may have been too soft
    // to sit off the bump stops).
    params.springFront = fixedSprings[0];
    params.springRear = fixedSprings[2];
    params.dampingFront = 2 * Math.sqrt(params.springFront * cornerMass) * Math.min(0.75, spec.suspension.dampingRatioFront || 0.4);
    params.dampingRear = 2 * Math.sqrt(params.springRear * cornerMass) * Math.min(0.75, spec.suspension.dampingRatioRear || 0.4);

    const inertia = deriveMassProperties(spec);
    const yaw = opts.yaw ?? 0;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const start = opts.position ?? { x: 0, y: spec.cgHeight + 0.02, z: 0 };

    const bodyDesc = RigidBodyDesc.dynamic()
      .setTranslation(start.x, start.y, start.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setLinearDamping(0.0)
      .setAngularDamping(0.35)
      .setCcdEnabled(true)
      .setCanSleep(false);
    this.body = world.createRigidBody(bodyDesc);

    // Collision box sits above the ground plane so it can never rest on the
    // terrain and fight the suspension. The collider carries the full mass
    // properties with its centre of mass placed at the body origin (= the
    // design CG), so pitch/roll inertia is exactly what the spec asks for.
    const boxH = Math.min(spec.height * 0.62, (spec.cgHeight - 0.18) * 2.2);
    const boxCenterAboveGround = 0.18 + boxH / 2 - params.rideHeightOffset;
    const boxLocalY = boxCenterAboveGround - spec.cgHeight;
    const colliderDesc = ColliderDesc.cuboid(spec.width * 0.46, boxH / 2, spec.length * 0.46)
      .setTranslation(0, boxLocalY, 0)
      .setMassProperties(
        params.mass,
        { x: 0, y: -boxLocalY, z: 0 },
        { x: inertia.ixx, y: inertia.iyy, z: inertia.izz },
        { x: 0, y: 0, z: 0, w: 1 },
      )
      .setFriction(0.4)
      .setRestitution(0.22)
      .setCollisionGroups(opts.collisionGroups ?? 0xffffffff);
    this.collider = world.createCollider(colliderDesc, this.body);

    // Cabin / roof volume for collisions with scenery. Massless.
    const cabinTopAboveGround = spec.height * 0.92;
    const cabinBottom = boxCenterAboveGround + boxH / 2 - 0.02;
    if (cabinTopAboveGround > cabinBottom + 0.05) {
      const cabinH = cabinTopAboveGround - cabinBottom;
      world.createCollider(
        ColliderDesc.cuboid(spec.width * 0.38, cabinH / 2, spec.length * 0.3)
          .setTranslation(0, cabinBottom + cabinH / 2 - spec.cgHeight, -spec.length * 0.03)
          .setDensity(0)
          .setFriction(0.3)
          .setRestitution(0.15)
          .setCollisionGroups(opts.collisionGroups ?? 0xffffffff),
        this.body,
      );
    }
    this.rapierWorld = world;

    // Wheels
    for (let i = 0; i < 4; i++) {
      const ws = wheelSpecs[i];
      const staticComp = this.staticCompression[i];
      const maxLen = spec.suspension.maxLength;
      const mountY = maxLen + ws.radius - staticComp - spec.cgHeight;
      const local = new THREE.Vector3(ws.x, mountY, ws.z);
      const compound = i < 2 ? COMPOUNDS[params.compoundFront] ?? COMPOUNDS.street : COMPOUNDS[params.compoundRear] ?? COMPOUNDS.street;
      this.wheels.push({
        spec: ws, local, omega: 0, steer: 0, spinAngle: 0,
        suspLen: maxLen, compression: 0, contact: false,
        contactPoint: new THREE.Vector3(), contactNormal: new THREE.Vector3(0, 1, 0),
        wheelCenter: new THREE.Vector3(), surface: SURFACES.asphaltDry, surfaceId: 'asphaltDry', wetness: 0,
        load: 0, fx: 0, fy: 0, slipRatio: 0, slipAngle: 0, utilisation: 0,
        temperature: (i < 2 ? COMPOUNDS[params.compoundFront] : COMPOUNDS[params.compoundRear])?.optTempC ?? 70,
        wear: 0, driveTorque: 0, brakeTorque: 0, absMod: 1, tcMod: 1,
        airborneTime: 0, camber: params.camberRad, springForce: 0,
      });
      this.wheels[this.wheels.length - 1].temperature *= 0.8;
      this.mountHeights.push(mountY);
    }

    this.readout = {
      speedMs: 0, forwardSpeedMs: 0, speedKmh: 0, rpm: spec.engine.idleRpm, gear: this.gear,
      shifting: false, engineTorque: 0, driveTorque: 0, throttle: 0, brake: 0,
      wheelsAirborne: 0, maxSlipAngle: 0, utilisation: 0, lateralG: 0, longitudinalG: 0,
      drifting: false, driftScoreRate: 0, surface: SURFACES.asphaltDry, revLimiter: false,
      damage: { engine: 0, steering: 0, wheelGrip: [1, 1, 1, 1] },
    };
  }

  // ---------------------------------------------------------------- helpers
  get mass() { return this.body.mass(); }
  get position() { return this.body.translation(); }
  get rotation() { return this.body.rotation(); }
  get speedMs(): number { return this.vel.length(); }
  get forwardSpeed(): number { return this.lastForwardSpeed; }
  get yaw(): number {
    const r = this.body.rotation();
    this.tmpQ.set(r.x, r.y, r.z, r.w);
    const f = this.tmpA.set(0, 0, 1).applyQuaternion(this.tmpQ);
    return Math.atan2(f.x, f.z);
  }
  get odometerKm() { return this.odometer / 1000; }

  setAssists(a: AssistSettings) { this.controls = a; }

  effectiveCompound(index: number) {
    return index < 2 ? COMPOUNDS[this.params.compoundFront] ?? COMPOUNDS.street : COMPOUNDS[this.params.compoundRear] ?? COMPOUNDS.street;
  }

  private refreshBasis() {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.pos.set(t.x, t.y, t.z);
    this.quat.set(r.x, r.y, r.z, r.w);
    const v = this.body.linvel();
    this.vel.set(v.x, v.y, v.z);
    const av = this.body.angvel();
    this.angVel.set(av.x, av.y, av.z);
    this.fwd.set(0, 0, 1).applyQuaternion(this.quat);
    this.rightV.set(1, 0, 0).applyQuaternion(this.quat);
    this.upV.set(0, 1, 0).applyQuaternion(this.quat);
  }

  /** Transform a local point to world space. */
  localToWorld(local: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(local).applyQuaternion(this.quat).add(this.pos);
  }

  // ------------------------------------------------------------------- step
  step(dt: number, control: CarControl, env: SimEnvironment = DEFAULT_ENVIRONMENT) {
    this.refreshBasis();
    this.body.resetForces(false);
    this.body.resetTorques(false);
    const spec = this.spec;
    const p = this.params;

    const forwardSpeed = this.vel.dot(this.fwd);
    const lateralSpeed = this.vel.dot(this.rightV);
    const speed = this.vel.length();
    this.prevForwardSpeed = this.lastForwardSpeed;
    this.prevLateralSpeed = this.lastLateralSpeed;
    this.lastForwardSpeed = forwardSpeed;
    this.lastLateralSpeed = lateralSpeed;
    this.odometer += Math.abs(forwardSpeed) * dt;

    if (this.shiftTimer > 0) this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    if (this.impactCooldown > 0) this.impactCooldown -= dt;

    // ---- 1. steering ------------------------------------------------
    const lockHighSpeed = spec.steering.speedFalloff;
    const lockBlend = smoothstep(0, 52, speed);
    let steerLock = lerp(spec.steering.maxAngle, lockHighSpeed, lockBlend);
    if (p.rideHeightOffset > 0.05) steerLock *= 0.96;
    let steerInput = clamp(control.steer, -1, 1);
    if (this.controls.steeringAssist > 0) {
      // Counter-steer helper: rotate the wheels towards the direction of travel
      // when the car is sliding. Explicit, user-tunable, off in simulation mode.
      const chassisSlip = Math.atan2(lateralSpeed, Math.max(Math.abs(forwardSpeed), 2.2));
      steerInput = clamp(steerInput - chassisSlip * this.controls.steeringAssist * 0.9, -1, 1);
    }
    if (this.damage.steering > 0) steerInput = clamp(steerInput + this.damage.steering, -1.2, 1.2);
    const steerAngle = steerInput * steerLock;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      if (!w.spec.steering) { w.steer = 0; continue; }
      // Ackermann: the inside wheel turns a little more than the outside wheel.
      const ackermann = spec.steering.ackermann;
      const outer = Math.sign(steerAngle) === Math.sign(w.spec.x) && steerAngle !== 0;
      w.steer = steerAngle * (1 + (outer ? -ackermann : ackermann) * 0.12 * Math.abs(steerAngle));
      w.steer += w.spec.x > 0 ? p.toeRad * 0.5 : -p.toeRad * 0.5;
    }

    // ---- 2. engine, gearbox, differential ---------------------------
    this.updateGearbox(dt, control, forwardSpeed);
    // In reverse the brake pedal becomes the throttle and vice versa, which is
    // how every arcade/sim-cade racer maps a two-pedal controller.
    const driveThrottle = this.gear === -1 ? control.brake : control.throttle;
    const brakePedal = this.gear === -1 ? control.throttle : control.brake;
    const effectiveControl: CarControl = { ...control, throttle: driveThrottle, brake: brakePedal };
    const gearRatio = this.currentGearRatio();
    const finalDrive = p.finalDrive;
    const wheelSideOmega = Math.abs(this.meanDrivenWheelOmega()) * Math.abs(gearRatio) * finalDrive;
    const idleOmega = spec.engine.idleRpm * Math.PI / 30;
    const redlineOmega = spec.engine.redlineRpm * Math.PI / 30;
    const limiterOmega = spec.engine.limiterRpm * Math.PI / 30;

    // Clutch behaviour: below idle the clutch slips and the engine can rev.
    const clutchLocked = wheelSideOmega > idleOmega * 0.9;
    // While the clutch slips the engine can rev freely, but a driven launch is
    // limited to a sensible take-up speed (roughly the torque peak).
    const launchOmega = idleOmega + driveThrottle * (redlineOmega * 0.58 - idleOmega);
    let targetOmega: number;
    if (driveThrottle > 0.02) {
      targetOmega = clutchLocked
        ? clamp(lerp(wheelSideOmega, launchOmega, 0.06), idleOmega, limiterOmega)
        : clamp(launchOmega, idleOmega, limiterOmega);
    } else {
      targetOmega = clamp(Math.max(wheelSideOmega, idleOmega), idleOmega, limiterOmega);
    }
    if (this.gear === 0) targetOmega = idleOmega + driveThrottle * (limiterOmega - idleOmega);
    const revRate = clutchLocked ? 26 : 11;
    this.engineOmega = damp(this.engineOmega, targetOmega, revRate, dt);
    if (!Number.isFinite(this.engineOmega)) this.engineOmega = idleOmega;

    // Rev limiter with hysteresis (fuel cut duration).
    let throttleEff = clamp(driveThrottle, 0, 1);
    if (this.limiterTimer > 0) { this.limiterTimer -= dt; throttleEff = 0; }
    else if (this.engineOmega >= limiterOmega) { this.limiterTimer = 0.075; throttleEff = 0; }
    const revLimiter = this.limiterTimer > 0;

    // Turbo lag
    if (spec.engine.turboLag > 0) {
      this.turboState = damp(this.turboState, throttleEff, 1 / spec.engine.turboLag, dt);
    } else this.turboState = 1;
    const boost = spec.engine.turboLag > 0 ? lerp(0.55, 1.0, this.turboState) : 1;

    // Misfire from damage
    if (this.misfire > 0) { throttleEff *= 1 - this.misfire * 0.8; }

    const rpm = this.engineOmega * 30 / Math.PI;
    let engineTorque = torqueAtRpm(spec, rpm) * throttleEff * p.torqueMultiplier * boost * (1 - this.damage.engine * 0.55);
    if (throttleEff < 0.05 && clutchLocked && this.gear !== 0) {
      // Off-throttle pumping losses: proportional to engine speed, scaled by the
      // engine's own braking coefficient and the current gear multiplication.
      const brakeTorque = spec.engine.engineBrake * spec.engine.peakTorqueNm
        * (0.35 + 0.65 * clamp(this.engineOmega / redlineOmega, 0, 1.2)) * p.engineBrakeMultiplier;
      engineTorque -= brakeTorque;
    }
    if (this.gear === 0) engineTorque = 0;

    let driveTorque = 0;
    if (this.shiftTimer === 0 && this.gear !== 0) {
      driveTorque = engineTorque * gearRatio * finalDrive * spec.gearbox.efficiency;
      // Clutch slip losses at very low road speed.
      if (!clutchLocked && speed < 3) driveTorque *= lerp(0.45, 1, clamp(speed / 3, 0, 1) * 0.5 + 0.5);
    }
    // Cap by what the clutch can transmit so a dumped clutch cannot produce
    // thousand-horsepower wheel torque.
    const clutchCapacity = spec.engine.peakTorqueNm * p.torqueMultiplier * 1.8 * Math.abs(gearRatio) * finalDrive;
    driveTorque = clamp(driveTorque, -clutchCapacity, clutchCapacity);

    this.distributeDriveTorque(driveTorque);

    // Traction control: cap each driven wheel's torque to roughly what the tyre
    // can put down at its current load, then trim on measured slip. It reduces
    // real torque - it never adds any.
    if (this.controls.tractionControl) {
      for (let i = 0; i < 4; i++) {
        const w = this.wheels[i];
        if (!w.spec.driven) continue;
        const mu = (i < 2 ? p.tireMuFront : p.tireMuRear) * (w.contact ? w.surface.grip : 1);
        const loadEstimate = w.contact && w.load > 200 ? w.load : p.mass * 9.81 * 0.28;
        const maxTractionTorque = loadEstimate * mu * w.spec.radius * 0.92;
        const target = clamp(w.driveTorque, -maxTractionTorque, maxTractionTorque);
        w.tcMod = damp(w.tcMod, Math.abs(w.driveTorque) > 1 ? Math.abs(target / w.driveTorque) : 1, 22, dt);
        const over = clamp((Math.abs(w.slipRatio) - 0.30) * 1.6, 0, 0.55);
        w.driveTorque = target * (1 - over);
      }
    } else {
      for (const w of this.wheels) w.tcMod = 1;
    }

    // ---- 3. suspension + tyres --------------------------------------
    this.lateralForce = 0;
    for (let i = 0; i < 4; i++) this.updateWheel(i, dt, effectiveControl, env);

    // ---- 4. aero, rolling resistance ---------------------------------
    this.applyAero(env);
    this.updateDriftScore(dt, forwardSpeed, lateralSpeed);
    this.updateDamageState(dt);
    this.updateReadout(dt, control, forwardSpeed, lateralSpeed, speed, engineTorque, driveTorque, revLimiter);
  }

  private currentGearRatio(): number {
    const g = this.spec.gearbox;
    if (this.gear === 0) return 0;
    if (this.gear === -1) return -g.reverse;
    return g.ratios[clamp(this.gear - 1, 0, g.ratios.length - 1)];
  }

  private meanDrivenWheelOmega(): number {
    let sum = 0, n = 0;
    for (const w of this.wheels) if (w.spec.driven) { sum += w.omega; n++; }
    return n ? sum / n : 0;
  }

  private updateGearbox(dt: number, control: CarControl, forwardSpeed: number) {
    const g = this.spec.gearbox;
    if (this.autoShiftCooldown > 0) this.autoShiftCooldown -= dt;
    const rpm = this.engineOmega * 30 / Math.PI;

    const requestUp = control.shiftUp || this.shiftQueued > 0;
    const requestDown = control.shiftDown || this.shiftQueued < 0;
    this.shiftQueued = 0;

    if (requestUp) this.tryShift(1);
    else if (requestDown) this.tryShift(-1);

    if (!this.controls.autoGears) return;

    // Automatic: reverse is selected by holding brake at a standstill.
    if (this.gear > 0 && control.brake > 0.6 && control.throttle < 0.1 && forwardSpeed < 0.6) {
      this.reverseHold += dt;
      if (this.reverseHold > 0.35) {
        this.gear = -1; this.shiftTimer = g.shiftTime * 0.6; this.autoShiftCooldown = 0.3; this.reverseHold = 0; return;
      }
    } else {
      this.reverseHold = 0;
    }
    if (this.gear === -1 && control.throttle > 0.25 && forwardSpeed > -1.2) {
      this.gear = 1; this.shiftTimer = g.shiftTime * 0.6; this.autoShiftCooldown = 0.3; return;
    }
    if (this.autoShiftCooldown > 0) return;
    if (this.gear === -1) return;
    // Shift decisions use the engine speed implied by road speed, not the live
    // engine speed: wheelspin must not trigger an upshift.
    const gearRatio = this.currentGearRatio() * this.params.finalDrive;
    const radius = this.wheels[2].spec.radius;
    // Road-speed-derived engine rpm: immune to wheelspin, so a spinning wheel
    // can never trigger an upshift.
    const roadWheelOmega = Math.abs(forwardSpeed) / radius;
    const wheelSideOmega = roadWheelOmega * Math.abs(gearRatio);
    const idleOmega = this.spec.engine.idleRpm * Math.PI / 30;
    if (wheelSideOmega < idleOmega * 0.9) return;
    const roadRpm = wheelSideOmega * 30 / Math.PI;
    void rpm;
    const upRpm = this.spec.engine.redlineRpm * g.upshiftRpmFraction;
    const downRpm = this.spec.engine.redlineRpm * g.downshiftRpmFraction;
    if (roadRpm > upRpm && this.gear < g.ratios.length && this.shiftTimer === 0) this.tryShift(1);
    else if (roadRpm < downRpm && this.gear > 1 && this.shiftTimer === 0) this.tryShift(-1);
  }

  tryShift(dir: number) {
    const g = this.spec.gearbox;
    if (this.shiftTimer > 0) return;
    let next = this.gear + dir;
    if (this.gear === -1) next = dir > 0 ? 1 : -1;
    if (next < -1 || next > g.ratios.length) return;
    this.gear = next;
    this.shiftTimer = g.shiftTime * this.params.shiftTimeMultiplier;
    this.autoShiftCooldown = Math.max(0.12, g.shiftTime);
  }

  private distributeDriveTorque(total: number) {
    const p = this.params;
    const front = this.wheels[0].spec.driven, rear = this.wheels[2].spec.driven;
    const frontShare = front && rear ? p.frontSplit : front ? 1 : 0;
    const axleTorque = [total * frontShare, total * frontShare, total * (1 - frontShare), total * (1 - frontShare)];
    // Differential action per axle.
    for (const axle of [[0, 1], [2, 3]]) {
      const [a, b] = axle;
      let ta = axleTorque[a], tb = axleTorque[b];
      if (p.diff === 'open') {
        // Open diff: equal torque, spin goes to the unloaded wheel naturally.
      } else {
        const delta = this.wheels[a].omega - this.wheels[b].omega;
        const base = Math.abs(ta);
        const transfer = clamp(p.diffPreload + p.diffLsdRatio * base * 0.5, 0, base * 0.9 + p.diffPreload) * clamp(delta * 2.5, -1, 1);
        ta -= transfer * 0.5;
        tb += transfer * 0.5;
      }
      this.wheels[a].driveTorque = this.wheels[a].spec.driven ? ta : 0;
      this.wheels[b].driveTorque = this.wheels[b].spec.driven ? tb : 0;
    }
  }

  private updateWheel(i: number, dt: number, control: CarControl, env: SimEnvironment) {
    const w = this.wheels[i];
    const spec = this.spec;
    const p = this.params;
    const isFront = i < 2;

    // ---- raycast (filtered: ignores own collider and body) ----------
    this.rayOrigin.copy(w.local).applyQuaternion(this.quat).add(this.pos);
    this.rayDir.copy(this.upV).multiplyScalar(-1);
    // The ray runs from the mount to the road: full droop puts the wheel centre
    // `maxLength` below the mount, so the ray must reach `maxLength + radius`.
    const suspMax = spec.suspension.maxLength;
    const maxToi = suspMax + w.spec.radius + 0.03;
    const contact = this.castWheelRay(this.rayOrigin, this.rayDir, maxToi);

    if (!contact) {
      w.contact = false;
      w.compression = 0;
      w.load = 0;
      w.fx = 0;
      w.fy = 0;
      w.springForce = 0;
      w.airborneTime += dt;
      w.contactPoint.copy(this.rayOrigin).addScaledVector(this.rayDir, suspMax + w.spec.radius);
      w.contactNormal.set(0, 1, 0);
      w.wheelCenter.copy(this.rayOrigin).addScaledVector(this.rayDir, suspMax);
      // Free-spinning driven wheel: accelerate toward the limiter but never
      // generate longitudinal force.
      if (w.spec.driven && this.shiftTimer === 0) {
        const ratio = this.currentGearRatio() * p.finalDrive;
        const maxOmega = Math.abs(ratio) > 1e-4 ? (spec.engine.limiterRpm * Math.PI / 30) / Math.abs(ratio) : 200;
        w.omega += (w.driveTorque / this.wheelInertia) * dt;
        w.omega = clamp(w.omega, -maxOmega, maxOmega);
      }
      w.driveTorque = 0;
      this.integrateWheelBrakeOnly(w, control, dt);
      w.spinAngle += w.omega * dt;
      w.slipRatio = 0;
      w.slipAngle = 0;
      w.utilisation = 0;
      return;
    }

    const dist = contact.toi;
    // Distance mount -> ground, minus the wheel radius = mount -> wheel centre.
    const suspLen = clamp(dist - w.spec.radius, suspMax - spec.suspension.travel - 0.06, suspMax);
    w.suspLen = suspLen;
    w.compression = suspMax - suspLen;
    w.contact = true;
    w.airborneTime = 0;
    w.contactNormal.set(contact.normal.x, contact.normal.y, contact.normal.z);
    // Contact point on the road along the ray; wheel centre sits `radius` above
    // it along the surface normal.
    w.contactPoint.copy(this.rayOrigin).addScaledVector(this.rayDir, suspLen);
    w.wheelCenter.copy(w.contactPoint).addScaledVector(w.contactNormal, w.spec.radius);

    // ---- spring, damper, bump stop ---------------------------------
    const k = (isFront ? p.springFront : p.springRear) * this.damage.wheelGrip[i];
    // Velocity of the body at the mount along the contact normal.
    this.tmpA.copy(this.rayOrigin).sub(this.pos);
    this.tmpB.copy(this.angVel).cross(this.tmpA).add(this.vel);
    const normalVel = this.tmpB.dot(w.contactNormal);
    const compVel = clamp(-normalVel, -6, 6);
    const c = isFront ? p.dampingFront : p.dampingRear;
    let springForce = k * w.compression + c * compVel;
    if (w.compression > spec.suspension.travel) {
      springForce += spec.suspension.bumpStopRate * (w.compression - spec.suspension.travel);
    }
    if (w.compression < 0 && w.suspLen >= suspMax - 1e-4) springForce = Math.min(springForce, 0);
    springForce = clamp(springForce, 0, p.mass * 9.81 * 3.5);
    w.springForce = springForce;

    // Anti-roll bar: transferred between the two sides of the axle.
    const partner = isFront ? (i === 0 ? 1 : 0) : (i === 2 ? 3 : 2);
    const arb = isFront ? p.antiRollFront : p.antiRollRear;
    const arbForce = arb * (w.compression - this.wheels[partner].compression) * 0.5;
    const totalNormal = Math.max(0, springForce + arbForce);

    // Suspension + anti-roll applied along the surface normal at the contact patch.
    this.tmpC.copy(w.contactNormal).multiplyScalar(totalNormal);
    this.body.addForceAtPoint(this.tmpC, w.contactPoint, true);

    // ---- tyre slip ------------------------------------------------
    const cosSteer = Math.cos(w.steer), sinSteer = Math.sin(w.steer);
    // Wheel forward direction in the contact plane.
    this.tmpA.set(sinSteer, 0, cosSteer).applyQuaternion(this.quat);
    this.tmpA.addScaledVector(w.contactNormal, -this.tmpA.dot(w.contactNormal)).normalize();
    const wheelFwd = this.tmpA.clone();
    if (wheelFwd.lengthSq() < 0.5) wheelFwd.set(0, 0, 1);
    const wheelLat = this.tmpB.copy(w.contactNormal).cross(wheelFwd).normalize().multiplyScalar(-1);

    // Contact patch velocity (chassis velocity + omega x r).
    const r = w.contactPoint.clone().sub(this.pos);
    const vC = this.angVel.clone().cross(r).add(this.vel);
    const vLong = vC.dot(wheelFwd);
    const vLat = vC.dot(wheelLat);

    // Wheel radius grows slightly with load (small effect, keeps contacts honest)
    const radius = w.spec.radius;
    const surfaceSpeed = w.omega * radius;
    const denom = Math.max(Math.abs(vLong), Math.abs(surfaceSpeed), 0.9);
    const slipRatio = clamp((surfaceSpeed - vLong) / denom, -4, 4);
    const slipAngle = Math.atan2(vLat, Math.max(Math.abs(vLong), 0.8));

    const sample = this.surfaceSampler(w.contactPoint.x, w.contactPoint.y, w.contactPoint.z, w.contactNormal.y);
    const surface = resolveSurface(sample.id, sample.wetness);
    w.surface = surface;
    w.surfaceId = surface.id;
    w.wetness = sample.wetness;

    const compound = this.effectiveCompound(i);
    const baseMu = (isFront ? p.tireMuFront : p.tireMuRear) * this.damage.wheelGrip[i] * (isFront ? 1 : 1);
    // Tyre temperature / wear (optional, measurable: both feed mu).
    if (env.enableTireTemp) {
      w.temperature = updateTireTemp(w.temperature, w.utilisation, Math.abs(vLong), dt, compound, env.ambientTempC);
    }
    const tempGrip = env.enableTireTemp ? tempGripMultiplier(w.temperature, compound) : 1;
    if (env.enableTireWear) {
      const wearRate = compound.wearRate * w.utilisation * Math.abs(slipRatio + Math.sin(slipAngle)) * 0.00012;
      w.wear = clamp(w.wear + wearRate * Math.abs(vLong) * dt, 0, 1);
    }
    const wearGrip = env.enableTireWear ? 1 - w.wear * 0.22 : 1;
    const camber = p.camberRad;
    w.camber = camber;

    // Standing water reduces the friction circle when fast.
    const aquaplane = surface.id === 'asphaltWet' ? clamp((Math.abs(vLong) - 18) / 40, 0, 0.25) : 0;

    this.tireOut = computeTireForce({
      slipRatio, slipAngle, loadN: totalNormal,
      mu: baseMu * surface.grip,
      camber,
      compound,
      tempGrip,
      wearGrip,
      surfaceScale: 1 - aquaplane,
    }, this.tireOut);

    let fx = this.tireOut.fx;
    const fy = this.tireOut.fy;
    void fy;

    // ---- brakes, ABS ------------------------------------------------
    const { service: serviceBrake, handbrake } = this.computeBrakeTorque(i, control);
    if (this.controls.abs && serviceBrake > 1) {
      // Target just past the peak-slip point rather than full lock.
      const locking = clamp((-slipRatio - 0.11) * 6.5, 0, 0.9);
      w.absMod = damp(w.absMod, 1 - locking, 18, dt);
    } else w.absMod = 1;
    const appliedBrake = serviceBrake * w.absMod + handbrake;
    w.brakeTorque = appliedBrake;

    // ---- wheel spin integration (semi-implicit) ----------------------
    // Linearise Fx around the current wheel speed so the stiff tyre/contact
    // coupling stays stable at 120 Hz.
    const dFxdslip = this.tireOut.dFxdslip;
    const dFxdOmega = (dFxdslip * radius) / denom;
    const Iw = this.wheelInertia;
    const num = (Iw * w.omega) / dt + w.driveTorque - radius * fx + radius * dFxdOmega * w.omega;
    const den = Iw / dt + radius * dFxdOmega;
    let omegaNew = den > 1e-3 ? num / den : w.omega + (w.driveTorque / Iw) * dt;
    if (!Number.isFinite(omegaNew)) omegaNew = w.omega;
    // A wheel with non-negative drive torque cannot be spun backwards by the
    // tyre reaction in one tick; the tyre may only bring it to a stop.
    if (Math.sign(omegaNew) !== Math.sign(w.omega) && w.omega !== 0 && w.driveTorque >= 0 && appliedBrake <= 0) {
      omegaNew = 0;
    }
    // Brakes oppose rotation but can never drive the wheel backwards.
    if (appliedBrake > 0) {
      const dOmegaBrake = (appliedBrake / Iw) * dt;
      if (Math.abs(omegaNew) <= dOmegaBrake) omegaNew = 0;
      else omegaNew -= Math.sign(omegaNew) * dOmegaBrake;
    }
    const ratio = this.currentGearRatio() * p.finalDrive;
    const maxOmega = Math.abs(ratio) > 1e-3 ? (spec.engine.limiterRpm * Math.PI / 30) / Math.abs(ratio) : 400;
    const hardCap = Math.max(maxOmega, Math.abs(vLong) / Math.max(radius, 0.1) + 60);
    omegaNew = clamp(omegaNew, -hardCap, hardCap);
    w.omega = omegaNew;

    // Evaluate the tyre a second time at the solved wheel speed: the force the
    // body receives must match the slip the wheel actually ends the tick with,
    // otherwise wheelspin can settle into a false equilibrium.
    const surfaceSpeedNew = w.omega * radius;
    const slipNew = clamp((surfaceSpeedNew - vLong) / Math.max(Math.abs(vLong), Math.abs(surfaceSpeedNew), 0.9), -4, 4);
    this.tireOut = computeTireForce({
      slipRatio: slipNew, slipAngle, loadN: totalNormal,
      mu: baseMu * surface.grip, camber, compound,
      tempGrip, wearGrip, surfaceScale: 1 - aquaplane,
    }, this.tireOut);
    fx = this.tireOut.fx;
    const fyFinal = this.tireOut.fy;
    w.fx = fx;
    w.fy = fyFinal;
    w.slipRatio = slipNew;
    w.slipAngle = slipAngle;
    w.utilisation = Math.max(this.tireOut.utilisation, 0);
    w.load = totalNormal;

    // ---- apply tyre force at the contact patch ----------------------
    this.tmpC.copy(wheelFwd).multiplyScalar(fx).addScaledVector(wheelLat, fyFinal);
    this.body.addForceAtPoint(this.tmpC, w.contactPoint, true);
    // Signed lateral force (positive = accelerating to the car's right) for the
    // HUD g-meter and the drift logic.
    this.lateralForce += fyFinal * Math.sign(wheelLat.dot(this.rightV) || 1);

    // ---- rolling resistance ----------------------------------------
    const crr = surface.rollResist;
    const rollForce = -Math.sign(vLong) * crr * totalNormal;
    if (Math.abs(vLong) > 0.05) {
      this.tmpC.copy(wheelFwd).multiplyScalar(clamp(rollForce, -totalNormal * 0.2, totalNormal * 0.2));
      this.body.addForceAtPoint(this.tmpC, w.contactPoint, true);
    }

    w.spinAngle = (w.spinAngle + w.omega * dt) % (Math.PI * 2);
  }

  private ray = new Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

  private castWheelRay(origin: THREE.Vector3, dir: THREE.Vector3, maxToi: number) {
    if (!this.rapierWorld) return null;
    this.ray.origin = { x: origin.x, y: origin.y, z: origin.z };
    this.ray.dir = { x: dir.x, y: dir.y, z: dir.z };
    const hit = this.rapierWorld.castRayAndGetNormal(
      this.ray, maxToi, true, undefined, undefined, this.collider, this.body,
    );
    if (!hit) return null;
    // Rapier reports toi in units of |dir| (normalised here).
    return { toi: hit.timeOfImpact, normal: hit.normal };
  }

  rapierWorld: RapierWorld | null = null;

  /**
   * Returns the service (foot) brake torque, which ABS may modulate, and the
   * handbrake torque, which it may not - a handbrake is mechanical, not
   * hydraulic, so an ABS-equipped car still locks the rear wheels with it.
   */
  private computeBrakeTorque(i: number, control: CarControl): { service: number; handbrake: number } {
    const p = this.params;
    const spec = this.spec;
    const isFront = i < 2;
    const totalForce = spec.brakes.capacityG * 9.81 * p.mass;
    const frontShare = clamp(p.brakeBias, 0.3, 0.85);
    const axleForce = totalForce * (isFront ? frontShare : 1 - frontShare);
    const perWheelForce = axleForce / 2;
    const service = perWheelForce * this.wheels[i].spec.radius * clamp(control.brake, 0, 1);
    const handbrake = !isFront ? spec.brakes.handbrakeTorque * clamp(control.handbrake, 0, 1) : 0;
    return { service, handbrake };
  }

  private integrateWheelBrakeOnly(w: WheelState, control: CarControl, dt: number) {
    const b = this.computeBrakeTorque(this.wheels.indexOf(w), control);
    const brake = b.service + b.handbrake;
    if (brake <= 0) return;
    const dOmega = (brake / this.wheelInertia) * dt;
    if (Math.abs(w.omega) <= dOmega) w.omega = 0;
    else w.omega -= Math.sign(w.omega) * dOmega;
  }

  private applyAero(env: SimEnvironment) {
    const p = this.params;
    const relVelX = this.vel.x - env.windX;
    const relVelZ = this.vel.z - env.windZ;
    const relSpeed = Math.hypot(relVelX, relVelZ);
    if (relSpeed > 0.2) {
      const q = 0.5 * env.airDensity * p.dragCoef * p.spec.aero.frontalArea * relSpeed * relSpeed;
      this.tmpA.set(-relVelX / relSpeed * q, 0, -relVelZ / relSpeed * q);
      this.body.addForce(this.tmpA, true);
    }
    // Downforce grows with speed squared and loads both axles.
    if (p.downforceFront > 0 || p.downforceRear > 0) {
      const q = 0.5 * env.airDensity * Math.max(0, this.vel.dot(this.fwd));
      const speed = Math.max(0, this.vel.dot(this.fwd));
      const dfF = 0.5 * env.airDensity * p.downforceFront * speed * speed;
      const dfR = 0.5 * env.airDensity * p.downforceRear * speed * speed;
      void q;
      if (dfF > 0.5) {
        this.tmpA.set(0, -dfF, 0);
        this.tmpB.copy(this.pos).addScaledVector(this.fwd, this.spec.wheelbase * 0.45);
        this.body.addForceAtPoint(this.tmpA, this.tmpB, true);
      }
      if (dfR > 0.5) {
        this.tmpA.set(0, -dfR, 0);
        this.tmpB.copy(this.pos).addScaledVector(this.fwd, -this.spec.wheelbase * 0.45);
        this.body.addForceAtPoint(this.tmpA, this.tmpB, true);
      }
    }
  }

  private updateDriftScore(dt: number, forwardSpeed: number, lateralSpeed: number) {
    const speed = Math.hypot(forwardSpeed, lateralSpeed);
    const slip = Math.atan2(lateralSpeed, Math.max(Math.abs(forwardSpeed), 0.5));
    const drifting = speed > 7 && Math.abs(slip) > 0.18 && forwardSpeed > 2;
    this.driftActive = drifting;
    const rate = drifting ? Math.abs(Math.sin(slip)) * speed * 6 : 0;
    this.readout.drifting = drifting;
    this.readout.driftScoreRate = rate;
    void dt;
  }

  /** Called by the game when Rapier reports a collision involving this car. */
  applyImpact(impulseMagnitude: number, localPoint?: THREE.Vector3Like) {
    if (this.impactCooldown > 0) return;
    const severity = clamp(impulseMagnitude / (this.params.mass * 6), 0, 1);
    if (severity < 0.02) return;
    this.impactCooldown = 0.12;
    if (!this.simDamage) return;
    // Mechanical effects: engine loses power, steering pulls, cornering grip drops.
    this.damage.engine = clamp(this.damage.engine + severity * 0.55, 0, 1);
    if (severity > 0.25) {
      this.damage.steering = clamp(this.damage.steering + (Math.random() - 0.5) * severity * 0.16, -0.2, 0.2);
      const idx = localPoint ? this.nearestWheel(localPoint) : Math.floor(Math.random() * 4);
      this.damage.wheelGrip[idx] = clamp(this.damage.wheelGrip[idx] - severity * 0.25, 0.45, 1);
    }
    if (severity > 0.6) this.misfire = clamp(this.misfire + severity * 0.6, 0, 0.8);
  }

  private nearestWheel(local: THREE.Vector3Like): number {
    let best = 0, bestDist = Infinity;
    for (let i = 0; i < 4; i++) {
      const d = Math.abs(local.x - this.wheels[i].spec.x) + Math.abs(local.z - this.wheels[i].spec.z);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
  }

  private updateDamageState(dt: number) {
    if (this.misfire > 0) this.misfire = Math.max(0, this.misfire - dt * 0.08);
    this.readout.damage = { engine: this.damage.engine, steering: this.damage.steering, wheelGrip: [...this.damage.wheelGrip] as [number, number, number, number] };
  }

  private updateReadout(dt: number, control: CarControl, forwardSpeed: number, lateralSpeed: number, speed: number, engineTorque: number, driveTorque: number, revLimiter: boolean) {
    const r = this.readout;
    r.speedMs = speed;
    r.forwardSpeedMs = forwardSpeed;
    r.speedKmh = speed * KMH_PER_MS;
    r.rpm = this.engineOmega * 30 / Math.PI;
    r.gear = this.gear;
    r.shifting = this.shiftTimer > 0;
    r.engineTorque = engineTorque;
    r.driveTorque = driveTorque;
    r.throttle = control.throttle;
    r.brake = control.brake;
    r.revLimiter = revLimiter;
    let airborne = 0, maxSlip = 0, util = 0;
    for (const w of this.wheels) {
      if (!w.contact) airborne++;
      maxSlip = Math.max(maxSlip, Math.abs(w.slipAngle));
      util = Math.max(util, w.utilisation);
    }
    r.wheelsAirborne = airborne;
    r.maxSlipAngle = maxSlip;
    r.utilisation = util;
    // Lateral g from the yaw rate the chassis is actually rotating at, and
    // longitudinal g from the change in forward speed.
    // Lateral acceleration is read straight from the lateral tyre forces the
    // contact patches are generating, divided by mass - the same number a phone
    // accelerometer in the car would read, without the yaw transient spike.
    const latFromForces = -this.lateralForce / (this.params.mass * 9.81);
    const longAccel = (forwardSpeed - this.prevForwardSpeed) / Math.max(dt, 1e-4);
    r.lateralG = lerp(r.lateralG, latFromForces, 0.5);
    r.longitudinalG = lerp(r.longitudinalG, longAccel / 9.81, 0.3);
    if (this.wheels[0].contact) r.surface = this.wheels[0].surface;
  }

  // ------------------------------------------------------------- utilities
  resetTo(x: number, y: number, z: number, yaw: number) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.body.setTranslation({ x, y, z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    for (const w of this.wheels) { w.omega = 0; w.contact = false; w.compression = 0; }
    this.gear = 1;
    this.engineOmega = this.spec.engine.idleRpm * Math.PI / 30;
    this.shiftTimer = 0;
    this.refreshBasis();
  }

  /** Place the car deterministically (used by reprojection / tests). */
  setPose(x: number, y: number, z: number, quat: { x: number; y: number; z: number; w: number }, linvel?: THREE.Vector3Like, angvel?: THREE.Vector3Like) {
    this.body.setTranslation({ x, y, z }, true);
    this.body.setRotation(quat, true);
    if (linvel) this.body.setLinvel({ x: linvel.x, y: linvel.y, z: linvel.z }, true);
    if (angvel) this.body.setAngvel({ x: angvel.x, y: angvel.y, z: angvel.z }, true);
    this.refreshBasis();
  }

  captureSnapshot(): VehicleSnapshot {
    const t = this.body.translation(), q = this.body.rotation(), v = this.body.linvel(), av = this.body.angvel();
    return {
      p: [t.x, t.y, t.z], q: [q.x, q.y, q.z, q.w], v: [v.x, v.y, v.z], av: [av.x, av.y, av.z],
      omega: [this.wheels[0].omega, this.wheels[1].omega, this.wheels[2].omega, this.wheels[3].omega],
      gear: this.gear, engineOmega: this.engineOmega,
      damageEngine: this.damage.engine, damageSteer: this.damage.steering,
      wheelGrip: [...this.damage.wheelGrip] as [number, number, number, number],
      turbo: this.turboState,
    };
  }

  restoreSnapshot(s: VehicleSnapshot) {
    this.body.setTranslation({ x: s.p[0], y: s.p[1], z: s.p[2] }, true);
    this.body.setRotation({ x: s.q[0], y: s.q[1], z: s.q[2], w: s.q[3] }, true);
    this.body.setLinvel({ x: s.v[0], y: s.v[1], z: s.v[2] }, true);
    this.body.setAngvel({ x: s.av[0], y: s.av[1], z: s.av[2] }, true);
    for (let i = 0; i < 4; i++) this.wheels[i].omega = s.omega[i];
    this.gear = s.gear;
    this.engineOmega = s.engineOmega;
    this.damage.engine = s.damageEngine;
    this.damage.steering = s.damageSteer;
    this.damage.wheelGrip = [...s.wheelGrip] as [number, number, number, number];
    this.turboState = s.turbo;
    this.refreshBasis();
  }

  /** Force the car to a straight-line velocity (used by tests and network). */
  setVelocity(x: number, y: number, z: number) {
    this.body.setLinvel({ x, y, z }, true);
  }

  dispose(world: RapierWorld) {
    world.removeRigidBody(this.body);
  }
}

export { wrapAngle, RAD2DEG };
