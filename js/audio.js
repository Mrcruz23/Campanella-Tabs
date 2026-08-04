/* ============================================================
   audio.js — Reproducción de tablaturas vía Web Audio (síntesis simple tipo pluck)
   ============================================================ */
(function (global) {
  'use strict';
  const E = global.CampanellaEngine;

  function AudioPlayer() {
    this.ctx = null;
    this.timers = [];
    this.isPlaying = false;
    this.onNoteOn = null;   // (index) => void
    this.onNoteOff = null;  // (index) => void
    this.onEnd = null;      // () => void
  }

  AudioPlayer.prototype._pluck = function (freq, startTime, durSeconds, gainVal) {
    const ctx = this.ctx;
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    osc1.type = 'triangle';
    osc2.type = 'sine';
    osc1.frequency.value = freq;
    osc2.frequency.value = freq * 2.01;

    const g = ctx.createGain();
    const g2 = ctx.createGain();
    g2.gain.value = 0.18;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = Math.min(9000, freq * 7);

    osc1.connect(g);
    osc2.connect(g2); g2.connect(g);
    g.connect(filter); filter.connect(ctx.destination);

    const decay = Math.max(durSeconds * 1.9, 0.55);
    g.gain.setValueAtTime(0, startTime);
    g.gain.linearRampToValueAtTime(gainVal, startTime + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0008, startTime + decay);

    osc1.start(startTime); osc2.start(startTime);
    osc1.stop(startTime + decay + 0.05); osc2.stop(startTime + decay + 0.05);
  };

  /**
   * @param {Array} events - full event list (midi/isRest)
   * @param {Array} notePositions - [{index,startBeat,durBeat}] from render.js
   * @param {number} bpm
   * @param {number} [fromBeat] - if given, playback starts at this beat offset instead of from the top; notes before it are skipped entirely (not just silenced), so "play from here" starts instantly rather than waiting through the skipped section.
   */
  AudioPlayer.prototype.play = function (events, notePositions, bpm, fromBeat) {
    this.stop();
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();

    const origin = fromBeat || 0;
    const toPlay = origin > 0 ? notePositions.filter(np => (np.startBeat + np.durBeat) > origin) : notePositions;

    const secPerBeat = 60 / (bpm || 100);
    const startAt = this.ctx.currentTime + 0.15;

    toPlay.forEach(np => {
      const ev = events[np.index];
      if (!ev || ev.midi === null) return;
      // Clamp so a note that was already sounding when playback starts mid-way
      // through it doesn't get scheduled at a negative offset.
      const relativeBeat = Math.max(0, np.startBeat - origin);
      const t = startAt + relativeBeat * secPerBeat;
      const dur = np.durBeat * secPerBeat;
      this._pluck(E.midiToFreq(ev.midi), t, dur, 0.16);

      const onDelayMs = Math.max(0, (t - this.ctx.currentTime) * 1000);
      const offDelayMs = Math.max(0, (t - this.ctx.currentTime + Math.min(dur, secPerBeat * 1.1)) * 1000);
      const onId = setTimeout(() => { if (this.onNoteOn) this.onNoteOn(np.index); }, onDelayMs);
      const offId = setTimeout(() => { if (this.onNoteOff) this.onNoteOff(np.index); }, offDelayMs);
      this.timers.push(onId, offId);
    });

    const totalBeat = toPlay.length
      ? Math.max(...toPlay.map(n => Math.max(0, n.startBeat - origin) + n.durBeat))
      : 0;
    const endId = setTimeout(() => {
      this.isPlaying = false;
      if (this.onEnd) this.onEnd();
    }, (totalBeat * secPerBeat + 0.3) * 1000);
    this.timers.push(endId);

    this.isPlaying = true;
  };

  /** Plays one pitch in isolation — used by "listen to this note" in the editor, to quickly confirm a note is correct without running the whole piece. */
  AudioPlayer.prototype.playSingleNote = function (midi, durSeconds) {
    this.stop();
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const t = this.ctx.currentTime + 0.05;
    this._pluck(E.midiToFreq(midi), t, durSeconds || 0.6, 0.18);
  };

  AudioPlayer.prototype.stop = function () {
    this.timers.forEach(id => clearTimeout(id));
    this.timers = [];
    this.isPlaying = false;
    // Scheduled oscillators keep sounding on Web Audio's own timeline even
    // after UI timers are cleared, since setTimeout doesn't control them.
    // Closing the context stops all sound immediately; a fresh one is
    // created on next play().
    if (this.ctx) {
      const c = this.ctx;
      this.ctx = null;
      c.close().catch(() => {});
    }
  };

  global.CampanellaAudio = { AudioPlayer };
})(typeof window !== 'undefined' ? window : globalThis);
