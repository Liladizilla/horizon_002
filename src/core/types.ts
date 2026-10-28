export type SurfaceId =
  | 'asphaltDry' | 'asphaltWet' | 'concrete' | 'gravel' | 'dirt'
  | 'grass' | 'sand' | 'mud' | 'snow' | 'water' | 'kerb';

export interface SurfaceSample {
  id: SurfaceId;
  /** 0 = bone dry, 1 = soaked. Blends grip and VFX. */
  wetness: number;
}

export type WeatherKind = 'clear' | 'overcast' | 'rain' | 'storm' | 'fog' | 'sandstorm' | 'snow';

export interface CarControl {
  throttle: number;   // 0..1
  brake: number;      // 0..1
  steer: number;      // -1 (left) .. 1 (right)
  handbrake: number;  // 0..1
  shiftUp: boolean;   // edge
  shiftDown: boolean; // edge
}

export const NEUTRAL_CONTROL: CarControl = { throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: false, shiftDown: false };

export interface Vec3Like { x: number; y: number; z: number }
export interface QuatLike { x: number; y: number; z: number; w: number }
