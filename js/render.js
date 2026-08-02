/* ============================================================
   render.js — Dibuja la tablatura en SVG (4 compases por línea, scroll vertical)
   ============================================================ */
(function (global) {
  'use strict';
  const E = global.CampanellaEngine;

  const UNIT_PX = 46;
  const MIN_NOTE_PX = 24;
  const ROW_GAP = 22;
  const SYSTEM_MAX_WIDTH = 620; // target width for a single measure's row (was 1040 when 4 measures shared a line)
  const LEFT_MARGIN = 56;
  const RIGHT_MARGIN = 20;
  const SYSTEM_VGAP = 34;
  const TOP_MARGIN = 30;
  const MEASURES_PER_LINE = 1; // one measure per row, stacked vertically with scroll — easier to read than 4-across on small screens

  /**
   * @param {Array} events - flat note/rest events, each with {midi,isRest,duration,measureIndex}
   * @param {Array} chosen - fingering per event index, {string,fret} or null
   * @param {number} divisions - MusicXML divisions-per-quarter-note (ticks)
   * @param {object} opts - { editable:boolean, colors:{bg,line,ink,accent,bad,selected}, repeatMarks:{measureIndex:'start'|'end'}, selectedMeasures:number[]|null }
   * @returns {{ svg:string, notePositions: Array<{index,startBeat,durBeat}> }}
   */
  function buildTabSVG(events, chosen, divisions, opts) {
    opts = opts || {};
    const editable = !!opts.editable;
    const C = Object.assign({
      bg: '#FBF7EC', line: '#B79E6C', ink: '#2B2013', accent: '#D9A94E', bad: '#9C3B2E', dim: '#7a6a4b', selected: '#4C7C68'
    }, opts.colors || {});
    const repeatMarks = opts.repeatMarks || {};
    const selectedMeasures = opts.selectedMeasures ? new Set(opts.selectedMeasures) : null;

    const notePositions = [];
    const beats = events.map(e => e.duration / divisions);

    const measures = [];
    let curMeasure = null;
    for (let i = 0; i < events.length; i++) {
      const w = Math.max(MIN_NOTE_PX, beats[i] * UNIT_PX);
      if (curMeasure === null || events[i].measureIndex !== curMeasure.measureIndex) {
        curMeasure = { measureIndex: events[i].measureIndex, items: [], width: 0 };
        measures.push(curMeasure);
      }
      curMeasure.items.push({ index: i, w });
      curMeasure.width += w;
    }
    if (measures.length === 0) measures.push({ measureIndex: 0, items: [], width: 0 });

    const systems = [];
    for (let mi = 0; mi < measures.length; mi += MEASURES_PER_LINE) {
      const groupMeasures = measures.slice(mi, mi + MEASURES_PER_LINE);
      const items = [];
      let width = 0;
      groupMeasures.forEach((meas) => {
        meas.items.forEach((it) => { items.push({ index: it.index, w: it.w }); });
        width += meas.width;
      });
      systems.push({ items, width, measureIndex: groupMeasures[0] ? groupMeasures[0].measureIndex : null });
    }
    if (systems.length === 0) systems.push({ items: [], width: 0, measureIndex: null });

    const targetWidth = SYSTEM_MAX_WIDTH;
    systems.forEach(system => {
      if (system.width > 0 && system.items.length > 0) {
        // With one measure per line, a sparse measure (e.g. a single whole
        // note) would otherwise get stretched to fill the full row width,
        // spacing that one note absurdly far from the margin. Capping the
        // upscale factor keeps sparse measures visually compact instead of
        // artificially wide, while dense measures still get to use the
        // full available width.
        const scale = Math.max(0.55, Math.min(1.15, targetWidth / system.width));
        system.items.forEach(it => { it.w = it.w * scale; });
        system.width = system.width * scale;
      }
    });

    const widestSystem = systems.reduce((max, s) => Math.max(max, s.width), 0);
    const svgWidth = LEFT_MARGIN + RIGHT_MARGIN + Math.max(widestSystem, 200);
    const systemHeight = 3 * ROW_GAP;
    const totalHeight = TOP_MARGIN * 2 + systems.length * systemHeight + (systems.length - 1) * SYSTEM_VGAP + 10;

    // width:100% lets the SVG shrink to fit narrow (mobile) screens without
    // horizontal scroll when the content is already narrow; max-width caps
    // it at its natural size so it doesn't blow up huge on wide desktop
    // screens either. The viewBox keeps everything crisp at any size.
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgWidth} ${Math.max(totalHeight, 120)}" preserveAspectRatio="xMinYMin meet" font-family="Courier New, monospace" style="display:block; width:100%; max-width:${svgWidth}px;">`;
    svg += `<rect x="0" y="0" width="${svgWidth}" height="${Math.max(totalHeight, 120)}" fill="${C.bg}"/>`;

    let cumulativeBeat = 0;
    let measureCounter = 0;
    let lastMeasureSeen = null;

    systems.forEach((system, sIdx) => {
      const sy = TOP_MARGIN + sIdx * (systemHeight + SYSTEM_VGAP);
      const lineYs = E.DISPLAY_ORDER.map((s, li) => sy + li * ROW_GAP);

      // Selection highlight: a soft background band behind the whole
      // measure row when it's part of the current selection.
      if (selectedMeasures && system.measureIndex !== null && selectedMeasures.has(system.measureIndex)) {
        svg += `<rect x="${LEFT_MARGIN - 14}" y="${sy - 16}" width="${system.width + 30}" height="${systemHeight + 26}" rx="6" fill="${C.selected}" opacity="0.16"/>`;
      }

      svg += `<text x="12" y="${sy + 2}" font-size="10" fill="${C.ink}" font-weight="bold">T</text>` +
             `<text x="12" y="${sy + ROW_GAP + 2}" font-size="10" fill="${C.ink}" font-weight="bold">A</text>` +
             `<text x="12" y="${sy + 2 * ROW_GAP + 2}" font-size="10" fill="${C.ink}" font-weight="bold">B</text>`;

      E.DISPLAY_ORDER.forEach((s, li) => {
        const y = lineYs[li];
        svg += `<line x1="${LEFT_MARGIN - 10}" y1="${y}" x2="${LEFT_MARGIN + system.width + 14}" y2="${y}" stroke="${C.line}" stroke-width="1"/>`;
        if (sIdx === 0) {
          svg += `<text x="${LEFT_MARGIN - 32}" y="${y + 4}" font-size="10" fill="${C.dim}">${E.STRING_NAMES[s][0]}</text>`;
        }
      });

      // Repeat-bar marks: purely visual notation convention (thick double
      // line + two dots), drawn at the very start or end of the measure's
      // row. They don't correspond to any event and never affect playback.
      const mark = system.measureIndex !== null ? repeatMarks[system.measureIndex] : null;
      if (mark === 'start') {
        svg += `<line x1="${LEFT_MARGIN - 12}" y1="${lineYs[0]}" x2="${LEFT_MARGIN - 12}" y2="${lineYs[3]}" stroke="${C.ink}" stroke-width="2.5"/>` +
               `<line x1="${LEFT_MARGIN - 7}" y1="${lineYs[0]}" x2="${LEFT_MARGIN - 7}" y2="${lineYs[3]}" stroke="${C.ink}" stroke-width="1"/>` +
               `<circle cx="${LEFT_MARGIN - 2}" cy="${(lineYs[1] + lineYs[0]) / 2}" r="2" fill="${C.ink}"/>` +
               `<circle cx="${LEFT_MARGIN - 2}" cy="${(lineYs[3] + lineYs[2]) / 2}" r="2" fill="${C.ink}"/>`;
      }
      if (mark === 'end') {
        const endX = LEFT_MARGIN + system.width + 10;
        svg += `<line x1="${endX}" y1="${lineYs[0]}" x2="${endX}" y2="${lineYs[3]}" stroke="${C.ink}" stroke-width="2.5"/>` +
               `<line x1="${endX - 5}" y1="${lineYs[0]}" x2="${endX - 5}" y2="${lineYs[3]}" stroke="${C.ink}" stroke-width="1"/>` +
               `<circle cx="${endX - 10}" cy="${(lineYs[1] + lineYs[0]) / 2}" r="2" fill="${C.ink}"/>` +
               `<circle cx="${endX - 10}" cy="${(lineYs[3] + lineYs[2]) / 2}" r="2" fill="${C.ink}"/>`;
      }

      let x = LEFT_MARGIN;
      if (system.items.length === 0 && editable) {
        svg += `<g class="empty-slot" data-idx="0" data-measure="${sIdx * MEASURES_PER_LINE}">` +
          `<rect x="${LEFT_MARGIN}" y="${sy - 10}" width="60" height="${systemHeight + 20}" fill="transparent"/></g>`;
      }

      // Invisible hit-rect covering the whole measure row, drawn BEFORE the
      // notes so it doesn't intercept clicks meant for individual notes in
      // normal editing mode; in selection mode this is what the editor
      // actually binds its click handler to (see editor.js _renderGrid),
      // so the whole measure — including empty beats and rests — is
      // clickable, not just the notes.
      if (editable && system.measureIndex !== null) {
        svg += `<rect class="measure-hit" data-measure="${system.measureIndex}" x="${LEFT_MARGIN - 14}" y="${sy - 16}" width="${system.width + 30}" height="${systemHeight + 26}" fill="${C.bg}" opacity="0.001"/>`;
      }

      system.items.forEach((item, ii) => {
        const i = item.index;
        const ev = events[i];
        if (ev.measureIndex !== lastMeasureSeen) {
          if (!(sIdx === 0 && ii === 0)) {
            svg += `<line x1="${x - 6}" y1="${lineYs[0]}" x2="${x - 6}" y2="${lineYs[3]}" stroke="${C.line}" stroke-width="1"/>`;
          }
          lastMeasureSeen = ev.measureIndex;
          measureCounter++;
          svg += `<text x="${x - 6}" y="${sy - 8}" font-size="9" fill="${C.dim}">${measureCounter}</text>`;
        }

        const cls = editable ? 'note-num editable' : 'note-num';
        if (!ev.isRest && ev.midi !== null && chosen[i]) {
          const c = chosen[i];
          const rowIndex = E.DISPLAY_ORDER.indexOf(c.string);
          const y = lineYs[rowIndex];
          const label = String(c.fret);
          const boxW = Math.max(18, label.length * 8 + 10);
          svg += `<g class="${cls}" data-idx="${i}">` +
                 `<rect x="${x - boxW / 2}" y="${y - 9}" width="${boxW}" height="16" rx="3" fill="${C.bg}" opacity="0.001"/>` +
                 `<text x="${x}" y="${y + 4}" font-size="12.5" fill="${C.ink}" text-anchor="middle">${label}</text>` +
                 `</g>`;
          notePositions.push({ index: i, startBeat: cumulativeBeat, durBeat: beats[i] });
        } else if (!ev.isRest && ev.midi !== null && !chosen[i]) {
          const y = lineYs[3] + 12;
          svg += `<g class="${cls}" data-idx="${i}"><text x="${x}" y="${y}" font-size="9" fill="${C.bad}" text-anchor="middle">✕</text></g>`;
        } else if (ev.isRest && editable) {
          const y = lineYs[3] + 12;
          svg += `<g class="${cls} rest-slot" data-idx="${i}"><text x="${x}" y="${y}" font-size="9" fill="${C.dim}" text-anchor="middle">·</text></g>`;
        }
        cumulativeBeat += beats[i];
        x += item.w;
      });
    });

    svg += '</svg>';
    return { svg, notePositions };
  }

  function buildTextTab(events, chosen, divisions, title) {
    const linesByString = { 1: '', 2: '', 3: '', 4: '' };
    const beats = events.map(e => e.duration / divisions);
    events.forEach((ev, i) => {
      const width = Math.max(3, Math.round(beats[i] * 3) + 1);
      let filled = { 1: false, 2: false, 3: false, 4: false };
      if (!ev.isRest && ev.midi !== null && chosen[i]) {
        filled[chosen[i].string] = String(chosen[i].fret);
      }
      for (const s of [1, 2, 3, 4]) {
        const val = filled[s] || '-';
        linesByString[s] += val + '-'.repeat(Math.max(0, width - val.length));
      }
    });
    let out = title ? (title + '\n') : '';
    out += 'Afinación: Sol(4, aguda) - Do(3) - Mi(2) - La(1)\n\n';
    E.DISPLAY_ORDER.forEach(s => {
      out += E.STRING_NAMES[s].padEnd(4, ' ') + '|' + linesByString[s] + '|\n';
    });
    return out;
  }

  global.CampanellaRender = { buildTabSVG, buildTextTab, MEASURES_PER_LINE };
})(typeof window !== 'undefined' ? window : globalThis);
