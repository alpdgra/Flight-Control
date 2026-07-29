'use strict';

const test = require('node:test');
const assert = require('node:assert');
const FC = require('../src/engine.js');

const { Game, Aircraft, TYPES, MAPS, util } = FC;
const { mulberry32, dist, angleDelta, angleApproach } = util;

function newGame(opts = {}) {
  return new Game(Object.assign({
    map: 'airfield',
    width: 1600,
    height: 1000,
    rng: mulberry32(12345)
  }, opts));
}

/** A game with the arrival stream switched off, for testing one thing at a time. */
function soloGame(opts = {}) {
  const g = newGame(opts);
  g.spawnTimer = Infinity;
  return g;
}

/** Put an aircraft in the sky, already established inside the play area. */
function inbound(game, typeId, x, y, heading = 0) {
  const a = new Aircraft(typeId, x, y, heading);
  a.entering = false;
  game.aircraft.push(a);
  return a;
}

/** Draw a route from an aircraft to a point, the way a player would. */
function route(game, aircraft, targetX, targetY, id = 'p') {
  if (!game.beginDrag(id, aircraft.x, aircraft.y)) return null;
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    game.dragTo(id, aircraft.x + (targetX - aircraft.x) * i / steps,
                    aircraft.y + (targetY - aircraft.y) * i / steps);
  }
  return game.endDrag(id, targetX, targetY);
}

/** Run the sim for `seconds` at 60 Hz, collecting every emitted event. */
function run(game, seconds, perStep) {
  const dt = 1 / 60;
  const events = [];
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    for (const e of game.update(dt)) events.push(e);
    if (perStep) perStep(game, i);
    if (game.state !== 'playing') break;
  }
  return events;
}

// --------------------------------------------------------------- math helpers

test('angleDelta returns the shortest signed turn', () => {
  assert.ok(Math.abs(angleDelta(0, 0.5) - 0.5) < 1e-9);
  assert.ok(Math.abs(angleDelta(0.5, 0) + 0.5) < 1e-9);
  // crossing the +/-PI seam takes the short way round
  assert.ok(Math.abs(angleDelta(3.0, -3.0) - (2 * Math.PI - 6.0)) < 1e-9);
  assert.ok(Math.abs(angleDelta(-3.0, 3.0) + (2 * Math.PI - 6.0)) < 1e-9);
  assert.ok(Math.abs(angleDelta(0, Math.PI * 4)) < 1e-9);
});

test('angleApproach never overshoots its target', () => {
  assert.strictEqual(angleApproach(0, 0.1, 1), 0.1);
  assert.ok(Math.abs(angleApproach(0, 1, 0.25) - 0.25) < 1e-9);
  assert.ok(Math.abs(angleApproach(0, -1, 0.25) + 0.25) < 1e-9);
});

// ------------------------------------------------------------ path following

test('advanceAlongPath travels an exact distance along a polyline', () => {
  const a = new Aircraft('jet', 0, 0, 0);
  a.path = [{ x: 100, y: 0 }, { x: 100, y: 100 }];
  const moved = a.advanceAlongPath(150);
  assert.strictEqual(moved, 150);
  assert.ok(Math.abs(a.x - 100) < 1e-9, `x=${a.x}`);
  assert.ok(Math.abs(a.y - 50) < 1e-9, `y=${a.y}`);
  assert.strictEqual(a.path.length, 1);
  // heading now points down the second leg
  assert.ok(Math.abs(a.heading - Math.PI / 2) < 1e-9);
});

test('advanceAlongPath reports the shortfall when the path runs out', () => {
  const a = new Aircraft('jet', 0, 0, 0);
  a.path = [{ x: 10, y: 0 }];
  const moved = a.advanceAlongPath(40);
  assert.strictEqual(moved, 10);
  assert.strictEqual(a.path.length, 0);
});

test('advanceAlongPath tolerates duplicate waypoints', () => {
  const a = new Aircraft('jet', 0, 0, 0);
  a.path = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 60, y: 0 }];
  const moved = a.advanceAlongPath(30);
  assert.strictEqual(moved, 30);
  assert.ok(Math.abs(a.x - 30) < 1e-9);
});

test('pathLength measures from the aircraft through every waypoint', () => {
  const a = new Aircraft('prop', 0, 0, 0);
  a.path = [{ x: 30, y: 40 }, { x: 30, y: 140 }];
  assert.ok(Math.abs(a.pathLength() - 150) < 1e-9);
});

// -------------------------------------------------------------------- routing

