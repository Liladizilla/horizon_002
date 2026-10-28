import * as THREE from 'three';
import type { VehicleSpec } from '../vehicles/spec';

/**
 * All audio is synthesised at runtime with the Web Audio API - no recordings are
 * shipped, so nothing here is a sample of a real car. Engine notes are built
 * from detuned sawtooths at the firing frequency plus intake noise, tyre squeal
 * from band-passed noise, wind from low-passed noise.
 */

export type StationId = 'horizon-fm' | 'neon-wave' | 'sunset-rock' | 'classic-hall' | 'off';

export interface StationDef {
  id: StationId;
  name: string;
  genre: string;
  tempo: number;
  scale: number[];
  root: number;
  wave: OscillatorType;
  dj: string;
}

export const STATIONS: StationDef[] = [
  { id: 'horizon-fm', name: 'Horizon FM', genre: 'Festival House', tempo: 124, scale: [0, 2, 3, 5, 7, 8, 10], root: 220, wave: 'sawtooth', dj: 'DJ Marisol' },
  { id: 'neon-wave', name: 'Neon Wave', genre: 'Synthwave', tempo: 104, scale: [0, 2, 3, 7, 8], root: 165, wave: 'square', dj: 'Vega' },
  { id: 'sunset-rock', name: 'Sunset Rock', genre: 'Garage Rock', tempo: 138, scale: [0, 3, 5, 7, 10], root: 147, wave: 'sawtooth', dj: 'Hollis' },
  { id: 'classic-hall', name: 'Classic Hall', genre: 'Orchestral', tempo: 76, scale: [0, 2, 4, 5, 7, 9, 11], root: 131, wave: 'triangle', dj: 'Ana' },
  { id: 'off', name: 'Radio Off', genre: '', tempo: 0, scale: [0], root: 220, wave: 'sine', dj: '' },
];

export interface AudioVolumes {
  master: number; engine: number; sfx: number; music: number; ui: number;
}

export class AudioSystem {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private engineBus!: GainNode;
  private sfxBus!: GainNode;
  private musicBus!: GainNode;
  private uiBus!: GainNode;
  private noiseBuffer!: AudioBuffer;
  private volumes: AudioVolumes = { master: 0.9, engine: 0.8, sfx: 0.8, music: 0.55, ui: 0.7 };
  started = false;
  station: StationId = 'horizon-fm';
  radioEnabled = true;
  private radioTimer: number | null = null;
  private radioStep = 0;
  private nextNoteTime = 0;
  radioTitle = '';

  /** Must be called from a user gesture. Safe to call repeatedly. */
  async start(): Promise<void> {
    if (this.started) { await this.ctx?.resume(); return; }
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    await this.ctx.resume();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.engineBus = this.ctx.createGain();
    this.sfxBus = this.ctx.createGain();
    this.musicBus = this.ctx.createGain();
    this.uiBus = this.ctx.createGain();
    for (const bus of [this.engineBus, this.sfxBus, this.musicBus, this.uiBus]) bus.connect(this.master);
    this.applyVolumes();

    // 2 s of white noise reused by every noise-based voice.
    const len = this.ctx.sampleRate * 2;
    this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.started = true;
    this.startRadio(this.station);
  }

  dispose() {
    if (this.radioTimer !== null) { clearInterval(this.radioTimer); this.radioTimer = null; }
    try { void this.ctx?.close(); } catch { /* already closed */ }
    this.ctx = null;
    this.started = false;
  }

  applyVolumes(v?: Partial<AudioVolumes>) {
    if (v) this.volumes = { ...this.volumes, ...v };
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.volumes.master, t, 0.05);
    this.engineBus.gain.setTargetAtTime(this.volumes.engine, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(this.volumes.sfx, t, 0.05);
    this.musicBus.gain.setTargetAtTime(this.radioEnabled ? this.volumes.music : 0, t, 0.1);
    this.uiBus.gain.setTargetAtTime(this.volumes.ui, t, 0.05);
  }

  get buses() { return { engine: this.engineBus, sfx: this.sfxBus, music: this.musicBus, ui: this.uiBus }; }
  get noise() { return this.noiseBuffer; }

