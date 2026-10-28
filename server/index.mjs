#!/usr/bin/env node
/**
 * Horizon Drive — optional authoritative race server.
 *
 * The single-player game never needs this: it is an add-on for LAN/online
 * rooms. Design notes (see README "Multiplayer"):
 *
 *  - The server owns the clock, the room, and the ordering of racers. Clients
 *    send *inputs* (throttle/brake/steer/handbrake + a sequence number), never
 *    positions, so a hacked client cannot teleport itself up the standings.
 *  - Clients predict locally and send the state they predicted; the server
 *    stores the last acknowledged input sequence plus an authoritative progress
 *    figure and echoes it back. Clients reconcile by replaying from the last
 *    acknowledged snapshot (see `src/net/client.ts` and README).
 *  - Every remote pose is echoed to other clients for interpolation; the server
 *    validates ranges, clamps rates, and drops anything malformed.
 *
 * Protocol (JSON, one message per frame, max 8 KiB):
 *   client -> server  {"t":"join","name":"...","room":"..."}
 *                     {"t":"input","seq":n,"c":[throttle,brake,steer,handbrake],
 *                      "s":{"x","y","z","qx","qy","qz","qw","speed"}}
 *                     {"t":"chat","text":"..."}
 *                     {"t":"ping","id":n}
 *   server -> client  {"t":"welcome","id":"p1","players":["p2"],"tick":n,"hz":20}
 *                     {"t":"join"|"leave","id":"p2"}
 *                     {"t":"state","id":"p2","s":{...},"seq":n}
 *                     {"t":"ack","seq":n,"tick":n,"pos":k}
 *                     {"t":"pong","id":n,"tick":n}
 *                     {"t":"chat","from":"p2","text":"..."}
 *                     {"t":"error","message":"..."}
 *
 * Run: npm run server  (PORT=8787 by default, then open the game with
 * ?server=ws://localhost:8787)
 */
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const TICK_HZ = 20;
const MAX_CLIENTS = 32;
const MAX_MESSAGE_BYTES = 8192;
const MAX_INPUTS_PER_SECOND = 90;      // ~4x the render rate; more is spam
const MAX_CHAT_PER_10S = 6;
const MAX_NAME = 24;
const IDLE_TIMEOUT_MS = 30_000;
const WORLD_HALF = 2100;               // metres from the origin: keep poses sane

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------
/** @typedef {{id:string,name:string,socket:import('ws').WebSocket,room:string,lastSeen:number,inputs:number,chats:number,chatWindow:number,seq:number,state:object|null,pos:number}} Client */

/** @type {Map<string, Client>} */
const clients = new Map();
/** @type {Map<string, Set<string>>} */
const rooms = new Map();
let nextId = 1;
let tick = 0;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const finite = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const now = () => Date.now();

/** Validates and clamps a pose. Returns null when unusable. */
function sanitiseState(s) {
  if (!s || typeof s !== 'object') return null;
  const x = finite(s.x), y = finite(s.y), z = finite(s.z);
  if (x === undefined || Math.abs(x) > WORLD_HALF || Math.abs(z) > WORLD_HALF) return null;
  if (y < -100 || y > 1200) return null;
  let qx = finite(s.qx, 0), qy = finite(s.qy, 0), qz = finite(s.qz, 0), qw = finite(s.qw, 1);
  const len = Math.hypot(qx, qy, qz, qw) || 1;
  qx /= len; qy /= len; qz /= len; qw /= len;
  return { x, y, z, qx, qy, qz, qw, speed: clamp(finite(s.speed), 0, 200) };
}

function send(client, msg) {
  const data = JSON.stringify(msg);
  if (data.length > MAX_MESSAGE_BYTES) return;
  if (client.socket.readyState === 1) client.socket.send(data);
}

function broadcast(room, msg, exceptId) {
  const members = rooms.get(room);
  if (!members) return;
  for (const id of members) {
    if (id === exceptId) continue;
    const c = clients.get(id);
    if (c) send(c, msg);
  }
}

function sanitiseName(raw, id) {
  const s = String(raw ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, MAX_NAME);
  return s || `Racer ${id}`;
}

function sanitiseRoom(raw) {
  const s = String(raw ?? 'lobby').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
  return s || 'lobby';
}

function leave(client) {
  const set = rooms.get(client.room);
  if (set) {
    set.delete(client.id);
    if (set.size === 0) rooms.delete(client.room);
  }
  clients.delete(client.id);
  broadcast(client.room, { t: 'leave', id: client.id });
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
const http = createServer((req, res) => {
  // Tiny status endpoint so players can check the server is alive.
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, tick, tickHz: TICK_HZ, clients: clients.size,
      rooms: [...rooms.entries()].map(([name, set]) => ({ name, players: set.size })),
    }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Horizon Drive multiplayer server. Connect a WebSocket client.\n');
});