test('drawing a path to a matching runway lands the aircraft', () => {
  const g = soloGame();
  const runway = g.zones.find(z => z.id === 'main');
  const a = inbound(g, 'jet', 200, 900);

  g.beginDrag('p1', a.x, a.y);
  g.dragTo('p1', 600, 600);
  const zone = g.endDrag('p1', runway.x, runway.y);
  assert.strictEqual(zone, runway);
  assert.strictEqual(a.landingZone, runway);

  const events = run(g, 40);
  const landed = events.filter(e => e.type === 'landed' && e.aircraft === a);
  assert.strictEqual(landed.length, 1, 'aircraft should land exactly once');
  assert.strictEqual(landed[0].zone, runway);
  assert.ok(g.score >= 1);
});

test('an aircraft lands travelling along the runway heading', () => {
  const g = soloGame();
  const runway = g.zones.find(z => z.id === 'strip'); // heading = PI
  const a = new Aircraft('prop', 120, 120, 0);
  a.entering = false;
  g.aircraft.push(a);
  g.beginDrag('p1', a.x, a.y);
  g.dragTo('p1', 400, 300);
  g.endDrag('p1', runway.x, runway.y);

  let touchdownHeading = null;
  run(g, 60, () => {
    if (a.state === 'landing' && touchdownHeading === null) touchdownHeading = a.heading;
  });
  assert.ok(touchdownHeading !== null, 'aircraft never touched down');
  assert.ok(
    runway.approaches.some(ap => Math.abs(angleDelta(touchdownHeading, ap.angle)) < 0.02),
    `landed on heading ${touchdownHeading}, which is neither end of the strip`
  );
});

// ------------------------------------------------- approach path is sensible

/**
 * Sharpest turn, in degrees, anywhere along an aircraft's route. A value near
 * 180 means the path doubles back on itself.
 */
function sharpestTurn(aircraft) {
  var worst = 0;
  var prev = { x: aircraft.x, y: aircraft.y };
  for (let i = 0; i < aircraft.path.length - 1; i++) {
    const a = aircraft.path[i], b = aircraft.path[i + 1];
    const h1 = Math.atan2(a.y - prev.y, a.x - prev.x);
    const h2 = Math.atan2(b.y - a.y, b.x - a.x);
    worst = Math.max(worst, Math.abs(angleDelta(h1, h2)) * 180 / Math.PI);
    prev = a;
  }
  return worst;
}

test('routing onto a runway does not double the path back on itself', () => {
  // The player drags from the aircraft onto the runway, so the drawn line ends
  // on top of it — past the point where the approach begins. Those trailing
  // points must be trimmed, or the aircraft overflies the runway and reverses.
  const g = soloGame();
  const runway = g.zones.find(z => z.id === 'main');
  const a = inbound(g, 'jet', 300, 850);
  assert.ok(route(g, a, runway.x, runway.y));

  assert.ok(sharpestTurn(a) < 135,
    `path reverses (${sharpestTurn(a).toFixed(0)}deg turn)`);

  // The drawn tail must have been trimmed off the strip: everything before the
  // touchdown point is still outside it.
  for (let i = 0; i < a.path.length - 2; i++) {
    assert.ok(!FC.zoneCaptures(runway, a.path[i].x, a.path[i].y),
      `waypoint ${i} is still sitting on the runway`);
  }
  // and the touchdown point is on the strip itself, not out in front of it
  const touch = a.path[a.path.length - 2];
  const ap = a.approach;
  const along = (touch.x - ap.tx) * ap.dx + (touch.y - ap.ty) * ap.dy;
  assert.ok(along >= -1e-6 && along <= runway.length,
    `touchdown sits ${along.toFixed(0)} along a ${runway.length.toFixed(0)} strip`);
});

/** Total distance an aircraft will fly along its current route. */
function routeLength(a) {
  let total = 0, px = a.x, py = a.y;
  for (const p of a.path) { total += dist(px, py, p.x, p.y); px = p.x; py = p.y; }
  return total;
}

/** The shortest route physically possible: to the nearest tip, then down it. */
function shortestPossible(a, zone) {
  const nearest = Math.min.apply(null,
    zone.approaches.map(ap => dist(a.x, a.y, ap.tx, ap.ty)));
  return nearest + zone.length;
}