  // ---------------------------------------------------------------- engine
  createVehicleAudio(spec: VehicleSpec): VehicleAudio {
    return new VehicleAudio(this, spec);
  }

  // ------------------------------------------------------------------- sfx
  playImpact(intensity: number, pan = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = 0.7 + Math.random() * 0.5;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900 + intensity * 1800;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(Math.min(0.9, 0.15 + intensity), t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35 + intensity * 0.3);
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    src.connect(filter).connect(gain).connect(panner).connect(this.sfxBus);
    src.start(t);
    src.stop(t + 0.8);
  }

  playScrape(pan = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 2400;
    filter.Q.value = 2;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0, t);
    gain.gain.linearRampToValueAtTime(0.14, t + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    src.connect(filter).connect(gain).connect(panner).connect(this.sfxBus);
    src.start(t);
    src.stop(t + 0.5);
  }

  playUi(kind: 'click' | 'confirm' | 'back' | 'reward' = 'click') {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const freqs = { click: 660, confirm: 880, back: 320, reward: 1040 };
    osc.type = kind === 'reward' ? 'triangle' : 'sine';
    osc.frequency.setValueAtTime(freqs[kind], t);
    if (kind === 'confirm' || kind === 'reward') osc.frequency.exponentialRampToValueAtTime(freqs[kind] * 1.6, t + 0.08);
    gain.gain.setValueAtTime(0.18, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + (kind === 'reward' ? 0.45 : 0.12));
    osc.connect(gain).connect(this.uiBus);
    osc.start(t);
    osc.stop(t + 0.5);
  }

  // ----------------------------------------------------------------- radio
  startRadio(station: StationId) {
    this.station = station;
    if (!this.ctx) return;
    if (this.radioTimer !== null) { window.clearInterval(this.radioTimer); this.radioTimer = null; }
    const def = STATIONS.find((s) => s.id === station);
    if (!def || station === 'off') { this.radioTitle = ''; return; }
    this.radioStep = 0;
    this.nextNoteTime = this.ctx.currentTime + 0.1;
    this.radioTimer = window.setInterval(() => this.scheduleRadio(), 120);
    this.radioTitle = `${def.genre} — original procedural session`;
  }

  private scheduleRadio() {
    const ctx = this.ctx;
    if (!ctx) return;
    const def = STATIONS.find((s) => s.id === this.station);
    if (!def || def.id === 'off') return;
    const stepDur = 60 / def.tempo / 2;
    while (this.nextNoteTime < ctx.currentTime + 0.4) {
      this.playStep(def, this.radioStep, this.nextNoteTime, stepDur);
      this.radioStep++;
      this.nextNoteTime += stepDur;
    }
  }

