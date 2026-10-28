import * as THREE from 'three';
import type { EventDef } from '../data/events';
import { buildRoute, type Route, type RouteGate } from './route';
import type { GameWorld } from '../world/world';
import type { VehicleActor } from './vehicleActor';
import { clamp } from '../core/math';

export type RaceState = 'countdown' | 'running' | 'finished';

export interface RacerProgress {
  id: string;
  name: string;
  isPlayer: boolean;
  gate: number;
  lap: number;
  finished: boolean;
  finishTime: number;
  totalTime: number;
  progress: number;
  lastDistToGate: number;
  wrongWay: boolean;
  skipped: boolean;
}

export interface RaceHud {
  state: RaceState;
  countdown: number | null;
  position: number;
  total: number;
  lap: number;
  laps: number;
  time: number;
  eventName: string;
  objective: string | null;
  distanceToNext: number;
}

/**
 * A time-based race: countdown, ordered gates, laps, live positions and results.
 *
 * Junction safety: gate crossing uses the swept segment between the previous
 * and current position, so a car at 300 km/h (83 m/s, i.e. 0.7 m per tick) can
 * never skip a gate between physics ticks.
 */
export class RaceSession {
  def: EventDef;
  route: Route;
  state: RaceState = 'countdown';
  countdown = 3.2;
  time = 0;
  progress = new Map<string, RacerProgress>();
  private prevPos = new Map<string, THREE.Vector3>();
  results: { name: string; time: number; isPlayer: boolean; position: number }[] = [];
  private playerFinished = false;

  constructor(def: EventDef, world: GameWorld, racers: { id: string; name: string; isPlayer: boolean }[]) {
    this.def = def;
    this.route = buildRoute(world, def);
    for (const r of racers) {
      this.progress.set(r.id, {
        id: r.id, name: r.name, isPlayer: r.isPlayer, gate: 0, lap: 1, finished: false,
        finishTime: 0, totalTime: 0, progress: 0, lastDistToGate: Infinity, wrongWay: false, skipped: false,
      });
    }
  }

  get gateCount() { return this.route.gates.length; }

  /** Start pose for the racer in a given grid slot (staggered behind the line). */
  gridPose(slot: number) {
    const gate = this.route.gates[0];
    const spacing = 9;
    const lateral = (slot % 2 === 0 ? -1 : 1) * 3.6;
    const back = Math.floor(slot / 2) * spacing + 6;
    const x = gate.x - gate.dirX * back + -gate.dirZ * lateral;
    const z = gate.z - gate.dirZ * back + gate.dirX * lateral;
    const yaw = Math.atan2(gate.dirX, gate.dirZ);
    return { x, z, yaw };
  }

  update(dt: number, actors: Map<string, VehicleActor>) {
    if (this.state === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) { this.state = 'running'; this.countdown = 0; }
      return;
    }
    if (this.state === 'finished') return;
    this.time += dt;

    const gates = this.route.gates;
    for (const [id, p] of this.progress) {
      const actor = actors.get(id);
      if (!actor || p.finished) continue;
      const pos = actor.position;
      const prev = this.prevPos.get(id) ?? pos.clone();
      p.totalTime += dt;

      // ---- gate crossing test (swept) ----
      const g = gates[p.gate % gates.length];
      const normal = { x: g.dirX, z: g.dirZ };
      const d0 = (prev.x - g.x) * normal.x + (prev.z - g.z) * normal.z;
      const d1 = (pos.x - g.x) * normal.x + (pos.z - g.z) * normal.z;
      const lateral = Math.abs((pos.x - g.x) * -normal.z + (pos.z - g.z) * normal.x);
      const crossed = d0 < 0 && d1 >= 0 && lateral < g.width;
      const distToGate = Math.hypot(pos.x - g.x, pos.z - g.z);
      p.lastDistToGate = distToGate;

      if (crossed) {
        p.gate++;
        if (p.gate >= gates.length) {
          p.gate = 0;
          p.lap++;
          if (p.lap > this.def.laps) {
            p.finished = true;
            p.finishTime = p.totalTime;
            if (p.isPlayer) this.playerFinished = true;
          }
        }
      }

      // ---- progress score ----
      const nextGate = gates[p.gate % gates.length];
      const distToNext = Math.hypot(pos.x - nextGate.x, pos.z - nextGate.z);
      p.progress = (p.lap - 1) * gates.length + p.gate + clamp(1 - distToNext / (this.route.length / gates.length + 1), 0, 0.99);

      // ---- wrong way detection ----
      const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(actor.curQuat);
      const alignment = forward.x * nextGate.dirX + forward.z * nextGate.dirZ;
      const speed = actor.sim.readout.speedMs;
      p.wrongWay = alignment < -0.4 && speed > 4;

      this.prevPos.set(id, pos.clone());
    }

