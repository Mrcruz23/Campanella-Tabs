/* ============================================================
   engine.js — Motor de reglas campanella (Sol·Do·Mi·La reentrante)
   Compartido entre el generador automático (MusicXML) y el editor manual.
   Sin dependencias externas; funciona 100% offline.
   ============================================================ */
(function (global) {
  'use strict';

  // string numbers follow the traditional right-hand exercise numbering:
  // string 4 = G4 (high G, nearest chin), string 3 = C4, string 2 = E4, string 1 = A4 (nearest feet)
  const OPEN_MIDI = { 1: 69, 2: 64, 3: 60, 4: 67 };
  const STRING_NAMES = { 1: 'La', 2: 'Mi', 3: 'Do', 4: 'Sol' };
  const DISPLAY_ORDER = [1, 2, 3, 4]; // top-to-bottom in the tab
  const PITCH_CLASS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const PITCH_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function midiToName(midi) {
    if (midi === null || midi === undefined) return '';
    const pc = ((midi % 12) + 12) % 12;
    const octave = Math.floor(midi / 12) - 1;
    return PITCH_NAMES_SHARP[pc] + octave;
  }

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  /** All string/fret combinations that produce this pitch, within maxFret. */
  function getCandidates(midi, maxFret) {
    const cands = [];
    for (const s of [1, 2, 3, 4]) {
      const fret = midi - OPEN_MIDI[s];
      if (fret >= 0 && fret <= maxFret) cands.push({ string: s, fret });
    }
    return cands;
  }

  /**
   * Weighted-DP fingering solver shared by the auto-generator and the
   * "assist" suggestions in the manual editor.
   *
   * weightMode: 'smooth' | 'balanced' | 'open'
   *
   * The jump-cost function is intentionally the same in every mode: past a
   * soft limit (4 frets) it grows quadratically, so a distant open string is
   * only chosen when no closer fingering exists — never merely "preferred"
   * because it happens to be open.
   */
  function solveFingering(events, maxFret, weightMode) {
    const SAME_STRING_PENALTY = 9;
    let HAND_MOVE_WEIGHT, FRET_WEIGHT;
    if (weightMode === 'smooth') { HAND_MOVE_WEIGHT = 0.55; FRET_WEIGHT = 0.10; }
    else if (weightMode === 'open') { HAND_MOVE_WEIGHT = 0.15; FRET_WEIGHT = 0.35; }
    else { HAND_MOVE_WEIGHT = 0.32; FRET_WEIGHT = 0.24; } // balanced (default)

    const JUMP_SOFT_LIMIT = 4;
    function jumpCost(fretDelta) {
      const d = Math.abs(fretDelta);
      let cost = d * HAND_MOVE_WEIGHT;
      if (d > JUMP_SOFT_LIMIT) {
        const excess = d - JUMP_SOFT_LIMIT;
        cost += excess * excess * 0.9;
      }
      return cost;
    }

    const n = events.length;
    const chosen = new Array(n).fill(null);
    const playable = [];
    for (let i = 0; i < n; i++) {
      const e = events[i];
      if (!e.isRest && e.midi !== null) {
        const cands = getCandidates(e.midi, maxFret);
        if (cands.length > 0) playable.push({ origIndex: i, cands });
      }
    }
    const totalPitched = events.filter(e => !e.isRest && e.midi !== null).length;
    if (playable.length === 0) return { chosen, unplayableCount: totalPitched, totalPitched };

    const m = playable.length;
    const dpCost = playable.map(p => p.cands.map(() => Infinity));
    const dpPrev = playable.map(p => p.cands.map(() => -1));

    playable[0].cands.forEach((c, ci) => { dpCost[0][ci] = c.fret * FRET_WEIGHT; });

    for (let k = 1; k < m; k++) {
      const cands = playable[k].cands;
      const prevCands = playable[k - 1].cands;
      cands.forEach((c, ci) => {
        let best = Infinity, bp = -1;
        prevCands.forEach((p, pi) => {
          let cost = dpCost[k - 1][pi];
          if (p.string === c.string) cost += SAME_STRING_PENALTY;
          cost += jumpCost(p.fret - c.fret);
          cost += c.fret * FRET_WEIGHT;
          if (cost < best) { best = cost; bp = pi; }
        });
        dpCost[k][ci] = best; dpPrev[k][ci] = bp;
      });
    }

    const lastCosts = dpCost[m - 1];
    let bestFinal = 0;
    for (let i = 1; i < lastCosts.length; i++) if (lastCosts[i] < lastCosts[bestFinal]) bestFinal = i;

    const chosenIdx = new Array(m);
    chosenIdx[m - 1] = bestFinal;
    for (let k = m - 1; k > 0; k--) chosenIdx[k - 1] = dpPrev[k][chosenIdx[k]];

    for (let k = 0; k < m; k++) {
      const c = playable[k].cands[chosenIdx[k]];
      chosen[playable[k].origIndex] = { string: c.string, fret: c.fret };
    }

    let unplayableCount = 0;
    for (let i = 0; i < n; i++) {
      const e = events[i];
      if (!e.isRest && e.midi !== null && chosen[i] === null) unplayableCount++;
    }
    return { chosen, unplayableCount, totalPitched };
  }

  function suggestTranspose(events) {
    const pitches = events.filter(e => !e.isRest && e.midi !== null).map(e => e.midi).sort((a, b) => a - b);
    if (!pitches.length) return 0;
    const mid = Math.floor(pitches.length / 2);
    const median = pitches.length % 2 ? pitches[mid] : (pitches[mid - 1] + pitches[mid]) / 2;
    const target = 70;
    return Math.round((target - median) / 12) * 12;
  }

  /* ============================================================
     Manual-editing rule engine ("estricto" mode)
     ============================================================
     Used by the grid editor: given the fingering chosen so far for the
     notes *before* a given position, and the pitch being placed at that
     position, decide which candidate string/frets are allowed.

     Rule enforced (per the user's explicit choice): a note may NOT repeat
     the same string as the immediately preceding sounded note if there is
     at least one alternative string available for this pitch. If the pitch
     genuinely only exists on the same string as the previous note (no
     alternative anywhere within maxFret), the repeat is allowed since there
     is no campanella-respecting way to avoid it.
  */

  /**
   * @param {number} midi - pitch to place
   * @param {number} maxFret
   * @param {{string:number, fret:number}|null} prevChosen - fingering of the previous sounded note, or null if none
   * @returns {{
   *   candidates: Array<{string:number, fret:number, allowed:boolean, reason:string|null, recommended:boolean}>,
   *   hasAlternative: boolean
   * }}
   */
  function evaluatePlacement(midi, maxFret, prevChosen) {
    const cands = getCandidates(midi, maxFret);
    if (cands.length === 0) {
      return { candidates: [], hasAlternative: false };
    }
    const sameStringOnly = prevChosen
      ? cands.every(c => c.string === prevChosen.string)
      : false;
    const hasAlternative = !!prevChosen && !sameStringOnly && cands.some(c => c.string !== prevChosen.string);

    // Rank candidates by the same jump-cost heuristic (balanced weights) so
    // the "recommended" one lines up with what the auto-solver would pick.
    const HAND_MOVE_WEIGHT = 0.32, FRET_WEIGHT = 0.24, JUMP_SOFT_LIMIT = 4;
    function score(c) {
      let s = c.fret * FRET_WEIGHT;
      if (prevChosen) {
        const d = Math.abs(prevChosen.fret - c.fret);
        s += d * HAND_MOVE_WEIGHT;
        if (d > JUMP_SOFT_LIMIT) { const ex = d - JUMP_SOFT_LIMIT; s += ex * ex * 0.9; }
        if (prevChosen.string === c.string) s += 9;
      }
      return s;
    }
    const scored = cands.map(c => ({ ...c, _score: score(c) })).sort((a, b) => a._score - b._score);
    const bestScore = scored.length ? scored[0]._score : 0;

    const out = scored.map((c, idx) => {
      const isSameString = !!prevChosen && c.string === prevChosen.string;
      const blocked = isSameString && hasAlternative; // strict rule
      return {
        string: c.string,
        fret: c.fret,
        allowed: !blocked,
        reason: blocked
          ? `Repetiría la cuerda ${STRING_NAMES[c.string]} (traste ${prevChosen.fret}→${c.fret}); hay otra cuerda disponible para esta nota.`
          : null,
        recommended: idx === 0 && !blocked
      };
    });
    // if the top-ranked candidate was blocked, promote the best allowed one to "recommended"
    if (!out.some(o => o.recommended)) {
      const firstAllowed = out.find(o => o.allowed);
      if (firstAllowed) firstAllowed.recommended = true;
    }
    return { candidates: out, hasAlternative };
  }

  global.CampanellaEngine = {
    OPEN_MIDI, STRING_NAMES, DISPLAY_ORDER, PITCH_CLASS,
    midiToName, midiToFreq,
    getCandidates, solveFingering, suggestTranspose,
    evaluatePlacement
  };

})(typeof window !== 'undefined' ? window : globalThis);
