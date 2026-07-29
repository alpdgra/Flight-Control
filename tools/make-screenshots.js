#!/usr/bin/env node
/*
 * Writes the README screenshots in docs/.
 *
 * The scenes are composed deliberately rather than captured from live play, so
 * the images are reproducible and actually show what they are meant to: a few
 * aircraft of each type, each with a drawn route onto its landing zone.
 *
 * Run with: npm run screenshots
 */
'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require(process.env.PW || '/opt/node22/lib/node_modules/playwright');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json'
};

function serve(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(root, rel === '/' ? 'index.html' : rel);
      if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/*
 * Each entry places aircraft as a fraction of the world size and routes them to
 * the named zone. Positions are chosen so the routes read clearly and do not
 * overlap the HUD.
 */
const SCENES = {
  airfield: [
    { type: 'jet', at: [0.14, 0.62], zone: 'main' },
    { type: 'jumbo', at: [0.32, 0.16], zone: 'main' },
    { type: 'prop', at: [0.60, 0.86], zone: 'strip' },
    { type: 'heli', at: [0.88, 0.44], zone: 'pad' }
  ],
  coralbay: [
    { type: 'jumbo', at: [0.16, 0.16], zone: 'main' },
    { type: 'prop', at: [0.12, 0.84], zone: 'strip' },
    { type: 'seaplane', at: [0.86, 0.86], zone: 'water' },
    { type: 'heli', at: [0.60, 0.40], zone: 'pad' }
  ],
  taskforce: [
    { type: 'jet', at: [0.10, 0.66], zone: 'deck' },
    { type: 'prop', at: [0.52, 0.86], zone: 'amphib' },
    { type: 'seaplane', at: [0.46, 0.44], zone: 'water' },
    { type: 'heli', at: [0.86, 0.68], zone: 'pad' }
  ]
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { server, port } = await serve(ROOT);
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1200, height: 750 },
    deviceScaleFactor: 1
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // mark the tutorial hint as already seen so it does not sit over the traffic
  await page.addInitScript(() => {
    window.localStorage.setItem('flightcontrol.seenhelp.v1', 'true');
  });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForFunction('window.__fc && window.__fc.screen === "menu"');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, 'menu.png') });
  console.log('  menu.png');

  for (const mapId of Object.keys(SCENES)) {
    await page.evaluate(`window.__fc.start(${JSON.stringify(mapId)})`);
    await page.waitForFunction('window.__fc.screen === "playing"');

    await page.evaluate(`(function (scene) {
      var g = window.__fc.game;
      g.spawnTimer = Infinity;      // compose the scene, do not let traffic arrive
      g.aircraft.length = 0;
      scene.forEach(function (s, i) {
        var a = new window.FC.Aircraft(s.type, g.W * s.at[0], g.H * s.at[1], 0);
        a.entering = false;
        g.aircraft.push(a);
        var z = null;
        for (var j = 0; j < g.zones.length; j++) if (g.zones[j].id === s.zone) z = g.zones[j];
        var id = 'shot' + i;
        if (!g.beginDrag(id, a.x, a.y)) return;
        for (var k = 1; k <= 10; k++) {
          g.dragTo(id, a.x + (z.x - a.x) * k / 10, a.y + (z.y - a.y) * k / 10);
        }
        g.endDrag(id, z.x, z.y);
      });
    })(${JSON.stringify(SCENES[mapId])})`);

    // one frame to draw, and no simulation time so nothing drifts or collides
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(OUT, `${mapId}.png`) });
    console.log(`  ${mapId}.png`);
  }

  await browser.close();
  server.close();

  if (errors.length) {
    console.error('page errors:', errors.slice(0, 3).join(' | '));
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