  /** One 8th-note of an original procedural pattern for the current station. */
  private playStep(def: StationDef, step: number, time: number, stepDur: number) {
    const ctx = this.ctx!;
    const bar = Math.floor(step / 8) % 4;
    const inBar = step % 8;
    const degree = def.scale[(inBar + bar * 2) % def.scale.length];
    const notes = def.id === 'classic-hall' ? [0, 4, 7] : [0, 2, 4];
    if (def.id === 'classic-hall') {
      if (inBar % 4 !== 0) return;
    }
    const noteCount = def.id === 'sunset-rock' && inBar === 0 ? 3 : 1;
    for (let n = 0; n < noteCount; n++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = def.id === 'neon-wave' ? 1800 : 3200;
      osc.type = def.wave;
      const octave = (notes[n] ?? 0) / 12;
      const freq = def.root * Math.pow(2, degree / 12 + octave) * (bar === 3 ? 1.5 : 1);
      osc.frequency.setValueAtTime(freq, time);
      if (def.id === 'neon-wave') osc.detune.setValueAtTime((n - 1) * 6, time);
      const peak = def.id === 'classic-hall' ? 0.09 : def.id === 'sunset-rock' ? 0.11 : 0.075;
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.exponentialRampToValueAtTime(peak, time + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + stepDur * (def.id === 'classic-hall' ? 3.6 : 1.35));
      osc.connect(filter).connect(gain).connect(this.musicBus);
      osc.start(time);
      osc.stop(time + stepDur * 4);
    }
    // Kick + hat for the electronic stations
    if (def.id === 'horizon-fm' || def.id === 'neon-wave' || def.id === 'sunset-rock') {
      if (inBar === 0 || inBar === 4) {
        const kick = ctx.createOscillator();
        const kg = ctx.createGain();
        kick.type = 'sine';
        kick.frequency.setValueAtTime(140, time);
        kick.frequency.exponentialRampToValueAtTime(48, time + 0.12);
        kg.gain.setValueAtTime(0.22, time);
        kg.gain.exponentialRampToValueAtTime(0.001, time + 0.24);
        kick.connect(kg).connect(this.musicBus);
        kick.start(time); kick.stop(time + 0.3);
      }
      if (inBar % 2 === 1) {
        const hat = ctx.createBufferSource();
        hat.buffer = this.noiseBuffer;
        const hf = ctx.createBiquadFilter();
        hf.type = 'highpass';
        hf.frequency.value = 7000;
        const hg = ctx.createGain();
        hg.gain.setValueAtTime(0.05, time);
        hg.gain.exponentialRampToValueAtTime(0.001, time + 0.06);
        hat.connect(hf).connect(hg).connect(this.musicBus);
        hat.start(time); hat.stop(time + 0.08);
      }
    }
  }

  suspend() { void this.ctx?.suspend(); }
  resume() { void this.ctx?.resume(); }
}

/** Per-vehicle engine, tyre, wind and road-noise voice. */
export class VehicleAudio {
  private ctx!: AudioContext | null;
  private osc1!: OscillatorNode;
  private osc2!: OscillatorNode;
  private osc3!: OscillatorNode;
  private engineGain!: GainNode;
  private engineFilter!: BiquadFilterNode;
  private shaper!: WaveShaperNode;
  private intakeGain!: GainNode;
  private tyreGain!: GainNode;
  private tyreFilter!: BiquadFilterNode;
  private windGain!: GainNode;
  private panner!: StereoPannerNode;
  private noiseSource!: AudioBufferSourceNode;
  spec: VehicleSpec;
  private baseFreq!: number;

  private system: AudioSystem;
  private built = false;

  constructor(system: AudioSystem, spec: VehicleSpec) {
    this.system = system;
    this.spec = spec;
    this.ctx = system.ctx ?? null;
    this.baseFreq = spec.engine.redlineRpm / 60 * 2; // ~firing frequency scale
    // The Web Audio graph is built lazily: browsers refuse to create an
    // AudioContext before a user gesture, but cars exist from the first frame.
    if (this.ctx) this.build();
  }

