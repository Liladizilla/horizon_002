import { clamp } from '../core/math';

export type Drivetrain = 'FWD' | 'RWD' | 'AWD';

export interface WheelSpec {
  /** local mount position: x = right, y = up (suspension top mount), z = forward */
  x: number;
  z: number;
  y: number;
  radius: number;
  width: number;
  driven: boolean;
  steering: boolean;
}

export interface TorquePoint { rpm: number; fraction: number }

export interface VehicleSpec {
  id: string;
  name: string;
  manufacturer: string;
  year: number;
  tier: string;
  bodyStyle: 'coupe' | 'hatch' | 'sedan' | 'suv' | 'supercar' | 'truck' | 'buggy' | 'muscle' | 'van';
  drivetrain: Drivetrain;
  price: number;

  // --- mass & geometry (SI) ---
  mass: number;              // kg including driver
  cgHeight: number;          // m above ground
  length: number; width: number; height: number;
  wheelbase: number; track: number;
  inertiaScale: number;      // multiplier on the auto-computed inertia tensor

  // --- engine ---
  engine: {
    idleRpm: number;
    redlineRpm: number;
    limiterRpm: number;
    peakTorqueNm: number;
    peakTorqueRpm: number;
    /** normalised torque curve, sampled across idle..redline */
    curve: TorquePoint[];
    /** engine braking coefficient (Nm per rad/s) */
    engineBrake: number;
    /** engine + flywheel rotational inertia (kg m^2) */
    inertia: number;
    /** turbo lag time constant in seconds (0 = naturally aspirated) */
    turboLag: number;
    /** internal drive losses as a fraction of indicated torque */
    frictionFraction: number;
  };

  // --- transmission ---
  gearbox: {
    ratios: number[];        // forward gears, first is lowest
    reverse: number;
    finalDrive: number;
    efficiency: number;
    shiftTime: number;       // seconds
    upshiftRpmFraction: number;
    downshiftRpmFraction: number;
  };

  // --- brakes ---
  brakes: {
    /** peak deceleration the system can produce on a tyre-limited surface (g) */
    capacityG: number;
    bias: number;            // fraction to the front axle
    handbrakeTorque: number; // Nm applied to the rear axle
  };

  // --- suspension (per corner, front and rear) ---
  suspension: {
    springFront: number;     // N/m
    springRear: number;
    dampingRatioFront: number; // zeta
    dampingRatioRear: number;
    antiRollFront: number;   // N/m of compression difference
    antiRollRear: number;
    travel: number;          // m of usable travel
    bumpStopRate: number;    // extra N/m beyond travel
    maxLength: number;       // mount-to-contact at full droop
  };

  // --- tyres ---
  tires: {
    front: string;  // compound id
    rear: string;
    pressure: number; // bar
    gripFront: number;
    gripRear: number;
    widthFront: number;
    widthRear: number;
  };

  // --- aero ---
  aero: {
    dragCoef: number;        // Cd
    frontalArea: number;     // m^2
    downforceFront: number;  // Cl*A front
    downforceRear: number;
  };

  // --- steering ---
  steering: {
    maxAngle: number;        // rad at low speed
    speedFalloff: number;    // rad at 200 km/h
    ackermann: number;       // 0..1
  };

  // --- driveline ---
  drive: {
    /** AWD front torque fraction (0 for RWD, 1 for FWD) */
    frontSplit: number;
    diff: 'open' | 'lsd' | 'locked';
    diffPreload: number;
    diffLsdRatio: number;
  };

  // --- visuals ---
  paint: string;
  accent: string;
  stats: { powerHp: number; torqueNm: number; weightKg: number; rating: number };
  description: string;
}

/** Peak power in watts from the torque curve. */
export function peakPowerW(spec: VehicleSpec): number {
  let best = 0;
  for (let rpm = spec.engine.idleRpm; rpm <= spec.engine.redlineRpm; rpm += 50) {
    const w = torqueAtRpm(spec, rpm) * (rpm * Math.PI / 30);
    if (w > best) best = w;
  }
  return best;
}

export function torqueAtRpm(spec: VehicleSpec, rpm: number): number {
  const { curve, idleRpm, redlineRpm, limiterRpm, peakTorqueNm } = spec.engine;
  const r = clamp(rpm, idleRpm * 0.8, limiterRpm);
  if (r <= curve[0].rpm) return peakTorqueNm * curve[0].fraction;
  if (r >= redlineRpm * 1.02) return 0;
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i], b = curve[i + 1];
    if (r >= a.rpm && r <= b.rpm) {
      const t = (r - a.rpm) / (b.rpm - a.rpm);
      // smooth interpolation keeps the curve differentiable for stability
      const s = t * t * (3 - 2 * t);
      return peakTorqueNm * (a.fraction + (b.fraction - a.fraction) * s);
    }
  }
  return peakTorqueNm * curve[curve.length - 1].fraction * 0.9;
}

/** Mass/geometry derived values that the simulation needs. */
export function deriveMassProperties(spec: VehicleSpec) {
  const m = spec.mass;
  // Treat the body as a solid box for inertia: Ixx (pitch), Iyy (yaw), Izz (roll)
  const l = spec.length, w = spec.width, h = spec.height;
  const ixx = (m / 12) * (h * h + l * l);
  const iyy = (m / 12) * (w * w + l * l);
  const izz = (m / 12) * (h * h + w * w);
  return {
    ixx: ixx * spec.inertiaScale,
    iyy: iyy * spec.inertiaScale,
    izz: izz * spec.inertiaScale,
  };
}

export function makeWheels(spec: VehicleSpec): WheelSpec[] {
  const { wheelbase, track } = spec;
  const halfTrack = track / 2;
  const frontZ = wheelbase / 2;
  const rearZ = -wheelbase / 2;
  const rF = spec.tires.widthFront >= 0 ? spec.tires.widthFront : 0.24;
  void rF;
  const isFwd = spec.drivetrain === 'FWD';
  const isAwd = spec.drivetrain === 'AWD';
  const y = 0.12; // mount height offset from body origin (body origin sits at CG height)
  return [
    { x: -halfTrack, z: frontZ, y, radius: 0.34, width: spec.tires.widthFront, driven: isFwd || isAwd, steering: true },
    { x: halfTrack, z: frontZ, y, radius: 0.34, width: spec.tires.widthFront, driven: isFwd || isAwd, steering: true },
    { x: -halfTrack, z: rearZ, y, radius: 0.35, width: spec.tires.widthRear, driven: !isFwd, steering: false },
    { x: halfTrack, z: rearZ, y, radius: 0.35, width: spec.tires.widthRear, driven: !isFwd, steering: false },
  ].map((w) => ({ ...w, radius: spec.bodyStyle === 'truck' || spec.bodyStyle === 'suv' || spec.bodyStyle === 'buggy' ? 0.42 : w.radius }));
}