    // ---- finish ordering ----
    if ([...this.progress.values()].every((p) => p.finished)) this.finish();
  }

  private finish() {
    if (this.state === 'finished') return;
    this.state = 'finished';
    this.results = [...this.progress.values()]
      .sort((a, b) => a.finishTime - b.finishTime)
      .map((p, i) => ({ name: p.name, time: p.finishTime, isPlayer: p.isPlayer, position: i + 1 }));
  }

  /** Live standings: finished racers first (by time), then by progress. */
  standings(): RacerProgress[] {
    return [...this.progress.values()].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.progress - a.progress;
    });
  }

  playerPosition(): number {
    const idx = this.standings().findIndex((p) => p.isPlayer);
    return idx < 0 ? 1 : idx + 1;
  }

  playerProgress(): RacerProgress | null {
    for (const p of this.progress.values()) if (p.isPlayer) return p;
    return null;
  }

  /** Force-finish (used when the player quits or times out). */
  abandon() { this.finish(); }

  hud(): RaceHud {
    const p = this.playerProgress();
    const gate = this.route.gates[p ? p.gate % this.route.gates.length : 0];
    return {
      state: this.state,
      countdown: this.state === 'countdown' ? Math.ceil(this.countdown - 0.2) : null,
      position: this.playerPosition(),
      total: this.progress.size,
      lap: p ? Math.min(p.lap, this.def.laps) : 1,
      laps: this.def.laps,
      time: p ? p.totalTime : 0,
      eventName: this.def.name,
      objective: p && p.wrongWay ? 'WRONG WAY' : null,
      distanceToNext: p ? p.lastDistToGate : 0,
    };
  }

  gate(): RouteGate | null { return this.route.gates[0] ?? null; }
}

// ---------------------------------------------------------------------------
// Zone challenges: drift, speed trap, jump
// ---------------------------------------------------------------------------

export interface ChallengeState {
  active: boolean;
  score: number;
  best: number;
  message: string;
  timeLeft: number;
  target: number;
  progress: number;
}

export class ChallengeSession {
  def: EventDef;
  route: Route;
  state: ChallengeState;
  private wasAirborne = false;
  private takeoff: THREE.Vector3 | null = null;
  private bestSpeed = 0;
  private inZone = false;

  constructor(def: EventDef, world: GameWorld) {
    this.def = def;
    this.route = buildRoute(world, def);
    this.state = { active: true, score: 0, best: 0, message: '', timeLeft: 90, target: def.targetScore ?? def.targetSpeed ?? def.targetDistance ?? 1, progress: 0 };
  }

  /** True when the car is inside the challenge zone (start of the route). */
  private insideZone(pos: THREE.Vector3): boolean {
    const pts = this.route.points;
    for (let i = 0; i < pts.length; i += 2) {
      const p = pts[i];
      if ((p.x - pos.x) ** 2 + (p.z - pos.z) ** 2 < 120 * 120) return true;
    }
    return false;
  }

  update(dt: number, actor: VehicleActor) {
    if (!this.state.active) return;
    this.state.timeLeft = Math.max(0, this.state.timeLeft - dt);
    const pos = actor.position;
    const sim = actor.sim;
    this.inZone = this.insideZone(pos);

    switch (this.def.type) {
      case 'drift': {
        if (this.inZone && sim.readout.drifting) {
          this.state.score += sim.readout.driftScoreRate * dt;
        }
        this.state.progress = clamp(this.state.score / (this.def.targetScore ?? 1), 0, 1);
        this.state.message = this.inZone ? 'DRIFT ZONE' : 'Return to the zone';
        break;
      }
      case 'speedtrap': {
        const gate = this.route.gates[Math.floor(this.route.gates.length / 2)];
        const dist = Math.hypot(pos.x - gate.x, pos.z - gate.z);
        this.bestSpeed = Math.max(this.bestSpeed, sim.readout.speedKmh);
        if (dist < 45) {
          const speed = sim.readout.speedKmh;
          if (speed > this.state.score) this.state.score = speed;
        }
        this.state.progress = clamp(this.state.score / (this.def.targetSpeed ?? 1), 0, 1);
        this.state.message = dist < 200 ? `TRAP IN ${Math.round(dist)} m` : 'Approach the trap at speed';
        break;
      }
      case 'jump': {
        const airborne = sim.readout.wheelsAirborne >= 3;
        if (airborne && !this.wasAirborne) this.takeoff = pos.clone();
        if (!airborne && this.wasAirborne && this.takeoff) {
          const dist = Math.hypot(pos.x - this.takeoff.x, pos.z - this.takeoff.z);
          if (dist > this.state.score) this.state.score = dist;
          this.takeoff = null;
        }
        this.state.progress = clamp(this.state.score / (this.def.targetDistance ?? 1), 0, 1);
        this.state.message = airborne ? 'AIRBORNE!' : 'Find a crest and jump';
        this.wasAirborne = airborne;
        break;
      }
      default: break;
    }
    if (this.state.timeLeft <= 0) this.state.active = false;
  }

  get success(): boolean {
    return this.state.score >= this.state.target;
  }

  hud() {
    return {
      eventName: this.def.name,
      objective: this.state.message,
      score: this.state.score,
      time: this.state.timeLeft,
    };
  }
}
