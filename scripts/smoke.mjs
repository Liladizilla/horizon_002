#!/usr/bin/env node
/**
 * Browser smoke test.
 *
 * Boots the *built* bundle in headless Chromium (SwiftShader, so it works on a
 * machine with no GPU), then exercises the real code paths: boot → menu →
 * driving → racing → results, checking for console errors and for the numbers
 * actually moving. Run after `npm run build`:
 *
 *   npm run smoke                 # serves dist/ on :4173, runs the test
 *   npm run smoke -- http://localhost:5173   # test a dev server instead
 *
 * Exits non-zero on failure.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const explicitUrl = process.argv[2];
const errors = [];
let server = null;

async function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function fail(msg) {
  console.error(`\n  ✖ ${msg}\n`);
  process.exitCode = 1;
}

const url = explicitUrl ?? 'http://127.0.0.1:4173/';
if (!explicitUrl) {
  server = spawn('npx', ['vite', 'preview', '--port', '4173', '--host', '127.0.0.1'], {
    stdio: 'ignore', detached: false,
  });
  if (!(await waitForServer(url))) {
    fail('preview server did not start (did you run npm run build?)');
    server.kill();
    process.exit(1);
  }
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`); });

try {
  await page.addInitScript(() => {
    // Low quality keeps SwiftShader usable; the game logic is identical.
    localStorage.setItem('horizon-drive.settings.v3', JSON.stringify({
      quality: 'low', shadows: false, antialias: 'off', reflections: false, bloom: false,
      renderScale: 0.5, dynamicResolution: false, foliageDensity: 0.3, particleDensity: 0.3,
    }));
  });

  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  const booted = await page.waitForFunction(() => window.horizonDrive?.debug?.state === 'menu', null, { timeout: 180000 })
    .then(() => true).catch(() => false);
  if (!booted) {
    fail(`game did not reach the menu. Boot text: ${await page.evaluate(() => document.getElementById('boot')?.innerText ?? '(no boot overlay)')}`);
    throw new Error('boot failed');
  }
  console.log(`  ✓ booted in ${Date.now() - t0} ms`);

  // ---- menu → driving -----------------------------------------------------
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const driving = await page.evaluate(() => window.horizonDrive.debug.state);
  if (driving !== 'driving') fail(`expected state "driving" after Enter, got "${driving}"`);
  else console.log('  ✓ Enter starts free roam');

  // ---- the car settles on its suspension ----------------------------------
  const settle = await page.evaluate(() => {
    const g = window.horizonDrive;
    for (let i = 0; i < 180; i++) { g.setRawInput({ throttle: 0 }); g.stepPhysicsManual(1 / 120); }
    return { wheels: g.debug.wheels.map((w) => ({ contact: w.contact, load: Math.round(w.load) })), y: +g.debug.playerPosition.y.toFixed(2) };
  });
  if (!settle.wheels.every((w) => w.contact && w.load > 500)) fail(`car did not settle on all four wheels: ${JSON.stringify(settle.wheels)}`);
  else console.log(`  ✓ settled on four wheels (loads ${settle.wheels.map((w) => w.load).join('/')} N)`);

  // ---- throttle actually moves the car ------------------------------------
  const accel = await page.evaluate(() => {
    const g = window.horizonDrive;
    const start = { ...g.debug.playerPosition };
    for (let i = 0; i < 600; i++) { g.setRawInput({ throttle: 1 }); g.stepPhysicsManual(1 / 120); }
    const end = g.debug.playerPosition;
    return { kmh: Math.round(g.debug.speedKmh), moved: +Math.hypot(end.x - start.x, end.z - start.z).toFixed(1) };
  });
  if (accel.kmh < 40 || accel.moved < 20) fail(`car barely moved on full throttle: ${JSON.stringify(accel)}`);
  else console.log(`  ✓ 5 s of throttle → ${accel.kmh} km/h, ${accel.moved} m travelled`);

  // ---- braking (brake held past a standstill engages reverse, so look for the
  // minimum speed reached rather than the speed at a fixed time) --------------
  // Measured over the first second of braking: the car is put straight into a
  // corner-less sprint above, so it may end up on the verge (lower grip) — the
  // initial deceleration is the surface-independent number to assert on.
  const brake = await page.evaluate(() => {
    const g = window.horizonDrive;
    const from = g.player.sim.readout.forwardSpeedMs * 3.6;
    for (let i = 0; i < 120; i++) { g.setRawInput({ throttle: 0, brake: 1 }); g.stepPhysicsManual(1 / 120); }
    const after = g.player.sim.readout.forwardSpeedMs * 3.6;
    let stopped = false;
    for (let i = 0; i < 400 && !stopped; i++) {
      g.setRawInput({ throttle: 0, brake: 1 });
      g.stepPhysicsManual(1 / 120);
      if (Math.abs(g.player.sim.readout.forwardSpeedMs) < 1.5) stopped = true;
    }
    return { from: Math.round(from), afterOneSecond: Math.round(after), stopped };
  });
  const shed = brake.from - brake.afterOneSecond;
  if (shed < 15) fail(`braking too weak: ${brake.from} → ${brake.afterOneSecond} km/h in 1 s`);
  else if (!brake.stopped) fail(`car never reached a standstill under braking (${brake.from} km/h start)`);
  else console.log(`  ✓ braking ${brake.from} → ${brake.afterOneSecond} km/h after 1 s, then a full stop`);

  // ---- an event runs, counts down and reaches the track -------------------
  const race = await page.evaluate(() => {
    const g = window.horizonDrive;
    g.startEvent('festival-circuit');
    // 5 s of countdown plus a few seconds of running.
    for (let i = 0; i < 120 * 8; i++) { g.setRawInput({ throttle: 1 }); g.stepPhysicsManual(1 / 120); }
    return { state: g.debug.state, race: g.debug.race, kmh: Math.round(g.debug.speedKmh) };
  });
  if (race.state !== 'racing') fail(`event did not enter racing state: ${race.state}`);
  if (!race.race || race.race.state !== 'running') fail(`race session not running: ${JSON.stringify(race.race)}`);
  else console.log(`  ✓ event running — gate ${race.race.gate}/${race.race.gates}, ${race.kmh} km/h`);

  // ---- results screen ------------------------------------------------------
  const results = await page.evaluate(() => {
    const g = window.horizonDrive;
    for (const p of g.race.progress.values()) { p.finished = true; p.finishTime = 72.4; }
    g.stepPhysicsManual(1 / 120);
    return { state: g.debug.state, text: (document.querySelector('.screen')?.textContent ?? '').slice(0, 120) };
  });
  if (results.state !== 'results') fail(`finishing did not show results: ${results.state}`);
  else console.log('  ✓ finishing an event shows results');

  // ---- renderer sanity -----------------------------------------------------
  const scene = await page.evaluate(() => window.horizonDrive.debug.world);
  if (!(scene.roads >= 9) || !(scene.chunks > 5) || !(scene.drawCalls > 10)) {
    fail(`world looks wrong: ${JSON.stringify(scene)}`);
  } else {
    console.log(`  ✓ ${scene.roads} roads, ${scene.chunks} chunks, ${scene.drawCalls} draw calls, ${scene.triangles} triangles`);
  }
} catch (err) {
  if (!process.exitCode) fail(String(err));
}

await browser.close();
server?.kill();

if (errors.length) {
  console.error(`\n  ✖ ${errors.length} console error(s):`);
  for (const e of errors.slice(0, 10)) console.error(`    ${e}`);
  process.exitCode = 1;
}

console.log(process.exitCode ? '\n  smoke test FAILED\n' : '\n  smoke test passed\n');
