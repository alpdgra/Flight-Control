#!/usr/bin/env node
/*
 * Renders the app icons with headless Chromium so they use the same vector
 * artwork as the game itself. Run with: npm run icons
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PW || '/opt/node22/lib/node_modules/playwright');

const OUT = path.join(__dirname, '..', 'icons');

/* This function is stringified and run inside the page. */
function drawIcon(size, opts) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const S = size / 512;                    // everything below is authored at 512
  const radius = opts.rounded ? 112 * S : 0;

  // backdrop
  ctx.save();
  if (radius) {
    ctx.beginPath();
    const r = radius, w = size, h = size;
    ctx.moveTo(r, 0);
    ctx.arcTo(w, 0, w, h, r);
    ctx.arcTo(w, h, 0, h, r);
    ctx.arcTo(0, h, 0, 0, r);
    ctx.arcTo(0, 0, w, 0, r);
    ctx.closePath();
    ctx.clip();
  }
  const sky = ctx.createLinearGradient(0, 0, size, size);
  sky.addColorStop(0, '#1d4f7d');
  sky.addColorStop(0.55, '#123c63');
  sky.addColorStop(1, '#0a2138');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, size, size);

  // soft glow behind the aircraft
  const glow = ctx.createRadialGradient(size * 0.58, size * 0.44, 0, size * 0.58, size * 0.44, size * 0.55);
  glow.addColorStop(0, 'rgba(120,190,255,0.30)');
  glow.addColorStop(1, 'rgba(120,190,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);

  // The logo lives inside the maskable safe zone (centre 80%).
  const scale = (opts.maskable ? 0.78 : 0.94) * S;
  ctx.translate(size / 2, size / 2);
  ctx.scale(scale, scale);

  // drawn flight path sweeping in from the lower left
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(-198, 176);
  ctx.quadraticCurveTo(-176, 16, -44, -6);
  ctx.quadraticCurveTo(52, -24, 96, -104);
  ctx.strokeStyle = 'rgba(6,20,34,0.45)';
  ctx.lineWidth = 40;
  ctx.stroke();
  ctx.strokeStyle = '#4da3ff';
  ctx.lineWidth = 26;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 9;
  ctx.setLineDash([20, 34]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  // the aircraft, reusing the game's own silhouette
  const spec = window.FC.TYPES.jet;
  const plane = { type: 'jet', spec: spec };
  const heading = Math.atan2(-104 - -6, 96 - -44);

  ctx.save();
  ctx.translate(108, -122);
  ctx.rotate(heading);
  ctx.scale(3.3, 3.3);
  ctx.globalAlpha = 0.20;
  ctx.save();
  ctx.translate(2, 2.8);
  window.FCRender.drawAircraftShape(ctx, plane, 'shadow', 0);
  ctx.restore();
  ctx.globalAlpha = 1;
  window.FCRender.drawAircraftShape(ctx, plane, 'body', 0);
  ctx.restore();

  ctx.restore();
  return canvas.toDataURL('image/png');
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 600, height: 600 } });

  await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');
  for (const file of ['engine.js', 'render.js']) {
    await page.addScriptTag({ path: path.join(__dirname, '..', 'src', file) });
  }
  await page.evaluate(`window.__drawIcon = ${drawIcon.toString()}`);

  const jobs = [
    { name: 'icon-512.png', size: 512, opts: { rounded: true } },
    { name: 'icon-192.png', size: 192, opts: { rounded: true } },
    { name: 'icon-maskable-512.png', size: 512, opts: { maskable: true } },
    { name: 'apple-touch-icon.png', size: 180, opts: {} },
    { name: 'favicon-64.png', size: 64, opts: { rounded: true } }
  ];

  for (const job of jobs) {
    const dataUrl = await page.evaluate(
      `window.__drawIcon(${job.size}, ${JSON.stringify(job.opts)})`
    );
    const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
    fs.writeFileSync(path.join(OUT, job.name), buf);
    console.log(`  ${job.name.padEnd(24)} ${job.size}x${job.size}  ${(buf.length / 1024).toFixed(1)} kB`);
  }

  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
