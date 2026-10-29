/**
 * `Game` — the orchestrator.
 *
 * It owns the fixed-timestep loop, the player/AI/traffic actors, event lifecycle,
 * rewind snapshots, saving, the HUD feed and the optional network mirror. It
 * deliberately contains no physics, rendering or UI internals: those live in
 * `physics/vehicle.ts`, `render/*` and `ui/*`.
 *
 * Frame contract
 * --------------
 *  1. `input.sample()` runs exactly once per animation frame, so key edges are
 *     never swallowed by a physics substep.
 *  2. Physics runs at a fixed 1/120 s. The accumulator is clamped, so a long
 *     stall (tab switch, GC pause, hitch) drops simulated time instead of
 *     teleporting cars through the world.
 *  3. Rendering interpolates between the previous and current physics poses.
 */
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';

import { GameWorld } from './world/world';
import { createMaterials, type MaterialSet } from './render/materials';
import { Renderer } from './render/scene';
import { CameraRig } from './render/cameraRig';
import { Hud, type MapMarker, type HudState } from './ui/hud';
import { UI } from './ui/screens';
import { AudioSystem, type VehicleAudio } from './audio/audio';
import { InputManager, toControl } from './core/input';
import type { RawInput } from './core/input';
import { Career } from './gameplay/career';
import { loadProfile, saveProfile, blankUpgrades, blankTuning } from './core/save';
import { loadSettings, saveSettings, DIFFICULTY_PRESETS } from './core/settings';
import type { GameSettings } from './core/settings';
import { WeatherSystem } from './gameplay/weather';
import { EVENTS, EVENT_BY_ID } from './data/events';
import { getCar } from './data/cars';
import { resolveParams } from './vehicles/tuning';
import { buildRoute } from './gameplay/route';
import type { Route } from './gameplay/route';
import { RaceSession, ChallengeSession } from './gameplay/race';
import { VehicleActor, emitVehicleEffects } from './gameplay/vehicleActor';
import type { EffectHooks } from './gameplay/vehicleActor';
import { AIDriver, TrafficDriver } from './gameplay/ai';
import { createEffectTexture, ParticleSystem, SkidMarks } from './render/effects';
import { NetClient } from './net/client';
import type { NetPlayerState } from './net/client';
import { clamp } from './core/math';
import type { SurfaceId } from './core/types';
import type { VehicleSnapshot } from './physics/vehicle';

const FIXED_DT = 1 / 120;
const MAX_FRAME_DT = 0.25;
const MAX_STEPS_PER_FRAME = 8;
const REWIND_HZ = 12;
const REWIND_SECONDS = 10;
const TRAFFIC_COUNT = 10;
const AI_RACERS = 5;

export type GameState = 'menu' | 'driving' | 'racing' | 'paused' | 'results' | 'photo';

interface RewindFrame { t: number; snap: VehicleSnapshot }

export class Game {
  readonly renderer: Renderer;
  readonly rapier: typeof RAPIER;
  settings: GameSettings;
  career: Career;
  audio: AudioSystem;
  input: InputManager;
  camera: CameraRig;
  weather: WeatherSystem;

  world!: GameWorld;
  hud!: Hud;
  ui!: UI;
  player!: VehicleActor;
  aiCars: VehicleActor[] = [];
  traffic: VehicleActor[] = [];

  state: GameState = 'menu';
  activeEventId: string | null = null;
  race: RaceSession | null = null;
  challenge: ChallengeSession | null = null;
  route: Route | null = null;
  net: NetClient | null = null;

  lastResults: {
    eventName: string; position: number; total: number; time: number;
    best: number | null; credits: number; xp: number;
    placements: { name: string; time: number; isPlayer: boolean }[];
  } | null = null;

  private aiDrivers: AIDriver[] = [];
  private trafficDrivers: TrafficDriver[] = [];
  private playerAudio: VehicleAudio | null = null;

  private smoke: ParticleSystem | null = null;
  private dust: ParticleSystem | null = null;
  private sparks: ParticleSystem | null = null;
  private skids: SkidMarks | null = null;
  private effectTexture: THREE.Texture | null = null;
  private effectHooks: EffectHooks;

  private accumulator = 0;
  private lastTime = 0;
  private frame = 0;
  private raf = 0;
  private running = false;
  private rewinds: RewindFrame[] = [];
  private rewindTimer = 0;
  private rewinding = false;
  private rewindHold = 0;
  private debugPhysics = false;
  /** When set, the camera rig leaves the camera alone (screenshot probes). */
  private cameraFrozen = false;
  private hudVisible = true;
  private photoMode = false;
  private suppressPause = false;
  private raw: RawInput;
  private hudAccum = 0;
  private netAccum = 0;
  private remoteCars = new Map<string, THREE.Object3D>();
  private distanceKm = 0;
  materials!: MaterialSet;

