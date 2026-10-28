import type { VehicleSpec, TorquePoint } from '../vehicles/spec';
import { peakPowerW } from '../vehicles/spec';

/**
 * Original vehicle roster.
 *
 * Every manufacturer, model and badge here is invented for this project.
 * The designs and performance figures evoke familiar classes of car so the
 * handling reads correctly, but no trademarks or copyrighted designs are used.
 *
 * All values are SI: kg, m, N, Nm, rad, watts.
 */

const na = (pts: [number, number][]): TorquePoint[] => pts.map(([rpm, fraction]) => ({ rpm, fraction }));

/** Naturally aspirated sports engine shape: torque peaks mid-range, tails at redline. */
const NA_SPORTS = na([[800, 0.42], [1500, 0.62], [2500, 0.82], [4200, 1.0], [5500, 0.96], [6500, 0.86], [7200, 0.72], [7600, 0.5]]);
/** Small turbo: strong low-mid, flat top. */
const TURBO_SMALL = na([[900, 0.5], [1800, 0.72], [2600, 0.97], [3400, 1.0], [4800, 0.94], [6000, 0.82], [6800, 0.66], [7000, 0.4]]);
/** Big V8 muscle: huge low-end, runs out of breath. */
const V8_MUSCLE = na([[700, 0.55], [1400, 0.82], [2400, 0.95], [3400, 1.0], [4400, 0.92], [5200, 0.78], [5800, 0.6], [6000, 0.3]]);
/** Turbo diesel: torque wall at 2000, no revs. */
const DIESEL = na([[800, 0.6], [1200, 0.85], [1600, 0.97], [2000, 1.0], [2800, 0.95], [3500, 0.82], [4200, 0.6], [4600, 0.3]]);
/** Diesel big-bore for trucks. */
const DIESEL_BIG = na([[700, 0.65], [1100, 0.9], [1600, 1.0], [2200, 0.98], [3000, 0.86], [3600, 0.66], [4200, 0.35]]);
/** Race V8 for supercars. */
const SUPER_V8 = na([[1000, 0.45], [2000, 0.72], [3500, 0.92], [5000, 1.0], [6500, 0.98], [7800, 0.9], [8500, 0.72], [8800, 0.4]]);
/** V12 hypercar. */
const V12 = na([[1000, 0.4], [2500, 0.7], [4000, 0.9], [5500, 0.98], [7000, 1.0], [8200, 0.94], [9000, 0.78], [9400, 0.45]]);
/** Electric: constant torque then constant power. */
const ELECTRIC = na([[1, 1.0], [4000, 1.0], [7000, 0.85], [10000, 0.6], [13000, 0.4], [16000, 0.25]]);

type CarInput = Omit<VehicleSpec, 'stats'> & { stats?: VehicleSpec['stats'] };

function build(input: CarInput): VehicleSpec {
  const spec = input as VehicleSpec;
  const powerW = peakPowerW(spec);
  const powerHp = Math.round(powerW / 745.7);
  // A simple 0-100 style rating, purely a UI summary of the real parameters.
  const rating = Math.round(
    Math.min(999, (powerW / 745.7) * 1.05 + (spec.mass < 1600 ? (1600 - spec.mass) * 0.09 : 0) + (spec.tires.gripFront - 0.9) * 220),
  );
  spec.stats = spec.stats ?? { powerHp, torqueNm: spec.engine.peakTorqueNm, weightKg: spec.mass, rating };
  return spec;
}