test('a strip is landed on from whichever end the aircraft arrives at', () => {
  // Same runway, opposite sides: the two aircraft must use opposite ends
  // rather than one of them flying all the way around.
  const g = soloGame();
  const runway = g.zones.find(z => z.id === 'main');

  const west = inbound(g, 'jet', 120, 500);
  assert.ok(route(g, west, runway.x, runway.y, 'w'));
  const east = inbound(g, 'jet', g.W - 120, 500);
  assert.ok(route(g, east, runway.x, runway.y, 'e'));

  assert.notStrictEqual(west.approach.idx, east.approach.idx,
    'both aircraft picked the same end of the runway');
  for (const a of [west, east]) {
    assert.ok(sharpestTurn(a) < 135, `path reverses (${sharpestTurn(a).toFixed(0)}deg)`);
  }
});

test('arriving from the far side does not cost a lap of the map', () => {
  // The reported case: a light aircraft west of a deck that used to be
  // approachable only from the east flew 1803 units to cover 560.
  const g = soloGame({ map: 'taskforce', width: 1900 });
  const deck = g.zones.find(z => z.id === 'amphib');
  const a = inbound(g, 'prop', 900, 440);
  assert.ok(route(g, a, deck.x, deck.y));

  const flown = routeLength(a);
  assert.ok(flown < shortestPossible(a, deck) + 300,
    `flew ${flown.toFixed(0)} for a ${dist(a.x, a.y, deck.x, deck.y).toFixed(0)} hop`);
  assert.ok(sharpestTurn(a) < 135);
  assert.strictEqual(run(g, 120).filter(e => e.type === 'landed').length, 1);
});

test('an aircraft already on the approach is not sent backwards first', () => {
  // Sitting a few units short of the tip must not produce a hop back to it.
  const g = soloGame();
  const runway = g.zones.find(z => z.id === 'main');
  const ap = runway.approaches[0];
  const a = inbound(g, 'jet', ap.tx - 12 * ap.dx, ap.ty - 12 * ap.dy);
  assert.ok(route(g, a, runway.x, runway.y));
  assert.ok(sharpestTurn(a) < 135,
    `path kinks backwards (${sharpestTurn(a).toFixed(0)}deg turn)`);
  assert.strictEqual(run(g, 90).filter(e => e.type === 'landed').length, 1);
});

