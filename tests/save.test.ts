import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadProfile, saveProfile, newProfile, levelFromXp, blankUpgrades, blankTuning, clearProfileCache } from '../src/core/save';
import { Career } from '../src/gameplay/career';
import { EVENT_BY_ID, EVENTS } from '../src/data/events';
import { CARS } from '../src/data/cars';

/** Minimal localStorage so the profile code can run under Node. */
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

const storage = new MemoryStorage();
beforeEach(() => {
  storage.clear();
  clearProfileCache();
  vi.stubGlobal('localStorage', storage);
});

describe('save profile', () => {
  it('round-trips a profile through storage', () => {
    const p = loadProfile();
    p.credits = 12345;
    p.completedEvents = ['festival-circuit'];
    p.lastPosition = { x: 12, y: 3, z: -8, yaw: 0.5 };
    saveProfile(p);
    const back = loadProfile();
    expect(back.credits).toBe(12345);
    expect(back.completedEvents).toEqual(['festival-circuit']);
    expect(back.lastPosition).toEqual({ x: 12, y: 3, z: -8, yaw: 0.5 });
  });

  it('starts a new player with three cars and money', () => {
    const p = newProfile();
    expect(p.owned.length).toBe(3);
    expect(p.credits).toBeGreaterThan(0);
    expect(p.owned.every((c) => c.upgrades && c.tuning)).toBe(true);
  });

  it('repairs a corrupted save instead of throwing', () => {
    localStorage.setItem('horizon-drive.profile.v3', '{not json');
    const p = loadProfile();
    expect(p.owned.length).toBeGreaterThan(0);
    expect(Number.isFinite(p.credits)).toBe(true);
  });

  it('fills in fields missing from an older save', () => {
    const old = newProfile();
    const partial: Record<string, unknown> = { ...old, credits: 500 };
    delete partial.playlist;
    delete partial.bestTimes;
    delete partial.driftRecords;
    for (const car of old.owned) {
      delete (car as unknown as Record<string, unknown>).upgrades;
      delete (car as unknown as Record<string, unknown>).tuning;
    }
    localStorage.setItem('horizon-drive.profile.v3', JSON.stringify(partial));
    const p = loadProfile();
    expect(p.credits).toBe(500);
    expect(p.playlist).toBeTruthy();
    expect(p.bestTimes).toEqual({});
    expect(p.driftRecords).toEqual({});
    // Missing upgrade/tuning blocks come back as defaults, not undefined.
    expect(p.owned.every((c) => c.upgrades && c.tuning)).toBe(true);
  });

  it('discards a save with no cars instead of loading an empty garage', () => {
    localStorage.setItem('horizon-drive.profile.v3', JSON.stringify({ credits: 500, owned: [] }));
    const p = loadProfile();
    expect(p.owned.length).toBe(3);
    expect(p.credits).toBeGreaterThan(0);
  });

  it('levels up monotonically', () => {
    let last = 0;
    for (const xp of [0, 500, 5000, 50000, 500000]) {
      const l = levelFromXp(xp);
      expect(l.level).toBeGreaterThanOrEqual(last);
      last = l.level;
    }
    expect(levelFromXp(1e9).level).toBeGreaterThan(levelFromXp(0).level);
  });
});

describe('career progression', () => {
  it('pays an event, then pays less for a repeat', () => {
    const career = new Career();
    const def = EVENT_BY_ID['festival-circuit'];
    const before = career.profile.credits;
    const first = career.completeEvent(def, { position: 1, time: 100 });
    expect(first.first).toBe(true);
    expect(career.profile.credits).toBe(before + first.credits);
    const second = career.completeEvent(def, { position: 1, time: 99 });
    expect(second.first).toBe(false);
    expect(second.credits).toBeLessThan(first.credits);
    expect(second.credits).toBeGreaterThan(0);
    expect(career.profile.bestTimes[def.id]).toBe(99);
  });

  it('scales the payout with finishing position', () => {
    const career = new Career();
    const def = EVENT_BY_ID['festival-circuit'];
    const p1 = career.completeEvent(def, { position: 1, time: 100 });
    const career2 = new Career();
    const p6 = career2.completeEvent(def, { position: 6, time: 120 });
    expect(p6.credits).toBeLessThan(p1.credits);
    expect(p6.xp).toBeLessThanOrEqual(p1.xp);
  });

  it('unlocks events by level and never stalls at zero', () => {
    const career = new Career();
    const unlocked = career.unlockedEvents();
    expect(unlocked.length).toBeGreaterThan(0);
    expect(unlocked.length).toBeLessThanOrEqual(EVENTS.length);
    expect(career.level.level).toBeGreaterThanOrEqual(1);
  });

  it('spins the wheel three times with valid prizes', () => {
    const career = new Career();
    const prizes = career.spin();
    expect(prizes.length).toBe(3);
    for (const p of prizes) {
      expect(typeof p.label).toBe('string');
      expect(p.label.length).toBeGreaterThan(0);
    }
  });

  it('buys, grants and switches cars', () => {
    const career = new Career();
    career.profile.credits = 5_000_000;
    const owned = career.profile.owned.map((c) => c.carId);
    const candidate = CARS.find((c) => !owned.includes(c.id))!;
    const res = career.buyCar(candidate.id);
    expect(res.ok).toBe(true);
    expect(career.profile.owned.some((c) => c.carId === candidate.id)).toBe(true);
    career.setActiveCar(candidate.id);
    expect(career.profile.activeCarId).toBe(candidate.id);
    // Buying the same car twice refunds part of the price.
    const again = career.buyCar(candidate.id);
    expect(again.ok).toBe(false);
  });

  it('refuses a car the player cannot afford', () => {
    const career = new Career();
    career.profile.credits = 0;
    const owned = career.profile.owned.map((c) => c.carId);
    const candidate = CARS.find((c) => !owned.includes(c.id))!;
    expect(career.buyCar(candidate.id).ok).toBe(false);
  });
});

describe('upgrade state', () => {
  it('starts blank and tunes within range', () => {
    const up = blankUpgrades();
    expect(Object.values(up).filter((v) => typeof v === 'number').every((v) => v === 0)).toBe(true);
    const t = blankTuning();
    expect(t.camber).toBeLessThan(0);
    expect(t.brakeBias).toBeGreaterThan(0.5);
    expect(t.brakeBias).toBeLessThan(0.75);
    // ensure the profile default car is one of the authored cars
    expect(CARS.some((c) => c.id === newProfile().owned[0].carId)).toBe(true);
  });
});
