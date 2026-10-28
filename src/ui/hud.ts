import { clamp } from '../core/math';
import type { GameWorld } from '../world/world';

export interface MapMarker {
  x: number; z: number; color: string; kind: 'event' | 'player' | 'house' | 'player2' | 'barn';
  label?: string;
}

export interface HudState {
  visible: boolean;
  speed: number;
  gear: number;
  rpm: number;
  redline: number;
  throttle: number;
  brake: number;
  assists: { abs: boolean; tcs: boolean; stm: boolean; auto: boolean };
  surface: string;
  weather: string;
  clock: string;
  position: number | null;
  totalRacers: number;
  lap: number;
  totalLaps: number;
  eventName: string | null;
  eventTimer: number | null;
  driftScore: number;
  driftActive: boolean;
  combo: number;
  damage: number;
  speedUnit: 'kmh' | 'mph';
  bearing: number;
  playerX: number;
  playerZ: number;
  markers: MapMarker[];
  objective: string | null;
  distanceToNext: number | null;
}

const TEMPLATE = `
<div class="hud-top-left">
  <div class="hud-chip" id="hud-event"><b>Free Roam</b><span id="hud-event-sub">Festival Hub</span></div>
  <div class="hud-chip" id="hud-objective" hidden><span id="hud-objective-text"></span></div>
</div>
<div class="hud-top-right">
  <canvas id="minimap" width="420" height="420"></canvas>
  <div class="hud-weather"><span class="clock" id="hud-clock">09:30</span><span id="hud-weather">Clear</span><span id="hud-surface">Asphalt</span></div>
</div>
<div class="race-hud" id="hud-race" hidden>
  <div class="item"><div class="k">POSITION</div><div class="v" id="hud-pos">1/8</div></div>
  <div class="item"><div class="k">LAP</div><div class="v" id="hud-lap">1/2</div></div>
  <div class="item"><div class="k">TIME</div><div class="v" id="hud-time">0:00.0</div></div>
</div>
<div class="hud-bottom-left">
  <div class="damage-row" id="hud-damage" hidden></div>
  <div class="assist-row">
    <span class="assist" id="assist-abs">ABS</span>
    <span class="assist" id="assist-tcs">TCS</span>
    <span class="assist" id="assist-stm">STM</span>
    <span class="assist" id="assist-auto">AUTO</span>
  </div>
</div>
<div class="speedo">
  <div class="gear" id="hud-gear">1</div>
  <div class="value" id="hud-speed">0</div>
  <div class="unit" id="hud-unit">KM/H</div>
  <div class="rpm-bar"><div class="rpm-fill" id="hud-rpm"></div></div>
</div>
<div class="hud-center" id="hud-center"></div>
<div class="toast-host" id="hud-toasts"></div>
<div class="subtitles" id="hud-subtitle" hidden></div>
`;

export class Hud {
  root: HTMLDivElement;
  private el: Record<string, HTMLElement> = {};
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private markers: MapMarker[] = [];
  private minimapRange = 320;

  constructor(host: HTMLElement, private world: GameWorld) {
    this.root = document.createElement('div');
    this.root.className = 'hud hidden';
    this.root.innerHTML = TEMPLATE;
    host.appendChild(this.root);
    this.root.querySelectorAll('[id]').forEach((node) => {
      this.el[node.id] = node as HTMLElement;
    });
    this.canvas = this.el['minimap'] as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    this.buildStaticMap();
  }

