import type { GameSettings } from './settings';

export interface CarUpgradeState {
  engine: number;      // 0..3 tiers (torque/power multipliers)
  turbo: number;       // 0..2
  gearbox: number;     // 0..2
  tires: number;       // 0..3 (compound upgrade)
  brakes: number;      // 0..3
  suspension: number;  // 0..3
  weight: number;      // 0..2 (reduction)
  aero: number;        // 0..2 (downforce + drag)
  drivetrain: 'keep' | 'fwd' | 'rwd' | 'awd';
}

export interface OwnedCar {
  carId: string;
  paint: { color: string; finish: 'gloss' | 'metallic' | 'matte' | 'chrome' | 'pearl' };
  upgrades: CarUpgradeState;
  tuning: { camber: number; toe: number; rideHeight: number; stiffnessBias: number; brakeBias: number; finalDrive: number };
  mileageKm: number;
}

export interface Profile {
  version: number;
  name: string;
  credits: number;
  xp: number;
  level: number;
  owned: OwnedCar[];
  activeCarId: string;
  completedEvents: string[];
  bestTimes: Record<string, number>;
  driftRecords: Record<string, number>;
  speedTrapRecords: Record<string, number>;
  jumpRecords: Record<string, number>;
  houses: string[];
  discoveredBarns: string[];
  photoCount: number;
  playlist: { season: string; week: number; completed: string[]; points: number };
  lastPosition: { x: number; y: number; z: number; yaw: number };
  totalDistanceKm: number;
  playSeconds: number;
}

const PROFILE_KEY = 'horizon-drive.profile.v3';
const SETTINGS_KEY = 'horizon-drive.settings.v3';

export function newProfile(): Profile {
  return {
    version: 3,
    name: 'Driver',
    credits: 240000,
    xp: 0,
    level: 1,
    owned: [
      { carId: 'kestrel-gt', paint: { color: '#e8402a', finish: 'metallic' }, upgrades: blankUpgrades(), tuning: blankTuning(), mileageKm: 0 },
      { carId: 'rallye-hatch', paint: { color: '#2f7de0', finish: 'gloss' }, upgrades: blankUpgrades(), tuning: blankTuning(), mileageKm: 0 },
      { carId: 'boulder-4x4', paint: { color: '#d7b23a', finish: 'matte' }, upgrades: blankUpgrades(), tuning: blankTuning(), mileageKm: 0 },
    ],
    activeCarId: 'kestrel-gt',
    completedEvents: [],
    bestTimes: {},
    driftRecords: {},
    speedTrapRecords: {},
    jumpRecords: {},
    houses: ['festival-hub'],
    discoveredBarns: [],
    photoCount: 0,
    playlist: { season: 'Dry', week: 1, completed: [], points: 0, },
    lastPosition: { x: 0, y: 1, z: 0, yaw: 0 },
    totalDistanceKm: 0,
    playSeconds: 0,
  };
}

export function blankUpgrades(): CarUpgradeState {
  return { engine: 0, turbo: 0, gearbox: 0, tires: 0, brakes: 0, suspension: 0, weight: 0, aero: 0, drivetrain: 'keep' };
}
export function blankTuning() {
  return { camber: -0.5, toe: 0.05, rideHeight: 0, stiffnessBias: 0.5, brakeBias: 0.62, finalDrive: 1 };
}

let memoryProfile: Profile | null = null;

export function loadProfile(): Profile {
  if (memoryProfile) return memoryProfile;
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) { memoryProfile = newProfile(); return memoryProfile; }
    const parsed = JSON.parse(raw) as Partial<Profile>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.owned) || parsed.owned.length === 0) {
      memoryProfile = newProfile();
      return memoryProfile;
    }
    const base = newProfile();
    memoryProfile = {
      ...base,
      ...parsed,
      owned: parsed.owned.map((c) => ({ ...c, upgrades: { ...blankUpgrades(), ...c.upgrades }, tuning: { ...blankTuning(), ...c.tuning } })),
      playlist: { ...base.playlist, ...(parsed.playlist ?? {}) },
      bestTimes: parsed.bestTimes ?? {},
      driftRecords: parsed.driftRecords ?? {},
      speedTrapRecords: parsed.speedTrapRecords ?? {},
      jumpRecords: parsed.jumpRecords ?? {},
    };
    if (!memoryProfile.owned.some((c) => c.carId === memoryProfile!.activeCarId)) {
      memoryProfile.activeCarId = memoryProfile.owned[0].carId;
    }
    return memoryProfile;
  } catch {
    // Corrupt save - fall back to a fresh profile rather than crashing.
    memoryProfile = newProfile();
    return memoryProfile;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Drops the in-memory copy so the next load re-reads storage (tests, new game). */
export function clearProfileCache() {
  memoryProfile = null;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
}
export function saveProfile(p: Profile, immediate = false) {
  memoryProfile = p;
  const write = () => {
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
    } catch { /* quota or private mode: keep the in-memory profile */ }
  };
  if (immediate) { if (saveTimer) clearTimeout(saveTimer); write(); return; }
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; write(); }, 1500);
}

/** XP curve: level n requires 1000 * n^1.35 total xp. */
export function xpForLevel(level: number): number {
  return Math.round(1000 * Math.pow(level, 1.35));
}
export function levelFromXp(xp: number): { level: number; into: number; needed: number } {
  let level = 1;
  while (level < 200 && xp >= xpForLevel(level)) level++;
  const prev = level > 1 ? xpForLevel(level - 1) : 0;
  return { level, into: xp - prev, needed: Math.max(1, xpForLevel(level) - prev) };
}

export function exportProfileText(p: Profile): string {
  return JSON.stringify({ profile: p, settings: localStorage.getItem(SETTINGS_KEY) ? JSON.parse(localStorage.getItem(SETTINGS_KEY)!) : null }, null, 2);
}
export type { GameSettings };
