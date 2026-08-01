/* ============================================================
   editor.js — Editor manual de tablaturas campanella
   Grid editable (clic en celda cuerda×tiempo) + panel de asistencia
   que aplica las reglas del motor (engine.js) en modo estricto:
   no permite repetir cuerda con la nota anterior si hay alternativa.
   ============================================================ */
(function (global) {
  'use strict';
  const E = global.CampanellaEngine;
  const R = global.CampanellaRender;

  const DURATIONS = [
    { label: 'Redonda', beats: 4 },
    { label: 'Blanca', beats: 2 },
    { label: 'Negra', beats: 1 },
    { label: 'Corchea', beats: 0.5 },
    { label: 'Semicorchea', beats: 0.25 }
  ];
  const DIVISIONS = 4; // ticks per quarter note for manually-built scores (supports up to semicorchea)

  function beatsToDuration(beats) { return Math.round(beats * DIVISIONS); }

  /**
   * TabEditor manages an in-memory list of events the user builds by hand,
   * plus the fingering chosen for each (auto-suggested but user-overridable),
   * and renders/updates a grid the user can click on directly.
   *
   * @param {HTMLElement} mountEl - container to render the grid + palette into
   * @param {object} opts - { maxFret:number, weightMode:string, onChange:fn }
   */
  function TabEditor(mountEl, opts) {
    this.mount = mountEl;
    this.maxFret = (opts && opts.maxFret) || 12;
    this.weightMode = (opts && opts.weightMode) || 'balanced';
    this.onChange = (opts && opts.onChange) || function () {};
    this.events = [];      // {midi,isRest,duration,measureIndex}
    this.chosen = [];      // {string,fret}|null, parallel to events
    this.beatsPerMeasure = 4; // 4/4 default; editable via UI
    this.selectedIndex = null; // index of note currently shown in the assist panel
    this.pendingDurationBeats = 1; // "negra" by default
    this._buildShell();
  }

  TabEditor.prototype._buildShell = function () {
    this.mount.innerHTML = `
      <div class="editor-toolbar">
        <div class="editor-tool-group">
          <label>Duración a insertar</label>
          <select class="ed-duration">
            ${DURATIONS.map((d, i) => `<option value="${i}" ${d.beats === 1 ? 'selected' : ''}>${d.label}</option>`).join('')}
          </select>
        </div>
        <div class="editor-tool-group">
          <label>Compás</label>
          <div class="meter-inputs">
            <input type="number" class="ed-meter-num" value="4" min="1" max="32" inputmode="numeric">
            <span class="meter-slash">/</span>
            <select class="ed-meter-den">
              <option value="4" selected>4</option>
              <option value="8">8</option>
              <option value="2">2</option>
              <option value="16">16</option>
            </select>
          </div>
        </div>
        <button type="button" class="btn-ghost ed-add-rest">+ Silencio</button>
        <button type="button" class="btn-ghost ed-undo" disabled>Deshacer última nota</button>
      </div>
      <div class="editor-grid-wrap"></div>
      <div class="assist-panel" style="display:none;">
        <div class="assist-title">Asistente campanella</div>
        <div class="assist-body"></div>
      </div>
      <div class="editor-hint">Elegí una nota musical y una duración, luego hacé clic en "Agregar nota" para colocarla al final. Para insertar en otra cuerda/traste, usá las opciones sugeridas en el asistente.</div>
      <div class="note-picker">
        <label>Nota a agregar</label>
        <div class="note-picker-row">
          <select class="ed-note-name">
            ${['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'].map(n=>`<option value="${n}">${n}</option>`).join('')}
          </select>
          <select class="ed-note-octave">
            ${[3,4,5,6].map(o=>`<option value="${o}" ${o===4?'selected':''}>${o}</option>`).join('')}
          </select>
          <button type="button" class="btn-brass ed-add-note">+ Agregar nota</button>
        </div>
      </div>
    `;
    this.gridWrap = this.mount.querySelector('.editor-grid-wrap');
    this.assistPanel = this.mount.querySelector('.assist-panel');
    this.assistBody = this.mount.querySelector('.assist-body');

    this.mount.querySelector('.ed-duration').addEventListener('change', (e) => {
      this.pendingDurationBeats = DURATIONS[parseInt(e.target.value, 10)].beats;
    });
    const updateMeter = () => {
      const num = Math.max(1, parseInt(this.mount.querySelector('.ed-meter-num').value, 10) || 4);
      const den = parseInt(this.mount.querySelector('.ed-meter-den').value, 10) || 4;
      // beatsPerMeasure is expressed in quarter-note units regardless of the
      // denominator, so 9/8 correctly becomes 4.5 quarter-notes per measure
      // (9 eighth notes), not 9 — any time signature works, not just the
      // handful that used to be hardcoded.
      this.beatsPerMeasure = num * (4 / den);
    };
    this.mount.querySelector('.ed-meter-num').addEventListener('input', updateMeter);
    this.mount.querySelector('.ed-meter-den').addEventListener('change', updateMeter);
    updateMeter();
    this.mount.querySelector('.ed-add-rest').addEventListener('click', () => this.addRest());
    this.mount.querySelector('.ed-undo').addEventListener('click', () => this.undo());
    this.mount.querySelector('.ed-add-note').addEventListener('click', () => {
      const name = this.mount.querySelector('.ed-note-name').value;
      const octave = parseInt(this.mount.querySelector('.ed-note-octave').value, 10);
      const midi = (octave + 1) * 12 + E.PITCH_CLASS[name.replace('#', '')] + (name.includes('#') ? 1 : 0);
      this.addNote(midi);
    });
  };

  TabEditor.prototype._currentMeasureIndex = function () {
    // recompute measure index by walking accumulated beats — keeps it correct
    // even if the user changes the meter mid-piece (new notes only).
    let beatAcc = 0, measure = 1;
    for (const ev of this.events) {
      beatAcc += ev.duration / DIVISIONS;
      if (beatAcc >= this.beatsPerMeasure - 1e-9) { beatAcc = 0; measure++; }
    }
    return measure;
  };

  TabEditor.prototype._prevChosen = function () {
    for (let i = this.chosen.length - 1; i >= 0; i--) {
      if (this.chosen[i]) return this.chosen[i];
    }
    return null;
  };

  TabEditor.prototype.addNote = function (midi, forcedFingering) {
    const duration = beatsToDuration(this.pendingDurationBeats);
    const measureIndex = this._currentMeasureIndex();
    const ev = { midi, isRest: false, duration, measureIndex };
    this.events.push(ev);

    let fingering = forcedFingering || null;
    if (!fingering) {
      const evalRes = E.evaluatePlacement(midi, this.maxFret, this._prevChosen());
      const rec = evalRes.candidates.find(c => c.recommended) || evalRes.candidates.find(c => c.allowed);
      fingering = rec ? { string: rec.string, fret: rec.fret } : null;
    }
    this.chosen.push(fingering);
    this._afterMutate();
    this.selectedIndex = this.events.length - 1;
    this._renderAssist();
  };

  TabEditor.prototype.addRest = function () {
    const duration = beatsToDuration(this.pendingDurationBeats);
    const measureIndex = this._currentMeasureIndex();
    this.events.push({ midi: null, isRest: true, duration, measureIndex });
    this.chosen.push(null);
    this._afterMutate();
  };

  TabEditor.prototype.undo = function () {
    if (!this.events.length) return;
    this.events.pop();
    this.chosen.pop();
    this.selectedIndex = null;
    this.assistPanel.style.display = 'none';
    this._afterMutate();
  };

  /** Called when the user clicks a note already on the grid: opens the assist panel for it. */
  TabEditor.prototype.selectNote = function (index) {
    if (this.events[index] == null || this.events[index].isRest) { this.assistPanel.style.display = 'none'; return; }
    this.selectedIndex = index;
    this._renderAssist();
  };

  TabEditor.prototype._prevChosenBefore = function (index) {
    for (let i = index - 1; i >= 0; i--) {
      if (this.chosen[i]) return this.chosen[i];
    }
    return null;
  };

  TabEditor.prototype._renderAssist = function () {
    const idx = this.selectedIndex;
    if (idx === null || idx === undefined || !this.events[idx] || this.events[idx].isRest) {
      this.assistPanel.style.display = 'none';
      return;
    }
    const ev = this.events[idx];
    const prev = this._prevChosenBefore(idx);
    const evalRes = E.evaluatePlacement(ev.midi, this.maxFret, prev);
    const noteName = E.midiToName(ev.midi);

    let html = `<div class="assist-note">Nota seleccionada: <b>${noteName}</b> (posición ${idx + 1})</div>`;
    if (evalRes.candidates.length === 0) {
      html += `<div class="assist-empty">Esta nota no tiene ninguna digitación posible dentro del traste máximo (${this.maxFret}). Subí el traste máximo o transportá la pieza.</div>`;
    } else {
      html += `<div class="assist-candidates">`;
      evalRes.candidates.forEach(c => {
        const isCurrent = this.chosen[idx] && this.chosen[idx].string === c.string && this.chosen[idx].fret === c.fret;
        const cls = ['assist-cand'];
        if (!c.allowed) cls.push('blocked');
        if (c.recommended) cls.push('recommended');
        if (isCurrent) cls.push('current');
        html += `<button type="button" class="${cls.join(' ')}" data-string="${c.string}" data-fret="${c.fret}" ${c.allowed ? '' : 'disabled'} title="${c.reason ? c.reason.replace(/"/g,'&quot;') : ''}">` +
          `<span class="cand-string">${E.STRING_NAMES[c.string]}</span>` +
          `<span class="cand-fret">traste ${c.fret}</span>` +
          (c.recommended ? '<span class="cand-tag">recomendado</span>' : '') +
          (!c.allowed ? '<span class="cand-tag bad">bloqueado</span>' : '') +
          `</button>`;
      });
      html += `</div>`;
      if (evalRes.candidates.some(c => !c.allowed)) {
        html += `<div class="assist-note-explain">Las opciones bloqueadas repetirían la cuerda de la nota anterior habiendo una alternativa — eso rompe el efecto campanella (las notas se cortarían entre sí en vez de sonar superpuestas).</div>`;
      }
    }
    this.assistBody.innerHTML = html;
    this.assistPanel.style.display = 'block';

    this.assistBody.querySelectorAll('.assist-cand:not(.blocked)').forEach(btn => {
      btn.addEventListener('click', () => {
        const string = parseInt(btn.getAttribute('data-string'), 10);
        const fret = parseInt(btn.getAttribute('data-fret'), 10);
        this.chosen[idx] = { string, fret };
        this._afterMutate();
        this._renderAssist();
      });
    });
  };

  TabEditor.prototype._afterMutate = function () {
    this.mount.querySelector('.ed-undo').disabled = this.events.length === 0;
    this._renderGrid();
    this.onChange({ events: this.events, chosen: this.chosen });
  };

  TabEditor.prototype._renderGrid = function () {
    if (this.events.length === 0) {
      this.gridWrap.innerHTML = `<div class="editor-empty">Todavía no agregaste ninguna nota. Elegí una nota abajo y tocá "+ Agregar nota".</div>`;
      return;
    }
    const { svg } = R.buildTabSVG(this.events, this.chosen, DIVISIONS, {
      editable: true,
      colors: { bg: '#1B1710', line: '#5c4f3a', ink: '#EDE3CC', accent: '#C9A24B', bad: '#D97D6C', dim: '#9c8b6a' }
    });
    this.gridWrap.innerHTML = svg;
    this.gridWrap.querySelectorAll('.note-num.editable').forEach(g => {
      g.style.cursor = 'pointer';
      g.addEventListener('click', () => {
        const idx = parseInt(g.getAttribute('data-idx'), 10);
        this.selectNote(idx);
      });
    });
  };

  TabEditor.prototype.loadFrom = function (events, chosen, maxFret, weightMode) {
    this.events = events.map(e => Object.assign({}, e));
    this.chosen = chosen.map(c => c ? Object.assign({}, c) : null);
    if (maxFret) this.maxFret = maxFret;
    if (weightMode) this.weightMode = weightMode;
    this.selectedIndex = null;
    this.assistPanel.style.display = 'none';
    this._afterMutate();
  };

  TabEditor.prototype.clear = function () {
    this.events = [];
    this.chosen = [];
    this.selectedIndex = null;
    this.assistPanel.style.display = 'none';
    this._afterMutate();
  };

  TabEditor.prototype.getState = function () {
    return { events: this.events, chosen: this.chosen, divisions: DIVISIONS };
  };

  global.CampanellaEditor = { TabEditor, DIVISIONS, DURATIONS };
})(typeof window !== 'undefined' ? window : globalThis);