  constructor(canvas: HTMLCanvasElement, rapier: typeof RAPIER, settings: GameSettings) {
    this.rapier = rapier;
    this.settings = settings;
    this.renderer = new Renderer(canvas, settings);
    this.career = new Career();
    this.audio = new AudioSystem();
    this.input = new InputManager();
    this.camera = new CameraRig(this.renderer.camera, settings.fov);
    this.weather = new WeatherSystem();
    this.weather.setLocked(settings.weatherLock);
    this.weather.setTimeLock(settings.timeOfDayLock);
    this.raw = { throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: false, shiftDown: false };

    this.effectHooks = {
      spawnSmoke: (pos, color, size, life, vel, grow) => {
        this.smoke?.spawn({
          x: pos.x, y: pos.y, z: pos.z, vx: vel.x, vy: vel.y, vz: vel.z,
          r: color[0], g: color[1], b: color[2], size, life, grow: grow ?? 1.4,
        });
      },
      spawnSkid: (wheelIndex, pos, normal, width, intensity) => {
        this.skids?.addSegment(wheelIndex, pos, normal, width, intensity);
      },
      liftSkid: () => { /* segments restart naturally when contact resumes */ },
      spawnSparks: (pos, count) => {
        for (let i = 0; i < count; i++) {
          this.sparks?.spawn({
            x: pos.x, y: pos.y, z: pos.z,
            vx: (Math.random() - 0.5) * 5, vy: Math.random() * 3.5, vz: (Math.random() - 0.5) * 5,
            r: 1, g: 0.72, b: 0.28, size: 0.16, life: 0.55, grow: 0.7,
          });
        }
      },
    };

    this.input.attach(window);
    this.input.setGamepadOptions(settings.gamepadDeadzone, settings.steeringSensitivity);
    window.addEventListener('resize', () => this.renderer.onResize());
    document.addEventListener('visibilitychange', () => this.onVisibility());
    window.addEventListener('pagehide', () => this.saveNow());
  }

  // ------------------------------------------------------------------ boot

  async init(onProgress: (fraction: number, label: string) => void = () => {}) {
    onProgress(0.05, 'Creating the physics world…');
    const rapierWorld = new this.rapier.World({ x: 0, y: -9.81, z: 0 });
    const aniso = this.settings.quality === 'low' ? 2 : this.settings.quality === 'ultra' ? 16 : 8;
    this.materials = createMaterials({ anisotropy: aniso, groundDetail: this.settings.quality !== 'low' });
    this.world = new GameWorld(this.renderer.scene, rapierWorld, this.materials, {
      foliageDensity: this.settings.foliageDensity,
      shadows: this.settings.shadows,
      anisotropy: aniso,
      // 2 m near the player on high/ultra, 8 m on low: this is the single
      // biggest lever on how "modelled" the terrain looks.
      terrainRes: this.settings.quality === 'ultra' ? 2 : this.settings.quality === 'high' ? 4 : 8,
      terrainResFar: this.settings.quality === 'low' ? 16 : 8,
      groundCover: this.settings.quality !== 'low' && this.settings.foliageDensity > 0.05,
    });

    this.world.rapier.timestep = FIXED_DT;

    const host = (document.getElementById('ui') ?? document.body) as HTMLElement;
    this.hud = new Hud(host, this.world);
    this.ui = new UI(host, {
      career: this.career,
      settings: this.settings,
      world: this.world,
      playerPosition: { x: 0, z: 0, yaw: 0 },
      activeCarId: this.activeOwnedCar().carId,
      applySettings: (s) => this.applySettings(s),
      resume: () => this.resume(),
      quitToMenu: () => this.quitToMenu(),
      startEvent: (id) => this.startEvent(id),
      retryEvent: () => this.retryEvent(),
      fastTravel: (x, z) => this.fastTravel(x, z),
      changeCar: (id) => this.changeCar(id),
      setPhotoMode: (on) => this.setPhotoMode(on),
      capturePhoto: () => this.capturePhoto(),
      openRadio: (dir) => this.cycleStation(dir),
      audioClick: (kind) => this.audio.playUi(kind),
      rewardsPreview: () => this.resultsData(),
      toast: (msg, kind) => this.hud.toast(msg, kind ?? 'info'),
    });

    this.createEffects();
    this.createPlayer();

    onProgress(0.4, 'Building roads and terrain…');
    this.world.preload(this.player.position, (p) => onProgress(0.4 + p * 0.45, 'Streaming the world…'));

    onProgress(0.88, 'Placing traffic…');
    this.spawnTraffic();

    this.camera.mode = 'chase';
    this.camera.setShake(this.settings.cameraShake, this.settings.reducedMotion);
    this.applyAudioSettings();
    this.state = 'menu';
    this.ui.show('menu');
    this.hud.update(this.buildHudState());
    this.startLoop();
  }

  /** Staggered start pose behind the first gate (slot 0 = pole). */
  private gridPose(route: Route, slot: number) {
    const gate = route.gates[0] ?? { x: route.start.x, z: route.start.z, dirX: 0, dirZ: 1 };
    const lateral = (slot % 2 === 0 ? -1 : 1) * 3.4;
    const back = Math.floor(slot / 2) * 8 + 4;
    return {
      x: gate.x - gate.dirX * back - gate.dirZ * lateral,
      z: gate.z - gate.dirZ * back + gate.dirX * lateral,
      yaw: Math.atan2(gate.dirX, gate.dirZ),
    };
  }

  private createEffects() {
    this.effectTexture = createEffectTexture();
    const density = clamp(this.settings.particleDensity, 0.1, 1);
    this.smoke = new ParticleSystem(Math.round(700 * density) + 120, this.effectTexture);
    this.dust = new ParticleSystem(Math.round(500 * density) + 120, this.effectTexture);
    this.sparks = new ParticleSystem(Math.round(220 * density) + 60, this.effectTexture);
    this.skids = new SkidMarks(2200);
    this.renderer.scene.add(this.smoke.points, this.dust.points, this.sparks.points, this.skids.mesh);
  }

  /** Where a new player starts: a straight on the festival loop. */
  private spawnPoint() {
    const inst = this.world.field.instances.find((i) => i.def.id === 'festival-loop') ?? this.world.field.instances[0];
    const sample = inst.samples[Math.floor(inst.samples.length * 0.74) % inst.samples.length];
    return { x: sample.x, z: sample.z };
  }

  private activeOwnedCar() {
    const owned = this.career.profile.owned;
    return owned.find((c) => c.carId === this.career.profile.activeCarId) ?? owned[0];
  }

