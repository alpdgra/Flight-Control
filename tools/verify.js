#!/usr/bin/env node
/*
 * Drives the built game in a real browser: checks for runtime errors, plays a
 * few aircraft in with genuine pointer input, exercises every map, resizes to
 * phone dimensions, and writes screenshots to build/shots/.
 *
 * Run with: npm run verify
 */
'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require(process.env.PW || '/opt/node22/lib/node_modules/playwright');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(ROOT, 'build', 'shots');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json'
};

function serve(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(root, rel === '/' ? 'index.html' : rel);
      if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const failures = [];
function check(ok, label, detail) {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
    failures.push(label + (detail ? ': ' + detail : ''));
  }
}

/** Convert a world point to viewport coordinates using the live renderer. */
const TO_SCREEN = `(function (r, x, y) { return { x: x * r.scale + r.offX, y: y * r.scale + r.offY }; })`;

async function grabAndRoute(page) {
  // Aircraft keep moving, so read the position and grab it in as few steps as
  // possible, retrying if the pointer lands just behind a fast jet.
  for (let attempt = 0; attempt < 14; attempt++) {
    const plan = await page.evaluate(`(function () {
      var g = window.__fc.game, r = window.__fc.renderer();
      if (!g) return null;
      var a = null;
      for (var i = 0; i < g.aircraft.length; i++) {
        var c = g.aircraft[i];
        if (c.state === 'flying' && !c.entering && !c.landingZone) { a = c; break; }
      }
      if (!a) return null;
      var zone = null;
      for (var j = 0; j < g.zones.length; j++) {
        if (g.zones[j].accepts.indexOf(a.type) !== -1) { zone = g.zones[j]; break; }
      }
      var ts = ${TO_SCREEN};
      return {
        type: a.type,
        from: ts(r, a.x, a.y),
        to: ts(r, zone.x, zone.y)
      };
    })()`);

    if (!plan) { await page.waitForTimeout(400); continue; }

    await page.mouse.move(plan.from.x, plan.from.y);
    await page.mouse.down();
    const grabbed = await page.evaluate('Object.keys(window.__fc.game.drags).length > 0');
    if (!grabbed) { await page.mouse.up(); continue; }

    const steps = 12;
    for (let s = 1; s <= steps; s++) {
      await page.mouse.move(
        plan.from.x + (plan.to.x - plan.from.x) * s / steps,
        plan.from.y + (plan.to.y - plan.from.y) * s / steps
      );
    }
    await page.mouse.up();

    const routed = await page.evaluate(`(function () {
      var g = window.__fc.game;
      for (var i = 0; i < g.aircraft.length; i++) if (g.aircraft[i].landingZone) return true;
      return false;
    })()`);
    if (routed) return plan.type;
  }
  return null;
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { server, port } = await serve(ROOT);
  const base = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch();

  const errors = [];
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`console.${m.type()}: ${m.text()}`);
  });

  console.log('\nDesktop (1440x900)');
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction('window.__fc && window.__fc.screen === "menu"', null, { timeout: 10000 });
  await page.waitForTimeout(1200);

  check(await page.$$eval('.map-card', (n) => n.length) === 3, 'menu lists all three airports');
  check(await page.evaluate('!!window.__fc.attract'), 'attract game runs behind the menu');
  check(await page.evaluate('window.__fc.attract.aircraft.length > 0'), 'attract traffic is airborne');

  // the canvas must actually have paint on it
  const painted = await page.evaluate(`(function () {
    var c = document.getElementById('stage');
    var d = c.getContext('2d').getImageData(c.width >> 1, (c.height * 3) >> 2, 8, 8).data;
    var sum = 0;
    for (var i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
    return sum;
  })()`);
  check(painted > 0, 'terrain is drawn to the canvas', 'canvas sampled empty');

  await page.screenshot({ path: path.join(SHOTS, '01-menu.png') });

  await page.click('#help-btn');
  await page.waitForTimeout(400);
  check(await page.$$eval('.legend-row', (n) => n.length) === 5, 'help screen lists every aircraft type');
  await page.screenshot({ path: path.join(SHOTS, '02-help.png') });
  await page.click('#help-close');
  await page.waitForTimeout(300);

  // ---- play each map -------------------------------------------------------
  const maps = await page.evaluate('window.FC.MAPS.map(function (m) { return m.id; })');
  for (const mapId of maps) {
    await page.evaluate(`window.__fc.start(${JSON.stringify(mapId)})`);
    await page.waitForFunction('window.__fc.screen === "playing"');
    await page.waitForTimeout(2600);

    const type = await grabAndRoute(page);
    check(!!type, `${mapId}: a route can be drawn with the mouse`, 'never grabbed an aircraft');

    // Clear the rest of the sky so the landing is what is under test, not
    // whether the remaining traffic happens to stay apart while we watch.
    await page.evaluate(`(function () {
      var g = window.__fc.game;
      g.spawnTimer = Infinity;
      g.aircraft = g.aircraft.filter(function (a) { return a.landingZone; });
    })()`);

    let landed = false;
    for (let i = 0; i < 60 && !landed; i++) {
      landed = await page.evaluate('window.__fc.game && window.__fc.game.score > 0');
      if (!landed) await page.waitForTimeout(500);
    }
    check(landed, `${mapId}: the routed aircraft lands and scores`);
    check(await page.evaluate('window.__fc.screen === "playing" || window.__fc.screen === "over"'),
      `${mapId}: game is in a sane state`);
    await page.screenshot({ path: path.join(SHOTS, `03-play-${mapId}.png`) });
  }

  // ---- pause / resume ------------------------------------------------------
  await page.evaluate('window.__fc.start("airfield")');
  await page.waitForFunction('window.__fc.screen === "playing"');
  await page.waitForTimeout(1500);
  await page.click('#pause-btn');
  await page.waitForTimeout(300);
  check(await page.evaluate('window.__fc.screen === "paused"'), 'pause button pauses');
  const frozen = await page.evaluate('window.__fc.game.elapsed');
  await page.waitForTimeout(700);
  check(await page.evaluate('window.__fc.game.elapsed') === frozen, 'the simulation is frozen while paused');
  await page.screenshot({ path: path.join(SHOTS, '04-paused.png') });
  await page.click('#resume-btn');
  await page.waitForTimeout(500);
  check(await page.evaluate('window.__fc.game.elapsed') > frozen, 'resuming restarts the simulation');

  // ---- game over ----------------------------------------------------------
  await page.evaluate(`(function () {
    var g = window.__fc.game;
    var A = new window.FC.Aircraft('jet', g.W * 0.5, g.H * 0.5, 0);
    var B = new window.FC.Aircraft('jet', g.W * 0.5 + 70, g.H * 0.5, Math.PI);
    A.entering = B.entering = false;
    g.aircraft.push(A, B);
  })()`);
  await page.waitForFunction('window.__fc.screen === "over"', null, { timeout: 8000 });
  check(true, 'a mid-air collision ends the game');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, '05-gameover.png') });
  check(await page.$eval('#final-score', (n) => n.textContent) !== '', 'game over shows the final score');

  await page.click('#again-btn');
  await page.waitForFunction('window.__fc.screen === "playing"');
  check(await page.evaluate('window.__fc.game.score === 0'), 'fly again starts a fresh game');

  // ---- resizing while playing ---------------------------------------------
  const beforeW = await page.evaluate('window.__fc.game.W');
  await page.setViewportSize({ width: 900, height: 900 });
  await page.waitForTimeout(500);
  const afterW = await page.evaluate('window.__fc.game.W');
  check(afterW !== beforeW, 'the world reflows when the window is resized');
  check(await page.evaluate(`(function () {
    var g = window.__fc.game;
    for (var i = 0; i < g.aircraft.length; i++) {
      var a = g.aircraft[i];
      if (!isFinite(a.x) || !isFinite(a.y)) return false;
      if (a.x < -200 || a.x > g.W + 200 || a.y < -200 || a.y > g.H + 200) return false;
    }
    return true;
  })()`), 'aircraft stay in the world after a resize');

  await page.close();
  await context.close();

  // ---- iPhone -------------------------------------------------------------
  console.log('\niPhone 14 (touch, landscape 844x390)');
  const phone = await browser.newContext({
    viewport: { width: 844, height: 390 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
               '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  });
  const pp = await phone.newPage();
  const phoneErrors = [];
  pp.on('pageerror', (e) => phoneErrors.push('pageerror: ' + e.message));
  pp.on('console', (m) => {
    if (m.type() === 'error') phoneErrors.push('console.error: ' + m.text());
  });
  await pp.goto(base, { waitUntil: 'load' });
  await pp.waitForFunction('window.__fc && window.__fc.screen === "menu"', null, { timeout: 10000 });
  await pp.waitForTimeout(900);
  await pp.screenshot({ path: path.join(SHOTS, '06-phone-menu.png') });

  await pp.evaluate('window.__fc.start("coralbay")');
  await pp.waitForFunction('window.__fc.screen === "playing"');
  await pp.waitForTimeout(2500);

  // touch-drag an aircraft to its zone
  const touchRouted = await pp.evaluate(`(function () {
    var g = window.__fc.game, r = window.__fc.renderer();
    var a = null;
    for (var i = 0; i < g.aircraft.length; i++) {
      var c = g.aircraft[i];
      if (c.state === 'flying' && !c.entering) { a = c; break; }
    }
    if (!a) return 'no aircraft';
    var zone = null;
    for (var j = 0; j < g.zones.length; j++) {
      if (g.zones[j].accepts.indexOf(a.type) !== -1) { zone = g.zones[j]; break; }
    }
    var ts = ${TO_SCREEN};
    var from = ts(r, a.x, a.y), to = ts(r, zone.x, zone.y);
    var canvas = document.getElementById('stage');
    function fire(type, x, y) {
      canvas.dispatchEvent(new PointerEvent(type, {
        pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true,
        clientX: x, clientY: y
      }));
    }
    fire('pointerdown', from.x, from.y);
    for (var s = 1; s <= 10; s++) {
      fire('pointermove', from.x + (to.x - from.x) * s / 10, from.y + (to.y - from.y) * s / 10);
    }
    fire('pointerup', to.x, to.y);
    return a.landingZone ? 'ok' : 'not routed';
  })()`);
  check(touchRouted === 'ok', 'touch input routes an aircraft', touchRouted);

  await pp.waitForTimeout(1200);
  await pp.screenshot({ path: path.join(SHOTS, '07-phone-play.png') });

  // two fingers at once — wait for enough traffic to have arrived
  await pp.waitForFunction(`(function () {
    var g = window.__fc.game, n = 0;
    for (var i = 0; i < g.aircraft.length; i++) {
      var c = g.aircraft[i];
      if (c.state === 'flying' && !c.entering) n++;
    }
    return n >= 2;
  })()`, null, { timeout: 30000 });

  const multi = await pp.evaluate(`(function () {
    var g = window.__fc.game, r = window.__fc.renderer();
    var free = [];
    for (var i = 0; i < g.aircraft.length && free.length < 2; i++) {
      var c = g.aircraft[i];
      if (c.state === 'flying' && !c.entering) free.push(c);
    }
    if (free.length < 2) return 'need two aircraft';
    var ts = ${TO_SCREEN};
    var canvas = document.getElementById('stage');
    function fire(type, id, x, y) {
      canvas.dispatchEvent(new PointerEvent(type, {
        pointerId: id, pointerType: 'touch', bubbles: true, cancelable: true,
        clientX: x, clientY: y
      }));
    }
    var p0 = ts(r, free[0].x, free[0].y), p1 = ts(r, free[1].x, free[1].y);
    fire('pointerdown', 11, p0.x, p0.y);
    fire('pointerdown', 12, p1.x, p1.y);
    var n = Object.keys(g.drags).length;
    fire('pointermove', 11, p0.x + 40, p0.y + 40);
    fire('pointermove', 12, p1.x - 40, p1.y + 40);
    fire('pointerup', 11, p0.x + 40, p0.y + 40);
    fire('pointerup', 12, p1.x - 40, p1.y + 40);
    return n;
  })()`);
  check(multi === 2, 'two aircraft can be routed at once on touch', 'concurrent drags: ' + multi);

  // portrait
  await pp.setViewportSize({ width: 390, height: 844 });
  await pp.waitForTimeout(600);
  check(await pp.evaluate('document.body.classList.contains("is-portrait")'),
    'portrait orientation is detected');
  await pp.screenshot({ path: path.join(SHOTS, '08-phone-portrait.png') });

  // ---- offline / installability -------------------------------------------
  const swReady = await pp.evaluate(`navigator.serviceWorker.getRegistrations().then(function (r) { return r.length; })`);
  check(swReady >= 1, 'a service worker is registered for offline play', 'registrations: ' + swReady);
  const manifest = await pp.evaluate(`fetch('manifest.webmanifest').then(function (r) { return r.ok; })`);
  check(manifest === true, 'the web app manifest is served');

  await phone.close();

  // ---- opened straight off the disk ---------------------------------------
  // Double-clicking index.html on a Mac loads it over file://, where there is
  // no origin for a service worker and storage may be restricted. The game has
  // to run there too, so check it explicitly.
  console.log('\nfile:// (double-clicked on disk)');
  const local = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const lp = await local.newPage();
  const localErrors = [];
  lp.on('pageerror', (e) => localErrors.push('pageerror: ' + e.message));
  lp.on('console', (m) => { if (m.type() === 'error') localErrors.push('console.error: ' + m.text()); });

  await lp.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'load' });
  await lp.waitForFunction('window.__fc && window.__fc.screen === "menu"', null, { timeout: 10000 });
  await lp.waitForTimeout(1200);
  check(await lp.$$eval('.map-card', (n) => n.length) === 3, 'menu renders from a local file');
  await lp.evaluate('window.__fc.start("airfield")');
  await lp.waitForFunction('window.__fc.screen === "playing"');
  await lp.waitForTimeout(3500);
  check(await lp.evaluate('window.__fc.game.aircraft.length') > 0, 'traffic arrives when run from disk');
  check(localErrors.length === 0, 'no errors when run from disk', localErrors.slice(0, 3).join(' | '));
  await local.close();

  await browser.close();
  server.close();

  console.log('\nRuntime errors');
  const allErrors = errors.concat(phoneErrors);
  check(allErrors.length === 0, 'no console errors or unhandled exceptions',
    allErrors.slice(0, 6).join(' | '));

  console.log(`\nScreenshots in ${path.relative(ROOT, SHOTS)}/`);
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed:`);
    failures.forEach((f) => console.error('  - ' + f));
    process.exit(1);
  }
  console.log('\nAll browser checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
