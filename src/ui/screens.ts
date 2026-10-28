import { EVENTS, EVENT_BY_ID, type EventDef } from '../data/events';
import { CARS, getCar } from '../data/cars';
import type { Career } from '../gameplay/career';
import type { GameSettings } from '../core/settings';
import { DIFFICULTY_PRESETS, QUALITY_PRESETS } from '../core/settings';
import type { GameWorld } from '../world/world';
import { UPGRADE_COSTS } from '../vehicles/tuning';
import { formatTime } from './hud';
import { STATIONS } from '../audio/audio';
import { clamp } from '../core/math';

export type ScreenName = 'none' | 'menu' | 'pause' | 'events' | 'garage' | 'map' | 'settings' | 'help' | 'results' | 'wheelspin' | 'photo';

export interface ResultsData {
  eventName: string;
  position: number;
  total: number;
  time: number;
  best: number | null;
  credits: number;
  xp: number;
  placements: { name: string; time: number; isPlayer: boolean }[];
}

export interface UIContext {
  career: Career;
  settings: GameSettings;
  world: GameWorld;
  playerPosition: { x: number; z: number; yaw: number };
  activeCarId: string;
  applySettings(s: GameSettings): void;
  resume(): void;
  quitToMenu(): void;
  startEvent(eventId: string): void;
  retryEvent(): void;
  fastTravel(x: number, z: number): void;
  changeCar(carId: string): void;
  setPhotoMode(on: boolean): void;
  capturePhoto(): void;
  openRadio(station: string): void;
  audioClick(kind: 'click' | 'confirm' | 'back' | 'reward'): void;
  rewardsPreview(): ResultsData | null;
  toast(msg: string, kind?: 'info' | 'good' | 'bad'): void;
}

const KEY_HELP: [string, string][] = [
  ['W / ↑', 'Throttle'], ['S / ↓', 'Brake & reverse'], ['A D / ← →', 'Steer'],
  ['Space', 'Handbrake'], ['Shift', 'Boost-less upshift (manual)'], ['E / Q', 'Shift up / down'],
  ['C', 'Cycle camera'], ['R', 'Reset car to road'], ['Z', 'Rewind (hold)'], ['M', 'World map'],
  ['Esc', 'Pause'], ['P', 'Photo mode'], ['N', 'Change radio station'], ['H', 'Horn'], ['U', 'Toggle HUD'],
  ['F1', 'Toggle physics debug'], ['F2', 'Toggle suggested racing line'],
];

type EventFilter = 'all' | 'circuit' | 'sprint' | 'dirt' | 'challenge';

export class UI {
  root: HTMLDivElement;
  current: ScreenName = 'none';
  private screens = new Map<ScreenName, HTMLDivElement>();
  private focusIndex = 0;
  private eventFilter: EventFilter = 'all';
  private results: ResultsData | null = null;
  private wheelspinResult: { label: string; rarity: string }[] | null = null;

