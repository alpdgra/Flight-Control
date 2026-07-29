/*
 * Flight Control — audio
 * ---------------------------------------------------------------------------
 * Every sound is synthesised with the Web Audio API so the game stays a single
 * file with no media assets. The context is created lazily on the first user
 * gesture, which is what iOS requires.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FCAudio = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function Audio() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.lastWarn = 0;
    this.failed = false;
  }

  Audio.prototype.ensure = function () {
    if (this.ctx || this.failed) return this.ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.failed = true; return null; }
    try {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.32;
      this.master.connect(this.ctx.destination);
    } catch (e) {
      this.failed = true;
      this.ctx = null;
    }
    return this.ctx;
  };

  /** Call from a user gesture; browsers start contexts suspended. */
  Audio.prototype.unlock = function () {
    var ctx = this.ensure();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  };

  Audio.prototype.setEnabled = function (on) {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? 0.32 : 0;
  };

  Audio.prototype.now = function () {
    var ctx = this.ensure();
    return ctx ? ctx.currentTime : 0;
  };

  /** A single shaped oscillator note. */
  Audio.prototype.tone = function (opts) {
    var ctx = this.ensure();
    if (!ctx || !this.enabled) return;
    var t0 = ctx.currentTime + (opts.delay || 0);
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(opts.freq, t0);
    if (opts.freqTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.freqTo), t0 + opts.dur);
    var peak = opts.gain == null ? 0.3 : opts.gain;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + (opts.attack || 0.008));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + opts.dur + 0.03);
  };

  /** Filtered white noise, for explosions and touchdown rumble. */
  Audio.prototype.noise = function (opts) {
    var ctx = this.ensure();
    if (!ctx || !this.enabled) return;
    var dur = opts.dur;
    var len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, opts.decay || 2);
    }
    var src = ctx.createBufferSource();
    src.buffer = buf;
    var filter = ctx.createBiquadFilter();
    filter.type = opts.filter || 'lowpass';
    filter.frequency.setValueAtTime(opts.freq || 900, ctx.currentTime);
    if (opts.freqTo) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(20, opts.freqTo), ctx.currentTime + dur);
    }
    var gain = ctx.createGain();
    gain.gain.value = opts.gain == null ? 0.4 : opts.gain;
    src.connect(filter); filter.connect(gain); gain.connect(this.master);
    src.start();
  };

  // ---------------------------------------------------------------- the cues

  Audio.prototype.click = function () {
    this.tone({ type: 'triangle', freq: 520, dur: 0.06, gain: 0.14 });
  };

  Audio.prototype.route = function () {
    this.tone({ type: 'sine', freq: 660, freqTo: 880, dur: 0.11, gain: 0.16 });
  };

  Audio.prototype.land = function (score) {
    // rises a little as the score climbs, then wraps around
    var step = (score % 8);
    var root = 523.25 * Math.pow(2, step / 12);
    this.tone({ type: 'sine', freq: root, dur: 0.16, gain: 0.22 });
    this.tone({ type: 'sine', freq: root * 1.5, dur: 0.26, gain: 0.16, delay: 0.07 });
    this.noise({ dur: 0.22, freq: 1400, freqTo: 300, gain: 0.09, decay: 2.4 });
  };

  Audio.prototype.warn = function () {
    var t = this.now();
    if (t - this.lastWarn < 0.42) return;
    this.lastWarn = t;
    this.tone({ type: 'square', freq: 880, dur: 0.07, gain: 0.07 });
    this.tone({ type: 'square', freq: 880, dur: 0.07, gain: 0.07, delay: 0.12 });
  };

  Audio.prototype.crash = function () {
    this.noise({ dur: 1.4, freq: 2200, freqTo: 90, gain: 0.55, decay: 1.5 });
    this.tone({ type: 'sine', freq: 160, freqTo: 40, dur: 0.9, gain: 0.4 });
    this.tone({ type: 'sawtooth', freq: 90, freqTo: 28, dur: 1.2, gain: 0.22, delay: 0.04 });
  };

  Audio.prototype.medal = function () {
    var self = this;
    [523.25, 659.25, 783.99, 1046.5].forEach(function (f, i) {
      self.tone({ type: 'sine', freq: f, dur: 0.3, gain: 0.2, delay: i * 0.09 });
    });
  };

  return new Audio();
});
