/**
 * Thin WebSocket client for the optional companion multiplayer server
 * (see `server/index.mjs`).
 *
 * The game is fully playable offline: this module only mirrors the player's pose
 * to other clients and receives theirs. Traffic is JSON with a hard cap on
 * message size and rate limits on reconnect, so a hostile server cannot flood
 * the render loop.
 */
export interface NetPlayerState {
  x: number; y: number; z: number;
  qx: number; qy: number; qz: number; qw: number;
  speed: number;
}

export interface NetHandlers {
  /** Fired once with this client's id plus the ids already in the room. */
  onWelcome?(id: string, players: string[]): void;
  /** Fired when the server broadcasts another player's pose. */
  onPlayerUpdate?(id: string, state: NetPlayerState): void;
  onPlayerLeft?(id: string): void;
  onChat?(from: string, text: string): void;
  onStatus?(status: 'connecting' | 'open' | 'closed' | 'error'): void;
}

const MAX_MESSAGE_BYTES = 8192;
const SEND_HZ = 15;
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECTS = 5;

export class NetClient {
  url: string;
  id = '';
  players = new Map<string, NetPlayerState>();
  status: 'idle' | 'connecting' | 'open' | 'closed' | 'error' = 'idle';
  private ws: WebSocket | null = null;
  private sendAccumulator = 0;
  private reconnects = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handlers: NetHandlers;
  private disposed = false;

  constructor(url: string, handlers: NetHandlers = {}) {
    this.url = url;
    this.handlers = handlers;
    this.connect();
  }

  private connect() {
    if (this.disposed) return;
    this.status = 'connecting';
    this.handlers.onStatus?.('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.status = 'error';
      this.handlers.onStatus?.('error');
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.status = 'open';
      this.reconnects = 0;
      this.handlers.onStatus?.('open');
    };
    ws.onerror = () => {
      this.status = 'error';
      this.handlers.onStatus?.('error');
    };
    ws.onclose = () => {
      this.status = 'closed';
      this.players.clear();
      this.handlers.onStatus?.('closed');
      if (this.disposed) return;
      if (this.reconnects < MAX_RECONNECTS) {
        this.reconnects++;
        this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS * this.reconnects);
      }
    };
    ws.onmessage = (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : '';
      if (!text || text.length > MAX_MESSAGE_BYTES) return;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(text) as Record<string, unknown>; } catch { return; }
      this.dispatch(msg);
    };
  }

  private dispatch(msg: Record<string, unknown>) {
    const type = msg.t as string;
    if (type === 'welcome') {
      this.id = String(msg.id ?? '');
      const others = Array.isArray(msg.players) ? (msg.players as string[]) : [];
      this.handlers.onWelcome?.(this.id, others);
    } else if (type === 'join') {
      this.handlers.onWelcome?.(String(msg.id ?? ''), []);
    } else if (type === 'leave') {
      const id = String(msg.id ?? '');
      this.players.delete(id);
      this.handlers.onPlayerLeft?.(id);
    } else if (type === 'state' && msg.s && typeof msg.s === 'object') {
      const s = msg.s as NetPlayerState;
      if (!Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.z)) return;
      this.players.set(String(msg.id ?? ''), s);
      this.handlers.onPlayerUpdate?.(String(msg.id ?? ''), s);
    } else if (type === 'chat') {
      this.handlers.onChat?.(String(msg.from ?? ''), String(msg.text ?? '').slice(0, 240));
    }
  }

  /** Queue this client's pose; sends at most `SEND_HZ` regardless of frame rate. */
  send(dt: number, state: NetPlayerState) {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.sendAccumulator += dt;
    if (this.sendAccumulator < 1 / SEND_HZ) return;
    this.sendAccumulator = 0;
    try {
      this.ws.send(JSON.stringify({ t: 'state', s: state }));
    } catch { /* socket died; onclose handles it */ }
  }

  dispose() {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.players.clear();
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ws = null;
    this.status = 'closed';
  }
}
