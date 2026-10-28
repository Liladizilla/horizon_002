# Horizon Drive

An original open-world arcade-racing game that runs in the browser. No account, no
API key, no build backend: `npm install && npm run dev`, press **W**.

* **Three.js** (WebGL2) for rendering, **Rapier3D** (WASM) for rigid bodies.
* A 4 km × 4 km streamed world — coastal highway, town, farmland, jungle, canyon,
  mountain passes and a desert — knitted together by a road graph that carries
  surface metadata used by the tyres, GPS, AI, traffic and events.
* Three physically-modelled cars (plus four more in the dealership) driven through
  a per-wheel raycast suspension, slip-ratio tyres with a friction ellipse, an
  engine torque curve, clutch, gearbox, differentials and aero.
* 12 events: circuits, point-to-point sprints, dirt stages, time trial, drift
  zone, speed trap and a jump.
* Fixed 120 Hz physics with frame interpolation, rewind, replay-ready snapshots,
  weather, day/night, a full menu/garage/map/settings stack, and an optional
  Node WebSocket server for multiplayer. The single-player game never needs it.

Everything in the repo is written for this project: no Forza/EH assets, names,
logos or map data. See [NOTICE.md](NOTICE.md) for third-party licences.

---

## Quick start

```bash
npm install          # installs deps and the lockfile versions
npm run dev          # http://localhost:5173
```

Then click once (audio needs a user gesture) and press **Enter** to start.

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server on `0.0.0.0:5173` (LAN playable) |
| `npm run build` | Type-check (`tsc --noEmit`) then bundle to `dist/` |
| `npm run preview` | Serve the production bundle on `:4173` |
| `npm test` | Headless Vitest suites (physics, world, route, race, AI, saves) |
| `npm run typecheck` | Types only |
| `npm run smoke` | Boots the built bundle in headless Chromium and drives it |
| `npm run server` | Optional multiplayer server on `:8787` |

**Browsers:** current Chrome/Edge, Firefox and Safari 15+ on desktop. WebGL2 and
WebAssembly are required and checked at boot with a readable error if missing.
Touch controls work on tablets; phones are playable but cramped.

---

## Controls

| Input | Action |
| --- | --- |
| **W / ↑** | Throttle |
| **S / ↓** | Brake, then reverse |
| **A D / ← →** | Steer |
| **Space** | Handbrake |
| **E / Q** | Shift up / down (manual gearbox) |
| **C** | Cycle camera: chase, close chase, hood, bumper, cockpit, drone |
| **R** | Reset the car onto the road |
| **Z** (hold) | Rewind (~10 s of snapshots, if the assist is on) |
| **M** | World map · **Esc** pause · **P** photo mode |
| **N** radio · **H** horn · **U** hide HUD |
| **F1** physics debug overlay · **F2** suggested racing line |

Gamepads are supported with analogue triggers and sticks (deadzone and
sensitivity are in Settings). Keys can be remapped from the Controls screen; the
bindings are stored in your save profile.

---

## What is in the game

### World

* `src/world/terrain.ts` — deterministic height field: coastline, plains,
  farmland, jungle ridges, a volcanic cone, a snow-capped mountain wall and a
  desert basin, all from seeded value/ridged noise (`src/core/rng.ts`).
* `src/world/roads.ts` — nine road loops/stages sampled at ~3 m, with
  cross-road height reconciliation so junctions and flyovers do not step, plus a
  node graph used for route finding.
* `src/world/world.ts` — 128 m chunk streaming (visual radius 1150 m, collision
  radius 620 m), LOD by distance, heightfield colliders built from the *same*
  sampling function as the visuals, road ribbon meshes sampled across their width
  from that height field, sea, and GPU resource disposal on unload.
* `src/world/props.ts` — deterministic props per chunk: trees, rocks, buildings,
  fences, street furniture, all instanced.

### Vehicles

Three authored cars (`src/data/cars.ts`) with SI parameters — a 1495 kg RWD
sports coupé, a 1330 kg AWD rally car and a 2350 kg off-roader. The simulation
(`src/physics/vehicle.ts`) is a rigid body with four raycast suspension units:

* spring/damper with bump stops, anti-roll bars, load transfer;
* slip-ratio + slip-angle tyre model with a friction ellipse, load sensitivity,
  combined slip, temperature and wear, stable at zero speed;
* wheel angular integration with non-reversing brake torque, ABS and TCS mod
  factors;
* engine torque curve, turbo lag, clutch, 6-speed gearbox with auto or manual
  shifting, open/LSD/viscous differentials, FWD/RWD/AWD splits;
* aero drag and downforce, rolling resistance, damage that degrades engine,
  steering and per-wheel grip.