test('every approach on every map is flyable without doubling back', () => {
  // Sweep each landing zone against each aircraft it accepts, approaching from
  // all around the compass.
  let checked = 0;
  for (const map of MAPS) {
    const probe = new Game({ map: map.id, width: 1600, height: 1000, rng: mulberry32(2) });
    for (const zone of probe.zones) {
      for (const typeId of zone.accepts) {
        for (let k = 0; k < 16; k++) {
          const th = (k / 16) * Math.PI * 2;
          const g = soloGame({ map: map.id });
          const z = g.zones.find(q => q.id === zone.id);
          const a = inbound(g, typeId,
            g.W / 2 + Math.cos(th) * g.W * 0.44,
            g.H / 2 + Math.sin(th) * g.H * 0.44);
          const where = `${map.id}/${zone.id}/${typeId} @${(th * 180 / Math.PI).toFixed(0)}deg`;

          assert.ok(route(g, a, z.x, z.y), `${where}: could not be routed`);
          assert.ok(sharpestTurn(a) < 135,
            `${where}: path reverses (${sharpestTurn(a).toFixed(0)}deg)`);
          if (z.kind !== 'helipad') {
            const flown = routeLength(a);
            const floor = shortestPossible(a, z);
            assert.ok(flown < floor + 150,
              `${where}: flew ${flown.toFixed(0)}, ${(flown - floor).toFixed(0)} more than needed`);
          }
          assert.strictEqual(run(g, 200).filter(e => e.type === 'landed').length, 1,
            `${where}: never landed`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked >= 200, `only swept ${checked} approaches`);
});

test('a path drawn across a helipad settles on the pad, not past it', () => {
  const g = soloGame();
  const pad = g.zones.find(z => z.kind === 'helipad');
  const heli = inbound(g, 'heli', 200, 200);
  assert.ok(route(g, heli, pad.x, pad.y));
  assert.ok(sharpestTurn(heli) < 135,
    `path reverses (${sharpestTurn(heli).toFixed(0)}deg turn)`);
  // the pad centre is the final waypoint
  const last = heli.path[heli.path.length - 1];
  assert.ok(Math.abs(last.x - pad.x) < 1e-6 && Math.abs(last.y - pad.y) < 1e-6);
});

test('a path that merely crosses the runway does not trigger a landing', () => {
  const g = soloGame();
  const runway = g.zones.find(z => z.id === 'main');
  const a = new Aircraft('jet', 100, runway.y, 0);
  a.entering = false;
  g.aircraft.push(a);

  // Route straight through the runway and out to open airspace, no landing.
  g.beginDrag('p1', a.x, a.y);
  for (let x = 120; x <= 1500; x += 40) g.dragTo('p1', x, runway.y);
  g.endDrag('p1', 1500, runway.y);
  assert.strictEqual(a.landingZone, null, 'endpoint was not on a zone');

  run(g, 25);
  assert.strictEqual(g.score, 0, 'flying over a runway must not score');
});

test('runways refuse aircraft they do not serve', () => {
  const g = soloGame();
  const runway = g.zones.find(z => z.id === 'main'); // jets and jumbos only
  const heli = new Aircraft('heli', 300, 500, 0);
  heli.entering = false;
  g.aircraft.push(heli);

  g.beginDrag('p1', heli.x, heli.y);
  g.dragTo('p1', 400, 500);
  const zone = g.endDrag('p1', runway.x, runway.y);
  assert.strictEqual(zone, null);
  assert.strictEqual(heli.landingZone, null);
});

test('helicopters land on the helipad', () => {
  const g = soloGame();
  const helipad = g.zones.find(z => z.kind === 'helipad');
  const heli = new Aircraft('heli', 200, 200, 0);
  heli.entering = false;
  g.aircraft.push(heli);

  g.beginDrag('p1', heli.x, heli.y);
  g.dragTo('p1', 400, 400);
  assert.strictEqual(g.endDrag('p1', helipad.x, helipad.y), helipad);

  const events = run(g, 60);
  assert.strictEqual(events.filter(e => e.type === 'landed').length, 1);
});

test('a tap with no drag keeps the existing route', () => {
  const g = soloGame();
  const runway = g.zones.find(z => z.id === 'main');
  const a = new Aircraft('jet', 200, 900, 0);
  a.entering = false;
  g.aircraft.push(a);

  g.beginDrag('p1', a.x, a.y);
  g.dragTo('p1', 500, 500);
  g.endDrag('p1', runway.x, runway.y);
  const routed = a.path.length;
  assert.ok(routed > 0 && a.landingZone === runway);

  // now a stray tap on the same aircraft
  g.beginDrag('p2', a.x, a.y);
  g.endDrag('p2', a.x, a.y);
  assert.strictEqual(a.landingZone, runway, 'route survived the tap');
  assert.strictEqual(a.path.length, routed);
});

test('a real drag replaces the previous route', () => {
  const g = soloGame();
  const runway = g.zones.find(z => z.id === 'main');
  const a = new Aircraft('jet', 200, 900, 0);
  a.entering = false;
  g.aircraft.push(a);

  g.beginDrag('p1', a.x, a.y);
  g.dragTo('p1', 500, 500);
  g.endDrag('p1', runway.x, runway.y);

  g.beginDrag('p2', a.x, a.y);
  g.dragTo('p2', 300, 800);
  g.dragTo('p2', 400, 850);
  g.endDrag('p2', 400, 850);
  assert.strictEqual(a.landingZone, null, 'new route ends in open airspace');
  assert.ok(a.path.length > 0);
});

test('cancelling a drag restores the previous route', () => {
  const g = soloGame();
  const runway = g.zones.find(z => z.id === 'main');
  const a = new Aircraft('jet', 200, 900, 0);
  a.entering = false;
  g.aircraft.push(a);
  g.beginDrag('p1', a.x, a.y);
  g.dragTo('p1', 500, 500);
  g.endDrag('p1', runway.x, runway.y);

  g.beginDrag('p2', a.x, a.y);
  g.dragTo('p2', 100, 100);
  g.cancelDrag('p2');
  assert.strictEqual(a.landingZone, runway);
  assert.strictEqual(a.drawing, false);
});

test('two aircraft can be routed at once with separate pointers', () => {
  const g = soloGame();
  const runway = g.zones.find(z => z.id === 'main');
  const pad = g.zones.find(z => z.kind === 'helipad');
  const jet = new Aircraft('jet', 200, 500, 0);
  const heli = new Aircraft('heli', 260, 900, 0);
  jet.entering = heli.entering = false;
  g.aircraft.push(jet, heli);

  g.beginDrag('a', jet.x, jet.y);
  g.beginDrag('b', heli.x, heli.y);
  g.dragTo('a', 500, 400);
  g.dragTo('b', 500, 900);
  g.endDrag('a', runway.x, runway.y);
  g.endDrag('b', pad.x, pad.y);

  assert.strictEqual(jet.landingZone, runway);
  assert.strictEqual(heli.landingZone, pad);
});

test('drawn waypoints are clamped inside the world', () => {
  const g = soloGame();
  const a = new Aircraft('jet', 200, 500, 0);
  a.entering = false;
  g.aircraft.push(a);
  g.beginDrag('p1', a.x, a.y);
  g.dragTo('p1', -900, -900);
  g.dragTo('p1', 9000, 9000);
  g.endDrag('p1', 9000, 9000);
  for (const p of a.path) {
    assert.ok(p.x >= 0 && p.x <= g.W, `x out of world: ${p.x}`);
    assert.ok(p.y >= 0 && p.y <= g.H, `y out of world: ${p.y}`);
  }
});

test('grabbing requires the pointer to be near an aircraft', () => {
  const g = soloGame();
  const a = new Aircraft('jet', 500, 500, 0);
  a.entering = false;
  g.aircraft.push(a);
  assert.strictEqual(g.beginDrag('p1', 500 + FC.GRAB_RADIUS + 5, 500), null);
  assert.strictEqual(g.beginDrag('p2', 500 + FC.GRAB_RADIUS - 5, 500), a);
});

// ------------------------------------------------------------------ collisions

test('two aircraft on a converging course end the game', () => {
  const g = soloGame();
  const a = new Aircraft('jet', 700, 500, 0);
  const b = new Aircraft('jet', 900, 500, Math.PI);
  a.entering = b.entering = false;
  g.aircraft.push(a, b);

  const events = run(g, 10);
  assert.strictEqual(g.state, 'over');
  const crash = events.find(e => e.type === 'crash');
  assert.ok(crash, 'a crash event should be emitted');
  assert.ok(Math.abs(crash.x - 800) < 40, `crash at x=${crash.x}`);
});

test('proximity raises a warning before aircraft collide', () => {
  const g = soloGame();
  const a = new Aircraft('jet', 700, 500, 0);
  const b = new Aircraft('jet', 900, 500, Math.PI);
  a.entering = b.entering = false;
  g.aircraft.push(a, b);

  let warnedBeforeCrash = false;
  run(g, 10, () => {
    if (g.state === 'playing' && a.warn > 0.15) warnedBeforeCrash = true;
  });
  assert.ok(warnedBeforeCrash, 'warning level should rise before the collision');
});

test('aircraft still entering the map cannot be hit', () => {
  const g = soloGame();
  const a = new Aircraft('jet', -20, 500, 0);   // still outside, entering
  const b = new Aircraft('jet', -20, 500, 0);
  g.aircraft.push(a, b);
  assert.strictEqual(a.entering, true);
  g.update(1 / 60);
  assert.strictEqual(g.state, 'playing');
});

test('landing aircraft are no longer a collision hazard', () => {
  const g = soloGame();
  const runway = g.zones.find(z => z.id === 'main');
  const ap = runway.approaches[0];
  const a = new Aircraft('jet', ap.tx, ap.ty, ap.angle);
  a.entering = false;
  g.aircraft.push(a);
  g.beginLanding(a, runway);
  assert.strictEqual(a.state, 'landing');

  const b = new Aircraft('jet', a.x, a.y, 0);   // sitting right on top of it
  b.entering = false;
  g.aircraft.push(b);
  g.update(1 / 60);
  assert.strictEqual(g.state, 'playing');
});

test('the game does not end on its own with an empty sky', () => {
  const g = soloGame();
  g.spawnTimer = 1e9;   // suppress arrivals
  run(g, 120);
  assert.strictEqual(g.state, 'playing');
  assert.strictEqual(g.aircraft.length, 0);
});

// -------------------------------------------------------------- free flight

test('unrouted aircraft turn back and stay inside the play area', () => {
  // Every type, launched at every edge, on a heading straight out of the map.
  for (const typeId of Object.keys(TYPES)) {
    const g = soloGame();
    g.spawnTimer = 1e9;
    const headings = [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.7, 2.4, -2.4, -0.7];
    const starts = [
      [80, 500], [g.W - 80, 500], [800, 80], [800, g.H - 80],
      [60, 60], [g.W - 60, g.H - 60], [g.W / 2, g.H / 2]
    ];
    for (const h of headings) {
      for (const [sx, sy] of starts) {
        const a = new Aircraft(typeId, sx, sy, h);
        a.entering = false;
        const solo = soloGame();
        solo.spawnTimer = 1e9;
        solo.aircraft.push(a);
        run(solo, 90);
        assert.ok(
          a.x > -60 && a.x < solo.W + 60 && a.y > -60 && a.y < solo.H + 60,
          `${typeId} escaped from (${sx},${sy}) h=${h.toFixed(2)} -> (${a.x.toFixed(0)},${a.y.toFixed(0)})`
        );
      }
    }
  }
});

test('spawned aircraft enter the map and are eventually collidable', () => {
  const g = soloGame();
  const a = g.spawn();
  assert.ok(a, 'spawn should succeed on an empty map');
  assert.strictEqual(a.entering, true);
  run(g, 12, () => { g.spawnTimer = 1e9; });
  assert.strictEqual(a.entering, false, 'aircraft should have entered the map');
});

test('an aircraft flying off the end of its path keeps flying', () => {
  const g = soloGame();
  const a = new Aircraft('prop', 400, 500, 0);
  a.entering = false;
  a.path = [{ x: 500, y: 500 }];
  g.aircraft.push(a);
  run(g, 5);
  assert.strictEqual(a.path.length, 0);
  assert.ok(a.x > 500, 'aircraft continued past the end of its path');
  assert.strictEqual(a.state, 'flying');
});

// ---------------------------------------------------------------- difficulty

test('arrivals get closer together and the sky gets busier as the score climbs', () => {
  const g = soloGame();
  const easy = g.spawnInterval();
  const easyCap = g.maxAirborne();
  g.score = 60;
  g.elapsed = 300;
  assert.ok(g.spawnInterval() < easy);
  assert.ok(g.spawnInterval() >= 1.45);
  assert.ok(g.maxAirborne() > easyCap);
  assert.ok(g.maxAirborne() <= 12);
});

test('aircraft types unlock progressively', () => {
  const g = soloGame();
  const early = g.availableTypes();
  assert.ok(early.includes('jet'));
  assert.ok(early.includes('prop'));
  assert.ok(!early.includes('jumbo'), 'jumbos should be a later unlock');
  g.score = 40;
  g.elapsed = 200;
  const late = g.availableTypes();
  for (const t of g.map.pool) assert.ok(late.includes(t), `${t} should be unlocked`);
});

test('the airborne cap is respected', () => {
  const g = soloGame();
  for (let i = 0; i < 400; i++) g.spawn();
  assert.ok(g.countAirborne() <= g.maxAirborne());
});

test('new arrivals are never dropped on top of existing traffic', () => {
  const g = soloGame({ rng: mulberry32(7) });
  g.maxAirborne = () => 99;   // isolate the clearance check from the traffic cap
  const scatter = mulberry32(99);
  for (let i = 0; i < 8; i++) {
    inbound(g, 'jet', 120 + scatter() * (g.W - 240), 120 + scatter() * (g.H - 240),
            scatter() * Math.PI * 2);
  }
  const traffic = g.aircraft.slice();

  let made = 0;
  for (let i = 0; i < 500; i++) {
    const a = g.spawn();
    if (!a) continue;
    made++;
    for (const other of traffic) {
      assert.ok(dist(a.x, a.y, other.x, other.y) >= 280,
        `arrival born ${dist(a.x, a.y, other.x, other.y).toFixed(0)} from traffic`);
      // and nothing sitting in the first stretch of its track either
      const ax = a.x + Math.cos(a.heading) * 340;
      const ay = a.y + Math.sin(a.heading) * 340;
      const clearance = Math.sqrt(util.pointSegDist2(other.x, other.y, a.x, a.y, ax, ay));
      assert.ok(clearance >= 105, `arrival tracks within ${clearance.toFixed(0)} of traffic`);
    }
    g.aircraft.pop();   // make room so the airborne cap keeps letting us spawn
  }
  assert.ok(made > 100, `only ${made} spawns succeeded`);
});

test('arrivals stop when the airspace is saturated', () => {
  const g = soloGame();
  // Ring the map with traffic so no edge is clear.
  for (let i = 0; i < 40; i++) {
    const t = i / 40 * Math.PI * 2;
    inbound(g, 'jet', g.W / 2 + Math.cos(t) * g.W * 0.47, g.H / 2 + Math.sin(t) * g.H * 0.47, t);
  }
  assert.strictEqual(g.spawn(), null, 'should refuse to spawn into a wall of traffic');
});

// -------------------------------------------------------------------- resize

test('resize keeps aircraft, paths and routes proportional', () => {
  const g = soloGame();
  const runway = g.zones.find(z => z.id === 'main');
  const a = new Aircraft('jet', 800, 500, 0);
  a.entering = false;
  g.aircraft.push(a);
  g.beginDrag('p1', a.x, a.y);
  g.dragTo('p1', 900, 400);
  g.endDrag('p1', runway.x, runway.y);

  g.resize(3200, 2000);
  assert.strictEqual(g.W, 3200);
  assert.ok(Math.abs(a.x - 1600) < 1e-6);
  assert.ok(Math.abs(a.y - 1000) < 1e-6);
  assert.ok(a.landingZone, 'route survived the resize');
  assert.strictEqual(a.landingZone.id, 'main');
  assert.notStrictEqual(a.landingZone, runway, 'zone was rebuilt at the new size');

  // and it still lands
  const events = run(g, 90);
  assert.strictEqual(events.filter(e => e.type === 'landed').length, 1);
});

test('worldWidthFor clamps extreme aspect ratios', () => {
  assert.strictEqual(FC.worldWidthFor(1.6), 1600);
  assert.strictEqual(FC.worldWidthFor(0.5), Math.round(1000 * FC.MIN_ASPECT));
  assert.strictEqual(FC.worldWidthFor(9), Math.round(1000 * FC.MAX_ASPECT));
});

// ---------------------------------------------------------------------- maps

test('every map is playable: each aircraft in its pool has a zone', () => {
  for (const map of MAPS) {
    const g = new Game({ map: map.id, width: 1600, height: 1000, rng: mulberry32(3) });
    assert.ok(g.zones.length >= 3, `${map.id} needs landing zones`);
    for (const typeId of map.pool) {
      const zone = g.zones.find(z => FC.zoneAccepts(z, typeId));
      assert.ok(zone, `${map.id} has no landing zone for ${typeId}`);
    }
    for (const z of g.zones) {
      assert.ok(z.x > 0 && z.x < g.W, `${map.id}/${z.id} is off-map horizontally`);
      assert.ok(z.y > 0 && z.y < g.H, `${map.id}/${z.id} is off-map vertically`);
      if (z.kind !== 'helipad') {
        // the snapped approach fix must sit inside the world, otherwise
        // aircraft would have to fly off-map to line up
        // both tips must sit inside the map so either can be flown to
        for (const ap of z.approaches) {
          assert.ok(ap.tx > -10 && ap.tx < g.W + 10 && ap.ty > -10 && ap.ty < g.H + 10,
            `${map.id}/${z.id} has a tip off-map`);
        }
      }
    }
  }
});

test('landing zones do not overlap each other', () => {
  for (const map of MAPS) {
    const g = new Game({ map: map.id, width: 1600, height: 1000, rng: mulberry32(3) });
    for (let i = 0; i < g.zones.length; i++) {
      for (let j = i + 1; j < g.zones.length; j++) {
        const a = g.zones[i], b = g.zones[j];
        assert.ok(
          dist(a.x, a.y, b.x, b.y) > 190,
          `${map.id}: ${a.id} and ${b.id} are too close (${dist(a.x, a.y, b.x, b.y).toFixed(0)})`
        );
      }
    }
  }
});

test('every map can be played to a score at the narrowest aspect ratio', () => {
  for (const map of MAPS) {
    const W = FC.worldWidthFor(FC.MIN_ASPECT);
    const g = new Game({ map: map.id, width: W, height: 1000, rng: mulberry32(99) });
    g.spawnTimer = 1e9;
    for (const typeId of map.pool) {
      const zone = g.zones.find(z => FC.zoneAccepts(z, typeId));
      const a = new Aircraft(typeId, W / 2, 500, 0);
      a.entering = false;
      g.aircraft.length = 0;
      g.aircraft.push(a);
      g.beginDrag('p', a.x, a.y);
      g.dragTo('p', a.x + 30, a.y + 10);
      assert.ok(g.endDrag('p', zone.x, zone.y), `${map.id}: ${typeId} could not be routed`);
      const before = g.score;
      run(g, 120);
      assert.strictEqual(g.score, before + 1, `${map.id}: ${typeId} never landed`);
    }
  }
});

// ------------------------------------------------------------- determinism

test('the same seed produces the same game', () => {
  const a = newGame({ rng: mulberry32(2024) });
  const b = newGame({ rng: mulberry32(2024) });
  run(a, 30);
  run(b, 30);
  assert.strictEqual(a.aircraft.length, b.aircraft.length);
  for (let i = 0; i < a.aircraft.length; i++) {
    assert.ok(Math.abs(a.aircraft[i].x - b.aircraft[i].x) < 1e-9);
    assert.ok(Math.abs(a.aircraft[i].y - b.aircraft[i].y) < 1e-9);
    assert.strictEqual(a.aircraft[i].type, b.aircraft[i].type);
  }
});

test('a large frame delta is sub-stepped rather than tunnelled through', () => {
  const g = soloGame();
  const a = new Aircraft('jumbo', 700, 500, 0);
  const b = new Aircraft('jumbo', 760, 500, Math.PI);
  a.entering = b.entering = false;
  g.aircraft.push(a, b);
  g.update(1.0);          // one enormous frame
  assert.strictEqual(g.state, 'over', 'collision must not be skipped over');
});

// -------------------------------------------------------- an actual play-through

test('aircraft land one after another, indefinitely', () => {
  // Feed the airport a long stream of arrivals, one at a time, cycling through
  // every aircraft type. Nothing should ever get stuck or fail to land.
  const g = soloGame();
  const pool = g.map.pool;
  for (let n = 0; n < 30; n++) {
    const typeId = pool[n % pool.length];
    const zone = g.zones.find(z => FC.zoneAccepts(z, typeId));
    const a = inbound(g, typeId, 60, 500 + ((n * 137) % 400) - 200, 0);
    assert.ok(route(g, a, zone.x, zone.y, 'p' + n), `${typeId} #${n} could not be routed`);
    const before = g.score;
    run(g, 120);
    assert.strictEqual(g.score, before + 1, `${typeId} #${n} never landed`);
    assert.strictEqual(g.aircraft.length, 0, 'the sky should be empty again');
  }
  assert.strictEqual(g.score, 30);
});

test('a full game runs cleanly and stays self-consistent', () => {
  // Play the real thing with a simple controller: send each aircraft to its
  // zone when that zone is free, otherwise park it in a holding orbit. The
  // controller never checks whether a route crosses other traffic, so any one
  // run can end early through its own bad flying — the assertions below are on
  // the aggregate, plus per-frame invariants that must never break.
  const scores = [];
  for (const seed of [4242, 77, 8, 101, 555, 1201, 90, 33, 7777, 512, 64, 2048]) {
    const g = newGame({ rng: mulberry32(seed) });
    // Hold the arrival stream at an early-game rate: the point of this test is
    // the end-to-end loop, not whether a trivial controller can beat rush hour.
    g.maxAirborne = () => 3;
    g.spawnInterval = () => 3.2;
    const holds = [
      { x: g.W * 0.16, y: g.H * 0.22 }, { x: g.W * 0.16, y: g.H * 0.80 },
      { x: g.W * 0.50, y: g.H * 0.52 }, { x: g.W * 0.86, y: g.H * 0.40 }
    ];
    const dt = 1 / 60;
    let pointer = 0, crashEvent = null;

    for (let i = 0; i < 60 * 150 && g.state === 'playing'; i++) {
      const idle = g.aircraft.find(a =>
        a.state === 'flying' && !a.entering && !a.landingZone && a.path.length === 0);
      if (idle) {
        const zone = g.zones.find(z => FC.zoneAccepts(z, idle.type));
        const busy = g.aircraft.some(o => o !== idle && o.landingZone === zone);
        const id = 'auto' + (pointer++);
        if (g.beginDrag(id, idle.x, idle.y)) {
          if (!busy) {
            g.dragTo(id, idle.x + Math.cos(idle.heading) * 40, idle.y + Math.sin(idle.heading) * 40);
            g.endDrag(id, zone.x, zone.y);
          } else {
            // lay out a holding circle around the least crowded fix
            const fix = holds[idle.id % holds.length];
            for (let k = 0; k <= 12; k++) {
              const th = (k / 12) * Math.PI * 2;
              g.dragTo(id, fix.x + Math.cos(th) * 110, fix.y + Math.sin(th) * 110);
            }
            g.endDrag(id, fix.x + 110, fix.y);
          }
        }
      }
      for (const e of g.update(dt)) if (e.type === 'crash') crashEvent = e;

      // invariants that must hold on every single frame
      for (const a of g.aircraft) {
        assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y), 'aircraft position went non-finite');
        assert.ok(Number.isFinite(a.heading), 'aircraft heading went non-finite');
        assert.ok(a.x > -140 && a.x < g.W + 140 && a.y > -140 && a.y < g.H + 140,
          `aircraft left the world at (${a.x.toFixed(0)}, ${a.y.toFixed(0)})`);
      }
    }

    // A game may only ever end through a collision.
    if (g.state === 'over') {
      assert.ok(crashEvent, `seed ${seed}: game ended without a crash event`);
    }
    scores.push(g.score);
  }

  // Any single run is noisy — this controller flies into its own traffic — so
  // assert on the spread rather than on any one seed.
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  assert.ok(mean >= 4.5, `mean score only ${mean.toFixed(1)} (${scores.join(', ')})`);
  assert.ok(Math.max.apply(null, scores) >= 12,
    `best of ${scores.length} runs only reached ${Math.max.apply(null, scores)}`);
});
