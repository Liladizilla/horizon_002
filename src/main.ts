/**
 * Boot: capability checks, physics init, then hand over to `Game`.
 *
 * Nothing here touches gameplay state; it only makes sure the two heavyweight
 * dependencies (WebGL2 and the Rapier WASM module) are actually available before
 * the loading bar is allowed to finish, so a missing browser feature produces a
 * readable message instead of a black screen.
 */
import './style.css';
import { Game } from './game';
import type { GameSettings } from './core/settings';
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from './core/settings';
import { loadProfile } from './core/save';

const boot = document.getElementById('boot') as HTMLDivElement | null;
const bootStatus = document.getElementById('boot-status') as HTMLDivElement | null;
const bootFill = document.getElementById('boot-fill') as HTMLDivElement | null;
const bootError = document.getElementById('boot-error') as HTMLDivElement | null;

function setProgress(fraction: number, text: string) {
  if (bootFill) bootFill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
  if (bootStatus) bootStatus.textContent = text;
}
function escapeHtml(s: string) {
  return s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] ?? c));
}
function fail(message: string, detail?: string) {
  setProgress(1, 'Could not start');
  if (bootFill) bootFill.style.background = '#ff5a5a';
  if (bootError) {
    bootError.hidden = false;
    bootError.innerHTML = `<b>${escapeHtml(message)}</b>${detail ? `<br /><code>${escapeHtml(detail.slice(0, 600))}</code>` : ''}
      <br />This game needs a desktop browser with WebGL2 and WebAssembly: recent Chrome, Edge, Firefox or Safari 15+.`;
  }
  console.error('[boot]', message, detail ?? '');
}

async function detectGpu(): Promise<string> {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2');
  if (!gl) return 'none';
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const name = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'WebGL2';
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return name;
}

async function start() {
  setProgress(0.05, 'Checking graphics support…');
  const gpu = await detectGpu();
  if (gpu === 'none') { fail('WebGL2 is not available in this browser.'); return; }

  if (typeof WebAssembly !== 'object') { fail('WebAssembly is required for the physics engine.'); return; }

  const settings = loadSettings();
  const quality: GameSettings = settings;

  // Rapier ships as WASM; on a slow connection the fetch is the slowest step, so
  // report it explicitly rather than leaving the bar frozen.
  setProgress(0.2, 'Loading physics engine…');
  let RAPIER: typeof import('@dimforge/rapier3d-compat');
  try {
    RAPIER = await import('@dimforge/rapier3d-compat');
    await RAPIER.init();
  } catch (err) {
    fail('The physics engine failed to load.', String(err));
    return;
  }

  setProgress(0.45, 'Preparing the world…');
  let game: Game;
  try {
    game = new Game(document.getElementById('game') as HTMLCanvasElement, RAPIER, settings);
  } catch (err) {
    fail('Failed to start the renderer.', String(err));
    return;
  }

  // Debug surface for the browser test suite and for players who like poking
  // at things from the console (`horizonDrive.debug`).
  (window as unknown as { horizonDrive: Game }).horizonDrive = game;

  const params = new URLSearchParams(location.search);
  if (params.has('server')) game.connectServer(params.get('server') ?? '');
  if (settings.quality !== quality.quality) saveSettings(settings);

  setProgress(0.7, 'Loading terrain and roads…');
  await game.init((f, label) => setProgress(0.7 + f * 0.28, label));
  setProgress(1, 'Ready');
  if (boot) {
    boot.classList.add('hidden');
    setTimeout(() => boot.remove(), 800);
  }

  // Audio may only start inside a user gesture; unlock on the first of any input.
  const unlock = () => {
    game.audio?.start();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
    window.removeEventListener('touchstart', unlock);
  };
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);
  window.addEventListener('touchstart', unlock, { passive: true });

  console.info(`[boot] ready — ${gpu}`);
  void loadProfile();
}

declare global {
  interface Window { horizonDrive?: unknown }
}

start().catch((err) => fail('Unexpected error while starting the game.', String(err?.stack ?? err)));

// Keep the module's settings defaults reachable for the settings screen reset.
export { DEFAULT_SETTINGS };