The car is never teleported by gameplay code: only `resetTo`/rewind/save-load
place it, which is what the reset key and rewind are for.

### Driving feel and assists

ABS, TCS, stability control, steering assist, braking assist, auto gears and
rewind are individually toggleable with a labelled **Simulation** difficulty that
turns them all off. Difficulty presets only change AI skill and aggression — there
is no hidden rubber-banding (the separate `AI catch-up` setting is off by default
and visible in Settings).

Surface grip is data-driven (`src/core/surfaces.ts`): dry/wet asphalt, concrete,
kerb, gravel, dirt, grass, sand, mud, snow and water, each with grip, rolling
resistance, roughness and particle behaviour. Weather and time of day
(`src/gameplay/weather.ts`) drive wetness, fog, wind and light; wetness lags the
sky because it is a physical state, so it keeps raining grip after the rain stops.

### Events

`src/data/events.ts` defines 12 events on the road graph with rewards, unlock
levels and challenge targets. `src/gameplay/race.ts` implements a race session
(countdown, swept gate crossing that cannot skip a checkpoint at 300 km/h,
progress-based standings, laps, wrong-way detection, results) and challenge
sessions (drift score, speed trap, jump). `src/gameplay/career.ts` pays credits
and XP, tracks best times/records, runs the seasonal playlist and wheelspins, and
persists a versioned profile (`.v3`, migrated and repaired on load).

### AI and traffic

`src/gameplay/ai.ts`: an AI racer drives the *same* physics as the player through
lookahead steering, corner-speed planning with braking points, throttle control
and recovery when it leaves the road. Civilian traffic follows lanes, keeps right
and brakes for obstacles. Neither uses scripted motion.

### Presentation

Chase/hood/bumper/cockpit/drone cameras (`src/render/cameraRig.ts`), sky + IBL,
dynamic resolution, SMAA/bloom, colour-blind grading modes, particles and skid
marks driven by measured tyre slip, and a Web Audio synthesiser (engine, tyre,
wind, impacts, radio stations) that suspends when the tab is hidden and falls
back silently if audio is blocked.

Nothing is loaded from disk or the network: every texture and mesh is authored
at boot.

- **Texture library** (`src/render/textures.ts`) — procedural, *tileable* PBR
  sets: albedo, tangent-space normal and roughness are generated from one shared
  height field per surface, so the lighting agrees with the visible detail.
  Asphalt (aggregate, tar patches, hairline cracks, polished wheel tracks),
  gravel, dirt, grass, rock, sand, concrete, foliage and cloud noise.
- **Material library** (`src/render/materials.ts`) — height-based exponential fog
  (valleys haze, peaks stay crisp), wetness that darkens albedo and drops
  roughness on flat ground, animated water ripples, and a tri-biome ground-detail
  pass that blends grass/sand/rock detail albedo *and* detail normals from
  bake-time biome weights plus slope, at two rotated scales to hide tiling, on
  top of two octaves of macro variation that break big fields into patches of
  growth, dry straw and shaded hollows.
- **Car modelling** (`src/render/carMesh.ts`) — bodies are lofted from rounded
  rectangular cross-sections per body style (supercar, coupe, muscle, hatch,
  sedan, SUV, truck, van, buggy) with caps, arch liners and arch lips, separate
  glass, pillars, bumpers, grille, splitter, diffuser, mirrors, spoilers and
  exhausts; wheels are full assemblies (tyre torus, tread blocks, barrel, face,
  ten spokes, hub, brake disc, caliper); interiors get dash, tunnel, seats and
  wheel; head/tail lights are emissive with real headlight spotlights.
- **Lighting** (`src/render/scene.ts`) — Preetham sky modelled for IBL, two
  shadow cascades (a tight 84 m box that follows the car for crisp contact
  shadows and a wide 340 m cascade for the landscape), a procedural cloud dome
  with sun-forward scattering, per-car contact-shadow blobs that fade with wheel
  load, and a filmic grade with split toning, grain and vignette.
- **Ground cover** (`src/render/groundCover.ts`) — crossed alpha-cutout grass
  cards in a 76 m disc that follows the camera, wind-swayed in the vertex shader
  and tinted from the biome colour beneath them. Placement is a hashed jittered
  grid (deterministic, no per-chunk bookkeeping) that skips tarmac, shoulders,
  water, snow, desert, volcanic ground and steep slopes using the same queries
  the tyres use; density fades toward the rim so the disc edge is not a circle.
  Rebuilds only when the camera has moved 6 m (~3-12 ms), so cost is flat.
  Measured: ~150 instances on the coastal start, ~2 000 inland.
