import type { SurfaceId } from './types';

/**
 * Surface definitions.
 *
 * `grip` is the peak friction multiplier applied to the tyre's own compound
 * friction coefficient (mu = tyreMu * surface.grip). Values are physically
 * inspired (measured dry tarmac ~0.9-1.1, wet tarmac ~0.6-0.8, loose gravel
 * ~0.5-0.65 etc.) but tuned for playability. See docs/PHYSICS.md.
 */
export interface SurfaceDef {
  id: SurfaceId;
  label: string;
  /** Peak friction multiplier vs. the tyre compound's reference surface. */
  grip: number;
  /** Rolling resistance coefficient (force = Crr * load). */
  rollResist: number;
  /** Roughness 0..1 - feeds suspension micro-bumps and camera shake. */
  roughness: number;
  /** Speed-scaled drag from loose material / sand. */
  speedDrag: number;
  /** Particle + sound category. */
  fx: 'tarmac' | 'gravel' | 'dirt' | 'grass' | 'sand' | 'mud' | 'snow' | 'water';
  /** Gravel/sand kicked up behind the wheel. */
  sprays: boolean;
  color: number;
}

export const SURFACES: Record<SurfaceId, SurfaceDef> = {
  asphaltDry: { id: 'asphaltDry', label: 'Dry asphalt', grip: 1.0, rollResist: 0.011, roughness: 0.05, speedDrag: 0, fx: 'tarmac', sprays: false, color: 0x2b2b2e },
  asphaltWet: { id: 'asphaltWet', label: 'Wet asphalt', grip: 0.78, rollResist: 0.014, roughness: 0.05, speedDrag: 0.0012, fx: 'tarmac', sprays: true, color: 0x1e2024 },
  concrete: { id: 'concrete', label: 'Concrete', grip: 0.94, rollResist: 0.012, roughness: 0.12, speedDrag: 0, fx: 'tarmac', sprays: false, color: 0x565659 },
  kerb: { id: 'kerb', label: 'Kerb', grip: 0.97, rollResist: 0.013, roughness: 0.4, speedDrag: 0, fx: 'tarmac', sprays: false, color: 0xb03a2e },
  gravel: { id: 'gravel', label: 'Gravel', grip: 0.62, rollResist: 0.035, roughness: 0.75, speedDrag: 0.0016, fx: 'gravel', sprays: true, color: 0x8a8175 },
  dirt: { id: 'dirt', label: 'Dirt', grip: 0.56, rollResist: 0.045, roughness: 0.65, speedDrag: 0.0018, fx: 'dirt', sprays: true, color: 0x6b5439 },
  grass: { id: 'grass', label: 'Grass', grip: 0.45, rollResist: 0.06, roughness: 0.55, speedDrag: 0.0012, fx: 'grass', sprays: true, color: 0x40602c },
  sand: { id: 'sand', label: 'Sand', grip: 0.42, rollResist: 0.11, roughness: 0.5, speedDrag: 0.0035, fx: 'sand', sprays: true, color: 0xc9b483 },
  mud: { id: 'mud', label: 'Mud', grip: 0.30, rollResist: 0.13, roughness: 0.6, speedDrag: 0.0035, fx: 'mud', sprays: true, color: 0x4a3a28 },
  snow: { id: 'snow', label: 'Snow', grip: 0.24, rollResist: 0.07, roughness: 0.35, speedDrag: 0.0012, fx: 'snow', sprays: true, color: 0xe8eef2 },
  water: { id: 'water', label: 'Water', grip: 0.22, rollResist: 0.20, roughness: 0.2, speedDrag: 0.0055, fx: 'water', sprays: true, color: 0x2d5a70 },
};

/** Returns the effective surface (wet tarmac is a distinct surface). */
export function resolveSurface(id: SurfaceId, wetness: number): SurfaceDef {
  if (id === 'asphaltDry' && wetness > 0.35) return SURFACES.asphaltWet;
  if (id === 'gravel' && wetness > 0.7) return { ...SURFACES.gravel, grip: 0.52, label: 'Wet gravel' };
  if (id === 'dirt' && wetness > 0.7) return SURFACES.mud;
  return SURFACES[id];
}