  /**
   * Surface under a wheel. The sampler is called with the contact point and the
   * contact normal as (x, y, z, normalY): `roadInfoAt` reports how far that point
   * is from a road corridor; off the corridor we report grass, on it we read the
   * road's own surface metadata (the same data the GPS, AI and HUD use).
   */
  private surfaceSampler = (x: number, _y: number, z: number) => {
    const info = this.world.roadInfoAt(x, z);
    const onRoad = !!info.roadId && info.dist <= info.width * 0.5 + 0.4;
    const surface = (onRoad ? this.surfaceOfRoad(info.roadId!) : 'grass') as SurfaceId;
    return { id: surface, wetness: this.weather.state.wetness };
  };

  private surfaceOfRoad(roadId: string): SurfaceId {
    const def = this.world.field.instances.find((i) => i.def.id === roadId)?.def;
    return (def?.surface ?? 'asphaltDry') as SurfaceId;
  }

  private actorParams(upgrades = blankUpgrades(), tuning = blankTuning()) {
    const owned = this.activeOwnedCar();
    const spec = getCar(owned.carId);
    return resolveParams(spec, upgrades, tuning);
  }

  private createPlayer() {
    const owned = this.activeOwnedCar();
    const params = resolveParams(getCar(owned.carId), owned.upgrades ?? blankUpgrades(), owned.tuning ?? blankTuning());
    this.player = new VehicleActor(this.world.rapier, params, {
      spec: params.spec,
      appearance: owned.paint,
      name: 'You',
      isPlayer: true,
      assists: this.settings.assist,
      simDamage: this.settings.simulationMode,
      surfaceSampler: this.surfaceSampler,
      shared: this.materials.shared,
    });
    // A brand-new profile spawns on the festival loop just outside the town
    // square: scenery, road furniture and the first event are all in view.
    const start = this.spawnPoint();
    const last = this.career.profile.lastPosition;
    // `newProfile()` seeds lastPosition at the origin, which is not a real
    // parking spot, so treat "near the origin" as "no saved position".
    const saved = last && (Math.abs(last.x) > 1 || Math.abs(last.z) > 1) ? last : null;
    const spawn = this.world.safeRespawn(saved ? saved.x : start.x, saved ? saved.z : start.z);
    this.player.place(spawn.x, spawn.y + 0.7, spawn.z, spawn.yaw);
    this.player.captureState();
    this.renderer.scene.add(this.player.mesh.group);
    this.playerAudio = this.audio.createVehicleAudio(params.spec);
    this.raw = { throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: false, shiftDown: false };
  }

  private spawnTraffic() {
    const params = this.actorParams();
    const instances = this.world.field.instances;
    for (let i = 0; i < TRAFFIC_COUNT; i++) {
      const inst = instances[i % instances.length];
      const sample = inst.samples[Math.floor(inst.samples.length * ((i * 0.13 + 0.07) % 1))];
      if (!sample) continue;
      const actor = new VehicleActor(this.world.rapier, params, {
        spec: params.spec,
        appearance: { color: ['#b7c4cc', '#8d9aa6', '#c9a227', '#4a6b8a', '#a33b3b'][i % 5], finish: 'gloss' },
        name: `Traffic ${i + 1}`,
        isPlayer: false,
        assists: { abs: true, tractionControl: true, stabilityControl: true, steeringAssist: 0.4, autoGears: true, rewind: false, racingLine: false, brakingAssist: 0.3 },
        simDamage: false,
        surfaceSampler: this.surfaceSampler,
        shared: this.materials.shared,
      });
      const yaw = Math.atan2(sample.dx, sample.dz);
      actor.place(sample.x, this.world.driveY(sample.x, sample.z) + 0.7, sample.z, yaw);
      actor.captureState();
      this.renderer.scene.add(actor.mesh.group);
      this.traffic.push(actor);
      this.trafficDrivers.push(new TrafficDriver((i % 2 === 0 ? 2.4 : -2.4), 0.55 + (i % 3) * 0.08));
    }
  }

  private clearRaceActors() {
    for (const car of this.aiCars) {
      this.renderer.scene.remove(car.mesh.group);
      car.mesh.dispose?.();
    }
    this.aiCars = [];
    this.aiDrivers = [];
  }

  private spawnAiRacers(count: number, route: Route) {
    this.clearRaceActors();
    const params = this.actorParams();
    const preset = DIFFICULTY_PRESETS[this.settings.difficulty];
    for (let i = 0; i < count; i++) {
      const driver = new AIDriver({
        skill: clamp(preset.aiSkill + (i - count / 2) * 0.02, 0.3, 1),
        aggression: preset.aiAggression,
        laneBias: (i % 2 === 0 ? -1 : 1) * 0.9,
        reactionTime: 0.35 - preset.aiSkill * 0.2,
      });
      driver.setRoute(route);
      const pose = this.gridPose(route, i + 1);
      const actor = new VehicleActor(this.world.rapier, params, {
        spec: params.spec,
        appearance: { color: ['#2f6f8f', '#b8452f', '#3f7a48', '#c9a227', '#6b4b8a'][i % 5], finish: 'metallic' },
        name: `Rival ${i + 1}`,
        isPlayer: false,
        assists: { abs: true, tractionControl: true, stabilityControl: true, steeringAssist: 0.25, autoGears: true, rewind: false, racingLine: false, brakingAssist: 0.2 },
        simDamage: false,
        surfaceSampler: this.surfaceSampler,
        shared: this.materials.shared,
      });
      actor.place(pose.x, this.world.driveY(pose.x, pose.z) + 0.7, pose.z, pose.yaw);
      actor.captureState();
      this.renderer.scene.add(actor.mesh.group);
      this.aiCars.push(actor);
      this.aiDrivers.push(driver);
    }
  }

