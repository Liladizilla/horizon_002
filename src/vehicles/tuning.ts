import { clamp } from '../core/math';
import type { CarUpgradeState } from '../core/save';
import type { VehicleSpec } from './spec';

export interface TuningState {
  camber: number;      // degrees, negative = more negative camber
  toe: number;         // degrees total
  rideHeight: number;  // m offset from stock
  stiffnessBias: number; // 0..1 (0 = soft, 1 = stiff) blend toward a stiffer setup
  brakeBias: number;   // 0..1 fraction front
  finalDrive: number;  // multiplier on the stock final drive
}

/** Fully resolved simulation parameters after upgrades + tuning. */
export interface VehicleParams {
  spec: VehicleSpec;
  mass: number;
  torqueMultiplier: number;
  engineBrakeMultiplier: number;
  shiftTimeMultiplier: number;
  finalDrive: number;
  brakeCapacityG: number;
  brakeBias: number;
  tireMuFront: number;
  tireMuRear: number;
  compoundFront: string;
  compoundRear: string;
  springFront: number;
  springRear: number;
  antiRollFront: number;
  antiRollRear: number;
  dampingFront: number;
  dampingRear: number;
  downforceFront: number;
  downforceRear: number;
  dragCoef: number;
  camberRad: number;
  toeRad: number;
  rideHeightOffset: number;
  drivetrain: 'FWD' | 'RWD' | 'AWD';
  frontSplit: number;
  diff: 'open' | 'lsd' | 'locked';
  diffPreload: number;
  diffLsdRatio: number;
  drivenFront: boolean;
  drivenRear: boolean;
  /** centre of mass height */
  cgHeight: number;
}

const TIRE_LADDER = ['street', 'sport', 'semiSlick', 'race'];

export const UPGRADE_COSTS = {
  engine: [0, 4500, 12000, 26000],
  turbo: [0, 7000, 18000],
  gearbox: [0, 5000, 14000],
  tires: [0, 3000, 9000, 22000],
  brakes: [0, 2500, 7000, 16000],
  suspension: [0, 3500, 9000, 20000],
  weight: [0, 6000, 16000],
  aero: [0, 9000, 24000],
};

export function upgradeCost(up: CarUpgradeState): number {
  let total = 0;
  total += UPGRADE_COSTS.engine[clamp(up.engine, 0, 3)];
  total += UPGRADE_COSTS.turbo[clamp(up.turbo, 0, 2)];
  total += UPGRADE_COSTS.gearbox[clamp(up.gearbox, 0, 2)];
  total += UPGRADE_COSTS.tires[clamp(up.tires, 0, 3)];
  total += UPGRADE_COSTS.brakes[clamp(up.brakes, 0, 3)];
  total += UPGRADE_COSTS.suspension[clamp(up.suspension, 0, 3)];
  total += UPGRADE_COSTS.weight[clamp(up.weight, 0, 2)];
  total += UPGRADE_COSTS.aero[clamp(up.aero, 0, 2)];
  return total;
}

export function resolveParams(spec: VehicleSpec, up: CarUpgradeState, tuning: TuningState): VehicleParams {
  const e = up.engine, t = up.turbo, g = up.gearbox, ti = up.tires, br = up.brakes, su = up.suspension, w = up.weight, ae = up.aero;
  const mass = spec.mass * (1 - 0.03 * w);
  const torqueMultiplier = [1, 1.08, 1.17, 1.29][e] * (1 + 0.05 * t);
  // Tyre upgrade climbs the compound ladder from the car's stock compound.
  const baseIdx = Math.max(0, TIRE_LADDER.indexOf(spec.tires.front));
  const compound = TIRE_LADDER[clamp(baseIdx + ti, 0, TIRE_LADDER.length - 1)];
  const driftOrOffroad = ['drift', 'offroad', 'rally', 'winter'].includes(spec.tires.front);
  const compoundFront = ti > 0 && !driftOrOffroad ? compound : spec.tires.front;
  const compoundRear = ti > 0 && !driftOrOffroad ? compound : spec.tires.rear;
  const muBonus = driftOrOffroad ? 0 : 0.016 * ti * e; // upgrades compound brand-wide
  const drivetrain = up.drivetrain === 'keep' ? spec.drivetrain : (up.drivetrain.toUpperCase() as 'FWD' | 'RWD' | 'AWD');
  const frontSplit = drivetrain === 'FWD' ? 1 : drivetrain === 'RWD' ? 0 : Math.max(0.25, spec.drive.frontSplit);
  const dampingRatio = 0.4;
  const cornerMass = mass / 4;
  const springMul = 1 + 0.09 * su;
  const bias = clamp(tuning.stiffnessBias, 0, 1);
  const springFront = spec.suspension.springFront * springMul * (0.85 + bias * 0.4);
  const springRear = spec.suspension.springRear * springMul * (0.85 + bias * 0.4);
  return {
    spec,
    mass,
    torqueMultiplier,
    engineBrakeMultiplier: 1 + 0.05 * e,
    shiftTimeMultiplier: 1 - 0.18 * g,
    finalDrive: spec.gearbox.finalDrive * clamp(tuning.finalDrive, 0.75, 1.3),
    brakeCapacityG: spec.brakes.capacityG * (1 + 0.09 * br),
    brakeBias: clamp(br > 0 ? Math.max(tuning.brakeBias, spec.brakes.bias - 0.02) : spec.brakes.bias, 0.45, 0.75),
    tireMuFront: spec.tires.gripFront + muBonus,
    tireMuRear: spec.tires.gripRear + muBonus,
    compoundFront,
    compoundRear,
    springFront,
    springRear,
    antiRollFront: spec.suspension.antiRollFront * springMul,
    antiRollRear: spec.suspension.antiRollRear * springMul,
    dampingFront: spec.suspension.dampingRatioFront > 0 ? 2 * Math.sqrt(springFront * cornerMass) * Math.min(0.75, spec.suspension.dampingRatioFront + 0.04 * su) : 2 * Math.sqrt(springFront * cornerMass) * dampingRatio,
    dampingRear: 2 * Math.sqrt(springRear * cornerMass) * Math.min(0.75, spec.suspension.dampingRatioRear + 0.04 * su),
    downforceFront: spec.aero.downforceFront * (1 + 0.35 * ae),
    downforceRear: spec.aero.downforceRear * (1 + 0.35 * ae),
    dragCoef: spec.aero.dragCoef * (1 + 0.04 * ae),
    camberRad: tuning.camber * Math.PI / 180,
    toeRad: tuning.toe * Math.PI / 180,
    rideHeightOffset: tuning.rideHeight,
    drivetrain,
    frontSplit,
    diff: spec.drive.diff,
    diffPreload: spec.drive.diffPreload,
    diffLsdRatio: spec.drive.diffLsdRatio,
    drivenFront: drivetrain !== 'RWD',
    drivenRear: drivetrain !== 'FWD',
    cgHeight: spec.cgHeight,
  };
}

export function defaultTuning(): TuningState {
  return { camber: -0.5, toe: 0.05, rideHeight: 0, stiffnessBias: 0.5, brakeBias: 0.62, finalDrive: 1 };
}