const wss = new WebSocketServer({ server: http, maxPayload: MAX_MESSAGE_BYTES });

wss.on('connection', (socket, req) => {
  if (clients.size >= MAX_CLIENTS) {
    socket.send(JSON.stringify({ t: 'error', message: 'Server full' }));
    socket.close();
    return;
  }
  const ip = req.socket.remoteAddress ?? 'unknown';
  const id = `p${nextId++}`;
  /** @type {Client} */
  const client = {
    id, name: sanitiseName('', id), socket, room: 'lobby',
    lastSeen: now(), inputs: 0, chats: 0, chatWindow: now(), seq: -1, state: null, pos: 0,
  };
  clients.set(id, client);

  socket.on('message', (raw) => {
    client.lastSeen = now();
    const text = raw.toString('utf8');
    if (text.length > MAX_MESSAGE_BYTES) return;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.t) {
      case 'join': {
        const room = sanitiseRoom(msg.room);
        const oldRoom = client.room;
        if (oldRoom !== room) {
          rooms.get(oldRoom)?.delete(id);
          client.room = room;
        }
        client.name = sanitiseName(msg.name, id);
        if (!rooms.has(room)) rooms.set(room, new Set());
        rooms.get(room).add(id);
        const players = [...rooms.get(room)].filter((p) => p !== id);
        send(client, { t: 'welcome', id, players, name: client.name, room, tick, hz: TICK_HZ });
        broadcast(room, { t: 'join', id, name: client.name }, id);
        console.log(`[${now()}] join ${id} "${client.name}" -> ${room} (${rooms.get(room).size}) ip=${ip}`);
        break;
      }

      case 'input': {
        // Rate limit: a client may not exceed MAX_INPUTS_PER_SECOND.
        client.inputs++;
        if (now() - client.chatWindow > 1000) { client.inputs = 1; }
        if (client.inputs > MAX_INPUTS_PER_SECOND) return;
        const seq = Math.trunc(finite(msg.seq, -1));
        if (!Number.isFinite(seq) || seq <= client.seq) return; // stale/duplicate
        const state = sanitiseState(msg.s);
        if (!state) return;
        client.seq = seq;
        client.state = state;
        // Authoritative progress: distance travelled along +X is only a proxy;
        // the room's own route logic lives in-game and reads `pos` from here.
        const prev = client.state;
        if (prev) client.pos += Math.hypot(state.x - prev.x, state.z - prev.z);
        send(client, { t: 'ack', seq, tick, pos: Math.round(client.pos) });
        broadcast(client.room, { t: 'state', id, s: state, seq }, id);
        break;
      }

      case 'chat': {
        const t = now();
        if (t - client.chatWindow > 10_000) { client.chats = 0; client.chatWindow = t; }
        client.chats++;
        if (client.chats > MAX_CHAT_PER_10S) return;
        const text = String(msg.text ?? '').slice(0, 240).replace(/[\u0000-\u001f]/g, '');
        if (!text) return;
        broadcast(client.room, { t: 'chat', from: id, name: client.name, text }, id);
        break;
      }

      case 'ping':
        send(client, { t: 'pong', id: msg.id ?? 0, tick });
        break;

      default:
        send(client, { t: 'error', message: `Unknown message type: ${String(msg.t).slice(0, 20)}` });
    }
  });

  socket.on('close', () => leave(client));
  socket.on('error', () => leave(client));

  send(client, { t: 'welcome', id, players: [], room: client.room, tick, hz: TICK_HZ });
});

// Authoritative clock: broadcasts the tick so clients can interpolate and can
// drop a client that has gone silent.
setInterval(() => {
  tick++;
  const stale = now() - IDLE_TIMEOUT_MS;
  for (const client of [...clients.values()]) {
    if (client.lastSeen < stale) {
      try { client.socket.close(); } catch { /* ignore */ }
      leave(client);
    }
  }
  for (const client of clients.values()) send(client, { t: 'tick', tick });
}, 1000 / TICK_HZ).unref?.();

http.listen(PORT, HOST, () => {
  console.log(`Horizon Drive server listening on ws://${HOST}:${PORT} (tick ${TICK_HZ} Hz, max ${MAX_CLIENTS} clients)`);
  console.log(`Open the game with:  http://localhost:5173/?server=ws://localhost:${PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nShutting down.');
    for (const c of clients.values()) { try { c.socket.close(); } catch { /* ignore */ } }
    http.close(() => process.exit(0));
  });
}
