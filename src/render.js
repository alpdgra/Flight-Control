/*
 * Flight Control — renderer
 * ---------------------------------------------------------------------------
 * Everything is drawn procedurally with the 2D canvas API; the game ships as a
 * single file with no image assets. Static terrain is painted once into an
 * offscreen canvas and blitted each frame.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.FCRender = factory(root.FC);
})(typeof self !== 'undefined' ? self : this, function (FC) {
  'use strict';

  // How far in front of each tip the landing chevrons are drawn.
  var CHEVRON_LEAD = 78;

  var clamp = FC.util.clamp;
  var lerp = FC.util.lerp;
  var mulberry32 = FC.util.mulberry32;
  var TAU = Math.PI * 2;

  function hash(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  // ------------------------------------------------------------------ palette

  var THEMES = {
    grass: {
      base: ['#4c9a42', '#3f8a3a'],
      patches: ['#57a54b', '#68b45a', '#4a9440', '#7abd63', '#43903c'],
      water: '#4083bb',
      waterEdge: '#63a3d4',
      road: '#9a9da1',
      roadEdge: '#7d8085',
      tree: '#2c6630',
      treeDark: '#1f4d24',
      building: '#d8dce0',
      buildingRoof: '#b3bac1',
      asphalt: '#3c4249',
      asphaltEdge: '#2b3036',
      marking: '#eef2f6',
      vignette: 'rgba(12,40,16,0.30)'
    },
    island: {
      base: ['#1f7ba8', '#155f8a'],
      patches: ['#2c8fb8', '#1a6d97', '#35a0c2'],
      shallow: '#48bcc4',
      shallow2: '#7ad7d0',
      sand: '#ecd9a4',
      land: '#4e9c44',
      landDark: '#3d8438',
      tree: '#2c6630',
      treeDark: '#1f4d24',
      building: '#e6e0d0',
      buildingRoof: '#c2b49a',
      asphalt: '#3c4249',
      asphaltEdge: '#2b3036',
      marking: '#eef2f6',
      foam: 'rgba(235,250,255,0.55)',
      vignette: 'rgba(4,30,54,0.34)'
    },
    ocean: {
      base: ['#1d5b86', '#123f63'],
      patches: ['#22688f', '#1a5178', '#2a7398'],
      foam: 'rgba(220,240,252,0.5)',
      hull: '#4d5761',
      hullDark: '#39424b',
      deck: '#333b43',
      deckLight: '#485159',
      marking: '#eef2f6',
      asphalt: '#333b43',
      asphaltEdge: '#242b32',
      vignette: 'rgba(2,22,42,0.38)'
    }
  };

  // ------------------------------------------------------------ shape helpers

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** A closed organic blob, used for islands, fields and cloud puffs. */
  function blob(ctx, cx, cy, radius, wobble, points, rng, squashY) {
    squashY = squashY == null ? 1 : squashY;
    var pts = [];
    for (var i = 0; i < points; i++) {
      var a = (i / points) * TAU;
      var r = radius * (1 - wobble / 2 + rng() * wobble);
      pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r * squashY });
    }
    ctx.beginPath();
    ctx.moveTo((pts[0].x + pts[points - 1].x) / 2, (pts[0].y + pts[points - 1].y) / 2);
    for (var j = 0; j < points; j++) {
      var cur = pts[j];
      var next = pts[(j + 1) % points];
      ctx.quadraticCurveTo(cur.x, cur.y, (cur.x + next.x) / 2, (cur.y + next.y) / 2);
    }
    ctx.closePath();
    return pts;
  }

  // ------------------------------------------------------------------ terrain

  function paintGrass(ctx, W, H, rng, T) {
    var g = ctx.createLinearGradient(0, 0, W * 0.35, H);
    g.addColorStop(0, T.base[0]);
    g.addColorStop(1, T.base[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // patchwork fields
    for (var i = 0; i < 26; i++) {
      ctx.save();
      var cx = rng() * W, cy = rng() * H;
      ctx.translate(cx, cy);
      ctx.rotate((rng() - 0.5) * 0.9);
      ctx.globalAlpha = 0.30 + rng() * 0.30;
      ctx.fillStyle = T.patches[(rng() * T.patches.length) | 0];
      var w = 120 + rng() * 300, h = 80 + rng() * 190;
      roundRect(ctx, -w / 2, -h / 2, w, h, 14);
      ctx.fill();
      ctx.restore();
    }

    // river
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    var riverPts = [];
    var ry = H * 0.90;
    for (var x = -40; x <= W + 40; x += W / 9) {
      riverPts.push({ x: x, y: ry });
      ry += (rng() - 0.45) * 150;
      ry = clamp(ry, H * 0.42, H * 1.05);
    }
    function strokeRiver(width, color) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(riverPts[0].x, riverPts[0].y);
      for (var k = 1; k < riverPts.length - 1; k++) {
        var mx = (riverPts[k].x + riverPts[k + 1].x) / 2;
        var my = (riverPts[k].y + riverPts[k + 1].y) / 2;
        ctx.quadraticCurveTo(riverPts[k].x, riverPts[k].y, mx, my);
      }
      ctx.stroke();
    }
    strokeRiver(48, T.waterEdge);
    strokeRiver(36, T.water);
    ctx.restore();

    // roads
    ctx.save();
    ctx.lineCap = 'round';
    for (var r = 0; r < 3; r++) {
      var x0 = rng() * W, y0 = rng() * H;
      var x1 = rng() * W, y1 = rng() * H;
      ctx.strokeStyle = T.roadEdge; ctx.lineWidth = 15;
      ctx.beginPath(); ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo((x0 + x1) / 2 + (rng() - 0.5) * 300, (y0 + y1) / 2 + (rng() - 0.5) * 300, x1, y1);
      ctx.stroke();
      ctx.strokeStyle = T.road; ctx.lineWidth = 10;
      ctx.stroke();
    }
    ctx.restore();

    paintTrees(ctx, W, H, rng, T, 54);
    paintFarmBuildings(ctx, W, H, rng, T, 9);
  }

  function paintTrees(ctx, W, H, rng, T, count) {
    for (var i = 0; i < count; i++) {
      var cx = rng() * W, cy = rng() * H;
      var n = 2 + ((rng() * 4) | 0);
      for (var j = 0; j < n; j++) {
        var ox = cx + (rng() - 0.5) * 70;
        var oy = cy + (rng() - 0.5) * 60;
        var rad = 9 + rng() * 11;
        ctx.fillStyle = 'rgba(0,0,0,0.13)';
        ctx.beginPath(); ctx.arc(ox + 5, oy + 7, rad, 0, TAU); ctx.fill();
        ctx.fillStyle = T.treeDark;
        ctx.beginPath(); ctx.arc(ox, oy, rad, 0, TAU); ctx.fill();
        ctx.fillStyle = T.tree;
        ctx.beginPath(); ctx.arc(ox - rad * 0.18, oy - rad * 0.22, rad * 0.8, 0, TAU); ctx.fill();
      }
    }
  }

  function paintFarmBuildings(ctx, W, H, rng, T, count) {
    for (var i = 0; i < count; i++) {
      ctx.save();
      ctx.translate(rng() * W, rng() * H);
      ctx.rotate((rng() - 0.5) * 1.2);
      var w = 34 + rng() * 56, h = 24 + rng() * 32;
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      roundRect(ctx, -w / 2 + 6, -h / 2 + 8, w, h, 4); ctx.fill();
      ctx.fillStyle = T.building;
      roundRect(ctx, -w / 2, -h / 2, w, h, 4); ctx.fill();
      ctx.fillStyle = T.buildingRoof;
      roundRect(ctx, -w / 2, -h / 2, w, h * 0.45, 4); ctx.fill();
      ctx.restore();
    }
  }

  function paintWaterBase(ctx, W, H, rng, T) {
    var g = ctx.createLinearGradient(0, 0, W * 0.4, H);
    g.addColorStop(0, T.base[0]);
    g.addColorStop(1, T.base[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    for (var i = 0; i < 24; i++) {
      ctx.save();
      ctx.globalAlpha = 0.20 + rng() * 0.22;
      ctx.fillStyle = T.patches[(rng() * T.patches.length) | 0];
      blob(ctx, rng() * W, rng() * H, 100 + rng() * 260, 0.5, 9, rng, 0.5);
      ctx.fill();
      ctx.restore();
    }
    // wave streaks
    ctx.save();
    ctx.strokeStyle = T.foam || 'rgba(255,255,255,0.35)';
    ctx.lineCap = 'round';
    for (var w = 0; w < 130; w++) {
      var x = rng() * W, y = rng() * H, len = 16 + rng() * 44;
      ctx.globalAlpha = 0.10 + rng() * 0.22;
      ctx.lineWidth = 1.5 + rng() * 2.5;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + len / 2, y - 4 + rng() * 8, x + len, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function paintIsland(ctx, W, H, rng, T, zones) {
    paintWaterBase(ctx, W, H, rng, T);

    // Land masses hosting the two runways plus the helipad, drawn generously so
    // the strips always sit on solid ground.
    var land = [];
    for (var z = 0; z < zones.length; z++) {
      var zn = zones[z];
      if (zn.kind === 'water') continue;
      var rad = zn.kind === 'helipad' ? zn.radius * 2.6 : zn.length * 0.72;
      land.push({ x: zn.x, y: zn.y, r: rad });
    }
    land.push({ x: W * 0.08, y: H * 0.16, r: 150 });

    for (var i = 0; i < land.length; i++) {
      var L = land[i];
      // reef halo
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = T.shallow;
      blob(ctx, L.x, L.y, L.r * 1.55, 0.34, 13, mulberry32(hash('reef' + i)), 0.82);
      ctx.fill();
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = T.shallow2;
      blob(ctx, L.x, L.y, L.r * 1.26, 0.30, 13, mulberry32(hash('reef2' + i)), 0.82);
      ctx.fill();
      ctx.restore();
      // sand then grass
      ctx.fillStyle = T.sand;
      blob(ctx, L.x, L.y, L.r * 1.06, 0.26, 15, mulberry32(hash('sand' + i)), 0.85);
      ctx.fill();
      ctx.fillStyle = T.landDark;
      blob(ctx, L.x, L.y, L.r * 0.94, 0.24, 15, mulberry32(hash('land' + i)), 0.85);
      ctx.fill();
      ctx.fillStyle = T.land;
      blob(ctx, L.x - L.r * 0.04, L.y - L.r * 0.05, L.r * 0.86, 0.22, 15, mulberry32(hash('land2' + i)), 0.85);
      ctx.fill();
    }

    // palms and huts scattered on the land only
    for (var t = 0; t < 70; t++) {
      var pick = land[(rng() * land.length) | 0];
      var ang = rng() * TAU, dd = Math.sqrt(rng()) * pick.r * 0.78;
      var px = pick.x + Math.cos(ang) * dd, py = pick.y + Math.sin(ang) * dd * 0.85;
      var rad2 = 7 + rng() * 9;
      ctx.fillStyle = 'rgba(0,0,0,0.14)';
      ctx.beginPath(); ctx.arc(px + 4, py + 6, rad2, 0, TAU); ctx.fill();
      ctx.fillStyle = T.treeDark;
      ctx.beginPath(); ctx.arc(px, py, rad2, 0, TAU); ctx.fill();
      ctx.fillStyle = T.tree;
      ctx.beginPath(); ctx.arc(px - rad2 * 0.2, py - rad2 * 0.2, rad2 * 0.76, 0, TAU); ctx.fill();
    }
  }

  function paintOcean(ctx, W, H, rng, T, zones) {
    paintWaterBase(ctx, W, H, rng, T);
    for (var i = 0; i < zones.length; i++) {
      var z = zones[i];
      if (z.kind === 'water') continue;
      if (z.kind === 'helipad') drawFrigate(ctx, z, T);
      else drawShip(ctx, z, T);
    }
  }

  /** Hull + wake for a carrier-style ship carrying a landing strip. */
  function drawShip(ctx, z, T) {
    var len = z.length * 1.30;
    var wid = z.width * 2.55;
    ctx.save();
    ctx.translate(z.x, z.y);
    ctx.rotate(z.angle);

    // wake
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = T.foam;
    ctx.beginPath();
    ctx.moveTo(-len / 2, -wid * 0.34);
    ctx.lineTo(-len / 2 - len * 0.75, -wid * 0.95);
    ctx.lineTo(-len / 2 - len * 0.75, wid * 0.95);
    ctx.lineTo(-len / 2, wid * 0.34);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // hull shadow
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    shipHull(ctx, len, wid, 10, 14);
    ctx.fill();
    // hull
    ctx.fillStyle = T.hull;
    shipHull(ctx, len, wid, 0, 0);
    ctx.fill();
    ctx.fillStyle = T.hullDark;
    ctx.globalAlpha = 0.5;
    shipHull(ctx, len * 0.98, wid * 0.62, 0, wid * 0.19);
    ctx.fill();
    ctx.globalAlpha = 1;

    // island superstructure off to one side
    ctx.fillStyle = T.hullDark;
    roundRect(ctx, len * 0.02, wid * 0.30, len * 0.20, wid * 0.16, 5); ctx.fill();
    ctx.fillStyle = T.deckLight;
    roundRect(ctx, len * 0.05, wid * 0.33, len * 0.10, wid * 0.09, 3); ctx.fill();
    ctx.restore();
  }

  function shipHull(ctx, len, wid, ox, oy) {
    ctx.beginPath();
    ctx.moveTo(len / 2 + ox, oy);
    ctx.quadraticCurveTo(len * 0.34 + ox, -wid / 2 + oy, len * 0.10 + ox, -wid / 2 + oy);
    ctx.lineTo(-len / 2 + ox, -wid / 2 + oy);
    ctx.quadraticCurveTo(-len / 2 - 12 + ox, oy, -len / 2 + ox, wid / 2 + oy);
    ctx.lineTo(len * 0.10 + ox, wid / 2 + oy);
    ctx.quadraticCurveTo(len * 0.34 + ox, wid / 2 + oy, len / 2 + ox, oy);
    ctx.closePath();
  }

  function drawFrigate(ctx, z, T) {
    var len = z.radius * 5.4, wid = z.radius * 1.9;
    ctx.save();
    ctx.translate(z.x, z.y);
    ctx.rotate(z.angle - 0.5);
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = T.foam;
    ctx.beginPath();
    ctx.moveTo(-len / 2, -wid * 0.4);
    ctx.lineTo(-len * 1.15, -wid * 0.95);
    ctx.lineTo(-len * 1.15, wid * 0.95);
    ctx.lineTo(-len / 2, wid * 0.4);
    ctx.closePath(); ctx.fill();
    ctx.restore();

    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    shipHull(ctx, len, wid, 8, 11); ctx.fill();
    ctx.fillStyle = T.hull;
    shipHull(ctx, len, wid, 0, 0); ctx.fill();
    ctx.fillStyle = T.hullDark;
    roundRect(ctx, -len * 0.10, -wid * 0.22, len * 0.34, wid * 0.44, 6); ctx.fill();
    ctx.fillStyle = T.deckLight;
    roundRect(ctx, len * 0.06, -wid * 0.12, len * 0.10, wid * 0.24, 3); ctx.fill();
    ctx.restore();
  }

  // ------------------------------------------------------------ landing zones

  function drawStrip(ctx, z, T, theme, ui) {
    ui = ui || 1;
    var L = z.length, Wd = z.width;
    ctx.save();
    ctx.translate(z.x, z.y);
    ctx.rotate(z.angle);

    if (z.kind === 'water') {
      // A marked-out lane on the water: buoys and a dashed centreline.
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      roundRect(ctx, -L / 2, -Wd / 2, L, Wd, Wd / 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.42)';
      ctx.lineWidth = 3;
      ctx.setLineDash([16, 14]);
      ctx.beginPath(); ctx.moveTo(-L / 2 + 12, 0); ctx.lineTo(L / 2 - 12, 0); ctx.stroke();
      ctx.setLineDash([]);
      var buoys = Math.max(3, Math.round(L / 78));
      for (var i = 0; i <= buoys; i++) {
        var bx = -L / 2 + (L / buoys) * i;
        for (var s = -1; s <= 1; s += 2) {
          var by = (Wd / 2) * s;
          ctx.fillStyle = 'rgba(0,0,0,0.22)';
          ctx.beginPath(); ctx.arc(bx + 3, by + 4, 6, 0, TAU); ctx.fill();
          ctx.fillStyle = i === 0 ? '#3ecf8e' : '#f2f5f7';
          ctx.beginPath(); ctx.arc(bx, by, 6, 0, TAU); ctx.fill();
        }
      }
    } else {
      // paved runway
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      roundRect(ctx, -L / 2 - 6, -Wd / 2 - 6 + 8, L + 12, Wd + 12, 10); ctx.fill();
      ctx.fillStyle = T.asphaltEdge;
      roundRect(ctx, -L / 2 - 6, -Wd / 2 - 6, L + 12, Wd + 12, 10); ctx.fill();
      ctx.fillStyle = T.asphalt;
      roundRect(ctx, -L / 2, -Wd / 2, L, Wd, 4); ctx.fill();

      // subtle lengthwise shading
      var sg = ctx.createLinearGradient(0, -Wd / 2, 0, Wd / 2);
      sg.addColorStop(0, 'rgba(255,255,255,0.07)');
      sg.addColorStop(0.5, 'rgba(255,255,255,0.00)');
      sg.addColorStop(1, 'rgba(0,0,0,0.14)');
      ctx.fillStyle = sg;
      roundRect(ctx, -L / 2, -Wd / 2, L, Wd, 4); ctx.fill();

      var mark = theme === 'ocean' ? '#f6d64a' : (T.marking || '#eef2f6');

      // centreline
      ctx.strokeStyle = mark;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = Math.max(3, Wd * 0.055);
      ctx.setLineDash([Wd * 0.55, Wd * 0.45]);
      ctx.beginPath();
      ctx.moveTo(-L / 2 + Wd * 0.75, 0);
      ctx.lineTo(L / 2 - Wd * 0.35, 0);
      ctx.stroke();
      ctx.setLineDash([]);

      // Threshold bars and aiming points at both ends — the strip is landed on
      // from whichever side an aircraft arrives.
      var bars = 4, bh = Wd * 0.13, gap = Wd * 0.075;
      for (var end = -1; end <= 1; end += 2) {
        for (var b = 0; b < bars; b++) {
          var yy = -((bars - 1) / 2) * (bh + gap) + b * (bh + gap);
          ctx.fillStyle = mark;
          ctx.fillRect(end * (L / 2) - (end > 0 ? Wd * 0.66 : -Wd * 0.16),
                       yy - bh / 2, Wd * 0.5, bh);
        }
        ctx.globalAlpha = 0.7;
        ctx.fillStyle = mark;
        var ax = end * (L / 2) - (end > 0 ? Wd * 1.92 : -Wd * 1.5);
        ctx.fillRect(ax, -Wd * 0.30, Wd * 0.42, Wd * 0.10);
        ctx.fillRect(ax, Wd * 0.20, Wd * 0.42, Wd * 0.10);
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();

    for (var ai = 0; ai < z.approaches.length; ai++) {
      drawApproachChevrons(ctx, z.approaches[ai], z.color, ui);
    }
  }

  /**
   * Chevrons leading into a threshold. A strip is usable from either end, so
   * this is drawn once per approach and each set points inward.
   */
  function drawApproachChevrons(ctx, ap, color, ui) {
    ui = ui || 1;
    ctx.save();
    ctx.translate(ap.tx, ap.ty);
    ctx.rotate(ap.angle);
    ctx.globalAlpha = 0.32;
    ctx.strokeStyle = color;
    ctx.lineWidth = 4 * ui;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (var i = 0; i < 3; i++) {
      var x = -CHEVRON_LEAD + 10 + i * 26;
      var s = 16 * ui;
      ctx.globalAlpha = 0.14 + i * 0.10;
      ctx.beginPath();
      ctx.moveTo(x, -s);
      ctx.lineTo(x + s * 0.85, 0);
      ctx.lineTo(x, s);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawHelipad(ctx, z, T) {
    var r = z.radius;
    ctx.save();
    ctx.translate(z.x, z.y);
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath(); ctx.arc(3, 8, r + 6, 0, TAU); ctx.fill();
    ctx.fillStyle = T.asphaltEdge || '#2b3036';
    ctx.beginPath(); ctx.arc(0, 0, r + 6, 0, TAU); ctx.fill();
    ctx.fillStyle = T.asphalt || '#3c4249';
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();

    ctx.strokeStyle = z.color;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(0, 0, r * 0.78, 0, TAU); ctx.stroke();

    // the H
    ctx.lineWidth = r * 0.20;
    ctx.lineCap = 'butt';
    var hw = r * 0.30, hh = r * 0.38;
    ctx.beginPath();
    ctx.moveTo(-hw, -hh); ctx.lineTo(-hw, hh);
    ctx.moveTo(hw, -hh); ctx.lineTo(hw, hh);
    ctx.moveTo(-hw, 0); ctx.lineTo(hw, 0);
    ctx.stroke();
    ctx.restore();
  }

  /** The badge beside each zone showing which aircraft it takes. */
  function drawZoneSign(ctx, z, W, H, ui) {
    var chipR = 9 * (ui || 1);
    var gap = 7 * (ui || 1);
    var types = z.accepts;
    var w = types.length * (chipR * 2) + (types.length - 1) * gap + 20 * (ui || 1);
    var h = chipR * 2 + 12 * (ui || 1);

    var sx, sy;
    if (z.kind === 'helipad') {
      sx = z.x;
      sy = z.y + z.radius + 16 + h * 0.6;
    } else {
      // Sit beside the strip, on whichever side has more room to the map edge.
      var nx = -z.dy, ny = z.dx;
      var off = z.width / 2 + 14 + h * 0.6;
      var best = null;
      for (var s = -1; s <= 1; s += 2) {
        var px = z.x + nx * off * s, py = z.y + ny * off * s;
        var room = Math.min(px, W - px, py, H - py);
        if (!best || room > best.room) best = { x: px, y: py, room: room };
      }
      sx = best.x; sy = best.y;
    }
    sx = clamp(sx, w / 2 + 6, W - w / 2 - 6);
    sy = clamp(sy, h / 2 + 6, H - h / 2 - 6);

    ctx.save();
    ctx.translate(sx, sy);
    ctx.fillStyle = 'rgba(8,15,22,0.55)';
    roundRect(ctx, -w / 2, -h / 2, w, h, h / 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1.5 * (ui || 1);
    ctx.stroke();

    for (var i = 0; i < types.length; i++) {
      var spec = FC.TYPES[types[i]];
      var cx = -w / 2 + 10 * (ui || 1) + chipR + i * (chipR * 2 + gap);
      ctx.fillStyle = spec.color;
      ctx.beginPath(); ctx.arc(cx, 0, chipR, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1.5 * (ui || 1);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ----------------------------------------------------------------- aircraft

  /**
   * Aircraft silhouettes, all drawn nose-first along +X and centred on the
   * origin. `mode` is 'shadow' (flat dark fill) or 'body' (full colour).
   */
  function drawAircraftShape(ctx, a, mode, spin) {
    var s = a.spec;
    var L = s.len, S = s.span;
    var shadow = mode === 'shadow';
    var body = shadow ? 'rgba(0,0,0,1)' : s.color;
    var dark = shadow ? 'rgba(0,0,0,1)' : s.dark;

    switch (a.type) {
      case 'heli':      drawHeli(ctx, L, S, body, dark, shadow, spin); break;
      case 'prop':      drawProp(ctx, L, S, body, dark, shadow, spin); break;
      case 'seaplane':  drawSeaplane(ctx, L, S, body, dark, shadow, spin); break;
      default:          drawJet(ctx, L, S, body, dark, shadow, a.type === 'jumbo'); break;
    }
  }

  function drawJet(ctx, L, S, body, dark, shadow, jumbo) {
    var hw = L * 0.11;                 // fuselage half-width
    // main wings, swept back
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.moveTo(L * 0.10, -hw * 0.6);
    ctx.lineTo(-L * 0.16, -S / 2);
    ctx.lineTo(-L * 0.30, -S / 2);
    ctx.lineTo(-L * 0.06, -hw * 0.9);
    ctx.lineTo(-L * 0.06, hw * 0.9);
    ctx.lineTo(-L * 0.30, S / 2);
    ctx.lineTo(-L * 0.16, S / 2);
    ctx.lineTo(L * 0.10, hw * 0.6);
    ctx.closePath();
    ctx.fill();

    // tailplane
    ctx.beginPath();
    ctx.moveTo(-L * 0.36, -hw * 0.5);
    ctx.lineTo(-L * 0.50, -S * 0.22);
    ctx.lineTo(-L * 0.56, -S * 0.22);
    ctx.lineTo(-L * 0.50, -hw * 0.5);
    ctx.lineTo(-L * 0.50, hw * 0.5);
    ctx.lineTo(-L * 0.56, S * 0.22);
    ctx.lineTo(-L * 0.50, S * 0.22);
    ctx.lineTo(-L * 0.36, hw * 0.5);
    ctx.closePath();
    ctx.fill();

    if (!shadow) {
      // engines
      ctx.fillStyle = dark;
      for (var side = -1; side <= 1; side += 2) {
        roundRect(ctx, -L * 0.20, side * S * 0.26 - hw * 0.42, L * 0.26, hw * 0.84, hw * 0.42);
        ctx.fill();
        if (jumbo) {
          roundRect(ctx, -L * 0.14, side * S * 0.40 - hw * 0.36, L * 0.22, hw * 0.72, hw * 0.36);
          ctx.fill();
        }
      }
    }

    // fuselage
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(L * 0.50, 0);
    ctx.quadraticCurveTo(L * 0.34, -hw, L * 0.10, -hw);
    ctx.lineTo(-L * 0.38, -hw * 0.86);
    ctx.quadraticCurveTo(-L * 0.50, -hw * 0.7, -L * 0.50, 0);
    ctx.quadraticCurveTo(-L * 0.50, hw * 0.7, -L * 0.38, hw * 0.86);
    ctx.lineTo(L * 0.10, hw);
    ctx.quadraticCurveTo(L * 0.34, hw, L * 0.50, 0);
    ctx.closePath();
    ctx.fill();

    if (!shadow) {
      // fin, sitting on the spine
      ctx.fillStyle = dark;
      ctx.beginPath();
      ctx.moveTo(-L * 0.34, 0);
      ctx.lineTo(-L * 0.52, -hw * 0.30);
      ctx.lineTo(-L * 0.56, 0);
      ctx.lineTo(-L * 0.52, hw * 0.30);
      ctx.closePath();
      ctx.fill();
      // cockpit
      ctx.fillStyle = 'rgba(30,44,60,0.75)';
      ctx.beginPath();
      ctx.ellipse(L * 0.34, 0, L * 0.07, hw * 0.52, 0, 0, TAU);
      ctx.fill();
      // highlight down the spine
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      roundRect(ctx, -L * 0.30, -hw * 0.62, L * 0.56, hw * 0.30, hw * 0.15);
      ctx.fill();
    }
  }

  function drawProp(ctx, L, S, body, dark, shadow, spin) {
    var hw = L * 0.13;
    // straight wings
    ctx.fillStyle = dark;
    roundRect(ctx, -L * 0.10, -S / 2, L * 0.30, S, 5);
    ctx.fill();
    // tailplane
    roundRect(ctx, -L * 0.50, -S * 0.24, L * 0.16, S * 0.48, 4);
    ctx.fill();
    // fuselage
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(L * 0.48, 0);
    ctx.quadraticCurveTo(L * 0.40, -hw, L * 0.16, -hw);
    ctx.lineTo(-L * 0.40, -hw * 0.62);
    ctx.quadraticCurveTo(-L * 0.52, -hw * 0.4, -L * 0.52, 0);
    ctx.quadraticCurveTo(-L * 0.52, hw * 0.4, -L * 0.40, hw * 0.62);
    ctx.lineTo(L * 0.16, hw);
    ctx.quadraticCurveTo(L * 0.40, hw, L * 0.48, 0);
    ctx.closePath();
    ctx.fill();

    if (!shadow) {
      ctx.fillStyle = dark;
      ctx.beginPath();
      ctx.moveTo(-L * 0.36, 0);
      ctx.lineTo(-L * 0.50, -hw * 0.46);
      ctx.lineTo(-L * 0.54, 0);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(30,44,60,0.72)';
      ctx.beginPath();
      ctx.ellipse(L * 0.18, 0, L * 0.10, hw * 0.62, 0, 0, TAU);
      ctx.fill();
      // spinning propeller disc
      ctx.save();
      ctx.translate(L * 0.50, 0);
      ctx.globalAlpha = 0.30;
      ctx.fillStyle = '#dfe6ec';
      ctx.beginPath(); ctx.ellipse(0, 0, L * 0.05, S * 0.40, 0, 0, TAU); ctx.fill();
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = '#3c4249';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(0, -S * 0.40 * Math.cos(spin));
      ctx.lineTo(0, S * 0.40 * Math.cos(spin));
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawSeaplane(ctx, L, S, body, dark, shadow, spin) {
    var hw = L * 0.13;
    if (!shadow) {
      // floats sit below the wing, drawn first
      ctx.fillStyle = dark;
      for (var side = -1; side <= 1; side += 2) {
        roundRect(ctx, -L * 0.16, side * S * 0.28 - hw * 0.34, L * 0.46, hw * 0.68, hw * 0.34);
        ctx.fill();
      }
    }
    ctx.fillStyle = dark;
    roundRect(ctx, -L * 0.06, -S / 2, L * 0.26, S, 5);
    ctx.fill();
    roundRect(ctx, -L * 0.50, -S * 0.22, L * 0.15, S * 0.44, 4);
    ctx.fill();

    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(L * 0.46, 0);
    ctx.quadraticCurveTo(L * 0.38, -hw, L * 0.14, -hw);
    ctx.lineTo(-L * 0.40, -hw * 0.60);
    ctx.quadraticCurveTo(-L * 0.52, -hw * 0.36, -L * 0.52, 0);
    ctx.quadraticCurveTo(-L * 0.52, hw * 0.36, -L * 0.40, hw * 0.60);
    ctx.lineTo(L * 0.14, hw);
    ctx.quadraticCurveTo(L * 0.38, hw, L * 0.46, 0);
    ctx.closePath();
    ctx.fill();

    if (!shadow) {
      ctx.fillStyle = dark;
      ctx.beginPath();
      ctx.moveTo(-L * 0.34, 0);
      ctx.lineTo(-L * 0.48, -hw * 0.50);
      ctx.lineTo(-L * 0.53, 0);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(30,44,60,0.72)';
      ctx.beginPath();
      ctx.ellipse(L * 0.16, 0, L * 0.10, hw * 0.58, 0, 0, TAU);
      ctx.fill();
      ctx.save();
      ctx.translate(L * 0.48, 0);
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = '#dfe6ec';
      ctx.beginPath(); ctx.ellipse(0, 0, L * 0.05, S * 0.36, 0, 0, TAU); ctx.fill();
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = '#2f3a44';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(0, -S * 0.36 * Math.cos(spin));
      ctx.lineTo(0, S * 0.36 * Math.cos(spin));
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawHeli(ctx, L, S, body, dark, shadow, spin) {
    var hw = L * 0.20;
    // tail boom
    ctx.fillStyle = dark;
    roundRect(ctx, -L * 0.52, -hw * 0.17, L * 0.46, hw * 0.34, hw * 0.17);
    ctx.fill();
    // tail fin
    ctx.beginPath();
    ctx.moveTo(-L * 0.40, 0);
    ctx.lineTo(-L * 0.54, -hw * 0.66);
    ctx.lineTo(-L * 0.58, -hw * 0.10);
    ctx.closePath();
    ctx.fill();

    // cabin
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(L * 0.42, 0);
    ctx.quadraticCurveTo(L * 0.40, -hw, L * 0.08, -hw);
    ctx.quadraticCurveTo(-L * 0.12, -hw, -L * 0.14, 0);
    ctx.quadraticCurveTo(-L * 0.12, hw, L * 0.08, hw);
    ctx.quadraticCurveTo(L * 0.40, hw, L * 0.42, 0);
    ctx.closePath();
    ctx.fill();

    if (!shadow) {
      ctx.fillStyle = 'rgba(30,44,60,0.72)';
      ctx.beginPath();
      ctx.ellipse(L * 0.24, 0, L * 0.13, hw * 0.66, 0, 0, TAU);
      ctx.fill();
      // skids
      ctx.strokeStyle = dark;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(L * 0.24, -hw * 1.02); ctx.lineTo(-L * 0.10, -hw * 1.02);
      ctx.moveTo(L * 0.24, hw * 1.02); ctx.lineTo(-L * 0.10, hw * 1.02);
      ctx.stroke();
      // tail rotor
      ctx.save();
      ctx.translate(-L * 0.52, 0);
      ctx.rotate(spin * 2.2);
      ctx.strokeStyle = 'rgba(40,52,64,0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -S * 0.20); ctx.lineTo(0, S * 0.20);
      ctx.stroke();
      ctx.restore();
    }

    // main rotor
    ctx.save();
    ctx.translate(L * 0.06, 0);
    ctx.rotate(spin);
    if (shadow) {
      ctx.globalAlpha = 0.5;
      ctx.beginPath(); ctx.arc(0, 0, S * 0.62, 0, TAU); ctx.fill();
    } else {
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = '#e9eef3';
      ctx.beginPath(); ctx.arc(0, 0, S * 0.62, 0, TAU); ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = '#2b3644';
      ctx.lineWidth = 3;
      for (var b = 0; b < 2; b++) {
        ctx.rotate(Math.PI / 2);
        ctx.beginPath();
        ctx.moveTo(-S * 0.62, 0); ctx.lineTo(S * 0.62, 0);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- particles

  function Particles() { this.items = []; }

  Particles.prototype.burst = function (x, y, opts) {
    var n = opts.count || 12;
    for (var i = 0; i < n; i++) {
      var a = Math.random() * TAU;
      var sp = lerp(opts.speedMin || 40, opts.speedMax || 180, Math.random());
      this.items.push({
        x: x, y: y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0, max: lerp(opts.lifeMin || 0.4, opts.lifeMax || 1.1, Math.random()),
        r: lerp(opts.rMin || 3, opts.rMax || 12, Math.random()),
        color: opts.colors[(Math.random() * opts.colors.length) | 0],
        drag: opts.drag == null ? 1.6 : opts.drag,
        grow: opts.grow || 0
      });
    }
  };

  Particles.prototype.update = function (dt) {
    for (var i = this.items.length - 1; i >= 0; i--) {
      var p = this.items[i];
      p.life += dt;
      if (p.life >= p.max) { this.items.splice(i, 1); continue; }
      var damp = Math.exp(-p.drag * dt);
      p.vx *= damp; p.vy *= damp;
      p.x += p.vx * dt; p.y += p.vy * dt;
      // shrinking embers must not pass through zero into a negative radius
      p.r = Math.max(0, p.r + p.grow * dt);
    }
  };

  Particles.prototype.draw = function (ctx) {
    for (var i = 0; i < this.items.length; i++) {
      var p = this.items[i];
      var t = p.life / p.max;
      var r = Math.max(0, p.r * (1 - t * 0.3));
      if (r <= 0) continue;
      ctx.globalAlpha = (1 - t) * 0.9;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  Particles.prototype.clear = function () { this.items.length = 0; };

  // ------------------------------------------------------------------ clouds

  /*
   * Clouds are pre-rendered once into a handful of soft sprites and then blitted
   * at whatever size each cloud needs. Drawing them as plain filled circles gives
   * hard edges that read as discs rather than cloud, and costs far more per frame.
   */
  var SPRITE_PX = 256;
  var cloudSprites = null;

  function cloudSprite(seed, rgb, peak) {
    var c = document.createElement('canvas');
    c.width = c.height = SPRITE_PX;
    var ctx = c.getContext('2d');
    var rng = mulberry32(seed);
    var mid = SPRITE_PX / 2;
    var base = SPRITE_PX * 0.16;
    for (var i = 0; i < 9; i++) {
      var ox = mid + (rng() - 0.5) * SPRITE_PX * 0.42;
      var oy = mid + (rng() - 0.5) * SPRITE_PX * 0.24;
      var rr = base * (1.0 + rng() * 1.3);
      var g = ctx.createRadialGradient(ox, oy, rr * 0.1, ox, oy, rr);
      g.addColorStop(0, 'rgba(' + rgb + ',' + peak + ')');
      g.addColorStop(0.5, 'rgba(' + rgb + ',' + (peak * 0.5).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(' + rgb + ',0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(ox, oy, rr, 0, TAU);
      ctx.fill();
    }
    return c;
  }

  function ensureCloudSprites() {
    if (cloudSprites) return cloudSprites;
    cloudSprites = { light: [], dark: [] };
    for (var i = 0; i < 4; i++) {
      cloudSprites.light.push(cloudSprite(4200 + i, '255,255,255', 0.55));
      cloudSprites.dark.push(cloudSprite(4200 + i, '38,58,74', 0.42));
    }
    return cloudSprites;
  }

  function makeClouds(W, H, seed) {
    var rng = mulberry32(seed);
    var list = [];
    for (var i = 0; i < 7; i++) {
      list.push({
        x: rng() * W, y: rng() * H,
        r: 90 + rng() * 130,
        vx: 6 + rng() * 12,
        vy: (rng() - 0.5) * 4,
        sprite: (rng() * 4) | 0,
        alpha: 0.20 + rng() * 0.22
      });
    }
    return list;
  }

  // ---------------------------------------------------------------- renderer

  function Renderer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bg = null;
    this.bgKey = '';
    this.scale = 1;
    this.offX = 0;
    this.offY = 0;
    this.W = 1600;
    this.H = 1000;
    this.cssW = 0;
    this.cssH = 0;
    this.dpr = 1;
    this.ui = 1;          // multiplier keeping hairlines legible when zoomed out
    this.particles = new Particles();
    this.clouds = [];
    this.shake = 0;
    this.time = 0;
  }

  /** Fit the world to the viewport. Returns the world size to run the game at. */
  Renderer.prototype.layout = function (cssW, cssH, dpr) {
    this.cssW = cssW; this.cssH = cssH; this.dpr = dpr;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';

    var W = FC.worldWidthFor(cssW / cssH);
    var H = FC.WORLD_H;
    var scale = Math.min(cssW / W, cssH / H);
    this.W = W; this.H = H;
    this.scale = scale;
    // At phone sizes one world unit is well under half a CSS pixel, so anything
    // line-weight sized has to be scaled back up to stay readable.
    this.ui = clamp(1 / scale, 1, 2.4);
    this.offX = (cssW - W * scale) / 2;
    this.offY = (cssH - H * scale) / 2;
    this.clouds = makeClouds(W, H, 9182);
    return { width: W, height: H };
  };

  Renderer.prototype.toWorld = function (sx, sy) {
    return {
      x: (sx - this.offX) / this.scale,
      y: (sy - this.offY) / this.scale
    };
  };

  /** Paint the static terrain once per map/size into an offscreen canvas. */
  Renderer.prototype.buildBackground = function (game) {
    var key = game.map.id + ':' + this.W + 'x' + this.H + '@' + this.ui.toFixed(2);
    if (this.bgKey === key && this.bg) return;
    var c = document.createElement('canvas');
    c.width = this.W;
    c.height = this.H;
    var ctx = c.getContext('2d');
    var T = THEMES[game.map.theme];
    var rng = mulberry32(hash(game.map.id));

    if (game.map.theme === 'grass') paintGrass(ctx, this.W, this.H, rng, T);
    else if (game.map.theme === 'island') paintIsland(ctx, this.W, this.H, rng, T, game.zones);
    else paintOcean(ctx, this.W, this.H, rng, T, game.zones);

    for (var i = 0; i < game.zones.length; i++) {
      var z = game.zones[i];
      if (z.kind === 'helipad') drawHelipad(ctx, z, T);
      else drawStrip(ctx, z, T, game.map.theme, this.ui);
    }
    for (var j = 0; j < game.zones.length; j++) drawZoneSign(ctx, game.zones[j], this.W, this.H, this.ui);

    // edge vignette so the play boundary reads clearly
    var vg = ctx.createRadialGradient(
      this.W / 2, this.H / 2, Math.min(this.W, this.H) * 0.34,
      this.W / 2, this.H / 2, Math.max(this.W, this.H) * 0.72
    );
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, T.vignette);
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, this.W, this.H);

    this.bg = c;
    this.bgKey = key;
  };

  Renderer.prototype.invalidateBackground = function () { this.bgKey = ''; };

  Renderer.prototype.addShake = function (amount) {
    this.shake = Math.min(1, this.shake + amount);
  };

  Renderer.prototype.landingPuff = function (x, y, color) {
    this.particles.burst(x, y, {
      count: 12, colors: ['rgba(255,255,255,0.9)', 'rgba(226,236,244,0.8)', color],
      speedMin: 24, speedMax: 110, rMin: 4, rMax: 11, lifeMin: 0.3, lifeMax: 0.7, grow: 16
    });
  };

  Renderer.prototype.explode = function (x, y, shake) {
    this.particles.burst(x, y, {
      count: 34, colors: ['#ffd76a', '#ff9f43', '#f2565c', '#8d3b1f'],
      speedMin: 60, speedMax: 340, rMin: 4, rMax: 18, lifeMin: 0.45, lifeMax: 1.3, grow: -6
    });
    this.particles.burst(x, y, {
      count: 20, colors: ['rgba(70,70,70,0.75)', 'rgba(110,110,110,0.65)'],
      speedMin: 20, speedMax: 130, rMin: 8, rMax: 24, lifeMin: 0.8, lifeMax: 2.0,
      drag: 1.1, grow: 26
    });
    this.addShake(shake == null ? 1 : shake);
  };

  Renderer.prototype.reset = function () {
    this.particles.clear();
    this.shake = 0;
  };

  Renderer.prototype.draw = function (game, dt, ui) {
    var ctx = this.ctx;
    this.time += dt;
    this.particles.update(dt);
    this.shake = Math.max(0, this.shake - dt * 1.9);

    this.buildBackground(game);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    // letterbox colour picked to blend with the map
    ctx.fillStyle = THEMES[game.map.theme].base[1];
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    var sh = this.shake * this.shake;
    var shx = (Math.random() - 0.5) * 22 * sh;
    var shy = (Math.random() - 0.5) * 22 * sh;

    ctx.save();
    ctx.translate(this.offX + shx, this.offY + shy);
    ctx.scale(this.scale, this.scale);
    ctx.beginPath();
    ctx.rect(0, 0, this.W, this.H);
    ctx.clip();

    ctx.drawImage(this.bg, 0, 0);

    this.drawCloudShadows(dt);
    this.drawZoneHighlights(game, ui);
    this.drawPaths(game);
    this.drawClouds();
    this.drawAircraftLayer(game);
    this.particles.draw(ctx);

    ctx.restore();
  };

  /** Drift the clouds and lay their shadows on the ground. */
  Renderer.prototype.drawCloudShadows = function (dt) {
    var ctx = this.ctx;
    var sprites = ensureCloudSprites();
    for (var i = 0; i < this.clouds.length; i++) {
      var c = this.clouds[i];
      c.x += c.vx * dt; c.y += c.vy * dt;
      var span = c.r * 2.4;
      if (c.x - span > this.W) { c.x = -span; c.y = Math.random() * this.H; }
      if (c.y - span > this.H) c.y = -span;
      if (c.y + span < 0) c.y = this.H + span;

      ctx.save();
      ctx.globalAlpha = c.alpha * 0.5;
      ctx.drawImage(sprites.dark[c.sprite],
        c.x - span / 2 + 30, c.y - span / 2 + 40, span, span);
      ctx.restore();
    }
  };

  Renderer.prototype.drawClouds = function () {
    var ctx = this.ctx;
    var sprites = ensureCloudSprites();
    for (var i = 0; i < this.clouds.length; i++) {
      var c = this.clouds[i];
      var span = c.r * 2.4;
      ctx.save();
      ctx.globalAlpha = c.alpha;
      ctx.drawImage(sprites.light[c.sprite],
        c.x - span / 2, c.y - span / 2, span, span);
      ctx.restore();
    }
  };

  /** Pulse the zones that will accept whatever the player is currently dragging. */
  Renderer.prototype.drawZoneHighlights = function (game, ui) {
    var dragging = ui && ui.draggingType;
    var ctx = this.ctx;
    var pulse = 0.5 + 0.5 * Math.sin(this.time * 4.5);

    for (var i = 0; i < game.zones.length; i++) {
      var z = game.zones[i];
      var accepts = dragging && FC.zoneAccepts(z, dragging);
      var hovered = ui && ui.hoverZone === z;
      if (!accepts && !hovered) continue;

      ctx.save();
      ctx.strokeStyle = z.color;
      ctx.globalAlpha = hovered ? 0.95 : 0.30 + pulse * 0.28;
      ctx.lineWidth = (hovered ? 6 : 4) * this.ui;
      ctx.lineJoin = 'round';
      if (z.kind === 'helipad') {
        ctx.beginPath();
        ctx.arc(z.x, z.y, z.radius + 12 + (hovered ? pulse * 4 : 0), 0, TAU);
        ctx.stroke();
      } else {
        ctx.translate(z.x, z.y);
        ctx.rotate(z.angle);
        var pad = 12 + (hovered ? pulse * 4 : 0);
        roundRect(ctx, -z.length / 2 - pad, -z.width / 2 - pad,
                  z.length + pad * 2, z.width + pad * 2, 12);
        ctx.stroke();
        if (hovered) {
          // show where the aircraft will be lined up from
          ctx.globalAlpha = 0.55;
          ctx.setLineDash([10 * this.ui, 8 * this.ui]);
          ctx.lineWidth = 3 * this.ui;
          // mark the two tips an aircraft can touch down on
          ctx.setLineDash([]);
          for (var t = -1; t <= 1; t += 2) {
            ctx.beginPath();
            ctx.arc(t * z.length / 2, 0, 9 * this.ui, 0, TAU);
            ctx.stroke();
          }
          ctx.setLineDash([]);
        }
      }
      ctx.restore();
    }
  };

  Renderer.prototype.drawPaths = function (game) {
    var ctx = this.ctx;
    var ui = this.ui;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (var i = 0; i < game.aircraft.length; i++) {
      var a = game.aircraft[i];
      if (a.state !== 'flying' || a.path.length === 0) continue;

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      for (var j = 0; j < a.path.length; j++) ctx.lineTo(a.path[j].x, a.path[j].y);

      // soft dark underlay keeps the line readable over any terrain
      ctx.globalAlpha = 0.28;
      ctx.strokeStyle = 'rgba(6,16,24,1)';
      ctx.lineWidth = 11 * ui;
      ctx.stroke();

      ctx.globalAlpha = a.drawing ? 0.98 : 0.82;
      ctx.strokeStyle = a.spec.color;
      ctx.lineWidth = 5.5 * ui;
      ctx.stroke();

      // marching dashes toward the destination
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 2.5 * ui;
      ctx.setLineDash([11 * ui, 26 * ui]);
      ctx.lineDashOffset = -this.time * 60 * ui;
      ctx.stroke();
      ctx.setLineDash([]);

      if (a.landingZone) {
        var end = a.path[a.path.length - 1];
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = a.spec.color;
        ctx.beginPath();
        ctx.arc(end.x, end.y, 6 * ui, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  };

  Renderer.prototype.drawAircraftLayer = function (game) {
    for (var i = 0; i < game.aircraft.length; i++) {
      this.drawOne(game.aircraft[i]);
    }
  };

  Renderer.prototype.drawOne = function (a) {
    var ctx = this.ctx;
    var landing = a.state === 'landing';
    // altitude cue: the shadow closes in as the aircraft touches down
    var alt = landing ? clamp(1 - a.landT / a.landDur, 0, 1) : 1;
    var scale = landing ? lerp(0.82, 1, alt) : 1;
    var alpha = a.fade;

    if (a.state === 'wreck') return;   // replaced by the explosion

    // shadow
    ctx.save();
    ctx.globalAlpha = 0.20 * alpha;
    ctx.translate(a.x + 19 * alt, a.y + 25 * alt);
    ctx.rotate(a.drawHeading);
    ctx.scale(scale, scale);
    drawAircraftShape(ctx, a, 'shadow', a.spin);
    ctx.restore();

    // proximity alarm
    if (a.warn > 0.02 && a.state === 'flying') {
      var pulse = 0.55 + 0.45 * Math.sin(this.time * 14);
      ctx.save();
      ctx.globalAlpha = a.warn * 0.75 * pulse;
      ctx.strokeStyle = '#ff4d4f';
      ctx.lineWidth = 3.5 * this.ui;
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.radius + 14 + a.warn * 9, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = a.warn * 0.16 * pulse;
      ctx.fillStyle = '#ff4d4f';
      ctx.fill();
      ctx.restore();
    }

    // selection ring while the player is drawing this aircraft's route
    if (a.drawing) {
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.5 * this.ui;
      ctx.setLineDash([6 * this.ui, 6 * this.ui]);
      ctx.lineDashOffset = -this.time * 30;
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.radius + 17, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(a.x, a.y);
    ctx.rotate(a.drawHeading);
    ctx.scale(scale, scale * (1 - Math.abs(a.roll) * 0.18));
    drawAircraftShape(ctx, a, 'body', a.spin);
    ctx.restore();
  };

  // ---------------------------------------------------------------- previews

  /**
   * Paint a map at full world size and scale it down, so menu thumbnails show
   * the real terrain rather than a differently-proportioned approximation.
   */
  function thumbnail(map, outW, outH) {
    var W = FC.worldWidthFor(outW / outH);
    var H = FC.WORLD_H;
    var zones = map.zones(W, H);
    var big = document.createElement('canvas');
    big.width = W; big.height = H;
    var ctx = big.getContext('2d');
    var T = THEMES[map.theme];
    var rng = mulberry32(hash(map.id));

    if (map.theme === 'grass') paintGrass(ctx, W, H, rng, T);
    else if (map.theme === 'island') paintIsland(ctx, W, H, rng, T, zones);
    else paintOcean(ctx, W, H, rng, T, zones);

    for (var i = 0; i < zones.length; i++) {
      if (zones[i].kind === 'helipad') drawHelipad(ctx, zones[i], T);
      else drawStrip(ctx, zones[i], T, map.theme, 1);
    }

    var out = document.createElement('canvas');
    out.width = outW; out.height = outH;
    var octx = out.getContext('2d');
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(big, 0, 0, W, H, 0, 0, outW, outH);
    big.width = big.height = 1;   // release the large buffer promptly
    return out;
  }

  // ------------------------------------------------------------------ exports

  return {
    Renderer: Renderer,
    thumbnail: thumbnail,
    THEMES: THEMES,
    drawAircraftShape: drawAircraftShape,
    Particles: Particles,
    roundRect: roundRect
  };
});