export const CARS: VehicleSpec[] = [
  build({
    id: 'kestrel-gt', name: 'Kestrel GT', manufacturer: 'Halcyon', year: 2019, tier: 'Sports',
    bodyStyle: 'coupe', drivetrain: 'RWD', price: 48000,
    mass: 1495, cgHeight: 0.52, length: 4.42, width: 1.86, height: 1.31, wheelbase: 2.62, track: 1.58, inertiaScale: 1,
    engine: { idleRpm: 850, redlineRpm: 7400, limiterRpm: 7700, peakTorqueNm: 240, peakTorqueRpm: 4200, curve: NA_SPORTS, engineBrake: 0.16, inertia: 0.22, turboLag: 0, frictionFraction: 0.07 },
    gearbox: { ratios: [3.32, 2.13, 1.52, 1.16, 0.95, 0.78], reverse: 3.4, finalDrive: 3.55, efficiency: 0.92, shiftTime: 0.24, upshiftRpmFraction: 0.95, downshiftRpmFraction: 0.42 },
    brakes: { capacityG: 1.12, bias: 0.63, handbrakeTorque: 2200 },
    suspension: { springFront: 34000, springRear: 32000, dampingRatioFront: 0.36, dampingRatioRear: 0.34, antiRollFront: 16000, antiRollRear: 12000, travel: 0.11, bumpStopRate: 240000, maxLength: 0.235 },
    tires: { front: 'sport', rear: 'sport', pressure: 2.2, gripFront: 1.02, gripRear: 1.02, widthFront: 0.245, widthRear: 0.285 },
    aero: { dragCoef: 0.33, frontalArea: 2.05, downforceFront: 0.0, downforceRear: 0.1 },
    steering: { maxAngle: 0.60, speedFalloff: 0.16, ackermann: 0.7 },
    drive: { frontSplit: 0, diff: 'lsd', diffPreload: 85, diffLsdRatio: 0.35 },
    paint: '#e8402a', accent: '#1a1a1e',
    description: 'The reference sports coupé: 1,495 kg, rear-drive, naturally aspirated straight-six. Balanced, communicative, easy to drift.',
  }),
  build({
    id: 'rallye-hatch', name: 'R5 Rallye', manufacturer: 'Vantaa', year: 2016, tier: 'Rally',
    bodyStyle: 'hatch', drivetrain: 'AWD', price: 92000,
    mass: 1330, cgHeight: 0.55, length: 4.02, width: 1.82, height: 1.46, wheelbase: 2.52, track: 1.6, inertiaScale: 0.95,
    engine: { idleRpm: 950, redlineRpm: 7000, limiterRpm: 7300, peakTorqueNm: 400, peakTorqueRpm: 3400, curve: TURBO_SMALL, engineBrake: 0.2, inertia: 0.2, turboLag: 0.28, frictionFraction: 0.08 },
    gearbox: { ratios: [3.42, 2.28, 1.68, 1.32, 1.06, 0.88], reverse: 3.1, finalDrive: 4.1, efficiency: 0.9, shiftTime: 0.19, upshiftRpmFraction: 0.96, downshiftRpmFraction: 0.45 },
    brakes: { capacityG: 1.25, bias: 0.6, handbrakeTorque: 2600 },
    suspension: { springFront: 42000, springRear: 38000, dampingRatioFront: 0.45, dampingRatioRear: 0.45, antiRollFront: 20000, antiRollRear: 16000, travel: 0.19, bumpStopRate: 260000, maxLength: 0.34 },
    tires: { front: 'rally', rear: 'rally', pressure: 2.1, gripFront: 0.93, gripRear: 0.93, widthFront: 0.225, widthRear: 0.225 },
    aero: { dragCoef: 0.38, frontalArea: 2.1, downforceFront: 0.1, downforceRear: 0.25 },
    steering: { maxAngle: 0.66, speedFalloff: 0.2, ackermann: 0.5 },
    drive: { frontSplit: 0.42, diff: 'lsd', diffPreload: 120, diffLsdRatio: 0.5 },
    paint: '#2f7de0', accent: '#f5f5f5',
    description: 'All-wheel-drive turbo rally hatch with long travel suspension. Enormous grip on loose surfaces, pointy on tarmac.',
  }),
  build({
    id: 'boulder-4x4', name: 'Boulder 4x4', manufacturer: 'Ironbark', year: 2014, tier: 'Off-road',
    bodyStyle: 'suv', drivetrain: 'AWD', price: 61000,
    mass: 2350, cgHeight: 0.86, length: 4.86, width: 1.96, height: 1.92, wheelbase: 2.85, track: 1.66, inertiaScale: 1.05,
    engine: { idleRpm: 700, redlineRpm: 4600, limiterRpm: 4800, peakTorqueNm: 520, peakTorqueRpm: 2000, curve: DIESEL_BIG, engineBrake: 0.3, inertia: 0.42, turboLag: 0.4, frictionFraction: 0.09 },
    gearbox: { ratios: [3.98, 2.6, 1.85, 1.42, 1.1, 0.84], reverse: 3.6, finalDrive: 3.9, efficiency: 0.88, shiftTime: 0.3, upshiftRpmFraction: 0.9, downshiftRpmFraction: 0.4 },
    brakes: { capacityG: 0.95, bias: 0.6, handbrakeTorque: 3400 },
    suspension: { springFront: 62000, springRear: 58000, dampingRatioFront: 0.4, dampingRatioRear: 0.4, antiRollFront: 30000, antiRollRear: 24000, travel: 0.26, bumpStopRate: 320000, maxLength: 0.46 },
    tires: { front: 'offroad', rear: 'offroad', pressure: 2.4, gripFront: 0.86, gripRear: 0.86, widthFront: 0.265, widthRear: 0.265 },
    aero: { dragCoef: 0.44, frontalArea: 3.0, downforceFront: 0, downforceRear: 0 },
    steering: { maxAngle: 0.62, speedFalloff: 0.22, ackermann: 0.4 },
    drive: { frontSplit: 0.35, diff: 'locked', diffPreload: 200, diffLsdRatio: 0.7 },
    paint: '#d7b23a', accent: '#2b2b2b',
    description: 'Two-and-a-half tonnes of ladder-frame diesel torque. Slow on tarmac, unstoppable on dirt, sand and rock.',
  }),
  build({
    id: 'larkspur-500', name: 'Larkspur 500', manufacturer: 'Larkspur', year: 1967, tier: 'Classic',
    bodyStyle: 'muscle', drivetrain: 'RWD', price: 74000,
    mass: 1640, cgHeight: 0.58, length: 4.78, width: 1.9, height: 1.34, wheelbase: 2.87, track: 1.6, inertiaScale: 1.1,
    engine: { idleRpm: 700, redlineRpm: 6000, limiterRpm: 6200, peakTorqueNm: 560, peakTorqueRpm: 3400, curve: V8_MUSCLE, engineBrake: 0.28, inertia: 0.4, turboLag: 0, frictionFraction: 0.1 },
    gearbox: { ratios: [2.52, 1.52, 1.0], reverse: 2.4, finalDrive: 3.73, efficiency: 0.87, shiftTime: 0.35, upshiftRpmFraction: 0.92, downshiftRpmFraction: 0.4 },
    brakes: { capacityG: 0.82, bias: 0.6, handbrakeTorque: 1800 },
    suspension: { springFront: 28000, springRear: 24000, dampingRatioFront: 0.28, dampingRatioRear: 0.26, antiRollFront: 9000, antiRollRear: 6000, travel: 0.13, bumpStopRate: 200000, maxLength: 0.27 },
    tires: { front: 'street', rear: 'street', pressure: 1.9, gripFront: 0.92, gripRear: 0.9, widthFront: 0.205, widthRear: 0.235 },
    aero: { dragCoef: 0.42, frontalArea: 2.2, downforceFront: 0, downforceRear: 0 },
    steering: { maxAngle: 0.7, speedFalloff: 0.24, ackermann: 0.8 },
    drive: { frontSplit: 0, diff: 'open', diffPreload: 40, diffLsdRatio: 0.2 },
    paint: '#1f6f4a', accent: '#f0e6c8',
    description: '1967 big-block muscle. Colossal torque, narrow tyres, leaf-spring rear. Entertaining and occasionally terrifying.',
  }),
  build({
    id: 'ts11-super', name: 'TS-11', manufacturer: 'Torretta', year: 2021, tier: 'Supercar',
    bodyStyle: 'supercar', drivetrain: 'RWD', price: 265000,
    mass: 1465, cgHeight: 0.44, length: 4.62, width: 1.99, height: 1.18, wheelbase: 2.66, track: 1.68, inertiaScale: 0.88,
    engine: { idleRpm: 900, redlineRpm: 8800, limiterRpm: 9000, peakTorqueNm: 600, peakTorqueRpm: 6500, curve: SUPER_V8, engineBrake: 0.22, inertia: 0.18, turboLag: 0.18, frictionFraction: 0.06 },
    gearbox: { ratios: [3.42, 2.35, 1.78, 1.42, 1.16, 0.98, 0.84], reverse: 3.0, finalDrive: 3.6, efficiency: 0.94, shiftTime: 0.09, upshiftRpmFraction: 0.97, downshiftRpmFraction: 0.45 },
    brakes: { capacityG: 1.45, bias: 0.64, handbrakeTorque: 2600 },
    suspension: { springFront: 48000, springRear: 52000, dampingRatioFront: 0.42, dampingRatioRear: 0.42, antiRollFront: 26000, antiRollRear: 22000, travel: 0.08, bumpStopRate: 400000, maxLength: 0.19 },
    tires: { front: 'semiSlick', rear: 'semiSlick', pressure: 2.1, gripFront: 1.1, gripRear: 1.1, widthFront: 0.255, widthRear: 0.325 },
    aero: { dragCoef: 0.34, frontalArea: 1.95, downforceFront: 0.9, downforceRear: 1.6 },
    steering: { maxAngle: 0.52, speedFalloff: 0.13, ackermann: 0.6 },
    drive: { frontSplit: 0, diff: 'lsd', diffPreload: 140, diffLsdRatio: 0.45 },
    paint: '#f2c31a', accent: '#101014',
    description: 'Mid-engined twin-turbo supercar. Vacuum-like low-speed grip, huge aero load above 200 km/h.',
  }),
  build({
    id: 'mako-v12', name: 'Mako V12', manufacturer: 'Mako', year: 2023, tier: 'Hypercar',
    bodyStyle: 'supercar', drivetrain: 'AWD', price: 890000,
    mass: 1385, cgHeight: 0.42, length: 4.72, width: 2.02, height: 1.14, wheelbase: 2.7, track: 1.7, inertiaScale: 0.85,
    engine: { idleRpm: 1000, redlineRpm: 9400, limiterRpm: 9600, peakTorqueNm: 900, peakTorqueRpm: 7000, curve: V12, engineBrake: 0.24, inertia: 0.17, turboLag: 0, frictionFraction: 0.05 },
    gearbox: { ratios: [3.6, 2.5, 1.9, 1.5, 1.24, 1.05, 0.9, 0.78], reverse: 3.2, finalDrive: 3.5, efficiency: 0.95, shiftTime: 0.07, upshiftRpmFraction: 0.98, downshiftRpmFraction: 0.45 },
    brakes: { capacityG: 1.55, bias: 0.65, handbrakeTorque: 2800 },
    suspension: { springFront: 54000, springRear: 58000, dampingRatioFront: 0.45, dampingRatioRear: 0.45, antiRollFront: 30000, antiRollRear: 26000, travel: 0.07, bumpStopRate: 460000, maxLength: 0.18 },
    tires: { front: 'race', rear: 'race', pressure: 2.2, gripFront: 1.19, gripRear: 1.19, widthFront: 0.275, widthRear: 0.355 },
    aero: { dragCoef: 0.36, frontalArea: 1.9, downforceFront: 1.5, downforceRear: 2.6 },
    steering: { maxAngle: 0.5, speedFalloff: 0.12, ackermann: 0.55 },
    drive: { frontSplit: 0.28, diff: 'lsd', diffPreload: 180, diffLsdRatio: 0.55 },
    paint: '#b01d3c', accent: '#d9d9de',
    description: '1000 hp naturally aspirated V12 with hybrid front assist and race slicks. The fastest car in the garage.',
  }),
  build({
    id: 'sakura-drift', name: 'Sakura FR', manufacturer: 'Sakura', year: 1998, tier: 'Drift',
    bodyStyle: 'coupe', drivetrain: 'RWD', price: 39000,
    mass: 1260, cgHeight: 0.49, length: 4.5, width: 1.75, height: 1.29, wheelbase: 2.55, track: 1.52, inertiaScale: 0.92,
    engine: { idleRpm: 950, redlineRpm: 8200, limiterRpm: 8500, peakTorqueNm: 390, peakTorqueRpm: 4800, curve: TURBO_SMALL, engineBrake: 0.2, inertia: 0.16, turboLag: 0.22, frictionFraction: 0.08 },
    gearbox: { ratios: [3.4, 2.2, 1.6, 1.25, 1.0, 0.82], reverse: 3.2, finalDrive: 3.9, efficiency: 0.91, shiftTime: 0.16, upshiftRpmFraction: 0.97, downshiftRpmFraction: 0.5 },
    brakes: { capacityG: 1.05, bias: 0.6, handbrakeTorque: 3000 },
    suspension: { springFront: 40000, springRear: 34000, dampingRatioFront: 0.4, dampingRatioRear: 0.38, antiRollFront: 22000, antiRollRear: 10000, travel: 0.1, bumpStopRate: 260000, maxLength: 0.22 },
    tires: { front: 'drift', rear: 'drift', pressure: 2.3, gripFront: 0.9, gripRear: 0.9, widthFront: 0.225, widthRear: 0.245 },
    aero: { dragCoef: 0.32, frontalArea: 1.95, downforceFront: 0, downforceRear: 0.15 },
    steering: { maxAngle: 0.72, speedFalloff: 0.26, ackermann: 0.35 },
    drive: { frontSplit: 0, diff: 'lsd', diffPreload: 160, diffLsdRatio: 0.75 },
    paint: '#8e43d6', accent: '#101014',
    description: 'Late-90s turbo coupé built for the drift zone: locked-ish diff, wide steering lock, twitchy rear axle.',
  }),
  build({
    id: 'crestline-lx', name: 'Crestline LX', manufacturer: 'Crestline', year: 2012, tier: 'Everyday',
    bodyStyle: 'sedan', drivetrain: 'FWD', price: 14000,
    mass: 1430, cgHeight: 0.57, length: 4.6, width: 1.79, height: 1.47, wheelbase: 2.7, track: 1.55, inertiaScale: 1.0,
    engine: { idleRpm: 750, redlineRpm: 6400, limiterRpm: 6600, peakTorqueNm: 195, peakTorqueRpm: 4000, curve: NA_SPORTS, engineBrake: 0.14, inertia: 0.2, turboLag: 0, frictionFraction: 0.08 },
    gearbox: { ratios: [3.6, 2.05, 1.36, 1.03, 0.82], reverse: 3.5, finalDrive: 3.9, efficiency: 0.9, shiftTime: 0.3, upshiftRpmFraction: 0.9, downshiftRpmFraction: 0.4 },
    brakes: { capacityG: 0.95, bias: 0.66, handbrakeTorque: 1400 },
    suspension: { springFront: 26000, springRear: 24000, dampingRatioFront: 0.3, dampingRatioRear: 0.3, antiRollFront: 14000, antiRollRear: 8000, travel: 0.14, bumpStopRate: 220000, maxLength: 0.26 },
    tires: { front: 'street', rear: 'street', pressure: 2.1, gripFront: 0.94, gripRear: 0.94, widthFront: 0.205, widthRear: 0.205 },
    aero: { dragCoef: 0.3, frontalArea: 2.1, downforceFront: 0, downforceRear: 0 },
    steering: { maxAngle: 0.66, speedFalloff: 0.22, ackermann: 0.85 },
    drive: { frontSplit: 1, diff: 'open', diffPreload: 30, diffLsdRatio: 0.15 },
    paint: '#9aa4ad', accent: '#22262b',
    description: 'Honest front-wheel-drive family saloon. Understeers when pushed, forgiving, and faster through town than you expect.',
  }),
  build({
    id: 'terrano-pickup', name: 'Terrano Pickup', manufacturer: 'Ironbark', year: 2018, tier: 'Utility',
    bodyStyle: 'truck', drivetrain: 'RWD', price: 34000,
    mass: 2120, cgHeight: 0.78, length: 5.32, width: 1.98, height: 1.85, wheelbase: 3.2, track: 1.68, inertiaScale: 1.15,
    engine: { idleRpm: 700, redlineRpm: 4200, limiterRpm: 4400, peakTorqueNm: 660, peakTorqueRpm: 1800, curve: DIESEL_BIG, engineBrake: 0.34, inertia: 0.45, turboLag: 0.35, frictionFraction: 0.1 },
    gearbox: { ratios: [4.1, 2.5, 1.6, 1.2, 0.95], reverse: 4.0, finalDrive: 3.55, efficiency: 0.88, shiftTime: 0.34, upshiftRpmFraction: 0.9, downshiftRpmFraction: 0.42 },
    brakes: { capacityG: 0.9, bias: 0.58, handbrakeTorque: 2600 },
    suspension: { springFront: 52000, springRear: 46000, dampingRatioFront: 0.35, dampingRatioRear: 0.33, antiRollFront: 20000, antiRollRear: 8000, travel: 0.22, bumpStopRate: 300000, maxLength: 0.38 },
    tires: { front: 'offroad', rear: 'offroad', pressure: 2.6, gripFront: 0.86, gripRear: 0.86, widthFront: 0.265, widthRear: 0.265 },
    aero: { dragCoef: 0.47, frontalArea: 3.2, downforceFront: 0, downforceRear: 0 },
    steering: { maxAngle: 0.68, speedFalloff: 0.25, ackermann: 0.6 },
    drive: { frontSplit: 0, diff: 'open', diffPreload: 60, diffLsdRatio: 0.25 },
    paint: '#3c6e8f', accent: '#d8d8d8',
    description: 'Torque-rich rear-drive pickup. Light rear axle means wheelspin on demand and enormous slides off-road.',
  }),
  build({
    id: 'volt-e', name: 'Volt E-One', manufacturer: 'Volt', year: 2024, tier: 'Hypercar',
    bodyStyle: 'supercar', drivetrain: 'AWD', price: 720000,
    mass: 2050, cgHeight: 0.38, length: 4.98, width: 1.99, height: 1.16, wheelbase: 2.96, track: 1.7, inertiaScale: 0.92,
    engine: { idleRpm: 1, redlineRpm: 16000, limiterRpm: 16500, peakTorqueNm: 1150, peakTorqueRpm: 4000, curve: ELECTRIC, engineBrake: 0.05, inertia: 0.05, turboLag: 0, frictionFraction: 0.02 },
    gearbox: { ratios: [8.4], reverse: 8.4, finalDrive: 1.0, efficiency: 0.97, shiftTime: 0.05, upshiftRpmFraction: 0.99, downshiftRpmFraction: 0.9 },
    brakes: { capacityG: 1.5, bias: 0.62, handbrakeTorque: 2400 },
    suspension: { springFront: 56000, springRear: 60000, dampingRatioFront: 0.5, dampingRatioRear: 0.5, antiRollFront: 32000, antiRollRear: 28000, travel: 0.09, bumpStopRate: 420000, maxLength: 0.2 },
    tires: { front: 'semiSlick', rear: 'semiSlick', pressure: 2.5, gripFront: 1.1, gripRear: 1.1, widthFront: 0.265, widthRear: 0.325 },
    aero: { dragCoef: 0.28, frontalArea: 2.1, downforceFront: 1.1, downforceRear: 2.0 },
    steering: { maxAngle: 0.5, speedFalloff: 0.13, ackermann: 0.6 },
    drive: { frontSplit: 0.4, diff: 'lsd', diffPreload: 160, diffLsdRatio: 0.5 },
    paint: '#22c9b8', accent: '#0a1013',
    description: 'Two-tonne electric hypercar. Instant torque, low centre of gravity, and mass you feel under braking.',
  }),
  build({
    id: 'dunerunner-buggy', name: 'Dunerunner', manufacturer: 'Sandpiper', year: 2022, tier: 'Off-road',
    bodyStyle: 'buggy', drivetrain: 'RWD', price: 128000,
    mass: 1010, cgHeight: 0.62, length: 3.9, width: 1.94, height: 1.6, wheelbase: 2.6, track: 1.72, inertiaScale: 0.8,
    engine: { idleRpm: 1000, redlineRpm: 7200, limiterRpm: 7400, peakTorqueNm: 420, peakTorqueRpm: 4200, curve: NA_SPORTS, engineBrake: 0.18, inertia: 0.15, turboLag: 0, frictionFraction: 0.07 },
    gearbox: { ratios: [3.6, 2.3, 1.7, 1.3, 1.0], reverse: 3.4, finalDrive: 4.3, efficiency: 0.9, shiftTime: 0.15, upshiftRpmFraction: 0.96, downshiftRpmFraction: 0.45 },
    brakes: { capacityG: 1.0, bias: 0.55, handbrakeTorque: 2400 },
    suspension: { springFront: 30000, springRear: 28000, dampingRatioFront: 0.32, dampingRatioRear: 0.3, antiRollFront: 8000, antiRollRear: 6000, travel: 0.42, bumpStopRate: 220000, maxLength: 0.66 },
    tires: { front: 'offroad', rear: 'offroad', pressure: 1.6, gripFront: 0.86, gripRear: 0.86, widthFront: 0.3, widthRear: 0.33 },
    aero: { dragCoef: 0.55, frontalArea: 2.4, downforceFront: 0, downforceRear: 0 },
    steering: { maxAngle: 0.75, speedFalloff: 0.28, ackermann: 0.3 },
    drive: { frontSplit: 0, diff: 'locked', diffPreload: 220, diffLsdRatio: 0.8 },
    paint: '#f2740f', accent: '#1b1b1b',
    description: 'Tubular-frame desert racer with 660 mm of wheel travel. Jumps, lands, and keeps going.',
  }),
  build({
    id: 'nordline-rs', name: 'Nordline RS', manufacturer: 'Nordline', year: 2019, tier: 'Rally',
    bodyStyle: 'hatch', drivetrain: 'AWD', price: 76000,
    mass: 1420, cgHeight: 0.53, length: 4.28, width: 1.84, height: 1.44, wheelbase: 2.6, track: 1.58, inertiaScale: 0.96,
    engine: { idleRpm: 900, redlineRpm: 6800, limiterRpm: 7000, peakTorqueNm: 460, peakTorqueRpm: 3000, curve: TURBO_SMALL, engineBrake: 0.22, inertia: 0.21, turboLag: 0.24, frictionFraction: 0.08 },
    gearbox: { ratios: [3.5, 2.3, 1.7, 1.3, 1.05, 0.87], reverse: 3.2, finalDrive: 3.9, efficiency: 0.91, shiftTime: 0.2, upshiftRpmFraction: 0.95, downshiftRpmFraction: 0.45 },
    brakes: { capacityG: 1.15, bias: 0.6, handbrakeTorque: 2600 },
    suspension: { springFront: 38000, springRear: 36000, dampingRatioFront: 0.42, dampingRatioRear: 0.42, antiRollFront: 18000, antiRollRear: 14000, travel: 0.16, bumpStopRate: 240000, maxLength: 0.3 },
    tires: { front: 'winter', rear: 'winter', pressure: 2.2, gripFront: 0.8, gripRear: 0.8, widthFront: 0.225, widthRear: 0.225 },
    aero: { dragCoef: 0.36, frontalArea: 2.05, downforceFront: 0.1, downforceRear: 0.2 },
    steering: { maxAngle: 0.64, speedFalloff: 0.2, ackermann: 0.5 },
    drive: { frontSplit: 0.45, diff: 'lsd', diffPreload: 110, diffLsdRatio: 0.5 },
    paint: '#e6ecf2', accent: '#1c4f9c',
    description: 'Studded winter rally car. Made for the snow pass above the treeline: soft, compliant and endlessly sideways.',
  }),
  build({
    id: 'meltvan', name: 'Glacier Van', manufacturer: 'Crestline', year: 1974, tier: 'Novelty',
    bodyStyle: 'van', drivetrain: 'RWD', price: 9000,
    mass: 1890, cgHeight: 0.92, length: 5.0, width: 1.96, height: 2.18, wheelbase: 3.0, track: 1.66, inertiaScale: 1.2,
    engine: { idleRpm: 650, redlineRpm: 4200, limiterRpm: 4400, peakTorqueNm: 230, peakTorqueRpm: 2400, curve: DIESEL, engineBrake: 0.3, inertia: 0.35, turboLag: 0, frictionFraction: 0.11 },
    gearbox: { ratios: [3.9, 2.3, 1.5, 1.0], reverse: 3.8, finalDrive: 4.1, efficiency: 0.85, shiftTime: 0.4, upshiftRpmFraction: 0.88, downshiftRpmFraction: 0.4 },
    brakes: { capacityG: 0.72, bias: 0.62, handbrakeTorque: 1600 },
    suspension: { springFront: 30000, springRear: 34000, dampingRatioFront: 0.26, dampingRatioRear: 0.28, antiRollFront: 12000, antiRollRear: 14000, travel: 0.15, bumpStopRate: 200000, maxLength: 0.3 },
    tires: { front: 'street', rear: 'street', pressure: 2.0, gripFront: 0.94, gripRear: 0.94, widthFront: 0.195, widthRear: 0.195 },
    aero: { dragCoef: 0.55, frontalArea: 3.4, downforceFront: 0, downforceRear: 0 },
    steering: { maxAngle: 0.75, speedFalloff: 0.3, ackermann: 0.7 },
    drive: { frontSplit: 0, diff: 'open', diffPreload: 30, diffLsdRatio: 0.15 },
    paint: '#f7f1e3', accent: '#d6483b',
    description: '1974 ice-cream van with a tired diesel. Tall, heavy, and technically capable of drifting. Do not ask how.',
  }),
];

export const CAR_BY_ID: Record<string, VehicleSpec> = Object.fromEntries(CARS.map((c) => [c.id, c]));

export function getCar(id: string): VehicleSpec {
  return CAR_BY_ID[id] ?? CARS[0];
}
