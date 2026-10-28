import type { TireCompound } from '../vehicles/tire';

/** Tyre compound catalogue. `mu` is the peak friction on dry asphalt. */
export const COMPOUNDS: Record<string, TireCompound> = {
  street: { id: 'street', label: 'Street', mu: 0.94, B: 8.2, Bx: 10.5, loadSensitivity: 0.11, optTempC: 75, wearRate: 1.0, tier: 0 },
  sport: { id: 'sport', label: 'Sport', mu: 1.02, B: 9.0, Bx: 11.4, loadSensitivity: 0.12, optTempC: 90, wearRate: 1.3, tier: 1 },
  semiSlick: { id: 'semiSlick', label: 'Semi-slick', mu: 1.10, B: 9.8, Bx: 12.4, loadSensitivity: 0.13, optTempC: 100, wearRate: 1.8, tier: 2 },
  race: { id: 'race', label: 'Race slick', mu: 1.19, B: 10.6, Bx: 13.4, loadSensitivity: 0.14, optTempC: 105, wearRate: 2.4, tier: 3 },
  drift: { id: 'drift', label: 'Drift', mu: 0.90, B: 10.5, Bx: 9.5, loadSensitivity: 0.10, optTempC: 110, wearRate: 2.8, tier: 1 },
  offroad: { id: 'offroad', label: 'All-terrain', mu: 0.86, B: 7.4, Bx: 9.2, loadSensitivity: 0.09, optTempC: 70, wearRate: 0.8, tier: 1 },
  rally: { id: 'rally', label: 'Rally gravel', mu: 0.93, B: 8.0, Bx: 10.0, loadSensitivity: 0.10, optTempC: 85, wearRate: 2.0, tier: 2 },
  winter: { id: 'winter', label: 'Winter studded', mu: 0.80, B: 7.0, Bx: 8.6, loadSensitivity: 0.08, optTempC: 40, wearRate: 1.1, tier: 1 },
};

export const TIRE_UPGRADES = ['street', 'sport', 'semiSlick', 'race'];
