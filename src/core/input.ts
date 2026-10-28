import { clamp, damp, DEG } from './math';
import { NEUTRAL_CONTROL, type CarControl } from './types';

export type KeyBindings = Record<string, string>;

export const DEFAULT_BINDINGS: KeyBindings = {
  throttle: 'KeyW', brake: 'KeyS', left: 'KeyA', right: 'KeyD',
  handbrake: 'Space', shiftUp: 'KeyE', shiftDown: 'KeyQ',
  camera: 'KeyC', reset: 'KeyR', rewind: 'KeyZ', map: 'KeyM',
  pause: 'Escape', photo: 'KeyP', horn: 'KeyH', radio: 'KeyN', hud: 'KeyU',
};

export interface RawInput {
  throttle: number; brake: number; steer: number; handbrake: number;
  shiftUp: boolean; shiftDown: boolean;
}

/**
 * Aggregates keyboard, gamepad and touch into one analogue input state.
 * Steering is smoothed here (not in physics) and physics runs on a fixed tick
 * with the latest sampled values, so frame-rate does not change handing.
 */
export class InputManager {
  private keys = new Set<string>();
  private prevKeys = new Set<string>();
  private gamepadIndex: number | null = null;
  private bindings: KeyBindings = { ...DEFAULT_BINDINGS };
  private steerSmooth = 0;
  private steerSensitivity = 1;
  private deadzone = 0.12;
  private touch: { steer: number; throttle: number; brake: number; handbrake: boolean } = { steer: 0, throttle: 0, brake: 0, handbrake: false };
  private rumbleUntil = 0;
  private rumbleStrength = 0;

  actions: Record<string, boolean> = {};
  private actionsPrev: Record<string, boolean> = {};
  usingGamepad = false;
  usingTouch = false;

