/* ============================================================
   musicxml.js — Parser de MusicXML (formato partwise) a eventos planos
   ============================================================ */
(function (global) {
  'use strict';
  const PITCH_CLASS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  function parseMusicXML(xmlText) {
    const parser = new DOMParser();
    const xml = parser.parseFromString(xmlText, 'application/xml');
    const perr = xml.querySelector('parsererror');
    if (perr) throw new Error('el XML no es válido.');

    if (xml.querySelector('score-timewise')) {
      throw new Error('este archivo usa formato "score-timewise". Por favor exportá en formato "partwise" (el formato estándar de MuseScore, Finale, etc.).');
    }
    const scoreEl = xml.querySelector('score-partwise');
    if (!scoreEl) throw new Error('no se encontró <score-partwise>. ¿Es realmente un archivo MusicXML?');

    const partListEl = xml.querySelector('part-list');
    const scoreParts = {};
    if (partListEl) {
      Array.from(partListEl.querySelectorAll('score-part')).forEach(sp => {
        const nameEl = sp.querySelector('part-name');
        scoreParts[sp.getAttribute('id')] = (nameEl && nameEl.textContent.trim()) || sp.getAttribute('id');
      });
    }

    let tempo = 100;
    const tempoEl = xml.querySelector('sound[tempo]');
    if (tempoEl) tempo = parseFloat(tempoEl.getAttribute('tempo')) || 100;

    const parts = [];
    const partEls = xml.querySelectorAll('score-partwise > part');
    partEls.forEach(partEl => {
      const id = partEl.getAttribute('id');
      let divisions = 1;
      const rawEvents = [];
      const measureEls = partEl.querySelectorAll('measure');
      let measureIndex = 0;

      measureEls.forEach(measureEl => {
        measureIndex++;
        let firstVoice = null;
        let sawBackup = false;
        const children = Array.from(measureEl.children);
        for (const child of children) {
          const tag = child.tagName;
          if (tag === 'attributes') {
            const divEl = child.querySelector('divisions');
            if (divEl) divisions = parseInt(divEl.textContent, 10) || divisions;
          } else if (tag === 'sound' && child.hasAttribute('tempo')) {
            tempo = parseFloat(child.getAttribute('tempo')) || tempo;
          } else if (tag === 'backup') {
            sawBackup = true;
          } else if (tag === 'forward') {
            if (!sawBackup) {
              const durEl = child.querySelector('duration');
              const d = durEl ? parseInt(durEl.textContent, 10) : 0;
              if (d > 0) rawEvents.push({ midi: null, isRest: true, duration: d, tieStart: false, tieStop: false, measureIndex });
            }
          } else if (tag === 'note' && !sawBackup) {
            const voiceEl = child.querySelector('voice');
            const voice = voiceEl ? voiceEl.textContent : '1';
            if (firstVoice === null) firstVoice = voice;
            if (voice !== firstVoice) continue;

            const isChord = !!child.querySelector('chord');
            const isRest = !!child.querySelector('rest');
            const durEl = child.querySelector('duration');
            const duration = durEl ? parseInt(durEl.textContent, 10) : 0;
            const tieEls = child.querySelectorAll('tie');
            let tieStart = false, tieStop = false;
            tieEls.forEach(t => {
              const ty = t.getAttribute('type');
              if (ty === 'start') tieStart = true;
              if (ty === 'stop') tieStop = true;
            });

            let midi = null;
            if (!isRest) {
              const pitchEl = child.querySelector('pitch');
              if (pitchEl) {
                const stepEl = pitchEl.querySelector('step');
                const octEl = pitchEl.querySelector('octave');
                const alterEl = pitchEl.querySelector('alter');
                if (stepEl && octEl) {
                  const step = stepEl.textContent.trim();
                  const octave = parseInt(octEl.textContent, 10);
                  const alter = alterEl ? parseInt(alterEl.textContent, 10) : 0;
                  midi = (octave + 1) * 12 + (PITCH_CLASS[step] || 0) + alter;
                }
              } else {
                continue;
              }
            }

            if (isChord) {
              const prev = rawEvents[rawEvents.length - 1];
              if (prev && !isRest && midi !== null) {
                if (prev.midi === null || midi > prev.midi) prev.midi = midi;
                prev.duration = Math.max(prev.duration, duration);
              }
              continue;
            }
            rawEvents.push({ midi, isRest, duration, tieStart, tieStop, measureIndex });
          }
        }
      });

      const merged = [];
      for (const ev of rawEvents) {
        const prev = merged[merged.length - 1];
        if (prev && ev.tieStop && !ev.isRest && !prev.isRest && prev.midi === ev.midi) {
          prev.duration += ev.duration;
          prev.tieStart = ev.tieStart;
        } else {
          merged.push(Object.assign({}, ev));
        }
      }
      parts.push({ id, name: scoreParts[id] || id, divisions, events: merged });
    });

    return { parts, tempo };
  }

  global.CampanellaMusicXML = { parseMusicXML };
})(typeof window !== 'undefined' ? window : globalThis);
