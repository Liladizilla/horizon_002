import { EVENTS, type EventDef } from '../data/events';
import { CARS, getCar, CAR_BY_ID } from '../data/cars';
import { loadProfile, saveProfile, levelFromXp, type Profile, newProfile } from '../core/save';
import { clamp } from '../core/math';

export interface WheelspinPrize {
  kind: 'credits' | 'car' | 'xp';
  label: string;
  value: number;
  carId?: string;
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
}

export interface PlaylistWeek {
  season: string;
  week: number;
  challenges: { id: string; title: string; eventId: string; points: number; done: boolean }[];
  rewardCar: string;
}

const SEASONS = ['Dry', 'Wet', 'Storm', 'Snow'];

/**
 * Progression: XP, levels, credits, wheelspins, event unlocks and the seasonal
 * playlist. All of it is persisted locally through core/save.
 */
export class Career {
  profile: Profile;
  private listeners: (() => void)[] = [];

  constructor() {
    this.profile = loadProfile();
  }

  onChange(fn: () => void) { this.listeners.push(fn); }
  private notify() { for (const l of this.listeners) l(); }

  save(immediate = false) { saveProfile(this.profile, immediate); this.notify(); }

  get level() { return levelFromXp(this.profile.xp); }

  addCredits(n: number) { this.profile.credits = Math.max(0, this.profile.credits + n); this.save(); }
  addXp(n: number) {
    const before = this.level.level;
    this.profile.xp += n;
    this.profile.level = this.level.level;
    this.save();
    return { levelsGained: this.profile.level - before, level: this.profile.level };
  }

  unlockedEvents(): EventDef[] {
    return EVENTS.filter((e) => this.level.level >= e.unlockLevel);
  }

  isEventComplete(id: string) { return this.profile.completedEvents.includes(id); }

  completeEvent(def: EventDef, opts: { position?: number; time?: number; score?: number; clean?: boolean }) {
    const first = !this.isEventComplete(def.id);
    let credits = def.rewardCredits;
    let xp = def.rewardXp;
    if (opts.position && opts.position > 1) {
      const scale = clamp(1 - (opts.position - 1) * 0.12, 0.4, 1);
      credits = Math.round(credits * scale);
      xp = Math.round(xp * scale);
    }
    if (!first) { credits = Math.round(credits * 0.45); xp = Math.round(xp * 0.4); }
    this.profile.credits += credits;
    const levelResult = this.addXp(xp);
    if (first) this.profile.completedEvents.push(def.id);

    if (opts.time !== undefined) {
      const prev = this.profile.bestTimes[def.id];
      if (prev === undefined || opts.time < prev) this.profile.bestTimes[def.id] = opts.time;
    }
    if (opts.score !== undefined) {
      if (def.type === 'drift') {
        const prev = this.profile.driftRecords[def.id] ?? 0;
        if (opts.score > prev) this.profile.driftRecords[def.id] = opts.score;
      } else if (def.type === 'speedtrap') {
        const prev = this.profile.speedTrapRecords[def.id] ?? 0;
        if (opts.score > prev) this.profile.speedTrapRecords[def.id] = opts.score;
      } else if (def.type === 'jump') {
        const prev = this.profile.jumpRecords[def.id] ?? 0;
        if (opts.score > prev) this.profile.jumpRecords[def.id] = opts.score;
      }
    }
    this.markPlaylistProgress(def.id);
    this.save(true);
    return { credits, xp, levelsGained: levelResult.levelsGained, first };
  }