  /** Pre-render the whole road network once into an offscreen canvas. */
  private mapCache: HTMLCanvasElement | null = null;
  private mapCacheScale = 0;
  private buildStaticMap() {
    const size = 2048;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d')!;
    const worldSize = 4096;
    const scale = size / worldSize;
    ctx.clearRect(0, 0, size, size);
    for (const inst of this.world.field.instances) {
      ctx.beginPath();
      const isDirt = inst.def.surface !== 'asphaltDry';
      ctx.strokeStyle = isDirt ? 'rgba(196,168,116,0.75)' : 'rgba(150,168,188,0.85)';
      ctx.lineWidth = isDirt ? 3.2 : Math.max(3, inst.def.width * scale * 1.3);
      ctx.lineCap = 'round';
      inst.samples.forEach((s, i) => {
        const px = (s.x + worldSize / 2) * scale;
        const py = (s.z + worldSize / 2) * scale;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }
    this.mapCache = c;
    this.mapCacheScale = scale;
  }

  setMarkers(m: MapMarker[]) { this.markers = m; }

  show(v: boolean) { this.root.classList.toggle('hidden', !v); }

  toast(text: string, kind: 'info' | 'good' | 'bad' = 'info', ms = 2600) {
    const host = this.el['hud-toasts'];
    const div = document.createElement('div');
    div.className = `toast ${kind}`;
    div.textContent = text;
    host.appendChild(div);
    setTimeout(() => { div.style.opacity = '0'; div.style.transition = 'opacity .4s'; }, ms);
    setTimeout(() => div.remove(), ms + 460);
    while (host.children.length > 4) host.removeChild(host.firstChild!);
  }

  subtitle(text: string | null) {
    const el = this.el['hud-subtitle'];
    if (!text) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = text;
  }

  countdown(text: string | null) {
    const el = this.el['hud-center'];
    el.textContent = text ?? '';
  }

  update(s: HudState) {
    this.show(s.visible);
    if (!s.visible) return;
    const speedVal = s.speedUnit === 'kmh' ? s.speed : s.speed * 0.621371;
    this.el['hud-speed'].textContent = String(Math.round(speedVal));
    this.el['hud-unit'].textContent = s.speedUnit === 'kmh' ? 'KM/H' : 'MPH';
    this.el['hud-gear'].textContent = s.gear === 0 ? 'N' : s.gear < 0 ? 'R' : String(s.gear);
    const rpmFrac = clamp(s.rpm / s.redline, 0, 1.05);
    this.el['hud-rpm'].style.width = `${Math.min(100, rpmFrac * 100)}%`;
    this.el['hud-clock'].textContent = s.clock;
    this.el['hud-weather'].textContent = s.weather;
    this.el['hud-surface'].textContent = s.surface;

    const setChip = (id: string, on: boolean) => this.el[id].classList.toggle('on', on);
    setChip('assist-abs', s.assists.abs);
    setChip('assist-tcs', s.assists.tcs);
    setChip('assist-stm', s.assists.stm);
    setChip('assist-auto', s.assists.auto);

    const raceHud = this.el['hud-race'];
    const showRace = s.position !== null;
    raceHud.hidden = !showRace;
    if (showRace) {
      this.el['hud-pos'].textContent = `${s.position}/${s.totalRacers}`;
      this.el['hud-lap'].textContent = s.totalLaps > 0 ? `${Math.min(s.lap, s.totalLaps)}/${s.totalLaps}` : '—';
      this.el['hud-time'].textContent = s.eventTimer !== null ? formatTime(s.eventTimer) : '—';
    }
    const eventChip = this.el['hud-event'];
    (eventChip.querySelector('b') as HTMLElement).textContent = s.eventName ?? 'Free Roam';
    const objective = this.el['hud-objective'];
    objective.hidden = !s.objective;
    if (s.objective) this.el['hud-objective-text'].textContent = s.objective;

    const dmg = this.el['hud-damage'];
    if (s.damage > 0.02) {
      dmg.hidden = false;
      dmg.innerHTML = `<span class="damage">DAMAGE ${Math.round(s.damage * 100)}%</span>`;
    } else dmg.hidden = true;

    this.drawMinimap(s);
  }

  private drawMinimap(s: HudState) {
    const ctx = this.ctx;
    const size = this.canvas.width;
    const half = size / 2;
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    // circular clip
    ctx.beginPath();
    ctx.arc(half, half, half - 6, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(10,16,22,0.92)';
    ctx.fillRect(0, 0, size, size);

    const zoom = half / this.minimapRange;
    ctx.translate(half, half);
    ctx.rotate(-s.bearing + Math.PI);
    ctx.translate(-s.playerX * zoom, -s.playerZ * zoom);

    // The cached map is drawn in world space, so it simply scales with the zoom.
    if (this.mapCache) {
      const worldSize = 4096;
      ctx.globalAlpha = 0.95;
      ctx.drawImage(this.mapCache, -worldSize / 2 * zoom, -worldSize / 2 * zoom, worldSize * zoom, worldSize * zoom);
    }

    // Markers
    for (const m of this.markers) {
      const px = m.x * zoom, py = m.z * zoom;
      ctx.beginPath();
      const r = m.kind === 'event' ? 7 : 5;
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = m.color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Player arrow
    ctx.beginPath();
    ctx.moveTo(0, -13);
    ctx.lineTo(9, 10);
    ctx.lineTo(0, 5);
    ctx.lineTo(-9, 10);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.6)';
    ctx.lineWidth = 2;
    ctx.stroke();
    // Heading cone
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 34, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fill();
    ctx.restore();

    // North indicator
    ctx.save();
    ctx.translate(half, half);
    ctx.rotate(-s.bearing);
    ctx.fillStyle = 'rgba(255,138,31,0.9)';
    ctx.font = 'bold 22px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', 0, -half + 32);
    ctx.restore();
  }

  dispose() { this.root.remove(); }
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