  // ---------------------------------------------------------------- events

  startEvent(eventId: string) {
    const def = EVENT_BY_ID[eventId];
    if (!def) return;
    const route = buildRoute(this.world, def);
    this.route = route;
    this.activeEventId = eventId;
    this.lastResults = null;
    this.rewinds.length = 0;

    const isChallenge = def.type === 'drift' || def.type === 'speedtrap' || def.type === 'jump';
    if (isChallenge) {
      this.race = null;
      this.challenge = new ChallengeSession(def, this.world);
      this.clearRaceActors();
    } else {
      this.challenge = null;
      const racers = [{ id: 'player', name: 'You', isPlayer: true }];
      for (let i = 0; i < AI_RACERS; i++) racers.push({ id: `ai${i}`, name: `Rival ${i + 1}`, isPlayer: false });
      this.race = new RaceSession(def, this.world, racers);
      this.spawnAiRacers(AI_RACERS, route);
    }

    const pose = this.race ? this.race.gridPose(0) : this.gridPose(route, 0);
    this.player.place(pose.x, this.world.driveY(pose.x, pose.z) + 0.7, pose.z, pose.yaw);
    this.player.captureState();
    this.state = 'racing';
    this.ui.close();
    this.hud.subtitle(def.description ?? null);
    this.hud.toast(def.name, 'info', 2200);
    this.audio.playUi('confirm');
    this.saveNow();
  }

  retryEvent() {
    if (this.activeEventId) this.startEvent(this.activeEventId);
  }

  abandonEvent() {
    this.race?.abandon();
    this.race = null;
    this.challenge = null;
    this.route = null;
    this.activeEventId = null;
    this.rewinds.length = 0;
    this.clearRaceActors();
    this.hud.subtitle(null);
    this.hud.countdown(null);
    if (this.state !== 'menu') this.state = 'driving';
  }

  private finishEvent() {
    const def = this.activeEventId ? EVENT_BY_ID[this.activeEventId] : null;
    if (!def) return;
    let position = 1;
    let total = 1;
    let time = 0;
    let score = 0;
    if (this.race) {
      const results = this.race.results;
      total = Math.max(1, results.length);
      const mine = results.find((r) => r.isPlayer);
      position = mine?.position ?? total;
      time = mine?.time ?? this.race.time;
    } else if (this.challenge) {
      score = Math.round(this.challenge.state.score);
      time = this.challenge.state.timeLeft;
    }
    const payout = this.career.completeEvent(def, { position, time, score });
    this.lastResults = {
      eventName: def.name,
      position,
      total,
      time,
      best: this.career.profile.bestTimes[def.id] ?? null,
      credits: payout.credits,
      xp: payout.xp,
      placements: this.race
        ? this.race.results.map((r) => ({ name: r.name, time: r.time, isPlayer: r.isPlayer }))
        : [{ name: 'You', time, isPlayer: true }],
    };
    this.state = 'results';
    this.clearRaceActors();
    this.hud.subtitle(null);
    const data = this.resultsData();
    if (data) this.ui.setResults(data);
    this.audio.playUi('reward');
    this.saveNow();
  }

  private resultsData() {
    const r = this.lastResults;
    if (!r) return null;
    return {
      eventName: r.eventName, position: r.position, total: r.total, time: r.time,
      best: r.best, credits: r.credits, xp: r.xp, placements: r.placements,
    };
  }

  // ----------------------------------------------------------------- modes

  resume() {
    this.ui.close();
    this.state = this.activeEventId ? 'racing' : 'driving';
  }

  quitToMenu() {
    this.abandonEvent();
    this.state = 'menu';
    this.ui.show('menu');
  }

  setPhotoMode(on: boolean) {
    this.photoMode = on;
    this.camera.mode = on ? 'photo' : 'chase';
    this.state = on ? 'photo' : this.activeEventId ? 'racing' : 'driving';
    if (!on) this.ui.close();
  }

  capturePhoto() {
    try {
      const data = this.renderer.capture();
      const a = document.createElement('a');
      a.href = data;
      a.download = `horizon-drive-${Date.now()}.png`;
      a.click();
      this.hud.toast('Photo saved', 'good');
    } catch {
      this.hud.toast('Photo capture failed', 'bad');
    }
  }

  fastTravel(x: number, z: number) {
    this.abandonEvent();
    const spawn = this.world.safeRespawn(x, z);
    this.player.place(spawn.x, spawn.y + 0.7, spawn.z, spawn.yaw);
    this.player.captureState();
    this.world.preload(this.player.position);
    this.state = 'driving';
    this.ui.close();
    this.hud.toast('Travelled', 'good');
    this.saveNow();
  }

  changeCar(carId: string) {
    if (!this.career.profile.owned.some((c) => c.carId === carId)) return;
    this.career.setActiveCar(carId);
    const pos = this.player.position.clone();
    const yaw = this.player.quaternion.clone();
    this.renderer.scene.remove(this.player.mesh.group);
    this.playerAudio?.dispose();
    const scene = this.renderer.scene;
    for (const c of [...this.aiCars, ...this.traffic]) scene.remove(c.mesh.group);
    this.createPlayer();
    this.player.place(pos.x, pos.y + 0.9, pos.z, new THREE.Euler().setFromQuaternion(yaw, 'YXZ').y);
    this.player.captureState();
    this.hud.toast(getCar(carId).name, 'info');
    this.saveNow();
  }