- **World dressing** — the horizon is closed by a coarse distant-landscape mesh
  plus procedural ridge systems beyond the playable square, roads carry painted
  lane markings that follow crests and camber, and props are multi-part
  instanced geometry (layered conifer canopies, branched broadleaves, curved palm
  trunks, displaced rock, buildings with window bands and eaves).

Quality presets gate the cost: `low` drops the far shadow cascade, ground detail
and anisotropy; `ultra` raises shadow resolution, anisotropy and terrain
resolution.

A ground-truth AO pass was prototyped and **removed**: its depth/normal G-buffer
reconstructed the 7 km sky sphere to garbage and flooded the horizon with the
normal-buffer clear colour, and the cost was a second full scene render. It was
replaced with shadow cascades plus per-car contact blobs, which cover the cue
that actually matters (the car sitting on the road) without the artifact.

### Accessibility

Keyboard and gamepad navigation with visible focus on every menu, scalable UI,
reduced motion (disables camera shake and grade animation), colour-blind grading
presets, toggleable HUD, subtitles for objectives, and photo mode.

---

## Architecture

```
index.html            canvas + #ui host + boot overlay
src/main.ts           boot: capability checks, Rapier WASM, loading bar, debug handle
src/game.ts           orchestrator: fixed-step loop, actors, events, rewind, HUD feed
src/core/             input (keyboard/gamepad/touch), math, rng, saves, settings, surfaces
src/data/             cars, events, tyre compounds
src/physics/vehicle.ts  the car: suspension, tyres, drivetrain, damage
src/world/            terrain field, road graph, chunk streaming, props
src/render/           renderer, materials, car meshes, cameras, particles
src/gameplay/         route, race, career, ai, weather, vehicle actor
src/ui/               HUD, screens (menu/pause/events/garage/map/settings/results)
src/net/client.ts     optional WebSocket client
server/index.mjs      optional authoritative multiplayer server
tests/                Vitest suites + a headless stub world
```

**Loop.** `Game.startLoop` samples input once per animation frame, accumulates
real time into a bounded buffer and steps physics at exactly 1/120 s (max 8
substeps, so a 2 s stall is dropped rather than replayed). Poses are
interpolated for rendering, so a low frame rate does not change handling. All
cars resolve their tyre forces, then the shared Rapier world is integrated once
per tick — the order in which cars are processed cannot bias the result.

**Pause safety.** Hiding the tab pauses and suspends audio; returning resets the
accumulator. If a car ever ends up below the terrain or the numbers go non-finite,
it is respawned onto the nearest road instead of falling through the world.

---

## Physics assumptions and validation

The vehicle model is a *game-grade* simulation, not a certified tyre model. Where
the numbers matter they were measured, not guessed:

| Check | Result |
| --- | --- |
| 100 → 0 km/h braking, dry asphalt, 0.9 g claim | **46.2 m** measured (~0.85 g) |
| Sustained lateral acceleration, 80 m radius | **0.95 g** |
| Same stop in the wet | **58.9 m** |
| Determinism (same inputs, two runs) | Δ **0.143 m** after 20 s |

Assumptions: rigid chassis on four point contacts, single contact point per tyre
with a combined-slip friction ellipse, no tyre relaxation length, no chassis
flex, no aero maps beyond a single drag/downforce pair, spring rates derived from
corner mass at the authored ride height, and fixed 1/120 s integration. Wet asphalt
is modelled as a grip multiplier with temperature-dependent recovery. Traffic and
AI use the same model at reduced input rates.

---

## Testing

```bash
npm test          # 6 suites, 48 tests, all headless (no browser, no GPU)
```

| Suite | Covers |
| --- | --- |
| `tests/physics.test.ts` | settle, airborne no-propulsion, brake distance, reverse and slope hold, NaN guard, frame-rate independence, high-speed collisions, 0.9 g braking, 0.98 g cornering |
| `tests/world.test.ts` | road continuity (surface grade and steep fraction along every centreline), junction sanity, height-field agreement |
| `tests/route.test.ts` | every event builds a routable course (>300 m, ≥8 gates), gates above sea level, in bounds, unit directions, ordered even spacing, start heading |
| `tests/race.test.ts` | countdown → running, swept gate crossing at 150 km/h without skipping, standings by route progress, finish + results, wrong-way, drift scoring, speed-trap timeout |
| `tests/ai.test.ts` | the AI drives a closed circuit on its own physics, stays on the road, lifts/brakes for corners |
| `tests/save.test.ts` | save round-trip, corrupt-save repair, old-save migration, payouts, unlocks, wheelspins, buying cars, upgrade/tuning defaults |

