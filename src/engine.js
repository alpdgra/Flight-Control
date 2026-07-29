/*
 * Flight Control — game engine
 * ---------------------------------------------------------------------------
 * Pure simulation logic: no DOM, no canvas, no audio. Everything in here is
 * deterministic given a seeded RNG so it can be unit-tested under Node.
 *
 * World coordinates: y grows downward (screen space). The world is always
 * WORLD_H units tall; width varies with the viewport aspect ratio.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FC = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- constants

  var WORLD_H = 1000;
  var MIN_ASPECT = 1.25;
  var MAX_ASPECT = 2.35;

  // How far outside the play area aircraft are born.
  var SPAWN_OFFSET = 60;
  // Pointer must come this close to an aircraft to grab it. Sized so that on a
  // phone (roughly 0.4 CSS px per world unit) the target still clears the 44 px
  // that a fingertip needs.
  var GRAB_RADIUS = 58;
  // A drag shorter than this counts as a stray tap and leaves the route alone.
  var TAP_SLOP = 20;
  // Minimum spacing between successive recorded path points.
  var PATH_STEP = 7;
  // Separation at which the proximity alarm starts, as a multiple of the
  // distance at which the two aircraft would actually collide.
  var WARN_FACTOR = 2.2;
  // World units of detour a radian of turning is judged to be worth when
  // choosing which end of a strip to land on. Keeps an aircraft from picking a
  // marginally nearer tip that it would have to double back to reach.
  var TURN_COST = 260;

  // --------------------------------------------------------------- math utils

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function dist2(ax, ay, bx, by) { var dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
  function dist(ax, ay, bx, by) { return Math.sqrt(dist2(ax, ay, bx, by)); }

  /** Shortest signed difference between two angles, in (-PI, PI]. */
  function angleDelta(from, to) {
    var d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d <= -Math.PI) d += Math.PI * 2;
    return d;
  }

  /** Rotate `from` toward `to` by at most `maxStep` radians. */
  function angleApproach(from, to, maxStep) {
    var d = angleDelta(from, to);
    if (Math.abs(d) <= maxStep) return to;
    return from + Math.sign(d) * maxStep;
  }

  /** Squared distance from point P to segment AB. */
  function pointSegDist2(px, py, ax, ay, bx, by) {
    var vx = bx - ax, vy = by - ay;
    var len2 = vx * vx + vy * vy;
    var t = len2 > 1e-9 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
    t = clamp(t, 0, 1);
    var cx = ax + vx * t, cy = ay + vy * t;
    return dist2(px, py, cx, cy);
  }

  /** Deterministic, fast PRNG. */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ----------------------------------------------------------- aircraft types

  /*
   * speed     world units per second (the world is always 1000 tall, so an
   *           airliner crosses it in a little under ten seconds)
   * turn      radians per second while free-flying; path following is exact
   * radius    collision radius, matched to the drawn sprite
   * span/len  wingspan and length used by the renderer
   */
  var TYPES = {
    heli: {
      id: 'heli', label: 'Helicopter', color: '#4d94ff', dark: '#1d4f9e',
      speed: 56, turn: 2.9, radius: 20, span: 40, len: 46
    },
    prop: {
      id: 'prop', label: 'Light aircraft', color: '#ffcc3d', dark: '#a8781a',
      speed: 78, turn: 2.1, radius: 23, span: 49, len: 44
    },
    seaplane: {
      id: 'seaplane', label: 'Seaplane', color: '#3ecf8e', dark: '#1a7a52',
      speed: 88, turn: 1.8, radius: 26, span: 57, len: 51
    },
    jet: {
      id: 'jet', label: 'Airliner', color: '#eef2f6', dark: '#8b97a5',
      speed: 104, turn: 1.5, radius: 30, span: 65, len: 68
    },
    jumbo: {
      id: 'jumbo', label: 'Jumbo jet', color: '#f2565c', dark: '#93262b',
      speed: 134, turn: 1.15, radius: 35, span: 81, len: 84
    }
  };

  // -------------------------------------------------------------------- zones

  /**
   * One usable direction along a strip: the tip the wheels touch, and the far
   * end the rollout finishes at.
   *
   * There is deliberately no approach fix out in front of the strip. Aircraft
   * fly to the tip and land on it, the same way a helicopter simply arrives at
   * the pad — anything further out reads as the aircraft leaving the runway to
   * go and line up somewhere else.
   */
  function approach(idx, cx, cy, angle, half) {
    var dx = Math.cos(angle), dy = Math.sin(angle);
    return {
      idx: idx,
      angle: angle,
      dx: dx, dy: dy,
      // the tip landed on, and the far end rolled out to
      tx: cx - dx * half, ty: cy - dy * half,
      ex: cx + dx * half, ey: cy + dy * half
    };
  }

  /**
   * Build a linear landing zone (runway or water lane).
   *
   * A strip is usable in both directions, exactly like a real runway numbered
   * at both ends. Aircraft take whichever end they arrive at, so arriving from
   * the "wrong" side costs a turn rather than a lap of the map.
   */
  function strip(opts) {
    var dx = Math.cos(opts.angle), dy = Math.sin(opts.angle);
    var half = opts.length / 2;
    return {
      kind: opts.kind || 'runway',
      id: opts.id,
      name: opts.name,
      x: opts.x, y: opts.y,
      angle: opts.angle,
      dx: dx, dy: dy,
      length: opts.length,
      width: opts.width,
      accepts: opts.accepts,
      color: opts.color,
      approaches: [
        approach(0, opts.x, opts.y, opts.angle, half),
        approach(1, opts.x, opts.y, opts.angle + Math.PI, half)
      ]
    };
  }

  function pad(opts) {
    return {
      kind: 'helipad',
      id: opts.id,
      name: opts.name,
      x: opts.x, y: opts.y,
      angle: opts.angle || 0,
      radius: opts.radius,
      accepts: opts.accepts,
      color: opts.color
    };
  }

  /** Is `pt` inside the zone's capture area? */
  function zoneCaptures(zone, px, py, slack) {
    slack = slack || 0;
    if (zone.kind === 'helipad') {
      return dist2(px, py, zone.x, zone.y) <= Math.pow(zone.radius + slack + 18, 2);
    }
    // Project onto the strip's local axes.
    var rx = px - zone.x, ry = py - zone.y;
    var along = rx * zone.dx + ry * zone.dy;
    var across = -rx * zone.dy + ry * zone.dx;
    return Math.abs(along) <= zone.length / 2 + slack + 26 &&
           Math.abs(across) <= zone.width / 2 + slack + 26;
  }

  function zoneAccepts(zone, typeId) {
    return zone.accepts.indexOf(typeId) !== -1;
  }

  // --------------------------------------------------------------------- maps

  var MAPS = [
    {
      id: 'airfield',
      name: 'Fairview Airfield',
      theme: 'grass',
      blurb: 'The classic. Two runways and a helipad in rolling green country.',
      pool: ['prop', 'jet', 'jumbo', 'heli'],
      zones: function (W, H) {
        return [
          strip({
            id: 'main', name: '09', kind: 'runway', accepts: ['jet', 'jumbo'],
            x: W * 0.60, y: H * 0.27, angle: 0,
            length: Math.min(W * 0.30, 470), width: 76, color: '#eef2f6'
          }),
          strip({
            id: 'strip', name: '27', kind: 'runway', accepts: ['prop'],
            x: W * 0.35, y: H * 0.74, angle: Math.PI,
            length: Math.min(W * 0.20, 320), width: 58, color: '#ffcc3d'
          }),
          pad({
            id: 'pad', name: 'H', accepts: ['heli'],
            x: W * 0.80, y: H * 0.755, radius: 52, color: '#4d94ff'
          })
        ];
      }
    },
    {
      id: 'coralbay',
      name: 'Coral Bay',
      theme: 'island',
      blurb: 'Island traffic. Seaplanes share the airspace with the jets.',
      pool: ['prop', 'jet', 'jumbo', 'heli', 'seaplane'],
      zones: function (W, H) {
        return [
          strip({
            id: 'main', name: '14', kind: 'runway', accepts: ['jet', 'jumbo'],
            x: W * 0.63, y: H * 0.24, angle: 0.20,
            length: Math.min(W * 0.29, 450), width: 76, color: '#eef2f6'
          }),
          strip({
            id: 'strip', name: '32', kind: 'runway', accepts: ['prop'],
            x: W * 0.20, y: H * 0.55, angle: Math.PI * 0.5,
            length: Math.min(H * 0.26, 280), width: 58, color: '#ffcc3d'
          }),
          strip({
            id: 'water', name: 'Water lane', kind: 'water', accepts: ['seaplane'],
            x: W * 0.55, y: H * 0.80, angle: Math.PI,
            length: Math.min(W * 0.24, 380), width: 78, color: '#3ecf8e'
          }),
          pad({
            id: 'pad', name: 'H', accepts: ['heli'],
            x: W * 0.855, y: H * 0.62, radius: 52, color: '#4d94ff'
          })
        ];
      }
    },
    {
      id: 'taskforce',
      name: 'Task Force',
      theme: 'ocean',
      blurb: 'Carrier ops. Tight decks, no diversions, nothing but water.',
      pool: ['prop', 'jet', 'jumbo', 'heli', 'seaplane'],
      zones: function (W, H) {
        return [
          strip({
            id: 'deck', name: 'CV-6', kind: 'runway', accepts: ['jet', 'jumbo'],
            x: W * 0.36, y: H * 0.30, angle: -0.16,
            length: Math.min(W * 0.27, 420), width: 76, color: '#eef2f6'
          }),
          strip({
            id: 'amphib', name: 'LHA-2', kind: 'runway', accepts: ['prop'],
            x: W * 0.74, y: H * 0.68, angle: Math.PI + 0.13,
            length: Math.min(W * 0.18, 290), width: 58, color: '#ffcc3d'
          }),
          strip({
            id: 'water', name: 'Water lane', kind: 'water', accepts: ['seaplane'],
            x: W * 0.24, y: H * 0.79, angle: 0.06,
            length: Math.min(W * 0.22, 350), width: 78, color: '#3ecf8e'
          }),
          pad({
            id: 'pad', name: 'H', accepts: ['heli'],
            x: W * 0.80, y: H * 0.24, radius: 52, color: '#4d94ff'
          })
        ];
      }
    }
  ];

  function mapById(id) {
    for (var i = 0; i < MAPS.length; i++) if (MAPS[i].id === id) return MAPS[i];
    return MAPS[0];
  }

  /** World width for a given viewport aspect ratio. */
  function worldWidthFor(aspect) {
    return Math.round(WORLD_H * clamp(aspect, MIN_ASPECT, MAX_ASPECT));
  }

  // ----------------------------------------------------------------- aircraft

  var nextId = 1;

  function Aircraft(typeId, x, y, heading) {
    var t = TYPES[typeId];
    this.id = nextId++;
    this.type = typeId;
    this.spec = t;
    this.x = x;
    this.y = y;
    this.heading = heading;
    this.drawHeading = heading;
    this.speed = t.speed;
    this.radius = t.radius;
    this.path = [];           // remaining waypoints, path[0] is the next one
    this.trail = [];          // recent positions, renderer only
    this.landingZone = null;
    this.approach = null;      // which end of the strip it is landing on
    this.drawing = false;
    this.entering = true;     // still crossing in from off-map
    this.state = 'flying';    // flying | landing | done
    this.warn = 0;            // 0..1 proximity alarm level
    this.age = 0;
    this.roll = 0;            // banking angle, renderer only
    this.spin = 0;            // rotor / propeller phase
    this.landT = 0;
    this.landDur = 0;
    this.fade = 1;
    this._prevPath = null;
    this._prevZone = null;
    this._prevAp = null;
    this._dragDist = 0;
  }

  /** Total remaining path length (used by tests and the renderer). */
  Aircraft.prototype.pathLength = function () {
    var total = 0, px = this.x, py = this.y;
    for (var i = 0; i < this.path.length; i++) {
      total += dist(px, py, this.path[i].x, this.path[i].y);
      px = this.path[i].x; py = this.path[i].y;
    }
    return total;
  };

  /**
   * Advance exactly `d` world units along the remaining polyline. Returns the
   * number of units actually travelled (less than `d` if the path ran out).
   */
  Aircraft.prototype.advanceAlongPath = function (d) {
    var moved = 0;
    var guard = 0;
    while (d > 1e-9 && this.path.length > 0 && guard++ < 4096) {
      var p = this.path[0];
      var seg = dist(this.x, this.y, p.x, p.y);
      if (seg < 1e-6) { this.path.shift(); continue; }
      if (seg <= d) {
        this.heading = Math.atan2(p.y - this.y, p.x - this.x);
        this.x = p.x; this.y = p.y;
        d -= seg; moved += seg;
        this.path.shift();
      } else {
        var nx = (p.x - this.x) / seg, ny = (p.y - this.y) / seg;
        this.heading = Math.atan2(ny, nx);
        this.x += nx * d; this.y += ny * d;
        moved += d; d = 0;
      }
    }
    return moved;
  };

  // --------------------------------------------------------------------- game

  function Game(opts) {
    opts = opts || {};
    this.map = typeof opts.map === 'string' ? mapById(opts.map) : (opts.map || MAPS[0]);
    this.W = opts.width || worldWidthFor(1.6);
    this.H = opts.height || WORLD_H;
    this.rng = opts.rng || mulberry32((Math.random() * 0xffffffff) >>> 0);
    this.zones = this.map.zones(this.W, this.H);
    this.aircraft = [];
    this.drags = {};          // pointerId -> aircraft
    this.score = 0;
    this.elapsed = 0;
    this.state = 'playing';   // playing | over
    this.crash = null;
    this.spawnTimer = 1.1;    // first arrival comes quickly
    this.events = [];
    this.warnPairs = 0;
    this.warnPeak = 0;
    this.landedByType = {};
  }

  Game.prototype.emit = function (e) { this.events.push(e); };

  // ---- difficulty ----------------------------------------------------------

  /** Seconds between arrivals at the current difficulty. */
  Game.prototype.spawnInterval = function () {
    var base = 4.4 - this.score * 0.055 - this.elapsed * 0.014;
    return clamp(base, 1.6, 4.4);
  };

  /** How many aircraft may share the airspace right now. */
  Game.prototype.maxAirborne = function () {
    return Math.min(10, 4 + Math.floor(this.score / 6) + Math.floor(this.elapsed / 50));
  };

  /** Aircraft types available at the current difficulty, in unlock order. */
  Game.prototype.availableTypes = function () {
    var pool = this.map.pool;
    var out = [];
    for (var i = 0; i < pool.length; i++) {
      var t = pool[i];
      var unlocked =
        t === 'prop' || t === 'jet' ? true :
        t === 'heli' ? (this.score >= 4 || this.elapsed > 35) :
        t === 'seaplane' ? (this.score >= 9 || this.elapsed > 65) :
        t === 'jumbo' ? (this.score >= 15 || this.elapsed > 100) : true;
      if (unlocked) out.push(t);
    }
    return out.length ? out : ['jet'];
  };

  Game.prototype.countAirborne = function () {
    var n = 0;
    for (var i = 0; i < this.aircraft.length; i++) {
      if (this.aircraft[i].state === 'flying') n++;
    }
    return n;
  };

  // ---- spawning ------------------------------------------------------------

  /**
   * Pick a spawn just outside a random edge, heading inward. Returns null if no
   * conflict-free slot was found, in which case the arrival is simply delayed.
   */
  Game.prototype.findSpawn = function () {
    var W = this.W, H = this.H, rng = this.rng;
    for (var attempt = 0; attempt < 24; attempt++) {
      var edge = Math.floor(rng() * 4);
      var x, y, base;
      var inset = 0.12 + rng() * 0.76; // keep away from the corners
      if (edge === 0) {            // top, heading down
        x = W * inset; y = -SPAWN_OFFSET; base = Math.PI / 2;
      } else if (edge === 1) {     // right, heading left
        x = W + SPAWN_OFFSET; y = H * inset; base = Math.PI;
      } else if (edge === 2) {     // bottom, heading up
        x = W * inset; y = H + SPAWN_OFFSET; base = -Math.PI / 2;
      } else {                     // left, heading right
        x = -SPAWN_OFFSET; y = H * inset; base = 0;
      }
      var heading = base + (rng() - 0.5) * 0.7;

      if (this.spawnIsClear(x, y, heading)) {
        return { x: x, y: y, heading: heading };
      }
    }
    return null;
  };

  /** No existing traffic near the spawn point or the first leg of its track. */
  Game.prototype.spawnIsClear = function (x, y, heading) {
    var ax = x + Math.cos(heading) * 380;
    var ay = y + Math.sin(heading) * 380;
    for (var i = 0; i < this.aircraft.length; i++) {
      var o = this.aircraft[i];
      if (o.state !== 'flying') continue;
      if (dist2(x, y, o.x, o.y) < 340 * 340) return false;
      if (pointSegDist2(o.x, o.y, x, y, ax, ay) < 135 * 135) return false;
    }
    return true;
  };

  Game.prototype.spawn = function () {
    if (this.countAirborne() >= this.maxAirborne()) return null;
    var slot = this.findSpawn();
    if (!slot) return null;
    var types = this.availableTypes();
    var typeId = types[Math.floor(this.rng() * types.length)];
    var a = new Aircraft(typeId, slot.x, slot.y, slot.heading);
    a.drawHeading = slot.heading;
    this.aircraft.push(a);
    this.emit({ type: 'spawn', aircraft: a });
    return a;
  };

  // ---- routing -------------------------------------------------------------

  /** Nearest grabbable aircraft to a point, or null. */
  Game.prototype.pick = function (x, y) {
    var best = null, bestD = GRAB_RADIUS * GRAB_RADIUS;
    for (var i = 0; i < this.aircraft.length; i++) {
      var a = this.aircraft[i];
      if (a.state !== 'flying' || a.drawing) continue;
      var d = dist2(x, y, a.x, a.y);
      if (d <= bestD) { bestD = d; best = a; }
    }
    return best;
  };

  Game.prototype.beginDrag = function (pointerId, x, y) {
    if (this.state !== 'playing') return null;
    if (this.drags[pointerId]) return this.drags[pointerId];
    var a = this.pick(x, y);
    if (!a) return null;
    a._prevPath = a.path;
    a._prevZone = a.landingZone;
    a._prevAp = a.approach;
    a._dragDist = 0;
    a.path = [];
    a.landingZone = null;
    a.approach = null;
    a.drawing = true;
    this.drags[pointerId] = a;
    return a;
  };

  Game.prototype.dragTo = function (pointerId, x, y) {
    var a = this.drags[pointerId];
    if (!a) return;
    var lx, ly;
    if (a.path.length) { lx = a.path[a.path.length - 1].x; ly = a.path[a.path.length - 1].y; }
    else { lx = a.x; ly = a.y; }
    var d = dist(lx, ly, x, y);
    a._dragDist += d;
    if (d < PATH_STEP) return;
    // Keep drawn points inside the world so aircraft never wander off-map.
    a.path.push({
      x: clamp(x, 6, this.W - 6),
      y: clamp(y, 6, this.H - 6)
    });
  };

  Game.prototype.endDrag = function (pointerId, x, y) {
    var a = this.drags[pointerId];
    if (!a) return null;
    delete this.drags[pointerId];
    a.drawing = false;

    // A stray tap should not throw away a route the player already drew.
    if (a._dragDist < TAP_SLOP && a.path.length === 0) {
      a.path = a._prevPath || [];
      a.landingZone = a._prevZone || null;
      a.approach = a._prevAp || null;
      a._prevPath = a._prevZone = a._prevAp = null;
      return null;
    }
    a._prevPath = a._prevZone = a._prevAp = null;

    var zone = this.zoneAt(x, y, a.type);
    if (zone) {
      this.assignLanding(a, zone);
      this.emit({ type: 'route', aircraft: a, zone: zone });
      return zone;
    }
    return null;
  };

  Game.prototype.cancelDrag = function (pointerId) {
    var a = this.drags[pointerId];
    if (!a) return;
    delete this.drags[pointerId];
    a.drawing = false;
    a.path = a._prevPath || [];
    a.landingZone = a._prevZone || null;
    a.approach = a._prevAp || null;
    a._prevPath = a._prevZone = a._prevAp = null;
  };

  /** The zone under a point that will accept `typeId`, if any. */
  Game.prototype.zoneAt = function (x, y, typeId) {
    for (var i = 0; i < this.zones.length; i++) {
      var z = this.zones[i];
      if (typeId && !zoneAccepts(z, typeId)) continue;
      if (zoneCaptures(z, x, y)) return z;
    }
    return null;
  };

  /**
   * Work out the route for landing on one end of a strip. Returns the waypoints,
   * how far the aircraft would fly and its sharpest turn, so both ends can be
   * compared and the better one taken.
   */
  Game.prototype.buildApproach = function (a, zone, ap, drawn) {
    var pts = drawn.slice();

    // The player releases *on* the strip, so the drawn line ends somewhere out
    // along it. Drop those points, or the aircraft flies to where the finger
    // stopped and then hops back to the touchdown point.
    while (pts.length) {
      var p = pts[pts.length - 1];
      if (zoneCaptures(zone, p.x, p.y)) pts.pop();
      else break;
    }

    // Touch down where the aircraft actually meets the strip, not at a fixed
    // point it has to go and find: project its arrival onto the centreline and
    // clamp it into the near half. Coming from beyond the end that lands it on
    // the tip; coming in abeam the middle it lands abeam the middle, the same
    // way a helicopter simply arrives on the pad.
    var tail = pts.length ? pts[pts.length - 1] : { x: a.x, y: a.y };
    var along = clamp((tail.x - ap.tx) * ap.dx + (tail.y - ap.ty) * ap.dy,
                      0, zone.length * 0.55);

    pts.push({ x: ap.tx + ap.dx * along, y: ap.ty + ap.dy * along });
    pts.push({ x: ap.ex, y: ap.ey });   // roll out to the far end

    var length = 0, worstTurn = 0;
    var px = a.x, py = a.y;
    var prevHeading = null;
    for (var i = 0; i < pts.length; i++) {
      var dx = pts[i].x - px, dy = pts[i].y - py;
      var seg = Math.sqrt(dx * dx + dy * dy);
      length += seg;
      if (seg > 1e-6) {
        var heading = Math.atan2(dy, dx);
        if (prevHeading !== null) {
          worstTurn = Math.max(worstTurn, Math.abs(angleDelta(prevHeading, heading)));
        }
        prevHeading = heading;
      }
      px = pts[i].x; py = pts[i].y;
    }
    return { points: pts, length: length, worstTurn: worstTurn };
  };

  /**
   * Snap the tail of an aircraft's path onto a landing zone.
   *
   * A strip can be landed on at either tip, so both are costed and the better
   * one wins — mostly the nearer, but a route that would need the aircraft to
   * double back is penalised so it loses to the longer, straighter one.
   */
  Game.prototype.assignLanding = function (a, zone) {
    a.landingZone = zone;

    if (zone.kind === 'helipad') {
      // Drop anything drawn inside the pad; the pad centre is the last word.
      while (a.path.length) {
        var q = a.path[a.path.length - 1];
        if (dist2(q.x, q.y, zone.x, zone.y) <= zone.radius * zone.radius) a.path.pop();
        else break;
      }
      a.approach = null;
      a.path.push({ x: zone.x, y: zone.y });
      return;
    }

    var drawn = a.path;
    var best = null, bestAp = null, bestCost = Infinity;
    for (var i = 0; i < zone.approaches.length; i++) {
      var candidate = this.buildApproach(a, zone, zone.approaches[i], drawn);
      var cost = candidate.length + candidate.worstTurn * TURN_COST;
      if (cost < bestCost) {
        bestCost = cost;
        best = candidate;
        bestAp = zone.approaches[i];
      }
    }
    a.approach = bestAp;
    a.path = best.points;
  };

  // ---- simulation ----------------------------------------------------------

  Game.prototype.update = function (dt) {
    this.events = [];
    if (this.state !== 'playing') return this.events;
    // Sub-step so fast aircraft can never tunnel past each other or a waypoint.
    var remaining = Math.min(dt, 0.25);
    while (remaining > 0) {
      var step = Math.min(remaining, 1 / 60);
      this.step(step);
      remaining -= step;
      if (this.state !== 'playing') break;
    }
    return this.events;
  };

  Game.prototype.step = function (dt) {
    this.elapsed += dt;

    // arrivals
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      var made = this.spawn();
      var jitter = 0.82 + this.rng() * 0.36;
      this.spawnTimer = made ? this.spawnInterval() * jitter : 0.7;
    }

    for (var i = 0; i < this.aircraft.length; i++) {
      this.stepAircraft(this.aircraft[i], dt);
    }

    // retire finished aircraft
    for (var j = this.aircraft.length - 1; j >= 0; j--) {
      if (this.aircraft[j].state === 'done') this.aircraft.splice(j, 1);
    }

    this.resolveProximity(dt);
  };

  Game.prototype.stepAircraft = function (a, dt) {
    a.age += dt;
    a.spin += dt * (a.type === 'heli' ? 26 : 34);

    if (a.state === 'landing') {
      this.stepLanding(a, dt);
      return;
    }

    var prevHeading = a.heading;
    var travel = a.speed * dt;

    if (a.path.length > 0) {
      var moved = a.advanceAlongPath(travel);
      var leftover = travel - moved;
      if (leftover > 1e-6) this.freeFly(a, leftover, dt);
    } else {
      this.freeFly(a, travel, dt);
    }

    // banking + smoothed sprite rotation
    var turned = angleDelta(prevHeading, a.heading);
    a.roll = clamp(lerp(a.roll, clamp(turned / Math.max(dt, 1e-4) / 3.2, -1, 1), 1 - Math.pow(0.001, dt)), -1, 1);
    a.drawHeading = angleApproach(a.drawHeading, a.heading, 14 * dt);

    if (a.entering &&
        a.x > 4 && a.x < this.W - 4 && a.y > 4 && a.y < this.H - 4) {
      a.entering = false;
    }

    // trail for the renderer
    if (a.trail.length === 0 ||
        dist2(a.x, a.y, a.trail[a.trail.length - 1].x, a.trail[a.trail.length - 1].y) > 90) {
      a.trail.push({ x: a.x, y: a.y });
      if (a.trail.length > 16) a.trail.shift();
    }

    this.checkTouchdown(a);
  };

  /**
   * The stand-off distance at which an aircraft starts turning back. It is
   * derived from the aircraft's own turning circle (speed / turn rate) so even
   * a jumbo flying straight at the boundary has room to complete a U-turn
   * without leaving the play area.
   */
  function edgeMarginFor(a) {
    return clamp(2.0 * a.spec.speed / a.spec.turn, 100, 320);
  }

  /** Straight flight with a turn-rate-limited nudge away from the boundary. */
  Game.prototype.freeFly = function (a, travel, dt) {
    if (!a.entering) {
      var ax = 0, ay = 0;
      var m = edgeMarginFor(a);
      if (a.x < m) ax += (m - a.x) / m;
      if (a.x > this.W - m) ax -= (a.x - (this.W - m)) / m;
      if (a.y < m) ay += (m - a.y) / m;
      if (a.y > this.H - m) ay -= (a.y - (this.H - m)) / m;
      if (ax !== 0 || ay !== 0) {
        // Peel away in a smooth arc: gentle at the edge of the margin, full
        // rate once a quarter of the way in.
        var urgency = Math.hypot(ax, ay);
        var want = Math.atan2(ay, ax);
        var rate = clamp(0.5 + urgency * 2, 0, 1);
        a.heading = angleApproach(a.heading, want, a.spec.turn * dt * rate);
      }
    }
    a.x += Math.cos(a.heading) * travel;
    a.y += Math.sin(a.heading) * travel;
  };

  /** Has the aircraft reached its assigned zone? */
  Game.prototype.checkTouchdown = function (a) {
    var z = a.landingZone;
    if (!z || a.state !== 'flying') return;

    if (z.kind === 'helipad') {
      if (a.path.length === 0 && dist2(a.x, a.y, z.x, z.y) < Math.pow(z.radius, 2)) {
        this.beginLanding(a, z);
      }
      return;
    }
    // Only after the approach fix has been consumed (one waypoint left: the
    // rollout end) do we look for the threshold, otherwise a path that happens
    // to cross the runway earlier would trigger a false touchdown.
    if (a.path.length <= 1) {
      var ap = a.approach;
      if (!ap) return;
      var along = (a.x - ap.tx) * ap.dx + (a.y - ap.ty) * ap.dy;
      var across = Math.abs(-(a.x - z.x) * ap.dy + (a.y - z.y) * ap.dx);
      if (along >= 0 && across <= z.width) this.beginLanding(a, z);
    }
  };

  Game.prototype.beginLanding = function (a, z) {
    a.state = 'landing';
    a.path = [];
    a.landT = 0;
    a.fade = 1;
    if (z.kind === 'helipad') {
      a.landDur = 0.75;
      a.landFrom = { x: a.x, y: a.y };
      a.landTo = { x: z.x, y: z.y };
    } else {
      a.landDur = 0.78;
      var ap = a.approach || z.approaches[0];
      a.heading = ap.angle;
      a.drawHeading = ap.angle;
      a.landFrom = { x: a.x, y: a.y };
      a.landTo = { x: ap.ex, y: ap.ey };
    }
    this.score++;
    this.landedByType[a.type] = (this.landedByType[a.type] || 0) + 1;
    this.emit({ type: 'landed', aircraft: a, zone: z, score: this.score });
  };

  Game.prototype.stepLanding = function (a, dt) {
    a.landT += dt;
    var t = clamp(a.landT / a.landDur, 0, 1);
    var e = 1 - Math.pow(1 - t, 2.4);   // ease-out rollout
    a.x = lerp(a.landFrom.x, a.landTo.x, e);
    a.y = lerp(a.landFrom.y, a.landTo.y, e);
    a.speed = a.spec.speed * (1 - e);
    a.fade = t > 0.72 ? clamp(1 - (t - 0.72) / 0.28, 0, 1) : 1;
    if (t >= 1) a.state = 'done';
  };

  // ---- separation ----------------------------------------------------------

  Game.prototype.resolveProximity = function (dt) {
    var list = this.aircraft;
    var n = list.length;
    for (var i = 0; i < n; i++) list[i]._warnNext = 0;

    for (var a = 0; a < n; a++) {
      var A = list[a];
      if (A.state !== 'flying' || A.entering) continue;
      for (var b = a + 1; b < n; b++) {
        var B = list[b];
        if (B.state !== 'flying' || B.entering) continue;
        var hit = A.radius + B.radius;
        var warn = hit * WARN_FACTOR;
        var d2 = dist2(A.x, A.y, B.x, B.y);
        if (d2 <= hit * hit) {
          this.triggerCrash(A, B);
          return;
        }
        if (d2 <= warn * warn) {
          var level = clamp(1 - (Math.sqrt(d2) - hit) / (warn - hit), 0, 1);
          if (level > A._warnNext) A._warnNext = level;
          if (level > B._warnNext) B._warnNext = level;
        }
      }
    }

    var pairs = 0, peak = 0;
    for (var k = 0; k < n; k++) {
      var C = list[k];
      var target = C._warnNext;
      // rise fast, fall slow, so the alarm does not flicker
      C.warn = target > C.warn
        ? Math.min(target, C.warn + dt * 6)
        : Math.max(target, C.warn - dt * 2.2);
      if (C.warn > 0.05) pairs++;
      if (C.warn > peak) peak = C.warn;
    }
    this.warnPairs = pairs;
    this.warnPeak = peak;
  };

  Game.prototype.triggerCrash = function (A, B) {
    this.state = 'over';
    this.crash = {
      x: (A.x + B.x) / 2,
      y: (A.y + B.y) / 2,
      a: A, b: B,
      t: 0
    };
    A.state = 'wreck';
    B.state = 'wreck';
    this.emit({ type: 'crash', a: A, b: B, x: this.crash.x, y: this.crash.y });
  };

  // ---- resizing ------------------------------------------------------------

  /** Keep everything proportional when the viewport changes shape. */
  Game.prototype.resize = function (W, H) {
    if (W === this.W && H === this.H) return;
    var sx = W / this.W, sy = H / this.H;
    this.W = W; this.H = H;
    this.zones = this.map.zones(W, H);
    for (var i = 0; i < this.aircraft.length; i++) {
      var a = this.aircraft[i];
      a.x *= sx; a.y *= sy;
      for (var j = 0; j < a.path.length; j++) { a.path[j].x *= sx; a.path[j].y *= sy; }
      for (var k = 0; k < a.trail.length; k++) { a.trail[k].x *= sx; a.trail[k].y *= sy; }
      if (a.landFrom) { a.landFrom.x *= sx; a.landFrom.y *= sy; }
      if (a.landTo) { a.landTo.x *= sx; a.landTo.y *= sy; }
      // re-point any assigned landing at the rebuilt zone
      if (a.landingZone) {
        for (var z = 0; z < this.zones.length; z++) {
          if (this.zones[z].id !== a.landingZone.id) continue;
          a.landingZone = this.zones[z];
          if (a.approach && this.zones[z].approaches) {
            a.approach = this.zones[z].approaches[a.approach.idx];
          }
          break;
        }
      }
    }
    if (this.crash) { this.crash.x *= sx; this.crash.y *= sy; }
  };

  // ------------------------------------------------------------------ exports

  return {
    WORLD_H: WORLD_H,
    MIN_ASPECT: MIN_ASPECT,
    MAX_ASPECT: MAX_ASPECT,
    GRAB_RADIUS: GRAB_RADIUS,
    TYPES: TYPES,
    MAPS: MAPS,
    mapById: mapById,
    worldWidthFor: worldWidthFor,
    Aircraft: Aircraft,
    Game: Game,
    zoneCaptures: zoneCaptures,
    zoneAccepts: zoneAccepts,
    edgeMarginFor: edgeMarginFor,
    util: {
      clamp: clamp, lerp: lerp, dist: dist, dist2: dist2,
      angleDelta: angleDelta, angleApproach: angleApproach,
      pointSegDist2: pointSegDist2, mulberry32: mulberry32
    }
  };
});