  cycleStation(dir = 'next') {
    const stations = ['horizon-fm', 'neon-wave', 'sunset-rock', 'classic-hall', 'off'] as const;
    const cur = this.audio.station as string;
    const idx = Math.max(0, stations.indexOf(cur as typeof stations[number]));
    const next = dir === 'next' ? stations[(idx + 1) % stations.length] : stations[(idx - 1 + stations.length) % stations.length];
    this.audio.startRadio(next);
    this.hud.toast(next === 'off' ? 'Radio off' : `Radio: ${next}`, 'info', 1600);
  }

  applySettings(s: GameSettings) {
    this.settings = s;
    saveSettings(s);
    this.ui.setSettings(s);
    this.renderer.applySettings(s);
    this.camera.setShake(s.cameraShake, s.reducedMotion);
    this.weather.setLocked(s.weatherLock);
    this.weather.setTimeLock(s.timeOfDayLock);
    this.input.setGamepadOptions(s.gamepadDeadzone, s.steeringSensitivity);
    this.player.sim.setAssists(s.assist);
    for (const car of [...this.aiCars, ...this.traffic]) car.sim.setAssists(car === this.player ? s.assist : car.controls as never);
    this.applyAudioSettings();
  }

  private applyAudioSettings() {
    this.audio.applyVolumes({
      master: this.settings.masterVolume,
      engine: this.settings.engineVolume,
      sfx: this.settings.sfxVolume,
      music: this.settings.musicVolume,
      ui: this.settings.uiVolume,
    });
    this.audio.radioEnabled = this.settings.radioEnabled;
    this.audio.applyVolumes();
  }

  private onVisibility() {
    if (document.hidden) {
      if (this.state === 'driving' || this.state === 'racing') {
        this.state = 'paused';
        this.ui.show('pause');
      }
      this.audio.suspend();
    } else {
      // Drop accumulated time so the first frame after a stall is a normal one.
      this.lastTime = performance.now();
      this.accumulator = 0;
      this.audio.resume();
    }
  }

  suppressPauseThisFrame() { this.suppressPause = true; }

  // ------------------------------------------------------------------ loop

  private startLoop() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      const rawDt = (now - this.lastTime) / 1000;
      this.lastTime = now;
      const dt = Math.min(Math.max(rawDt, 0), MAX_FRAME_DT);
      this.frame++;

      this.raw = this.input.sample(dt);
      this.handleGlobalInput();