  /** Three-reel wheelspin with weighted rarities. */
  spin(): WheelspinPrize[] {
    const reel = (): WheelspinPrize => {
      const r = Math.random();
      if (r < 0.02) {
        const car = CARS[Math.floor(Math.random() * CARS.length)];
        return { kind: 'car', label: car.name, value: 0, carId: car.id, rarity: 'legendary' };
      }
      if (r < 0.12) return { kind: 'credits', label: '25,000 credits', value: 25000, rarity: 'epic' };
      if (r < 0.35) return { kind: 'credits', label: '9,000 credits', value: 9000, rarity: 'rare' };
      if (r < 0.6) return { kind: 'xp', label: '1,200 XP', value: 1200, rarity: 'common' };
      return { kind: 'credits', label: '2,400 credits', value: 2400, rarity: 'common' };
    };
    const prizes = [reel(), reel(), reel()];
    // Apply the best prize of the three reels.
    const rank = { common: 0, rare: 1, epic: 2, legendary: 3 } as const;
    const best = prizes.reduce((a, b) => (rank[b.rarity] > rank[a.rarity] ? b : a));
    this.applyPrize(best);
    return prizes;
  }

  applyPrize(p: WheelspinPrize) {
    if (p.kind === 'credits') this.profile.credits += p.value;
    else if (p.kind === 'xp') this.addXp(p.value);
    else if (p.kind === 'car' && p.carId) this.grantCar(p.carId);
    this.save(true);
  }

  grantCar(carId: string) {
    if (this.profile.owned.some((c) => c.carId === carId)) {
      const spec = getCar(carId);
      this.profile.credits += Math.round(spec.price * 0.3);
      return false;
    }
    this.profile.owned.push({
      carId,
      paint: { color: getCar(carId).paint, finish: 'metallic' },
      upgrades: { engine: 0, turbo: 0, gearbox: 0, tires: 0, brakes: 0, suspension: 0, weight: 0, aero: 0, drivetrain: 'keep' },
      tuning: { camber: -0.5, toe: 0.05, rideHeight: 0, stiffnessBias: 0.5, brakeBias: 0.62, finalDrive: 1 },
      mileageKm: 0,
    });
    this.save(true);
    return true;
  }

  buyCar(carId: string): { ok: boolean; reason?: string } {
    const spec = CAR_BY_ID[carId];
    if (!spec) return { ok: false, reason: 'Unknown car' };
    if (this.profile.owned.some((c) => c.carId === carId)) return { ok: false, reason: 'Already owned' };
    if (this.profile.credits < spec.price) return { ok: false, reason: 'Not enough credits' };
    this.profile.credits -= spec.price;
    this.grantCar(carId);
    this.save(true);
    return { ok: true };
  }

  setActiveCar(carId: string) {
    if (this.profile.owned.some((c) => c.carId === carId)) {
      this.profile.activeCarId = carId;
      this.save(true);
    }
  }

  // ---- seasonal playlist -------------------------------------------------
  playlist(): PlaylistWeek {
    const week = Math.max(1, Math.floor((Date.now() / (1000 * 60 * 60 * 24 * 7)) % 52) + 1);
    const season = SEASONS[week % SEASONS.length];
    const pool = EVENTS.filter((e) => e.type !== 'drift');
    const chosen = pool.slice(0, 3);
    return {
      season,
      week,
      challenges: chosen.map((e, i) => ({
        id: `${season}-${week}-${i}`,
        title: `${e.name} — ${e.type === 'circuit' ? 'finish top 3' : e.type === 'sprint' ? 'beat the target time' : 'win the event'}`,
        eventId: e.id,
        points: 20 + i * 10,
        done: this.profile.playlist.completed.includes(`${season}-${week}-${i}`),
      })),
      rewardCar: 'ts11-super',
    };
  }

  private markPlaylistProgress(eventId: string) {
    const week = this.playlist();
    const challenge = week.challenges.find((c) => c.eventId === eventId);
    if (challenge && !challenge.done) {
      this.profile.playlist.completed.push(challenge.id);
      this.profile.playlist.points += challenge.points;
      this.profile.playlist.season = week.season;
      this.profile.playlist.week = week.week;
    }
  }

  reset() {
    this.profile = newProfile();
    this.save(true);
  }
}
