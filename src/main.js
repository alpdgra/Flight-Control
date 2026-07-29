/*
 * Flight Control — application shell
 * ---------------------------------------------------------------------------
 * Screens, input handling, HUD, persistence and the animation loop.
 *
 * Screens: menu | help | playing | paused | over.
 * The menu runs a live, silent game of its own behind the panel.
 */
(function () {
  'use strict';

  var FC = window.FC;
  var FCRender = window.FCRender;
  var Audio = window.FCAudio;

  var MEDALS = [
    { score: 100, name: 'Platinum', cls: 'platinum' },
    { score: 60, name: 'Gold', cls: 'gold' },
    { score: 35, name: 'Silver', cls: 'silver' },
    { score: 18, name: 'Bronze', cls: 'bronze' }
  ];

  var STORE = {
    best: 'flightcontrol.best.v1',
    sound: 'flightcontrol.sound.v1',
    seen: 'flightcontrol.seenhelp.v1',
    lastMap: 'flightcontrol.lastmap.v1'
  };

  var IDLE_UI = { draggingType: null, hoverZone: null };

  var els = {};
  var renderer = null;
  var game = null;          // the player's game
  var attract = null;       // the decorative game behind the menu
  var attractRestart = 0;
  var aiPointer = 0;
  var lastFrame = 0;
  var screen = 'menu';
  var helpReturn = 'menu';
  var overTimer = 0;
  var hintTimer = 0;
  var shownScore = -1;

  var ui = { draggingType: null, hoverZone: null };
  var pointers = {};        // pointerId -> true, for drags we own

  // ------------------------------------------------------------------ storage

  function readJSON(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }

  function writeJSON(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }

  function bestScores() {
    var v = readJSON(STORE.best, {});
    return (v && typeof v === 'object') ? v : {};
  }

  function bestFor(mapId) { return bestScores()[mapId] || 0; }

  function recordBest(mapId, score) {
    var all = bestScores();
    if (score > (all[mapId] || 0)) {
      all[mapId] = score;
      writeJSON(STORE.best, all);
      return true;
    }
    return false;
  }

  function medalFor(score) {
    for (var i = 0; i < MEDALS.length; i++) if (score >= MEDALS[i].score) return MEDALS[i];
    return null;
  }

  // ------------------------------------------------------------------ screens

  function show(name) {
    screen = name;
    document.body.setAttribute('data-screen', name);
    var overlays = document.querySelectorAll('.overlay');
    for (var i = 0; i < overlays.length; i++) {
      overlays[i].classList.toggle('is-open', overlays[i].getAttribute('data-screen') === name);
    }
    els.hud.classList.toggle('is-hidden', name !== 'playing');
    if (name !== 'playing') els.hint.classList.remove('is-open');
    else if (hintTimer > 0) els.hint.classList.add('is-open');
  }

  /** The game currently on screen — the player's, or the menu's attract game. */
  function scene() {
    return (screen === 'menu' || (screen === 'help' && helpReturn === 'menu')) ? attract : game;
  }

  // -------------------------------------------------------------- map chooser

  function buildMapCards() {
    els.maps.innerHTML = '';
    FC.MAPS.forEach(function (map) {
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'map-card';
      card.setAttribute('aria-label', 'Play ' + map.name);

      var shot = FCRender.thumbnail(map, 360, 216);
      shot.className = 'map-shot';
      card.appendChild(shot);

      var body = document.createElement('div');
      body.className = 'map-body';
      var best = bestFor(map.id);
      body.innerHTML =
        '<div class="map-name"></div>' +
        '<div class="map-blurb"></div>' +
        '<div class="map-best">' + (best ? 'Best <b>' + best + '</b>' : 'Not yet flown') + '</div>';
      body.querySelector('.map-name').textContent = map.name;
      body.querySelector('.map-blurb').textContent = map.blurb;
      card.appendChild(body);

      card.addEventListener('click', function () {
        Audio.unlock();
        Audio.click();
        writeJSON(STORE.lastMap, map.id);
        startGame(map.id);
      });
      els.maps.appendChild(card);
    });
  }

  // ------------------------------------------------------------- attract mode

  function newAttract() {
    var size = { width: renderer.W, height: renderer.H };
    var mapId = readJSON(STORE.lastMap, FC.MAPS[0].id);
    attract = new FC.Game({ map: FC.mapById(mapId).id, width: size.width, height: size.height });
    attractRestart = 0;
  }

  function firstZoneFor(g, typeId) {
    for (var i = 0; i < g.zones.length; i++) {
      if (FC.zoneAccepts(g.zones[i], typeId)) return g.zones[i];
    }
    return null;
  }

  /** A simple autopilot. It is decorative; when it fails, it starts over. */
  function stepAttract(dt) {
    if (!attract) return;
    if (attract.state === 'over') {
      attractRestart -= dt;
      if (attractRestart <= 0) newAttract();
      return;
    }
    for (var i = 0; i < attract.aircraft.length; i++) {
      var a = attract.aircraft[i];
      if (a.state !== 'flying' || a.entering || a.landingZone || a.path.length) continue;
      var zone = firstZoneFor(attract, a.type);
      if (!zone) continue;
      var busy = false;
      for (var j = 0; j < attract.aircraft.length; j++) {
        if (attract.aircraft[j] !== a && attract.aircraft[j].landingZone === zone) busy = true;
      }
      var id = 'ai' + (aiPointer++);
      if (!attract.beginDrag(id, a.x, a.y)) continue;
      if (busy) {
        // lazy holding orbit around wherever it happens to be
        var cx = a.x - Math.sin(a.heading) * 120;
        var cy = a.y + Math.cos(a.heading) * 120;
        for (var k = 0; k <= 14; k++) {
          var th = a.heading - Math.PI / 2 + (k / 14) * Math.PI * 2;
          attract.dragTo(id, cx + Math.cos(th) * 120, cy + Math.sin(th) * 120);
        }
        attract.endDrag(id, cx, cy);
      } else {
        attract.dragTo(id, a.x + Math.cos(a.heading) * 40, a.y + Math.sin(a.heading) * 40);
        attract.endDrag(id, zone.x, zone.y);
      }
      break;   // one instruction per frame keeps it looking human
    }

    var events = attract.update(dt);
    for (var e = 0; e < events.length; e++) {
      var ev = events[e];
      if (ev.type === 'landed') {
        renderer.landingPuff(ev.aircraft.x, ev.aircraft.y, ev.aircraft.spec.color);
      } else if (ev.type === 'crash') {
        renderer.explode(ev.x, ev.y, 0.35);
        attractRestart = 2.6;
      }
    }
  }

  // ------------------------------------------------------------------ the game

  function startGame(mapId) {
    game = new FC.Game({ map: mapId, width: renderer.W, height: renderer.H });
    renderer.reset();
    pointers = {};
    ui.draggingType = null;
    ui.hoverZone = null;
    overTimer = 0;
    shownScore = -1;
    hintTimer = readJSON(STORE.seen, false) ? 0 : 8;
    els.mapName.textContent = game.map.name;
    els.best.textContent = bestFor(mapId) || '0';
    updateScore(true);
    show('playing');
  }

  function updateScore(force) {
    if (!force && game.score === shownScore) return;
    shownScore = game.score;
    els.score.textContent = game.score;
    els.score.classList.remove('pop');
    void els.score.offsetWidth;   // restart the CSS animation
    if (!force) els.score.classList.add('pop');
  }

  function finishGame() {
    var isRecord = recordBest(game.map.id, game.score);
    var medal = medalFor(game.score);

    els.finalScore.textContent = game.score;
    els.finalMap.textContent = game.map.name;
    els.finalBest.textContent = bestFor(game.map.id);
    els.record.classList.toggle('is-open', isRecord && game.score > 0);

    if (medal) {
      els.medal.className = 'medal is-open ' + medal.cls;
      els.medal.textContent = medal.name;
    } else {
      els.medal.className = 'medal';
      els.medal.textContent = '';
    }

    var next = null;
    for (var i = MEDALS.length - 1; i >= 0; i--) {
      if (game.score < MEDALS[i].score) { next = MEDALS[i]; break; }
    }
    els.nextMedal.textContent = next
      ? (next.score - game.score) + ' more for ' + next.name
      : 'Every medal earned. Outstanding.';

    if (medal && isRecord) Audio.medal();
    show('over');
  }

  function pause() {
    if (screen !== 'playing') return;
    // drop any half-drawn routes so nothing is left dangling
    for (var id in pointers) {
      if (Object.prototype.hasOwnProperty.call(pointers, id)) game.cancelDrag(id);
    }
    pointers = {};
    ui.draggingType = null;
    ui.hoverZone = null;
    show('paused');
  }

  function resume() {
    if (screen !== 'paused') return;
    lastFrame = 0;      // discard the time spent paused
    show('playing');
  }

  function quitToMenu() {
    if (game && game.state === 'playing' && game.score > 0) recordBest(game.map.id, game.score);
    game = null;
    newAttract();
    buildMapCards();
    show('menu');
  }

  // ------------------------------------------------------------------- events

  function handleEvents(events) {
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (e.type === 'landed') {
        Audio.land(e.score);
        renderer.landingPuff(e.aircraft.x, e.aircraft.y, e.aircraft.spec.color);
        updateScore(false);
        if (hintTimer > 0) dismissHint();
      } else if (e.type === 'crash') {
        Audio.crash();
        renderer.explode(e.x, e.y, 1);
        overTimer = 1.35;
      } else if (e.type === 'route') {
        Audio.route();
        // the player has clearly got the idea; stop nagging
        if (hintTimer > 0) dismissHint();
      }
    }
    if (game.warnPeak > 0.35) Audio.warn();
  }

  function dismissHint() {
    hintTimer = 0;
    els.hint.classList.remove('is-open');
    writeJSON(STORE.seen, true);
  }

  // --------------------------------------------------------------------- loop

  function frame(now) {
    window.requestAnimationFrame(frame);
    var dt = lastFrame ? Math.min((now - lastFrame) / 1000, 0.1) : 0;
    lastFrame = now;

    if (screen === 'playing' && game && game.state === 'playing') {
      handleEvents(game.update(dt));
      if (hintTimer > 0) {
        hintTimer -= dt;
        if (hintTimer <= 0) els.hint.classList.remove('is-open');
      }
    }

    if (overTimer > 0) {
      overTimer -= dt;
      if (overTimer <= 0) { overTimer = 0; finishGame(); }
    }

    var live = scene();
    if (live === attract) stepAttract(dt);
    if (live) renderer.draw(live, dt, live === game ? ui : IDLE_UI);
  }

  // -------------------------------------------------------------------- input

  function pointFromEvent(ev) {
    var rect = els.canvas.getBoundingClientRect();
    return renderer.toWorld(ev.clientX - rect.left, ev.clientY - rect.top);
  }

  function refreshDragUI() {
    var type = null;
    for (var id in game.drags) {
      if (Object.prototype.hasOwnProperty.call(game.drags, id)) {
        type = game.drags[id].type;
        break;
      }
    }
    ui.draggingType = type;
    if (!type) ui.hoverZone = null;
  }

  function onDown(ev) {
    if (screen !== 'playing' || !game || game.state !== 'playing') return;
    Audio.unlock();
    var p = pointFromEvent(ev);
    if (!game.beginDrag(ev.pointerId, p.x, p.y)) return;
    pointers[ev.pointerId] = true;
    refreshDragUI();
    if (els.canvas.setPointerCapture && typeof ev.pointerId === 'number') {
      try { els.canvas.setPointerCapture(ev.pointerId); } catch (e) { /* not capturable */ }
    }
    ev.preventDefault();
  }

  function onMove(ev) {
    if (!game || !pointers[ev.pointerId]) return;
    var p = pointFromEvent(ev);
    game.dragTo(ev.pointerId, p.x, p.y);
    var dragged = game.drags[ev.pointerId];
    ui.hoverZone = dragged ? game.zoneAt(p.x, p.y, dragged.type) : null;
    ev.preventDefault();
  }

  function onUp(ev) {
    if (!game || !pointers[ev.pointerId]) return;
    delete pointers[ev.pointerId];
    var p = pointFromEvent(ev);
    game.endDrag(ev.pointerId, p.x, p.y);
    ui.hoverZone = null;
    refreshDragUI();
    ev.preventDefault();
  }

  function onCancel(ev) {
    if (!game || !pointers[ev.pointerId]) return;
    delete pointers[ev.pointerId];
    game.cancelDrag(ev.pointerId);
    ui.hoverZone = null;
    refreshDragUI();
  }

  /** Touch/mouse fallback for browsers without Pointer Events. */
  function installLegacyInput(canvas) {
    function wrap(touch) {
      return {
        pointerId: 't' + touch.identifier,
        clientX: touch.clientX, clientY: touch.clientY,
        preventDefault: function () {}
      };
    }
    function forEachTouch(handler) {
      return function (ev) {
        for (var i = 0; i < ev.changedTouches.length; i++) handler(wrap(ev.changedTouches[i]));
        if (ev.cancelable) ev.preventDefault();
      };
    }
    canvas.addEventListener('touchstart', forEachTouch(onDown), { passive: false });
    canvas.addEventListener('touchmove', forEachTouch(onMove), { passive: false });
    canvas.addEventListener('touchend', forEachTouch(onUp), { passive: false });
    canvas.addEventListener('touchcancel', forEachTouch(onCancel), { passive: false });

    var down = false;
    function mouse(ev) {
      return {
        pointerId: 'mouse', clientX: ev.clientX, clientY: ev.clientY,
        preventDefault: function () { ev.preventDefault(); }
      };
    }
    canvas.addEventListener('mousedown', function (ev) { down = true; onDown(mouse(ev)); });
    window.addEventListener('mousemove', function (ev) { if (down) onMove(mouse(ev)); });
    window.addEventListener('mouseup', function (ev) {
      if (!down) return;
      down = false;
      onUp(mouse(ev));
    });
  }

  function installInput(canvas) {
    if (window.PointerEvent) {
      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
      canvas.addEventListener('pointercancel', onCancel);
    } else {
      installLegacyInput(canvas);
    }
    canvas.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
  }

  // ------------------------------------------------------------------- layout

  function onResize() {
    var size = renderer.layout(window.innerWidth, window.innerHeight,
                               Math.min(window.devicePixelRatio || 1, 2));
    if (game) game.resize(size.width, size.height);
    if (attract) attract.resize(size.width, size.height);
    document.body.classList.toggle('is-portrait', window.innerHeight > window.innerWidth * 1.05);
  }

  // --------------------------------------------------------------------- wiring

  function openHelp(from) {
    helpReturn = from;
    Audio.click();
    show('help');
  }

  function closeHelp() {
    Audio.click();
    show(helpReturn);
  }

  function bind() {
    els.playBtn.addEventListener('click', function () {
      Audio.unlock(); Audio.click();
      startGame(FC.mapById(readJSON(STORE.lastMap, FC.MAPS[0].id)).id);
    });
    els.helpBtn.addEventListener('click', function () { openHelp('menu'); });
    els.helpClose.addEventListener('click', closeHelp);

    els.pauseBtn.addEventListener('click', function () { Audio.click(); pause(); });
    els.resumeBtn.addEventListener('click', function () { Audio.click(); resume(); });
    els.pauseQuit.addEventListener('click', function () { Audio.click(); quitToMenu(); });
    els.pauseHelp.addEventListener('click', function () { openHelp('paused'); });

    els.againBtn.addEventListener('click', function () {
      Audio.click();
      startGame(game ? game.map.id : FC.MAPS[0].id);
    });
    els.changeBtn.addEventListener('click', function () { Audio.click(); quitToMenu(); });

    els.soundBtn.addEventListener('click', function () {
      var on = readJSON(STORE.sound, true) === false;
      writeJSON(STORE.sound, on);
      applySound(on);
      Audio.unlock();
      if (on) Audio.click();
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        if (screen === 'playing') pause();
        else if (screen === 'paused') resume();
        else if (screen === 'help') closeHelp();
      } else if (ev.key === ' ') {
        if (screen === 'playing') { ev.preventDefault(); pause(); }
        else if (screen === 'paused') { ev.preventDefault(); resume(); }
      } else if (ev.key === 'r' || ev.key === 'R') {
        if (screen === 'over' && game) startGame(game.map.id);
      } else if (ev.key === 'Enter') {
        if (screen === 'menu') els.playBtn.click();
        else if (screen === 'over') els.againBtn.click();
      }
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) pause();
    });
    window.addEventListener('blur', pause);

    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', function () {
      window.setTimeout(onResize, 150);
    });
  }

  function applySound(on) {
    Audio.setEnabled(on);
    els.soundBtn.classList.toggle('is-off', !on);
    els.soundBtn.setAttribute('aria-label', on ? 'Mute sound' : 'Unmute sound');
    els.soundBtn.textContent = on ? '🔊' : '🔇';
  }

  function buildLegend() {
    var order = ['jet', 'jumbo', 'prop', 'heli', 'seaplane'];
    els.legend.innerHTML = '';
    order.forEach(function (id) {
      var spec = FC.TYPES[id];
      var row = document.createElement('div');
      row.className = 'legend-row';

      // sized to hold the largest silhouette (the jumbo) without clipping
      var swatch = document.createElement('canvas');
      swatch.width = 88; swatch.height = 56;
      var c = swatch.getContext('2d');
      c.translate(44, 28);
      c.scale(0.5, 0.5);
      FCRender.drawAircraftShape(c, { type: id, spec: spec }, 'body', 0.6);
      row.appendChild(swatch);

      var dest = id === 'heli' ? 'Helipad'
        : id === 'seaplane' ? 'Water lane'
        : id === 'prop' ? 'Short strip'
        : 'Main runway';
      var label = document.createElement('div');
      var name = document.createElement('b');
      name.textContent = spec.label;
      var sub = document.createElement('span');
      sub.textContent = dest;
      label.appendChild(name);
      label.appendChild(sub);
      row.appendChild(label);

      els.legend.appendChild(row);
    });
  }

  function init() {
    var ids = ['stage', 'hud', 'score', 'best', 'map-name', 'pause-btn', 'sound-btn',
               'hint', 'maps', 'play-btn', 'help-btn', 'help-close', 'legend',
               'resume-btn', 'pause-quit', 'pause-help', 'final-score', 'final-best',
               'final-map', 'record', 'medal', 'next-medal', 'again-btn', 'change-btn'];
    ids.forEach(function (id) {
      var key = id.replace(/-([a-z])/g, function (m, ch) { return ch.toUpperCase(); });
      els[key] = document.getElementById(id);
    });
    els.canvas = els.stage;

    renderer = new FCRender.Renderer(els.canvas);
    onResize();
    newAttract();
    buildMapCards();
    buildLegend();
    applySound(readJSON(STORE.sound, true) !== false);
    installInput(els.canvas);
    bind();
    show('menu');

    lastFrame = 0;
    window.requestAnimationFrame(frame);

    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function () { /* offline is a bonus */ });
      });
    }

    // Expose a tiny hook so the automated browser checks can drive the game.
    window.__fc = {
      get game() { return game; },
      get attract() { return attract; },
      get screen() { return screen; },
      renderer: function () { return renderer; },
      start: startGame,
      quit: quitToMenu
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