  constructor(private host: HTMLElement, private ctx: UIContext) {
    this.root = document.createElement('div');
    this.root.id = 'screens';
    host.appendChild(this.root);
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  // -------------------------------------------------------------- plumbing
  private makeScreen(name: ScreenName): HTMLDivElement {
    let el = this.screens.get(name);
    if (!el) {
      el = document.createElement('div');
      el.className = 'screen hidden';
      el.dataset.screen = name;
      this.root.appendChild(el);
      this.screens.set(name, el);
    }
    return el;
  }

  get isOpen() { return this.current !== 'none' && this.current !== 'photo'; }

  /** Keep the screen context in step when settings change at runtime. */
  setSettings(s: GameSettings) {
    this.ctx.settings = s;
  }

  show(name: ScreenName) {
    this.current = name;
    this.focusIndex = 0;
    // Create/render first, then unhide: a brand new screen element starts hidden.
    if (name !== 'none') {
      const el = this.makeScreen(name);
      this.render(name, el);
    }
    for (const [key, el] of this.screens) el.classList.toggle('hidden', key !== name);
    if (name !== 'none') this.applyFocus();
  }

  close() { this.show('none'); }

  setResults(r: ResultsData) {
    this.results = r;
    this.show('results');
  }

  setWheelspin(prizes: { label: string; rarity: string }[]) {
    this.wheelspinResult = prizes;
    this.show('wheelspin');
  }

  private items(el: HTMLElement): HTMLElement[] {
    return Array.from(el.querySelectorAll<HTMLElement>('.menu-item, .btn, .car-card'));
  }

  private applyFocus() {
    const el = this.screens.get(this.current);
    if (!el) return;
    const items = this.items(el);
    items.forEach((i, idx) => i.classList.toggle('focus', idx === this.focusIndex));
    items[this.focusIndex]?.scrollIntoView({ block: 'nearest' });
  }

  private move(delta: number) {
    const el = this.screens.get(this.current);
    if (!el) return;
    const items = this.items(el);
    if (!items.length) return;
    this.focusIndex = (this.focusIndex + delta + items.length) % items.length;
    this.ctx.audioClick('click');
    this.applyFocus();
  }

  private activate() {
    const el = this.screens.get(this.current);
    if (!el) return;
    const items = this.items(el);
    const item = items[this.focusIndex];
    if (!item || item.classList.contains('disabled')) { this.ctx.audioClick('back'); return; }
    this.ctx.audioClick('confirm');
    item.click();
  }

  private onKey(e: KeyboardEvent) {
    if (!this.isOpen) return;
    const target = e.target as HTMLElement;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
    switch (e.code) {
      case 'ArrowDown': case 'KeyS': this.move(1); e.preventDefault(); break;
      case 'ArrowUp': case 'KeyW': this.move(-1); e.preventDefault(); break;
      case 'ArrowLeft': case 'KeyA': this.adjust(-1); e.preventDefault(); break;
      case 'ArrowRight': case 'KeyD': this.adjust(1); e.preventDefault(); break;
      case 'Enter': case 'Space': this.activate(); e.preventDefault(); break;
      case 'Escape': if (this.current !== 'menu' && this.current !== 'results' && this.current !== 'wheelspin') { this.ctx.audioClick('back'); this.ctx.resume(); } break;
      default: break;
    }
  }

  private adjust(dir: number) {
    const el = this.screens.get(this.current);
    if (!el) return;
    const items = this.items(el);
    const item = items[this.focusIndex];
    if (!item) return;
    const step = item.dataset.step;
    if (!step) return;
    const delta = parseFloat(step) * dir;
    const action = item.dataset.adjust;
    if (action) {
      this.ctx.audioClick('click');
      this.adjustSetting(action, delta, item);
    }
  }

  private adjustSetting(name: string, delta: number, item: HTMLElement) {
    const s = this.ctx.settings;
    const set = (fn: () => void) => { fn(); this.ctx.applySettings(s); this.render(this.current, this.screens.get(this.current)!); };
    switch (name) {
      case 'fov': set(() => { s.fov = clamp(s.fov + delta * 2, 45, 105); }); break;
      case 'volume.master': set(() => { s.masterVolume = clamp(s.masterVolume + delta * 0.05, 0, 1); }); break;
      case 'volume.engine': set(() => { s.engineVolume = clamp(s.engineVolume + delta * 0.05, 0, 1); }); break;
      case 'volume.sfx': set(() => { s.sfxVolume = clamp(s.sfxVolume + delta * 0.05, 0, 1); }); break;
      case 'volume.music': set(() => { s.musicVolume = clamp(s.musicVolume + delta * 0.05, 0, 1); }); break;
      case 'uiScale': set(() => { s.uiScale = clamp(s.uiScale + delta * 0.05, 0.8, 1.6); document.documentElement.style.setProperty('--ui-scale', String(s.uiScale)); }); break;
      case 'renderScale': set(() => { s.renderScale = clamp(s.renderScale + delta * 0.05, 0.5, 1.4); }); break;
      case 'timeScale': set(() => { s.timeScale = clamp(s.timeScale + delta * 0.5, 0.5, 20); }); break;
      case 'gamepadDeadzone': set(() => { s.gamepadDeadzone = clamp(s.gamepadDeadzone + delta * 0.02, 0, 0.5); }); break;
      case 'steeringSensitivity': set(() => { s.steeringSensitivity = clamp(s.steeringSensitivity + delta * 0.05, 0.4, 2); }); break;
      default: break;
    }
    void item;
  }

  private menuItem(label: string, value: string | null, onClick: () => void, opts: { disabled?: boolean; hint?: string } = {}) {
    const div = document.createElement('div');
    div.className = `menu-item${opts.disabled ? ' disabled' : ''}`;
    div.innerHTML = `<span>${label}</span>${value !== null ? `<span class="val">${value}</span>` : ''}`;
    if (opts.hint) div.title = opts.hint;
    if (!opts.disabled) div.addEventListener('click', onClick);
    return div;
  }

  private toggleItem(label: string, on: boolean, onClick: () => void) {
    return this.menuItem(label, on ? 'ON' : 'OFF', onClick);
  }

  // ---------------------------------------------------------------- render
  private render(name: ScreenName, el: HTMLDivElement) {
    switch (name) {
      case 'menu': this.renderMainMenu(el); break;
      case 'pause': this.renderPause(el); break;
      case 'events': this.renderEvents(el); break;
      case 'garage': this.renderGarage(el); break;
      case 'map': this.renderMap(el); break;
      case 'settings': this.renderSettings(el); break;
      case 'help': this.renderHelp(el); break;
      case 'results': this.renderResults(el); break;
      case 'wheelspin': this.renderWheelspin(el); break;
      case 'photo': this.renderPhoto(el); break;
      default: break;
    }
  }

  private renderMainMenu(el: HTMLDivElement) {
    const c = this.ctx.career;
    const lvl = c.level;
    el.innerHTML = `
      <div class="panel" style="min-width:min(880px,92vw)">
        <h1>HORIZON <span>DRIVE</span></h1>
        <div class="sub">Level ${lvl.level} · ${c.profile.credits.toLocaleString()} CR · ${c.profile.owned.length} cars · ${c.profile.completedEvents.length}/${EVENTS.length} events</div>
        <div class="menu" id="main-menu"></div>
      </div>`;
    const menu = el.querySelector('#main-menu') as HTMLElement;
    menu.append(
      this.menuItem('Drive', 'Free Roam', () => { this.ctx.audioClick('confirm'); this.ctx.resume(); }),
      this.menuItem('Events', `${c.unlockedEvents().length} available`, () => this.show('events')),
      this.menuItem('Garage', `${c.profile.owned.length} owned`, () => this.show('garage')),
      this.menuItem('World Map', 'Press M', () => this.show('map')),
      this.menuItem('Seasonal Playlist', `Week ${c.playlist().week} · ${c.playlist().season}`, () => this.showEventsPlaylist()),
      this.menuItem('Settings', '', () => this.show('settings')),
      this.menuItem('Controls & Help', 'Press F1 in game for physics debug', () => this.show('help')),
    );
    const row = document.createElement('div');
    row.className = 'menu-row';
    row.style.marginTop = '18px';
    row.innerHTML = `<span class="tag">Original vehicles, world, music and sounds — no third-party game assets.</span>`;
    el.querySelector('.panel')!.appendChild(row);
  }

  private showEventsPlaylist() {
    const p = this.ctx.career.playlist();
    this.ctx.toast(`${p.season} week ${p.week}: ${p.challenges.filter((c) => c.done).length}/${p.challenges.length} complete, ${this.ctx.career.profile.playlist.points} pts`);
    this.show('events');
  }

  private renderPause(el: HTMLDivElement) {
    el.innerHTML = `
      <div class="panel">
        <h1>Paused</h1>
        <div class="sub">Physics is suspended while this menu is open.</div>
        <div class="menu" id="pause-menu"></div>
      </div>`;
    const menu = el.querySelector('#pause-menu') as HTMLElement;
    menu.append(
      this.menuItem('Resume', 'Esc', () => this.ctx.resume()),
      this.menuItem('Retry Event', '', () => this.ctx.retryEvent()),
      this.menuItem('Events', '', () => this.show('events')),
      this.menuItem('Garage', '', () => this.show('garage')),
      this.menuItem('World Map', '', () => this.show('map')),
      this.menuItem('Photo Mode', 'P', () => this.ctx.setPhotoMode(true)),
      this.menuItem('Settings', '', () => this.show('settings')),
      this.menuItem('Quit to Main Menu', '', () => this.ctx.quitToMenu()),
    );
  }

  private renderEvents(el: HTMLDivElement) {
    const c = this.ctx.career;
    const filters: { id: EventFilter; label: string }[] = [
      { id: 'all', label: 'All' }, { id: 'circuit', label: 'Circuits' }, { id: 'sprint', label: 'Sprints' },
      { id: 'dirt', label: 'Dirt' }, { id: 'challenge', label: 'Challenges' },
    ];
    el.innerHTML = `
      <div class="panel">
        <h1>Events</h1>
        <div class="sub">Drive to an event in the world, or start one straight from here.</div>
        <div class="menu-row" id="event-filters" style="margin-bottom:14px"></div>
        <div class="menu" id="event-list"></div>
        <div class="menu-row" style="margin-top:16px"><button class="btn" id="back-btn">Back</button></div>
      </div>`;
    const fRow = el.querySelector('#event-filters') as HTMLElement;
    for (const f of filters) {
      const b = document.createElement('button');
      b.className = `btn small${this.eventFilter === f.id ? ' primary' : ''}`;
      b.textContent = f.label;
      b.onclick = () => { this.eventFilter = f.id; this.render('events', el); this.applyFocus(); };
      fRow.appendChild(b);
    }
    const list = el.querySelector('#event-list') as HTMLElement;
    const matches = EVENTS.filter((e) => {
      if (this.eventFilter === 'all') return true;
      if (this.eventFilter === 'challenge') return ['drift', 'speedtrap', 'jump', 'timetrial'].includes(e.type);
      if (this.eventFilter === 'dirt') return e.type === 'dirt';
      return e.type === this.eventFilter;
    });
    for (const e of matches) {
      const locked = c.level.level < e.unlockLevel;
      const best = c.profile.bestTimes[e.id];
      const done = c.isEventComplete(e.id);
      const rewards = `${e.rewardCredits.toLocaleString()} CR · ${e.rewardXp} XP`;
      list.appendChild(this.menuItem(
        `${done ? '✓ ' : ''}${e.name} <span class="badge">${e.type.toUpperCase()}</span>`,
        locked ? `Unlocks at level ${e.unlockLevel}` : `${best ? formatTime(best) : rewards}`,
        () => { this.ctx.startEvent(e.id); },
        { disabled: locked, hint: e.description },
      ));
    }
    (el.querySelector('#back-btn') as HTMLButtonElement).onclick = () => this.show('menu');
  }

  private renderGarage(el: HTMLDivElement) {
    const c = this.ctx.career;
    const active = c.profile.activeCarId;
    const ownedIds = new Set(c.profile.owned.map((o) => o.carId));
    el.innerHTML = `
      <div class="panel" style="min-width:min(980px,94vw)">
        <h1>Garage</h1>
        <div class="sub">${c.profile.credits.toLocaleString()} CR · ${c.profile.owned.length} cars owned · active: ${getCar(active).name}</div>
        <h2>Your cars</h2>
        <div class="garage-grid" id="owned-grid"></div>
        <h2>Dealership</h2>
        <div class="garage-grid" id="shop-grid"></div>
        <div class="menu-row" style="margin-top:18px"><button class="btn" id="back-btn">Back</button></div>
      </div>`;
    const ownedGrid = el.querySelector('#owned-grid') as HTMLElement;
    for (const owned of c.profile.owned) {
      const spec = getCar(owned.carId);
      const card = document.createElement('div');
      card.className = `car-card${owned.carId === active ? ' focus' : ''}`;
      card.innerHTML = `
        <div class="name">${spec.manufacturer} ${spec.name}</div>
        <div class="meta">${spec.year} · ${spec.tier} · ${spec.drivetrain}</div>
        <div class="stats"><span>${spec.stats.powerHp} hp</span><span>${spec.stats.torqueNm} Nm</span><span>${spec.stats.weightKg} kg</span></div>
        <div class="menu-row" style="margin-top:10px">
          <button class="btn small" data-act="drive">${owned.carId === active ? 'Active' : 'Drive'}</button>
          <input type="color" value="${owned.paint.color}" data-act="color" style="width:38px;height:30px;border:none;background:none" />
          <select data-act="finish" class="btn small" style="padding:6px">
            ${['gloss', 'metallic', 'matte', 'chrome', 'pearl'].map((f) => `<option ${owned.paint.finish === f ? 'selected' : ''}>${f}</option>`).join('')}
          </select>
        </div>`;
      (card.querySelector('[data-act="drive"]') as HTMLButtonElement).onclick = (ev) => {
        ev.stopPropagation();
        this.ctx.changeCar(owned.carId);
        this.ctx.toast(`${spec.name} ready to drive`, 'good');
        this.render('garage', el);
      };
      (card.querySelector('[data-act="color"]') as HTMLInputElement).onchange = (ev) => {
        owned.paint.color = (ev.target as HTMLInputElement).value;
        c.save(true);
        this.ctx.changeCar(owned.carId);
        this.ctx.toast('Paint updated', 'good');
      };
      (card.querySelector('[data-act="finish"]') as HTMLSelectElement).onchange = (ev) => {
        owned.paint.finish = (ev.target as HTMLSelectElement).value as typeof owned.paint.finish;
        c.save(true);
        this.ctx.changeCar(owned.carId);
      };
      ownedGrid.appendChild(card);
    }
    const shopGrid = el.querySelector('#shop-grid') as HTMLElement;
    for (const spec of CARS) {
      if (ownedIds.has(spec.id)) continue;
      const card = document.createElement('div');
      card.className = 'car-card';
      card.innerHTML = `
        <div class="name">${spec.manufacturer} ${spec.name}</div>
        <div class="meta">${spec.year} · ${spec.tier} · ${spec.drivetrain}</div>
        <div class="stats"><span>${spec.stats.powerHp} hp</span><span>${spec.stats.weightKg} kg</span><span>R ${spec.stats.rating}</span></div>
        <div class="menu-row" style="margin-top:10px">
          <button class="btn small" data-act="buy">${spec.price.toLocaleString()} CR</button>
        </div>`;
      (card.querySelector('[data-act="buy"]') as HTMLButtonElement).onclick = () => {
        const r = c.buyCar(spec.id);
        if (r.ok) { this.ctx.changeCar(spec.id); this.ctx.toast(`Bought ${spec.name}`, 'good'); }
        else this.ctx.toast(r.reason ?? 'Cannot buy', 'bad');
        this.render('garage', el);
      };
      shopGrid.appendChild(card);
    }
    (el.querySelector('#back-btn') as HTMLButtonElement).onclick = () => this.show('menu');
    this.renderUpgradePanel(el);
  }

  private renderUpgradePanel(el: HTMLDivElement) {
    const c = this.ctx.career;
    const owned = c.profile.owned.find((o) => o.carId === c.profile.activeCarId);
    if (!owned) return;
    const spec = getCar(owned.carId);
    const panel = document.createElement('div');
    panel.innerHTML = `<h2>Upgrades · ${spec.name}</h2><div class="menu" id="upgrade-menu"></div>`;
    const menu = panel.querySelector('#upgrade-menu') as HTMLElement;
    const rows: [string, keyof typeof owned.upgrades & ('engine' | 'turbo' | 'gearbox' | 'tires' | 'brakes' | 'suspension' | 'weight' | 'aero'), number][] = [
      ['Engine', 'engine', 3], ['Turbo', 'turbo', 2], ['Gearbox', 'gearbox', 2], ['Tyres', 'tires', 3],
      ['Brakes', 'brakes', 3], ['Suspension', 'suspension', 3], ['Weight reduction', 'weight', 2], ['Aero', 'aero', 2],
    ];
    for (const [label, key, max] of rows) {
      const current = owned.upgrades[key] as number;
      const cost = current < max ? UPGRADE_COSTS[key][current + 1] : 0;
      menu.appendChild(this.menuItem(
        `${label}`,
        current >= max ? 'MAX' : `${current}/${max} · ${cost.toLocaleString()} CR`,
        () => {
          if (current >= max) return;
          if (c.profile.credits < cost) { this.ctx.toast('Not enough credits', 'bad'); return; }
          c.profile.credits -= cost;
          (owned.upgrades[key] as number) = current + 1;
          c.save(true);
          this.ctx.changeCar(owned.carId);
          this.ctx.toast(`${label} upgraded`, 'good');
          this.render('garage', el);
        },
        { disabled: current >= max || c.profile.credits < cost },
      ));
    }
    el.querySelector('.panel')!.appendChild(panel);
  }

  private renderMap(el: HTMLDivElement) {
    const c = this.ctx.career;
    el.innerHTML = `
      <div class="panel" style="min-width:min(980px,94vw)">
        <h1>World Map</h1>
        <div class="sub">Click an event to start it. Houses act as fast-travel points (owned houses only).</div>
        <div class="map-wrap"><canvas id="bigmap"></canvas>
          <div class="map-legend">Festival Hub · ${EVENTS.length} events · ${c.profile.houses.length} houses</div>
        </div>
        <div class="menu-row" style="margin-top:14px"><button class="btn" id="back-btn">Back</button></div>
      </div>`;
    const canvas = el.querySelector('#bigmap') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    const draw = () => {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      canvas.width = w * devicePixelRatio; canvas.height = h * devicePixelRatio;
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      const scale = Math.min(w, h) / 4400;
      const cx = w / 2, cy = h / 2;
      const toX = (x: number) => cx + x * scale;
      const toY = (z: number) => cy + z * scale;
      ctx.fillStyle = '#0e1720';
      ctx.fillRect(0, 0, w, h);
      // terrain tint
      const grad = ctx.createRadialGradient(cx, cy, 20, cx, cy, Math.max(w, h) * 0.6);
      grad.addColorStop(0, '#16232e'); grad.addColorStop(1, '#0b1219');
      ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
      for (const inst of this.ctx.world.field.instances) {
        ctx.beginPath();
        const dirt = inst.def.surface !== 'asphaltDry';
        ctx.strokeStyle = dirt ? '#c4a874' : '#8fa3b8';
        ctx.lineWidth = Math.max(1.5, inst.def.width * scale * 1.1);
        inst.samples.forEach((s, i) => {
          const px = toX(s.x), py = toY(s.z);
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        });
        ctx.stroke();
      }
      // events
      for (const e of EVENTS) {
        const locked = c.level.level < e.unlockLevel;
        const done = c.isEventComplete(e.id);
        const px = toX(e.location.x), py = toY(e.location.z);
        ctx.beginPath();
        ctx.arc(px, py, 7, 0, Math.PI * 2);
        ctx.fillStyle = locked ? '#4a5563' : done ? '#46e08a' : '#ff8a1f';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.fillStyle = '#dfe9f2'; ctx.font = '11px Inter, sans-serif';
        ctx.fillText(e.name, px + 10, py + 4);
      }
      // houses
      for (const h of HOUSE_POINTS) {
        const px = toX(h.x), py = toY(h.z);
        const owned = c.profile.houses.includes(h.id);
        ctx.fillStyle = owned ? '#22d3c5' : '#5d6b7a';
        ctx.fillRect(px - 5, py - 5, 10, 10);
      }
      // player
      const p = this.ctx.playerPosition;
      const px = toX(p.x), py = toY(p.z);
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.stroke();

      canvas.onclick = (ev) => {
        const rect = canvas.getBoundingClientRect();
        const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
        for (const e of EVENTS) {
          const ex = toX(e.location.x), ey = toY(e.location.z);
          if (Math.hypot(mx - ex, my - ey) < 14) {
            if (c.level.level < e.unlockLevel) { this.ctx.toast(`Unlocks at level ${e.unlockLevel}`, 'bad'); return; }
            this.ctx.startEvent(e.id);
            return;
          }
        }
        for (const h of HOUSE_POINTS) {
          const hx = toX(h.x), hy = toY(h.z);
          if (Math.hypot(mx - hx, my - hy) < 12) {
            if (c.profile.houses.includes(h.id)) { this.ctx.fastTravel(h.x, h.z); this.ctx.resume(); }
            else this.ctx.toast(`Buy ${h.name} for ${h.price.toLocaleString()} CR to fast travel here`);
            return;
          }
        }
      };
    };
    requestAnimationFrame(draw);
    (el.querySelector('#back-btn') as HTMLButtonElement).onclick = () => this.show('menu');
  }

  private renderSettings(el: HTMLDivElement) {
    const s = this.ctx.settings;
    el.innerHTML = `
      <div class="panel" style="min-width:min(760px,94vw)">
        <h1>Settings</h1>
        <div class="sub">Changes apply immediately and are saved locally.</div>
        <h2>Graphics</h2><div class="menu" id="gfx"></div>
        <h2>Audio</h2><div class="menu" id="audio"></div>
        <h2>Driving assists</h2><div class="menu" id="assists"></div>
        <h2>Accessibility</h2><div class="menu" id="access"></div>
        <div class="menu-row" style="margin-top:16px">
          <button class="btn" id="back-btn">Back</button>
          <button class="btn" id="reset-btn">Reset to defaults</button>
        </div>
      </div>`;
    const gfx = el.querySelector('#gfx') as HTMLElement;
    const qualityRow = document.createElement('div');
    qualityRow.className = 'menu-row';
    for (const q of ['low', 'medium', 'high', 'ultra'] as const) {
      const b = document.createElement('button');
      b.className = `btn small${s.quality === q ? ' primary' : ''}`;
      b.textContent = q.toUpperCase();
      b.onclick = () => {
        Object.assign(s, QUALITY_PRESETS[q]);
        s.quality = q;
        this.ctx.applySettings(s);
        this.render('settings', el);
      };
      qualityRow.appendChild(b);
    }
    gfx.appendChild(qualityRow);
    const fovItem = this.menuItem('Field of view', `${Math.round(s.fov)}°`, () => {});
    fovItem.dataset.adjust = 'fov'; fovItem.dataset.step = '1';
    gfx.append(
      fovItem,
      this.renderScaleItem(),
      this.toggleItem('Shadows', s.shadows, () => { s.shadows = !s.shadows; this.ctx.applySettings(s); this.render('settings', el); }),
      this.toggleItem('Reflections (env map)', s.reflections, () => { s.reflections = !s.reflections; this.ctx.applySettings(s); this.render('settings', el); }),
      this.toggleItem('Bloom', s.bloom, () => { s.bloom = !s.bloom; this.ctx.applySettings(s); this.render('settings', el); }),
      this.toggleItem('Dynamic resolution', s.dynamicResolution, () => { s.dynamicResolution = !s.dynamicResolution; this.ctx.applySettings(s); this.render('settings', el); }),
      this.menuItem('Anti-aliasing', s.antialias.toUpperCase(), () => {
        s.antialias = s.antialias === 'off' ? 'smaa' : s.antialias === 'smaa' ? 'taa' : 'off';
        this.ctx.applySettings(s); this.render('settings', el);
      }),
      this.menuItem('Quality preset', s.quality.toUpperCase(), () => {
        const order = ['low', 'medium', 'high', 'ultra'] as const;
        const next = order[(order.indexOf(s.quality) + 1) % order.length];
        Object.assign(s, QUALITY_PRESETS[next]); s.quality = next;
        this.ctx.applySettings(s); this.render('settings', el);
      }),
      this.menuItem('Particle density', `${Math.round(s.particleDensity * 100)}%`, () => {
        s.particleDensity = s.particleDensity >= 1 ? 0.2 : Math.round((s.particleDensity + 0.2) * 10) / 10;
        this.ctx.applySettings(s); this.render('settings', el);
      }),
      this.menuItem('Foliage density', `${Math.round(s.foliageDensity * 100)}%`, () => {
        s.foliageDensity = s.foliageDensity >= 1 ? 0.2 : Math.round((s.foliageDensity + 0.2) * 10) / 10;
        this.ctx.applySettings(s); this.render('settings', el);
      }),
    );

    const audio = el.querySelector('#audio') as HTMLElement;
    const vol = (label: string, key: 'volume.master' | 'volume.engine' | 'volume.sfx' | 'volume.music', value: number) => {
      const item = this.menuItem(label, `${Math.round(value * 100)}%`, () => {});
      item.dataset.adjust = key; item.dataset.step = '1';
      return item;
    };
    audio.append(
      vol('Master volume', 'volume.master', s.masterVolume),
      vol('Engine volume', 'volume.engine', s.engineVolume),
      vol('Effects volume', 'volume.sfx', s.sfxVolume),
      vol('Music / radio volume', 'volume.music', s.musicVolume),
      this.toggleItem('Radio', s.radioEnabled, () => { s.radioEnabled = !s.radioEnabled; this.ctx.applySettings(s); this.render('settings', el); }),
      this.menuItem('Radio station', STATIONS.find((st) => st.id === (this.ctx as unknown as { station?: string }).station)?.name ?? 'Horizon FM', () => {
        this.ctx.openRadio('next'); this.render('settings', el);
      }),
    );

    const assists = el.querySelector('#assists') as HTMLElement;
    const diffRow = document.createElement('div');
    diffRow.className = 'menu-row';
    for (const d of ['arcade', 'balanced', 'pro', 'simulation'] as const) {
      const b = document.createElement('button');
      b.className = `btn small${s.difficulty === d ? ' primary' : ''}`;
      b.textContent = d.toUpperCase();
      b.onclick = () => {
        s.difficulty = d;
        Object.assign(s.assist, DIFFICULTY_PRESETS[d]);
        s.simulationMode = d === 'simulation';
        this.ctx.applySettings(s);
        this.render('settings', el);
      };
      diffRow.appendChild(b);
    }
    assists.appendChild(diffRow);
    assists.append(
      this.toggleItem('ABS', s.assist.abs, () => { s.assist.abs = !s.assist.abs; this.ctx.applySettings(s); this.render('settings', el); }),
      this.toggleItem('Traction control', s.assist.tractionControl, () => { s.assist.tractionControl = !s.assist.tractionControl; this.ctx.applySettings(s); this.render('settings', el); }),
      this.toggleItem('Stability control', s.assist.stabilityControl, () => { s.assist.stabilityControl = !s.assist.stabilityControl; this.ctx.applySettings(s); this.render('settings', el); }),
      this.toggleItem('Automatic gears', s.assist.autoGears, () => { s.assist.autoGears = !s.assist.autoGears; this.ctx.applySettings(s); this.render('settings', el); }),
      this.toggleItem('Rewind', s.assist.rewind, () => { s.assist.rewind = !s.assist.rewind; this.ctx.applySettings(s); this.render('settings', el); }),
      this.toggleItem('Suggested racing line', s.assist.racingLine, () => { s.assist.racingLine = !s.assist.racingLine; this.ctx.applySettings(s); this.render('settings', el); }),
      this.menuItem('Steering assist', `${Math.round(s.assist.steeringAssist * 100)}%`, () => {
        s.assist.steeringAssist = s.assist.steeringAssist >= 0.9 ? 0 : Math.round((s.assist.steeringAssist + 0.2) * 10) / 10;
        this.ctx.applySettings(s); this.render('settings', el);
      }),
      this.toggleItem('AI catch-up (off = pure performance)', s.aiCatchUp, () => { s.aiCatchUp = !s.aiCatchUp; this.ctx.applySettings(s); this.render('settings', el); }),
    );

    const access = el.querySelector('#access') as HTMLElement;
    access.append(
      this.menuItem('Speed units', s.speedUnits === 'kmh' ? 'KM/H' : 'MPH', () => {
        s.speedUnits = s.speedUnits === 'kmh' ? 'mph' : 'kmh'; this.ctx.applySettings(s); this.render('settings', el);
      }),
      this.menuItem('Colour-blind mode', s.colorBlind.toUpperCase(), () => {
        const modes = ['off', 'protanopia', 'deuteranopia', 'tritanopia'] as const;
        s.colorBlind = modes[(modes.indexOf(s.colorBlind) + 1) % modes.length];
        this.ctx.applySettings(s); this.render('settings', el);
      }),
      this.menuItem('UI scale', `${Math.round(s.uiScale * 100)}%`, () => {}),
      this.toggleItem('Reduced motion (no camera shake)', s.reducedMotion, () => {
        s.reducedMotion = !s.reducedMotion; this.ctx.applySettings(s); this.render('settings', el);
      }),
      this.toggleItem('Subtitles', s.showSubtitles, () => { s.showSubtitles = !s.showSubtitles; this.ctx.applySettings(s); this.render('settings', el); }),
      this.menuItem('Camera shake', `${Math.round(s.cameraShake * 100)}%`, () => {
        s.cameraShake = s.cameraShake >= 1 ? 0 : Math.round((s.cameraShake + 0.2) * 10) / 10;
        this.ctx.applySettings(s); this.render('settings', el);
      }),
      this.menuItem('Time of day', s.timeOfDayLock === null ? 'Live cycle' : `${s.timeOfDayLock.toFixed(0)}:00`, () => {
        s.timeOfDayLock = s.timeOfDayLock === null ? 6 : s.timeOfDayLock >= 22 ? null : s.timeOfDayLock + 4;
        this.ctx.applySettings(s); this.render('settings', el);
      }),
      this.menuItem('Weather', s.weatherLock === 'auto' ? 'Dynamic' : s.weatherLock, () => {
        const seq = ['auto', 'clear', 'overcast', 'rain', 'storm', 'fog', 'sandstorm', 'snow'] as const;
        s.weatherLock = seq[(seq.indexOf(s.weatherLock) + 1) % seq.length];
        this.ctx.applySettings(s); this.render('settings', el);
      }),
    );

    (el.querySelector('#back-btn') as HTMLButtonElement).onclick = () => this.show('pause');
    (el.querySelector('#reset-btn') as HTMLButtonElement).onclick = () => {
      this.ctx.toast('Settings reset on next load');
      localStorage.removeItem('horizon-drive.settings.v3');
    };
  }

  private renderScaleItem() {
    const item = this.menuItem('Render scale', `${Math.round(this.ctx.settings.renderScale * 100)}%`, () => {});
    item.dataset.adjust = 'renderScale'; item.dataset.step = '1';
    return item;
  }

  private renderHelp(el: HTMLDivElement) {
    el.innerHTML = `
      <div class="panel">
        <h1>Controls & Help</h1>
        <div class="sub">Keyboard, gamepad (standard mapping) and touch are all supported. Menus work with arrows + Enter too.</div>
        <div class="keys">${KEY_HELP.map(([k, v]) => `<div><b>${k}</b>${v}</div>`).join('')}</div>
        <h2>Driving assists</h2>
        <div class="sub" style="margin:0 0 14px">ABS, traction control and stability control act on real forces — they reduce torque or modulate brakes, they never add grip. Simulation difficulty turns them off.</div>
        <h2>HUD legend</h2>
        <div class="sub" style="margin:0">Top right minimap rotates with your heading. The chip under the event name shows your objective. F1 shows live physics telemetry (slip, load, suspension travel).</div>
        <div class="menu-row" style="margin-top:16px"><button class="btn" id="back-btn">Back</button></div>
      </div>`;
    (el.querySelector('#back-btn') as HTMLButtonElement).onclick = () => this.show('menu');
  }

  private renderResults(el: HTMLDivElement) {
    const r = this.results;
    if (!r) { this.show('none'); return; }
    el.innerHTML = `
      <div class="panel">
        <h1>${r.position === 1 ? 'Victory' : 'Event Complete'}</h1>
        <div class="sub">${r.eventName} · finished ${r.position} of ${r.total} · ${formatTime(r.time)}${r.best !== null ? ` · best ${formatTime(r.best)}` : ''}</div>
        <table class="results-table">
          <thead><tr><th>Pos</th><th>Driver</th><th>Time</th></tr></thead>
          <tbody>${r.placements.map((p, i) => `<tr class="${p.isPlayer ? 'me' : ''}"><td>${i + 1}</td><td>${p.name}</td><td>${formatTime(p.time)}</td></tr>`).join('')}</tbody>
        </table>
        <h2>Rewards</h2>
        <div class="sub">+${r.credits.toLocaleString()} CR · +${r.xp} XP</div>
        <div class="menu-row">
          <button class="btn primary" id="cont-btn">Continue</button>
          <button class="btn" id="retry-btn">Retry</button>
        </div>
      </div>`;
    (el.querySelector('#cont-btn') as HTMLButtonElement).onclick = () => this.ctx.resume();
    (el.querySelector('#retry-btn') as HTMLButtonElement).onclick = () => this.ctx.retryEvent();
  }

  private renderWheelspin(el: HTMLDivElement) {
    const prizes = this.wheelspinResult ?? [];
    el.innerHTML = `
      <div class="panel" style="text-align:center">
        <h1>Wheelspin</h1>
        <div class="sub">Rewards from the festival playlist</div>
        <div class="menu-row" style="justify-content:center;gap:18px;margin:22px 0">
          ${prizes.map((p) => `<div class="car-card" style="min-width:160px"><div class="name">${p.label}</div><div class="meta">${p.rarity}</div></div>`).join('')}
        </div>
        <div class="menu-row" style="justify-content:center"><button class="btn primary" id="ok-btn">Collect</button></div>
      </div>`;
    (el.querySelector('#ok-btn') as HTMLButtonElement).onclick = () => this.ctx.resume();
  }

  private renderPhoto(el: HTMLDivElement) {
    el.innerHTML = `
      <div class="screen" style="background:none;backdrop-filter:none;pointer-events:none">
        <div class="photo-toolbar clickable">
          <button class="btn primary" id="shot-btn">Capture</button>
          <button class="btn" id="exit-btn">Exit photo mode</button>
        </div>
        <div class="photo-filters clickable">
          <div class="tag">WASD / drag: move camera</div>
          <div class="tag">Q / E: zoom</div>
          <div class="tag">R / F: raise / lower</div>
          <div class="tag">Space: capture · Esc: exit</div>
        </div>
      </div>`;
    (el.querySelector('#shot-btn') as HTMLButtonElement).onclick = () => this.ctx.capturePhoto();
    (el.querySelector('#exit-btn') as HTMLButtonElement).onclick = () => this.ctx.setPhotoMode(false);
  }
}

export interface HousePoint { id: string; name: string; x: number; z: number; price: number }
export const HOUSE_POINTS: HousePoint[] = [
  { id: 'festival-hub', name: 'Festival Hub House', x: 80, z: 250, price: 0 },
  { id: 'coast-house', name: 'Coast House', x: -1420, z: 420, price: 120000 },
  { id: 'farm-house', name: 'Farm House', x: -600, z: 1420, price: 150000 },
  { id: 'mountain-house', name: 'Mountain Lodge', x: 900, z: -1320, price: 220000 },
  { id: 'desert-house', name: 'Desert Casita', x: 1480, z: -700, price: 180000 },
];
