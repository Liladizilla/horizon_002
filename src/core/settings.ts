import { clamp } from './math';

export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra';
export type DifficultyPreset = 'arcade' | 'balanced' | 'pro' | 'simulation';

export interface AssistSettings {
  abs: boolean;
  tractionControl: boolean;
  stabilityControl: boolean;
  steeringAssist: number; // 0..1 counter-steer helper
  autoGears: boolean;
  rewind: boolean;
  racingLine: boolean;
  brakingAssist: number;  // 0..1
}

export interface GameSettings {
  version: number;
  quality: QualityPreset;
  renderScale: number;      // 0.5..1.5 dynamic resolution multiplier
  dynamicResolution: boolean;
  shadows: boolean;
  shadowMapSize: number;
  reflections: boolean;
  particleDensity: number;  // 0..1
  foliageDensity: number;   // 0..1
  antialias: 'off' | 'smaa' | 'taa';
  fov: number;
  speedUnits: 'kmh' | 'mph';
  cameraShake: number;      // 0..1
  motionBlur: boolean;
  bloom: boolean;
  reducedMotion: boolean;
  /** Ground-truth ambient occlusion pass (contact shadows). */
  colorBlind: 'off' | 'protanopia' | 'deuteranopia' | 'tritanopia';
  uiScale: number;
  showSubtitles: boolean;
  masterVolume: number;
  engineVolume: number;
  sfxVolume: number;
  musicVolume: number;
  uiVolume: number;
  radioEnabled: boolean;
  assist: AssistSettings;
  difficulty: DifficultyPreset;
  /** Explicit "simulation" flag: disables catch-up and hides residual assists. */
  simulationMode: boolean;
  aiCatchUp: boolean;
  gamepadDeadzone: number;
  steeringSensitivity: number;
  invertLookY: boolean;
  weatherLock: 'auto' | 'clear' | 'overcast' | 'rain' | 'storm' | 'fog' | 'sandstorm' | 'snow';
  timeOfDayLock: number | null; // hours, null = live cycle
  timeScale: number;            // game-hours per real minute (1 = 1h per minute)
}

export const DEFAULT_SETTINGS: GameSettings = {
  version: 3,
  quality: 'high',
  renderScale: 1,
  dynamicResolution: true,
  shadows: true,
  shadowMapSize: 2048,
  reflections: true,
  particleDensity: 0.8,
  foliageDensity: 0.8,
  antialias: 'smaa',
  fov: 62,
  speedUnits: 'kmh',
  cameraShake: 0.6,
  motionBlur: false,
  bloom: true,
  reducedMotion: false,
  colorBlind: 'off',
  uiScale: 1,
  showSubtitles: true,
  masterVolume: 0.9,
  engineVolume: 0.8,
  sfxVolume: 0.8,
  musicVolume: 0.55,
  uiVolume: 0.7,
  radioEnabled: true,
  assist: {
    abs: true,
    tractionControl: true,
    stabilityControl: true,
    steeringAssist: 0.35,
    autoGears: true,
    rewind: true,
    racingLine: false,
    brakingAssist: 0.25,
  },
  difficulty: 'balanced',
  simulationMode: false,
  aiCatchUp: false,
  gamepadDeadzone: 0.12,
  steeringSensitivity: 1,
  invertLookY: false,
  weatherLock: 'auto',
  timeOfDayLock: null,
  timeScale: 1,
};

export const DIFFICULTY_PRESETS: Record<DifficultyPreset, Partial<AssistSettings> & { aiSkill: number; aiAggression: number }> = {
  arcade: { abs: true, tractionControl: true, stabilityControl: true, steeringAssist: 0.6, autoGears: true, rewind: true, racingLine: true, brakingAssist: 0.5, aiSkill: 0.72, aiAggression: 0.35 },
  balanced: { abs: true, tractionControl: true, stabilityControl: true, steeringAssist: 0.35, autoGears: true, rewind: true, racingLine: false, brakingAssist: 0.25, aiSkill: 0.85, aiAggression: 0.5 },
  pro: { abs: true, tractionControl: false, stabilityControl: false, steeringAssist: 0.1, autoGears: false, rewind: true, racingLine: false, brakingAssist: 0, aiSkill: 0.93, aiAggression: 0.65 },
  simulation: { abs: false, tractionControl: false, stabilityControl: false, steeringAssist: 0, autoGears: false, rewind: false, racingLine: false, brakingAssist: 0, aiSkill: 0.97, aiAggression: 0.7 },
};

export const QUALITY_PRESETS: Record<QualityPreset, Partial<GameSettings>> = {
  low: { renderScale: 0.7, shadowMapSize: 1024, shadows: true, reflections: false, particleDensity: 0.35, foliageDensity: 0.35, antialias: 'off', bloom: false },
  medium: { renderScale: 0.85, shadowMapSize: 2048, shadows: true, reflections: false, particleDensity: 0.6, foliageDensity: 0.6, antialias: 'smaa', bloom: true },
  high: { renderScale: 1, shadowMapSize: 2048, shadows: true, reflections: true, particleDensity: 0.8, foliageDensity: 0.8, antialias: 'smaa', bloom: true },
  ultra: { renderScale: 1.15, shadowMapSize: 4096, shadows: true, reflections: true, particleDensity: 1, foliageDensity: 1, antialias: 'taa', bloom: true },
};

const KEY = 'horizon-drive.settings.v3';

export function loadSettings(): GameSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const parsed = JSON.parse(raw) as Partial<GameSettings>;
    const merged: GameSettings = { ...structuredClone(DEFAULT_SETTINGS), ...parsed, assist: { ...DEFAULT_SETTINGS.assist, ...(parsed.assist ?? {}) } };
    merged.fov = clamp(merged.fov, 40, 110);
    merged.renderScale = clamp(merged.renderScale, 0.4, 1.5);
    merged.masterVolume = clamp(merged.masterVolume, 0, 1);
    return merged;
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(s: GameSettings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage may be unavailable */ }
}