      let alpha = 1;
      if (this.state === 'driving' || this.state === 'racing') {
        this.accumulator += dt;
        if (this.accumulator > MAX_FRAME_DT) this.accumulator = MAX_FRAME_DT;
        let steps = 0;
        while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
          this.stepPhysics(FIXED_DT);
          this.accumulator -= FIXED_DT;
          steps++;
        }
        if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;
        alpha = clamp(this.accumulator / FIXED_DT, 0, 1);
      } else {
        this.accumulator = 0;
      }

      this.updatePresentation(dt, alpha);
      this.renderer.adaptResolution(dt, 1000 / 60);
      this.renderer.render(dt);
      this.updateHud(dt);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private handleGlobalInput() {
    const s = this.state;
    if (this.input.justPressed('pause')) {
      if (this.suppressPause) { this.suppressPause = false; return; }
      if (s === 'driving' || s === 'racing') {
        this.state = 'paused';
        this.ui.show('pause');
      } else if (s === 'paused' || s === 'results') {
        this.resume();
      }
    }
    if (this.suppressPause) { this.suppressPause = false; return; }
    if (this.input.justPressed('map') && s !== 'menu') { this.state = 'paused'; this.ui.show('map'); }
    if (this.input.justPressed('photo')) this.setPhotoMode(!this.photoMode);
    if (this.input.justPressed('hud')) { this.hudVisible = !this.hudVisible; this.hud.show(this.hudVisible); }
    if (this.input.justPressed('radio')) this.cycleStation('next');
    if (this.input.justPressed('camera') && !this.photoMode) this.camera.cycle();
    if (this.input.justPressed('reset') && (s === 'driving' || s === 'racing')) this.respawnPlayer();
    if (this.input.isDown('rewind') && (s === 'driving' || s === 'racing')) this.beginRewind();
    else { this.rewinding = false; this.rewindHold = 0; }
    if (this.input.justPressed('horn')) this.audio.playUi('click');
  }

  private respawnPlayer() {
    const p = this.player.position;
    const spawn = this.world.safeRespawn(p.x, p.z);
    this.player.place(spawn.x, spawn.y + 0.7, spawn.z, spawn.yaw);
    this.player.captureState();
    this.rewinds.length = 0;
    this.hud.toast('Back on the road', 'info', 1400);
  }

  /** Hold R… (Z) to walk backwards through the last ~10 s of snapshots. */
  private beginRewind() {
    if (!this.settings.assist.rewind) return;
    this.rewindHold += 1 / 60;
    if (this.rewindHold < 0.12) return;
    this.rewindHold = 0;
    const frame = this.rewinds.pop();
    if (!frame) return;
    this.player.sim.restoreSnapshot(frame.snap);
    this.player.captureState();
    this.rewinding = true;
  }

  // ------------------------------------------------------------ simulation

  private environment() {
    const w = this.weather.state;
    return {
      gravity: 9.81,
      airDensity: 1.225,
      windX: w.windX,
      windZ: w.windZ,
      wetness: w.wetness,
      ambientTempC: w.temperatureC,
      enableTireTemp: true,
      enableTireWear: this.settings.simulationMode,
    };
  }

  private stepPhysics(dt: number) {
    this.weather.update(dt);
    const env = this.environment();
    const racing = this.state === 'racing';
    const control = toControl(this.raw);

    // Each car resolves its tyres and applies forces; the shared Rapier world is
    // then integrated exactly once, so every body sees the same tick and the
    // order in which cars were processed cannot bias the result.
    this.player.controls = control;
    this.player.sim.step(dt, control, env);
    this.distanceKm += this.player.sim.readout.speedMs * dt / 1000;

    const others = [
      { pos: this.player.position, speed: this.player.sim.readout.speedMs },
      ...this.aiCars.map((c) => ({ pos: c.position, speed: c.sim.readout.speedMs })),
    ];
    for (let i = 0; i < this.aiCars.length; i++) {
      const car = this.aiCars[i];
      const driver = this.aiDrivers[i];
      const aiControl = driver.update(dt, car, this.world, others);
      car.controls = aiControl;
      car.sim.step(dt, aiControl, env);
    }

    for (let i = 0; i < this.traffic.length; i++) {
      const car = this.traffic[i];
      car.controls = this.trafficDrivers[i].update(dt, car, this.world, this.player.position);
      car.sim.step(dt, car.controls, env);
    }

    // Fixed-step integration of every rigid body (cars + terrain colliders are
    // static). `timestep` is set at init to the same FIXED_DT.
    this.world.rapier.step();

    this.player.captureState();
    for (const car of this.aiCars) { car.captureState(); this.recoverActor(car); }
    for (const car of this.traffic) { car.captureState(); this.recoverActor(car); }

    this.world.update(this.player.position, 4);
    this.checkStuckPlayer();

    if (racing && this.race) {
      const actors = new Map<string, VehicleActor>();
      actors.set('player', this.player);
      this.aiCars.forEach((c, i) => actors.set(`ai${i}`, c));
      this.race.update(dt, actors);
      const hud = this.race.hud();
      this.hud.countdown(hud.countdown !== null && hud.countdown > 0 ? String(hud.countdown) : null);
      if (hud.objective) this.hud.subtitle(hud.objective);
      if (this.race.state === 'finished') this.finishEvent();
    } else if (racing && this.challenge) {
      this.challenge.update(dt, this.player);
      this.hud.subtitle(this.challenge.state.message ?? null);
      if (!this.challenge.state.active) this.finishEvent();
    }

    // Rewind ring: 12 Hz for 10 s of history.
    if (!this.rewinding) {
      this.rewindTimer += dt;
      if (this.rewindTimer >= 1 / REWIND_HZ) {
        this.rewindTimer = 0;
        this.rewinds.push({ t: this.player.sim.readout.speedMs, snap: this.player.sim.captureSnapshot() });
        while (this.rewinds.length > REWIND_HZ * REWIND_SECONDS) this.rewinds.shift();
      }
    }
  }

  private recoverActor(car: VehicleActor) {
    const p = car.position;
    if (!Number.isFinite(p.x + p.y + p.z) || p.y < this.world.heightAt(p.x, p.z) - 12) {
      const spawn = this.world.safeRespawn(Number.isFinite(p.x) ? p.x : 0, Number.isFinite(p.z) ? p.z : 0);
      car.place(spawn.x, spawn.y + 0.8, spawn.z, spawn.yaw);
      car.captureState();
    }
  }

  private checkStuckPlayer() {
    const p = this.player.position;
    if (!Number.isFinite(p.x + p.y + p.z)) { this.respawnPlayer(); return; }
    if (p.y < this.world.heightAt(p.x, p.z) - 12) this.respawnPlayer();
  }

  // ---------------------------------------------------------- presentation

  private updatePresentation(dt: number, alpha: number) {
    const info = this.world.roadInfoAt(this.player.position.x, this.player.position.z);
    const roughness = info.roadId ? 0.15 : 0.75;
    if (this.cameraFrozen) return;
    this.camera.update(dt, {
      position: this.player.position,
      quaternion: this.player.quaternion,
      speed: this.player.sim.readout.speedMs,
      forwardSpeed: this.player.sim.readout.forwardSpeedMs,
      surfaceRoughness: roughness,
      drifting: this.player.sim.readout.drifting,
    }, (x, z) => this.world.heightAt(x, z));

    const w = this.weather.state;
    // One wetness value drives the road, terrain, foliage, buildings and paint.
    this.materials.shared.wetness.value = w.wetness;
    this.materials.shared.time.value += dt;
    this.renderer.updateEnvironment({
      sunDir: this.sunDirection(w.hour),
      hour: w.hour,
      weather: w.weather,
      wetness: w.wetness,
      fogDensity: w.fogDensity,
    }, this.camera.camera.position);

    const density = this.settings.particleDensity;
    const camPos = this.camera.camera.position;
    this.player.syncVisuals(dt, alpha, this.player.sim.readout.brake, w.isNight);
    emitVehicleEffects(this.player, dt, this.effectHooks, density, camPos);
    for (const car of this.aiCars) {
      car.syncVisuals(dt, alpha, car.sim.readout.brake, w.isNight);
      emitVehicleEffects(car, dt, this.effectHooks, density * 0.6, camPos);
    }
    for (const car of this.traffic) car.syncVisuals(dt, alpha, car.sim.readout.brake, w.isNight);

    this.smoke?.update(dt);
    this.dust?.update(dt);
    this.sparks?.update(dt);
    this.updateRemoteCars();
    this.career.profile.totalDistanceKm = (this.career.profile.totalDistanceKm ?? 0);
    void this.distanceKm;
  }

  private sunDirection(hour: number) {
    const t = ((hour - 6) / 12) * Math.PI;
    return new THREE.Vector3(Math.cos(t), Math.sin(t), 0.3).normalize();
  }

  /** Heading in degrees clockwise from +Z (the HUD compass bearing). */
  private playerYawDeg() {
    if (!this.player) return 0;
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(this.player.quaternion);
    return ((Math.atan2(forward.x, forward.z) * 180) / Math.PI + 360) % 360;
  }

  private updateRemoteCars() {
    if (!this.net) return;
    for (const [id, state] of this.net.players) {
      let mesh = this.remoteCars.get(id);
      if (!mesh) {
        mesh = this.player.mesh.group.clone(true);
        this.renderer.scene.add(mesh);
        this.remoteCars.set(id, mesh);
      }
      mesh.position.set(state.x, state.y, state.z);
      mesh.quaternion.set(state.qx, state.qy, state.qz, state.qw);
    }
    for (const [id, mesh] of [...this.remoteCars]) {
      if (!this.net.players.has(id)) { this.renderer.scene.remove(mesh); this.remoteCars.delete(id); }
    }
  }

  private updateHud(dt: number) {
    this.netAccum += dt;
    if (this.net && this.netAccum > 1 / 15) {
      this.netAccum = 0;
      const p = this.player.position;
      const q = this.player.quaternion;
      const state: NetPlayerState = { x: p.x, y: p.y, z: p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w, speed: this.player.sim.readout.speedMs };
      this.net.send(this.netAccum + 1 / 15, state);
    }
    this.hudAccum += dt;
    if (this.hudAccum < 1 / 20) return;
    this.hudAccum = 0;
    this.hud.update(this.buildHudState());
    if (this.debugPhysics) this.hud.subtitle(this.physicsDebugText());
  }

  private physicsDebugText() {
    const r = this.player.sim.readout;
    const w = this.player.sim.wheels;
    const load = w.reduce((s, x) => s + x.load, 0) / 9.81;
    return [
      `speed ${r.speedKmh.toFixed(0)} km/h  gear ${r.gear}  rpm ${r.rpm.toFixed(0)}`,
      `load ${load.toFixed(0)} kg  slip ${w.map((x) => x.slipRatio.toFixed(2)).join(' ')}`,
      `y ${this.player.position.y.toFixed(2)}  util ${(r.utilisation * 100).toFixed(0)}%  dmg ${(r.damage.engine * 100).toFixed(0)}%`,
    ].join('   ');
  }

  private buildHudState() {
    const r = this.player?.sim.readout;
    const p = this.player?.position ?? new THREE.Vector3();
    const info = this.world?.roadInfoAt(p.x, p.z);
    const def = this.activeEventId ? EVENT_BY_ID[this.activeEventId] : null;
    const progress = this.race?.progress.get('player');
    const markers: MapMarker[] = EVENTS.map((e) => ({
      x: e.location.x, z: e.location.z, color: '#ffcc44', kind: 'event', label: e.name,
    }));
    markers.push({ x: p.x, z: p.z, color: '#ffffff', kind: 'player', label: 'You' });
    for (const [id, s] of this.net?.players ?? []) markers.push({ x: s.x, z: s.z, color: '#66ddff', kind: 'player2', label: id });
    const surfaceId = info?.roadId ? this.surfaceOfRoad(info.roadId) : 'grass';
    const hudState: HudState = {
      visible: this.hudVisible,
      speed: r?.speedKmh ?? 0,
      gear: r?.gear ?? 1,
      rpm: r?.rpm ?? 0,
      redline: 7400,
      throttle: r?.throttle ?? 0,
      brake: r?.brake ?? 0,
      assists: {
        abs: this.settings.assist.abs,
        tcs: this.settings.assist.tractionControl,
        stm: this.settings.assist.stabilityControl,
        auto: this.settings.assist.autoGears,
      },
      surface: surfaceId,
      weather: this.weather.state.weather,
      clock: this.weather.clockText(),
      position: this.race ? this.race.playerPosition() : null,
      totalRacers: this.race ? this.race.progress.size : 1,
      lap: progress?.lap ?? 1,
      totalLaps: def?.laps ?? 1,
      eventName: def?.name ?? null,
      eventTimer: this.race ? this.race.time : this.challenge ? this.challenge.state.timeLeft : null,
      driftScore: this.challenge ? this.challenge.state.score : 0,
      driftActive: r?.drifting ?? false,
      combo: 1,
      damage: r?.damage.engine ?? 0,
      speedUnit: this.settings.speedUnits,
      bearing: this.playerYawDeg(),
      playerX: p.x,
      playerZ: p.z,
      markers,
      objective: this.challenge ? this.challenge.state.message ?? null : null,
      distanceToNext: progress?.lastDistToGate ?? null,
    };
    return hudState;
  }

  // ---------------------------------------------------------------- network

  connectServer(url: string) {
    if (!url) return;
    this.net?.dispose();
    this.net = new NetClient(url, {
      onStatus: (s) => {
        if (s === 'open') this.hud.toast('Connected to session', 'good');
        else if (s === 'closed') this.hud.toast('Session closed — playing offline', 'bad');
        else if (s === 'error') this.hud.toast('Could not reach the server', 'bad');
      },
      onWelcome: (id, others) => this.hud.toast(`Joined as ${id} · ${others.length + 1} racers`, 'good'),
      onChat: (from, text) => this.hud.toast(`${from}: ${text}`, 'info', 4000),
    });
  }

  saveNow() {
    if (!this.player) return;
    const p = this.player.position;
    this.career.profile.lastPosition = { x: p.x, y: p.y, z: p.z, yaw: (this.playerYawDeg() * Math.PI) / 180 };
    this.career.profile.totalDistanceKm = Math.round(((this.career.profile.totalDistanceKm ?? 0) + this.distanceKm) * 10) / 10;
    this.distanceKm = 0;
    saveProfile(this.career.profile, true);
  }

  dispose() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.net?.dispose();
    this.audio.dispose();
    this.input.detach();
    this.hud.dispose();
    this.world.dispose();
    this.renderer.renderer.dispose();
  }

  // ---- debug surface used by the browser test suite -----------------------
  get debug() {
    return {
      state: this.state,
      playerPosition: this.player?.position,
      speedKmh: this.player?.sim.readout.speedKmh ?? 0,
      surface: this.player?.sim.wheels[0]?.surfaceId ?? '?',
      wheels: this.player?.sim.wheels.map((w) => ({ contact: w.contact, load: w.load, slip: w.slipRatio })),
      race: this.race ? { state: this.race.state, gate: this.race.progress.get('player')?.gate ?? 0, gates: this.race.gateCount } : null,
      world: {
        roads: this.world.field.instances.length,
        chunks: this.world.chunks.size,
        drawCalls: this.renderer.renderer.info.render.calls,
        triangles: this.renderer.renderer.info.render.triangles,
      },
    };
  }

  /** Renderer/lighting state for browser-side diagnostics. */
  debugScene() {
    const sun = this.renderer.sun;
    return {
      shadowMapEnabled: this.renderer.renderer.shadowMap.enabled,
      sunCastShadow: sun.castShadow,
      sunIntensity: +sun.intensity.toFixed(2),
      shadowMapSize: sun.shadow.map ? sun.shadow.map.width : 0,
      shadowCam: {
        left: sun.shadow.camera.left, right: sun.shadow.camera.right,
        near: sun.shadow.camera.near, far: sun.shadow.camera.far,
      },
      sunPos: sun.position.toArray().map((v) => +v.toFixed(1)),
      toneExposure: +this.renderer.renderer.toneMappingExposure.toFixed(2),
    };
  }

  /** Mesh inventory for browser-side diagnostics (used by the visual probes). */
  debugMeshes() {
    const out: {
      material: string;
      map: boolean;
      color?: string;
      verts: number;
      nan: boolean;
      minY: number;
      maxY: number;
      visible: boolean;
    }[] = [];
    this.renderer.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!(mesh as unknown as { isMesh?: boolean }).isMesh || !mesh.material) return;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const pos = mesh.geometry?.attributes?.position;
      let nan = false, minY = Infinity, maxY = -Infinity;
      if (pos) {
        for (let i = 0; i < pos.count; i++) {
          const y = pos.getY(i);
          if (Number.isNaN(y)) { nan = true; break; }
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      out.push({
        material: mat.type + (mat.name ? `:${mat.name}` : ''),
        map: Boolean(mat.map),
        color: mat.color?.getHexString(),
        verts: pos?.count ?? 0,
        nan,
        minY: Number.isFinite(minY) ? +minY.toFixed(1) : 0,
        maxY: Number.isFinite(maxY) ? +maxY.toFixed(1) : 0,
        visible: mesh.visible,
      });
    });
    return out;
  }

  /**
   * Test hook: move the player to the nearest road to (x, z) and run the world
   * streamer long enough to fill the ring, so browser probes can inspect any
   * biome without driving there first.
   */
  debugTeleport(x: number, z: number) {
    const spawn = this.world.safeRespawn(x, z);
    this.player.place(spawn.x, spawn.y + 0.7, spawn.z, spawn.yaw);
    this.player.captureState();
    for (let i = 0; i < 40; i++) this.world.update(this.player.position, 200);
    return { x: spawn.x, y: spawn.y, z: spawn.z };
  }

  /** Prop instance counts for the loaded ring, used to verify scenery coverage. */
  debugProps() {
    const counts: Record<string, number> = {};
    this.renderer.scene.traverse((obj) => {
      const mesh = obj as THREE.InstancedMesh;
      if (!(mesh as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) return;
      const key = mesh.userData.propType ?? mesh.name ?? 'prop';
      counts[key] = (counts[key] ?? 0) + mesh.count;
    });
    return counts;
  }

  /** Live lighting override for visual tuning (probes only, not saved). */
  debugLight(o: { hemi?: number; env?: number; exposure?: number; sun?: number }) {
    const r = this.renderer;
    if (o.hemi !== undefined) r.hemi.intensity = o.hemi;
    if (o.env !== undefined) r.scene.environmentIntensity = o.env;
    if (o.exposure !== undefined) r.renderer.toneMappingExposure = o.exposure;
    if (o.sun !== undefined) r.sun.intensity = o.sun;
    return { hemi: r.hemi.intensity, env: r.scene.environmentIntensity, exposure: r.renderer.toneMappingExposure, sun: r.sun.intensity };
  }

  /** Nearest prop of a given type in the loaded ring (for visual probes). */
  debugNearestProp(type: string) {
    let best: { x: number; y: number; z: number; d: number } | null = null;
    const p = this.player.position;
    this.world.eachProp((prop) => {
      if (prop.type !== type) return;
      const d = Math.hypot(prop.x - p.x, prop.z - p.z);
      if (!best || d < best.d) best = { x: prop.x, y: prop.y, z: prop.z, d };
    });
    return best;
  }

  /** Park the camera at an explicit pose for screenshots (photo-mode style). */
  debugCamera(px: number, py: number, pz: number, tx: number, ty: number, tz: number) {
    this.renderer.camera.position.set(px, py, pz);
    this.renderer.camera.lookAt(tx, ty, tz);
    this.renderer.camera.updateMatrixWorld();
    this.cameraFrozen = true;
  }

  /** Ground-cover telemetry (instance count + rebuild time). */
  debugCover() { return this.world.coverStats(); }

  get hudText() { return (this.hud.root?.innerText ?? '').slice(0, 400); }
  stepPhysicsManual(dt = 1 / 120) { this.stepPhysics(dt); }
  setRawInput(r: Partial<RawInput>) { this.raw = { ...this.raw, ...r }; }
}