The browser probes (`scripts/smoke.mjs` and the local visual scripts) drive the
game through a small debug surface on `window.horizonDrive`: `debugTeleport(x,
z)` moves the car to the nearest road and fills the stream ring so any biome can
be inspected without driving there, `debugProps()` counts instanced scenery by
type, `debugCover()` reports ground-cover instance count, rebuild time and
rejection reasons, and `debugMeshes()`/`debugScene()` dump geometry, material
and shadow state.

`tests/stubWorld.ts` is a headless stand-in for `GameWorld` so world-dependent
logic (routes, races) can be tested in Node without Three.js or WebGL.

`npm run smoke` (needs `npm run build` first, or pass a dev-server URL:
`npm run smoke -- http://localhost:5173`) boots the built bundle in headless
Chromium on SwiftShader, drives the car with synthetic input, starts an event and
finishes it, and asserts the boot → menu → driving → racing → results path plus a
clean console. Last run on this tree:

```
✓ booted in 13.9 s
✓ Enter starts free roam
✓ settled on four wheels (loads 3692/3688/3736/3726 N)
✓ 5 s of throttle → 75 km/h, 56 m travelled
✓ braking 75 → 60 km/h after 1 s, then a full stop
✓ event running — gate 0/31, 78 km/h
✓ finishing an event shows results
✓ 9 roads, 33 chunks, 709 draw calls, 223410 triangles
```

---

## Multiplayer (optional)

```bash
npm run server                       # ws://0.0.0.0:8787, HTTP health at /health
# then open the game with:
http://localhost:5173/?server=ws://localhost:8787
```

Offline play is unaffected: without `?server=` the client is never constructed.

The server (`server/index.mjs`) owns the room, the 20 Hz clock and the message
validation. Clients send **inputs plus the pose their own physics produced**
(`{t:'input', seq, c:[throttle,brake,steer,handbrake], s:{x,y,z,qx,qy,qz,qw,speed}}`)
and never "authoritative positions", so a manipulated client cannot teleport
itself up the order; the server keeps the last accepted sequence per client and
echoes an ack. Remote poses are broadcast for interpolation with a 15 Hz client
send rate. Rate limits (90 inputs/s, 6 chats/10 s, 8 KiB messages, 32 clients,
30 s idle timeout) and range checks are enforced server-side; anything malformed
or out of bounds is dropped.

Interpolation, prediction and reconciliation run on the client: it simulates
locally at 1/120 s, keeps a history ring, and corrects towards acknowledged
state (the rewind ring buffer is the same mechanism). This is deliberately modest
— it is a working prototype for LAN/co-op driving, not a netcode showcase, and
the README says so rather than pretending otherwise.

---

## Known limitations

* **Visual finish is stylised, not photoreal.** Everything is authored in code at
  boot, so there are no authored assets, no baked global illumination, no
  reflection probes, and no cloth/hair/vegetation simulation. Ground and props
  are normal-mapped and AO'd, cars are lofted procedural bodies, and the sky,
  clouds and shadows are real-time only. Populated foliage thins out with
  distance and the LOD swap is visible if you stop and stare at a treeline.
* **Ground cover is a disc, not a texture.** Grass exists within ~76 m of the
  camera and thins out at the rim; on the coastal start there is little of it
  because the shelf is water, sand and tarmac.
* **Rendering cost is real.** Measured on the headless reference run: ~1.6 k draw
  calls and 710 k triangles per frame once shadows are counted (a further ~1.2 M
  triangles when `high` enables the far cascade). Low-end machines should use the
  `low` preset (no far cascade, no ground detail) or the dynamic resolution
  scaler.
* **No damage deformation.** Damage is a set of physical parameters (engine,
  steering, per-wheel grip); panels do not crumple and nothing breaks apart.
* **Traffic is sparse and simple** (10 cars, lane follower, no overtaking logic).
* **AI rivals are competent but not alien-fast**; they use racing-line lookahead
  and braking points, not a full trajectory optimiser.
* **Multiplayer is a companion prototype**, not a service: no matchmaking, no
  persistence, no anti-cheat beyond input/pose validation, no host migration.
* **Rewind** restores the player's car state from 12 Hz snapshots; other cars keep
  moving, so it is an "undo the mistake" tool rather than a full time-rewind.
* No mobile-specific UI layout; the HUD scales but the touch layout is minimal.
* The photo-mode capture grabs the framebuffer, so on some drivers the browser
  may return an empty image when `preserveDrawingBuffer` is off.

---

## Licence

MIT (see [LICENSE](LICENSE)). Third-party libraries and their licences are listed
in [NOTICE.md](NOTICE.md).