  /** Builds the voice once a live AudioContext exists. Safe to call repeatedly. */
  build() {
    if (this.built) return;
    const ctx = this.system.ctx;
    if (!ctx) return;
    this.ctx = ctx;
    this.built = true;
    const spec = this.spec;
    this.panner = ctx.createStereoPanner();
    this.panner.connect(this.system.buses.engine);
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 900;
    this.shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 2.2);
    }
    this.shaper.curve = curve;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.osc1 = ctx.createOscillator();
    this.osc1.type = spec.drivetrain === 'AWD' ? 'sawtooth' : 'sawtooth';
    this.osc2 = ctx.createOscillator();
    this.osc2.type = 'square';
    this.osc3 = ctx.createOscillator();
    this.osc3.type = 'triangle';
    const g1 = ctx.createGain(); g1.gain.value = 0.5;
    const g2 = ctx.createGain(); g2.gain.value = 0.22;
    const g3 = ctx.createGain(); g3.gain.value = 0.3;
    this.osc1.connect(g1).connect(this.engineFilter);
    this.osc2.connect(g2).connect(this.engineFilter);
    this.osc3.connect(g3).connect(this.engineFilter);
    this.engineFilter.connect(this.shaper).connect(this.engineGain).connect(this.panner);
    this.osc1.start(); this.osc2.start(); this.osc3.start();

    // intake / exhaust noise
    const intake = ctx.createBufferSource();
    intake.buffer = this.system.noise;
    intake.loop = true;
    const intakeFilter = ctx.createBiquadFilter();
    intakeFilter.type = 'bandpass';
    intakeFilter.frequency.value = 1100;
    intakeFilter.Q.value = 0.8;
    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0;
    intake.connect(intakeFilter).connect(this.intakeGain).connect(this.panner);
    intake.start();
    this.noiseSource = intake;

    // tyre squeal
    const tyre = ctx.createBufferSource();
    tyre.buffer = this.system.noise;
    tyre.loop = true;
    this.tyreFilter = ctx.createBiquadFilter();
    this.tyreFilter.type = 'bandpass';
    this.tyreFilter.frequency.value = 1900;
    this.tyreFilter.Q.value = 6;
    this.tyreGain = ctx.createGain();
    this.tyreGain.gain.value = 0;
    tyre.connect(this.tyreFilter).connect(this.tyreGain).connect(this.panner);
    tyre.start();

    // wind
    const wind = ctx.createBufferSource();
    wind.buffer = this.system.noise;
    wind.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 620;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    wind.connect(windFilter).connect(this.windGain).connect(this.panner);
    wind.start();
  }

  update(state: {
    rpm: number; throttle: number; speed: number; slip: number; redline: number;
    distance: number; pan: number; interior: boolean; gear: number; limiter: boolean; surfaceGrip: number;
  }) {
    if (!this.built) this.build();
    const ctx = this.ctx;
    if (!ctx || !this.built) return;
    const t = ctx.currentTime;
    const { rpm, throttle, speed, slip, redline, distance, pan, interior } = state;
    const rpmFrac = Math.min(1.15, rpm / Math.max(1, redline));
    const firingFreq = Math.max(18, (rpm / 60) * (this.spec.engine.redlineRpm > 8000 ? 3 : 2) + 8);
    this.osc1.frequency.setTargetAtTime(firingFreq, t, 0.03);
    this.osc2.frequency.setTargetAtTime(firingFreq * 2.01, t, 0.03);
    this.osc3.frequency.setTargetAtTime(firingFreq * 0.5, t, 0.03);
    this.engineFilter.frequency.setTargetAtTime(420 + throttle * 2200 + rpmFrac * 1700, t, 0.05);

    // Distance attenuation and stereo placement (cheap spatialisation).
    const atten = 1 / (1 + (distance / 14) ** 2);
    const engineLevel = (0.16 + throttle * 0.5 + rpmFrac * 0.18) * atten * (interior ? 0.45 : 1);
    this.engineGain.gain.setTargetAtTime(Math.min(0.55, engineLevel), t, 0.04);
    this.intakeGain.gain.setTargetAtTime(Math.min(0.16, throttle * 0.18 * atten), t, 0.06);
    this.tyreGain.gain.setTargetAtTime(Math.min(0.3, slip * 0.22 * atten), t, 0.05);
    this.tyreFilter.frequency.setTargetAtTime(1500 + slip * 1400, t, 0.06);
    this.windGain.gain.setTargetAtTime(Math.min(0.22, (speed / 70) ** 2 * 0.16 * atten), t, 0.1);
    this.panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), t, 0.05);
  }

  setVolume(v: number) {
    if (!this.ctx || !this.built) return;
    this.engineGain.gain.setTargetAtTime(v * 0.4, this.ctx.currentTime, 0.1);
  }

  dispose() {
    if (!this.built) return;
    try {
      this.osc1.stop(); this.osc2.stop(); this.osc3.stop(); this.noiseSource.stop();
      this.panner.disconnect();
    } catch { /* already stopped */ }
  }
}

/** Helper: compute distance + pan for a world position relative to a listener. */
export function spatialise(pos: THREE.Vector3, listenerPos: THREE.Vector3, listenerQuat: THREE.Quaternion) {
  const rel = pos.clone().sub(listenerPos);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(listenerQuat);
  const distance = rel.length();
  const pan = distance > 0.5 ? rel.clone().normalize().dot(right) : 0;
  return { distance, pan };
}