  private onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    this.keys.add(e.code);
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab'].includes(e.code)) e.preventDefault();
  };
  private onKeyUp = (e: KeyboardEvent) => { this.keys.delete(e.code); };
  private onBlur = () => { this.keys.clear(); };
  private onGamepadConnected = (e: GamepadEvent) => { this.gamepadIndex = e.gamepad.index; };

  attach(target: Window = window) {
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.onBlur);
    window.addEventListener('gamepadconnected', this.onGamepadConnected);
    window.addEventListener('gamepaddisconnected', () => { this.gamepadIndex = null; });
    // Browsers only expose pads after a button press; poll lazily.
  }

  /** Removes every listener the manager installed on `window`. */
  detach(target: Window = window) {
    target.removeEventListener('keydown', this.onKeyDown);
    target.removeEventListener('keyup', this.onKeyUp);
    target.removeEventListener('blur', this.onBlur);
    window.removeEventListener('gamepadconnected', this.onGamepadConnected);
    this.keys.clear();
  }

  setBindings(b: KeyBindings) { this.bindings = { ...DEFAULT_BINDINGS, ...b }; }
  setGamepadOptions(deadzone: number, sensitivity: number) { this.deadzone = deadzone; this.steerSensitivity = sensitivity; }

  setTouch(t: Partial<{ steer: number; throttle: number; brake: number; handbrake: boolean }>) {
    Object.assign(this.touch, t);
    this.usingTouch = true;
  }

  private key(name: keyof typeof DEFAULT_BINDINGS): boolean {
    return this.keys.has(this.bindings[name]);
  }
  private pressed(name: keyof typeof DEFAULT_BINDINGS): boolean {
    const code = this.bindings[name];
    return this.keys.has(code) && !this.prevKeys.has(code);
  }
  private action(name: string): boolean {
    return this.actions[name] === true;
  }
  private actionPressed(name: string): boolean {
    return this.actions[name] === true && this.actionsPrev[name] !== true;
  }

  /** Call once per rendered frame, before physics steps, to sample devices. */
  sample(dt: number): RawInput {
    this.prevKeys = new Set(this.keys);

    let throttle = 0, brake = 0, steerTarget = 0, handbrake = 0;
    let shiftUp = false, shiftDown = false;
    let padSteer = 0;
    let padThrottle = 0, padBrake = 0;

    // --- Gamepad -------------------------------------------------------
    this.usingGamepad = false;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad: Gamepad | null = null;
    for (const p of pads) { if (p && p.connected) { pad = p; break; } }
    if (pad) {
      const dz = (v: number) => (Math.abs(v) < this.deadzone ? 0 : (v - Math.sign(v) * this.deadzone) / (1 - this.deadzone));
      const axes = pad.axes;
      padSteer = dz(axes[0] ?? 0);
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      padThrottle = clamp(dz(rt), 0, 1);
      padBrake = clamp(dz(lt), 0, 1);
      if (pad.buttons[0]?.pressed) padBrake = Math.max(padBrake, 0.35); // A = brake fallback
      if (pad.buttons[1]?.pressed) handbrake = 1;
      shiftUp = !!(pad.buttons[5]?.pressed && this.gamepadBtnPrev(pad.index, 5) === false);
      shiftDown = !!(pad.buttons[4]?.pressed && this.gamepadBtnPrev(pad.index, 4) === false);
      if (padSteer !== 0 || padThrottle > 0 || padBrake > 0) this.usingGamepad = true;
      this.rememberGamepadButtons(pad);
      // L3 click = camera, Start = pause, Select = map
      this.setPadAction('camera', !!pad.buttons[10]?.pressed);
      this.setPadAction('pause', !!pad.buttons[9]?.pressed);
      this.setPadAction('map', !!pad.buttons[8]?.pressed);
      this.setPadAction('reset', !!pad.buttons[3]?.pressed);
      this.setPadAction('rewind', !!pad.buttons[2]?.pressed);
      this.setPadAction('photo', !!(pad.buttons[12]?.pressed && pad.buttons[13]?.pressed));
    } else {
      this.setPadAction('camera', false); this.setPadAction('pause', false); this.setPadAction('map', false);
      this.setPadAction('reset', false); this.setPadAction('rewind', false); this.setPadAction('photo', false);
    }

    // --- Keyboard ------------------------------------------------------
    const keyValues = (v: boolean) => (v ? 1 : 0);
    throttle = Math.max(keyValues(this.key('throttle')), padThrottle, this.touch.throttle);
    brake = Math.max(keyValues(this.key('brake')), padBrake, this.touch.brake);
    handbrake = Math.max(keyValues(this.key('handbrake')), handbrake, this.touch.handbrake ? 1 : 0);
    const keySteer = keyValues(this.key('right')) - keyValues(this.key('left'));
    steerTarget = clamp(Math.abs(padSteer) > 0.02 ? padSteer : keySteer + this.touch.steer, -1, 1);
    shiftUp = shiftUp || this.pressed('shiftUp');
    shiftDown = shiftDown || this.pressed('shiftDown');

    // Steering smoothing: faster return-to-centre than wind-on, like a real rack.
    const attacking = Math.sign(steerTarget) === Math.sign(this.steerSmooth) || this.steerSmooth === 0;
    const rate = (Math.abs(steerTarget) > Math.abs(this.steerSmooth) ? (attacking ? 9.0 : 7.0) : 12.0) * this.steerSensitivity;
    this.steerSmooth = damp(this.steerSmooth, steerTarget, rate, dt);
    if (Math.abs(this.steerSmooth) < 0.002) this.steerSmooth = 0;

    // Discrete actions for UI / camera etc.
    const actions: Record<string, boolean> = {
      camera: this.key('camera') || this.action('camera'),
      reset: this.key('reset') || this.action('reset'),
      rewind: this.key('rewind') || this.action('rewind'),
      map: this.key('map') || this.action('map'),
      pause: this.key('pause') || this.action('pause'),
      photo: this.key('photo') || this.action('photo'),
      horn: this.key('horn'),
      radio: this.key('radio'),
      hud: this.key('hud'),
    };
    // Edge detection for actions is consumed via `justPressed` before this overwrite.
    this.actionsPrev = { ...this.actions };
    this.actions = actions;

    return { throttle, brake, steer: this.steerSmooth, handbrake, shiftUp, shiftDown };
  }

  private padButtonsPrev = new Map<number, boolean[]>();
  private gamepadBtnPrev(index: number, btn: number): boolean {
    return this.padButtonsPrev.get(index)?.[btn] === true;
  }
  private rememberGamepadButtons(pad: Gamepad) {
    this.padButtonsPrev.set(pad.index, pad.buttons.map((b) => b.pressed));
  }
  private padActions: Record<string, boolean> = {};
  private setPadAction(name: string, value: boolean) { this.padActions[name] = value; }

  justPressed(name: string): boolean {
    return (this.actions[name] === true && this.actionsPrev[name] !== true);
  }
  isDown(name: string): boolean { return this.actions[name] === true; }
  /** Menu navigation helpers (keyboard + d-pad + stick). */
  menuAxis(): { x: number; y: number } {
    const pad = navigator.getGamepads ? Array.from(navigator.getGamepads()).find((p) => p?.connected) : null;
    let x = this.key('right') ? 1 : this.key('left') ? -1 : 0;
    let y = this.key('brake') ? 1 : this.key('throttle') ? -1 : 0;
    if (pad) {
      const ax = pad.axes[0] ?? 0, ay = pad.axes[1] ?? 0;
      if (Math.abs(ax) > 0.5) x = Math.sign(ax);
      if (Math.abs(ay) > 0.5) y = Math.sign(ay);
      if (pad.buttons[15]?.pressed) x = 1;
      if (pad.buttons[14]?.pressed) x = -1;
      if (pad.buttons[13]?.pressed) y = 1;
      if (pad.buttons[12]?.pressed) y = -1;
    }
    return { x, y };
  }
  confirmPressed(): boolean {
    if (this.pressed('throttle')) return true;
    const pad = navigator.getGamepads ? Array.from(navigator.getGamepads()).find((p) => p?.connected) : null;
    if (pad && pad.buttons[0]?.pressed && !this.gamepadBtnPrev(pad.index, 0)) return true;
    return false;
  }

  rumble(strength: number, durationMs: number) {
    const pad = navigator.getGamepads ? Array.from(navigator.getGamepads()).find((p) => p?.connected) : null;
    if (!pad || !pad.vibrationActuator) return;
    try {
      pad.vibrationActuator.playEffect('dual-rumble', { duration: durationMs, strongMagnitude: clamp(strength, 0, 1), weakMagnitude: clamp(strength * 0.6, 0, 1) });
    } catch { /* rumble is best-effort */ }
  }
}

export function toControl(raw: RawInput): CarControl {
  return { throttle: raw.throttle, brake: raw.brake, steer: raw.steer, handbrake: raw.handbrake, shiftUp: raw.shiftUp, shiftDown: raw.shiftDown };
}
export { NEUTRAL_CONTROL, DEG };
