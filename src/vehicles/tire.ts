import { clamp } from '../core/math';

/**
 * Simplified Pacejka "Magic Formula" tyre.
 *
 * The full Pacejka 96/2002 models have 20+ coefficients fitted from
 * tyre-machine data. This implementation keeps the characteristic shape
 * (linear region -> peak -> sliding plateau and fall-off) with 4 tunable
 * coefficients per axis plus load sensitivity and a friction ellipse, which is
 * what most consumer racing titles use under the hood.
 *
 *   F = D * sin(C * atan(B*x - E*(B*x - atan(B*x))))
 *
 * D = peak force = mu_eff * Fz
 * B = stiffness factor, C = shape factor, E = curvature factor
 */
export interface AxialCoeffs { B: number; C: number; E: number }

export interface TireCompound {
  id: string;
  label: string;
  /** Peak friction coefficient vs. dry asphalt. */
  mu: number;
  /** Cornering stiffness factor. */
  B: number;
  /** Longitudinal stiffness factor. */
  Bx: number;
  /** Rate of grip loss per N of load above the reference load. */
  loadSensitivity: number;
  /** Peak operating temperature (deg C) - only used when temp model is on. */
  optTempC: number;
  wearRate: number;
  /** Price tier for the garage. */
  tier: number;
}

export const REFERENCE_LOAD_N = 4000; // ~quarter of a 1.5 t car under load transfer

export function magicFormula(x: number, B: number, C: number, E: number): number {
  const bx = B * x;
  return Math.sin(C * Math.atan(bx - E * (bx - Math.atan(bx))));
}

/** Effective friction after load sensitivity (grip falls slightly with load). */
export function effectiveMu(baseMu: number, loadN: number, loadSensitivity: number): number {
  const ratio = Math.max(loadN, 1) / REFERENCE_LOAD_N;
  const scale = 1 - loadSensitivity * (ratio - 1);
  return baseMu * clamp(scale, 0.55, 1.35);
}

export interface TireInputs {
  /** longitudinal slip ratio (dimensionless, can exceed 1) */
  slipRatio: number;
  /** slip angle in radians */
  slipAngle: number;
  /** vertical load in newtons (>= 0) */
  loadN: number;
  /** base friction coefficient of the compound already multiplied by surface */
  mu: number;
  /** camber in radians (negative = top of wheel leaning in) */
  camber: number;
  compound: TireCompound;
  /** 0..1 grip multiplier from temperature (optional model). */
  tempGrip?: number;
  /** 0..1 grip multiplier from wear. */
  wearGrip?: number;
  /** friction circle scale 0..1 (e.g. water film reduces it) */
  surfaceScale?: number;
}

export interface TireOutputs {
  fx: number;
  fy: number;
  /** peak available force magnitude for HUD/debug */
  available: number;
  /** 0..1 how much of the friction circle is used */
  utilisation: number;
  /** local longitudinal stiffness dFx/d(slipRatio), used by the wheel solver */
  dFxdslip: number;
}

const LONG: AxialCoeffs = { B: 11.5, C: 1.62, E: 0.55 };
const LAT: AxialCoeffs = { B: 8.8, C: 1.42, E: 0.42 };

/**
 * Pure function, allocation free. Long and lateral forces are computed
 * independently then combined with a friction ellipse so that simultaneous
 * braking and cornering cannot exceed available grip.
 */
export function computeTireForce(i: TireInputs, out: TireOutputs): TireOutputs {
  const load = Math.max(i.loadN, 0);
  const tempGrip = i.tempGrip ?? 1;
  const wearGrip = i.wearGrip ?? 1;
  const scale = i.surfaceScale ?? 1;
  const muEff = effectiveMu(i.mu * tempGrip * wearGrip * scale, load, i.compound.loadSensitivity);
  const D = muEff * load;

  if (load <= 1e-3) {
    out.fx = 0; out.fy = 0; out.available = 0; out.utilisation = 0; out.dFxdslip = 0;
    return out;
  }

  const Bx = i.compound.Bx, By = i.compound.B;
  const kappa = clamp(i.slipRatio, -6, 6);
  const alpha = clamp(i.slipAngle, -1.6, 1.6);

  const fxPure = D * magicFormula(kappa, Bx, LONG.C, LONG.E);
  const fyPure = -D * magicFormula(alpha, By, LAT.C, LAT.E);

  // Camber thrust: a leaning tyre pushes toward the lean.
  const fyCamber = -i.camber * load * 0.55;

  // Friction ellipse: normalise both axes to the pure peak, then clamp to 1.
  const nx = Math.abs(fxPure) / Math.max(D, 1);
  const ny = Math.abs(fyPure + fyCamber) / Math.max(D, 1);
  const n = Math.sqrt(nx * nx + ny * ny);
  const shrink = n > 1 ? 1 / n : 1;

  out.fx = fxPure * shrink;
  out.fy = (fyPure + fyCamber) * shrink;
  out.available = D;
  out.utilisation = Math.min(n, 1.6);
  // dFx/dkappa of the pure curve, scaled by the same shrink. Central difference
  // is cheap and stays correct for any coefficient set.
  const h = 1e-3;
  const fPlus = D * magicFormula(kappa + h, Bx, LONG.C, LONG.E);
  const fMinus = D * magicFormula(kappa - h, Bx, LONG.C, LONG.E);
  out.dFxdslip = ((fPlus - fMinus) / (2 * h)) * shrink;
  return out;
}

export function makeTireOutputs(): TireOutputs {
  return { fx: 0, fy: 0, available: 0, utilisation: 0, dFxdslip: 0 };
}

/** Approximate tyre temperature model (optional, toggleable from settings). */
export function updateTireTemp(
  tempC: number,
  utilisation: number,
  speed: number,
  dt: number,
  compound: TireCompound,
  ambientC = 22,
): number {
  // Heat comes from rolling (proportional to speed), from sliding (including a
  // cross term for airflow over a slipping tyre) and is lost to the air.
  const rolling = 0.12 * Math.abs(speed);
  const sliding = 6 * utilisation * utilisation * (0.6 + 0.05 * Math.abs(speed));
  const heat = rolling + sliding - (tempC - ambientC) * 0.12;
  return clamp(tempC + heat * dt, ambientC, 220);
}

/**
 * Grip versus temperature. Real tyres lose a little grip when cold and a lot
 * when overheated; the curve here is deliberately gentle on the cold side so
 * the first corner of a session does not feel broken.
 */
export function tempGripMultiplier(tempC: number, compound: TireCompound): number {
  const delta = (tempC - compound.optTempC) / 95;
  return clamp(1 - delta * delta * 0.30, 0.84, 1.02);
}
