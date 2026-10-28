/** Small, dependency-light math helpers shared by physics, world and rendering. */
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp(invLerp(e0, e1, x), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent exponential smoothing. */
export const damp = (current: number, target: number, rate: number, dt: number) =>
  lerp(current, target, 1 - Math.exp(-rate * dt));
export const moveTowards = (current: number, target: number, maxDelta: number) => {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
};
export const DEG = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const KMH_PER_MS = 3.6;
export const sign0 = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0);
export const isFiniteNum = (v: number) => Number.isFinite(v);

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

export interface Box2 { minX: number; minZ: number; maxX: number; maxZ: number }
