/* ============================================================
   app.js — Orquestador de la PWA: navegación de vistas, generador,
   integración del editor manual, y la librería local.
   ============================================================ */
(function () {
  'use strict';
  const E = window.CampanellaEngine;
  const R = window.CampanellaRender;
  const X = window.CampanellaMusicXML;
  const L = window.CampanellaLibrary;
  const A = window.CampanellaAudio;
  const Ed = window.CampanellaEditor;

  const $ = (id) => document.getElementById(id);

  /* ============ view navigation ============ */
  const views = ['generator', 'editor', 'library'];
  function showView(name) {
    views.forEach(v => {
      $('view-' + v).classList.toggle('active', v === name);
      $('nav-' + v).classList.toggle('active', v === name);
    });
    if (name === 'library') renderLibrary();
  }
  views.forEach(v => $('nav-' + v).addEventListener('click', () => showView(v)));

  /* ============ shared audio player ============ */
  const player = new A.AudioPlayer();

  /* ============================================================
     GENERATOR VIEW (MusicXML → tab)
     ============================================================ */
  let parsedScore = null;
  let activePart = null;
  let fingering = null;
  let genNotePositions = [];
  let currentFileName = '';

  const fileInput = $('fileInput');
  const dropzone = $('dropzone');
  const generateBtn = $('generateBtn');
  const fileMsgs = $('fileMsgs');

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault(); dropzone.classList.remove('drag');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
  });

  function showMsg(container, text, kind) { container.innerHTML = `<div class="msg ${kind}">${text}</div>`; }
  function clearMsg(container) { container.innerHTML = ''; }

  function handleFile(file) {
    currentFileName = file.name;
    $('filename').textContent = file.name;
    clearMsg(fileMsgs);
    generateBtn.disabled = true;
    $('partField').style.display = 'none';

    const lower = file.name.toLowerCase();
    if (lower.endsWith('.mxl')) {
      showMsg(fileMsgs, 'Este archivo está comprimido (.mxl). Exportalo como "MusicXML sin comprimir" (.xml / .musicxml) desde tu editor de partituras y volvé a subirlo.', 'error');
      return;
    }

    const reader = new FileReader();
    reader.onload = function (ev) {
      try {
        parsedScore = X.parseMusicXML(ev.target.result);
      } catch (err) {
        showMsg(fileMsgs, 'No se pudo leer la partitura: ' + err.message, 'error');
        parsedScore = null;
        return;
      }
      if (!parsedScore.parts.length) {
        showMsg(fileMsgs, 'El archivo no contiene partes reconocibles. Verificá que sea un MusicXML válido (formato "partwise").', 'error');
        return;
      }
      const sel = $('partSelect');
      sel.innerHTML = '';
      parsedScore.parts.forEach((p, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        const noteCount = p.events.filter(e => !e.isRest && e.midi !== null).length;
        opt.textContent = `${p.name} (${noteCount} notas)`;
        sel.appendChild(opt);
      });
      $('partField').style.display = parsedScore.parts.length > 1 ? 'block' : 'none';
      $('bpmInput').value = Math.round(parsedScore.tempo) || 100;
      showMsg(fileMsgs, `Partitura leída correctamente: ${parsedScore.parts.length} voz(ces) encontrada(s).`, 'ok');
      generateBtn.disabled = false;
    };
    reader.onerror = function () { showMsg(fileMsgs, 'No se pudo abrir el archivo.', 'error'); };
    reader.readAsText(file);
  }

  $('suggestBtn').addEventListener('click', () => {
    if (!parsedScore) return;
    const partIdx = parseInt($('partSelect').value || '0', 10);
    const events = parsedScore.parts[partIdx].events;
    $('transpose').value = E.suggestTranspose(events);
  });

  generateBtn.addEventListener('click', generate);

  function generate() {
    if (!parsedScore) return;
    const partIdx = parseInt($('partSelect').value || '0', 10);
    const part = parsedScore.parts[partIdx];
    const maxFret = parseInt($('maxFret').value, 10);
    const semis = parseInt($('transpose').value, 10) || 0;
    const weightMode = $('handWeight').value;

    const events = part.events.map(e => Object.assign({}, e, { midi: (e.midi === null ? null : e.midi + semis) }));

    const result = E.solveFingering(events, maxFret, weightMode);
    fingering = result;
    activePart = { events, divisions: part.divisions, title: part.name || currentFileName, maxFret, weightMode };

    const { svg, notePositions } = R.buildTabSVG(events, result.chosen, part.divisions, {
      colors: { bg: '#1B1710', line: '#5c4f3a', ink: '#EDE3CC', accent: '#C9A24B', bad: '#D97D6C', dim: '#9c8b6a' }
    });
    genNotePositions = notePositions;
    $('tabwrap').innerHTML = svg;

    $('emptyState').style.display = 'none';
    $('resultArea').style.display = 'block';
    $('tuneTitle').textContent = activePart.title;
    const noteCount = result.totalPitched;
    let metaText = `${noteCount} nota(s) · traste máx. ${maxFret}` + (semis ? ` · transportado ${semis > 0 ? '+' : ''}${semis} semitono(s)` : '');
    $('tuneMeta').textContent = metaText;

    if (result.unplayableCount > 0) {
      showMsg(fileMsgs, `${result.unplayableCount} nota(s) quedan fuera del rango del ukulele con estos ajustes (marcadas con ✕). Probá "Sugerir" transposición o ampliá el traste máximo.`, 'warn');
    } else {
      showMsg(fileMsgs, 'Tablatura generada correctamente.', 'ok');
    }
  }

  $('playBtn').addEventListener('click', () => {
    if (!activePart || !fingering) return;
    player.onNoteOn = (idx) => { const el = document.querySelector(`#tabwrap .note-num[data-idx="${idx}"]`); if (el) el.classList.add('active'); };
    player.onNoteOff = (idx) => { const el = document.querySelector(`#tabwrap .note-num[data-idx="${idx}"]`); if (el) el.classList.remove('active'); };
    player.onEnd = () => { $('playBtn').disabled = false; $('stopBtn').disabled = true; };
    player.play(activePart.events, genNotePositions, parseFloat($('bpmInput').value) || 100);
    $('playBtn').disabled = true; $('stopBtn').disabled = false;
  });
  $('stopBtn').addEventListener('click', () => {
    player.stop();
    document.querySelectorAll('#tabwrap .note-num.active').forEach(el => el.classList.remove('active'));
    $('playBtn').disabled = false; $('stopBtn').disabled = true;
  });

  $('downloadTxtBtn').addEventListener('click', () => {
    if (!activePart || !fingering) return;
    const txt = R.buildTextTab(activePart.events, fingering.chosen, activePart.divisions, activePart.title);
    downloadBlob(txt, (activePart.title || 'tablatura').replace(/[^a-z0-9\-_]+/gi, '_') + '.txt', 'text/plain');
  });
  $('downloadSvgBtn').addEventListener('click', () => {
    const svgEl = document.querySelector('#tabwrap svg');
    if (!svgEl) return;
    const svgText = new XMLSerializer().serializeToString(svgEl);
    downloadBlob('<?xml version="1.0" encoding="UTF-8"?>\n' + svgText, 'tablatura-campanella.svg', 'image/svg+xml');
  });
  $('printBtn').addEventListener('click', () => window.print());

  $('saveToLibraryBtn').addEventListener('click', async () => {
    if (!activePart || !fingering) return;
    const tab = {
      title: activePart.title,
      divisions: activePart.divisions,
      tempo: parseFloat($('bpmInput').value) || 100,
      maxFret: activePart.maxFret,
      weightMode: activePart.weightMode,
      events: activePart.events,
      chosen: fingering.chosen,
      source: 'musicxml'
    };
    await L.saveTab(tab);
    showMsg(fileMsgs, `Guardada en tu librería como "${tab.title}".`, 'ok');
  });

  function downloadBlob(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /* ============================================================
     EDITOR VIEW (manual tab building)
     ============================================================ */
  const editorMount = $('editorMount');
  const editor = new Ed.TabEditor(editorMount, {
    maxFret: 12,
    weightMode: 'balanced',
    onChange: () => { $('editorPlayBtn').disabled = editor.events.length === 0; }
  });
  let editorNotePositions = [];
  let editorTabId = null; // set when editing an existing library tab

  $('editorMaxFret').addEventListener('change', (e) => { editor.maxFret = parseInt(e.target.value, 10); });
  $('editorWeightMode').addEventListener('change', (e) => { editor.weightMode = e.target.value; });

  $('editorPlayBtn').addEventListener('click', () => {
    if (!editor.events.length) return;
    const { notePositions } = R.buildTabSVG(editor.events, editor.chosen, Ed.DIVISIONS, { editable: false });
    editorNotePositions = notePositions;
    player.onNoteOn = (idx) => { const el = editorMount.querySelector(`.note-num[data-idx="${idx}"]`); if (el) el.classList.add('active'); };
    player.onNoteOff = (idx) => { const el = editorMount.querySelector(`.note-num[data-idx="${idx}"]`); if (el) el.classList.remove('active'); };
    player.onEnd = () => { $('editorPlayBtn').disabled = false; $('editorStopBtn').disabled = true; };
    player.play(editor.events, editorNotePositions, parseFloat($('editorBpm').value) || 90);
    $('editorPlayBtn').disabled = true; $('editorStopBtn').disabled = false;
  });
  $('editorStopBtn').addEventListener('click', () => {
    player.stop();
    editorMount.querySelectorAll('.note-num.active').forEach(el => el.classList.remove('active'));
    $('editorPlayBtn').disabled = false; $('editorStopBtn').disabled = true;
  });

  $('editorClearBtn').addEventListener('click', () => {
    if (editor.events.length && !confirm('¿Borrar toda la tablatura en construcción? Esto no afecta lo ya guardado en tu librería.')) return;
    editor.clear();
    editorTabId = null;
    $('editorTitleInput').value = '';
    clearMsg($('editorMsgs'));
  });

  $('editorSaveBtn').addEventListener('click', async () => {
    if (!editor.events.length) { showMsg($('editorMsgs'), 'Agregá al menos una nota antes de guardar.', 'warn'); return; }
    const title = $('editorTitleInput').value.trim() || 'Tablatura sin título';
    const tab = {
      id: editorTabId || undefined,
      title,
      divisions: Ed.DIVISIONS,
      tempo: parseFloat($('editorBpm').value) || 90,
      maxFret: editor.maxFret,
      weightMode: editor.weightMode,
      events: editor.events,
      chosen: editor.chosen,
      source: 'manual'
    };
    const saved = await L.saveTab(tab);
    editorTabId = saved.id;
    showMsg($('editorMsgs'), `Guardada como "${title}".`, 'ok');
  });

  /* ============================================================
     LIBRARY VIEW
     ============================================================ */
  const libraryGrid = $('libraryGrid');
  const librarySearch = $('librarySearch');
  librarySearch.addEventListener('input', () => renderLibrary());

  async function renderLibrary() {
    const items = await L.listTabs();
    const q = librarySearch.value.trim().toLowerCase();
    const filtered = q ? items.filter(t => (t.title || '').toLowerCase().includes(q)) : items;

    if (filtered.length === 0) {
      libraryGrid.innerHTML = `<div class="library-empty">${items.length === 0
        ? 'Tu librería está vacía todavía. Generá una tablatura o construí una a mano y guardala acá.'
        : 'Ninguna tablatura coincide con la búsqueda.'}</div>`;
      return;
    }

    libraryGrid.innerHTML = filtered.map(t => {
      const noteCount = (t.events || []).filter(e => !e.isRest && e.midi !== null).length;
      const date = new Date(t.updatedAt || t.createdAt || Date.now());
      const dateStr = date.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' });
      return `
        <div class="tab-card" data-id="${t.id}">
          <span class="tab-source ${t.source === 'manual' ? 'manual' : 'musicxml'}">${t.source === 'manual' ? 'manual' : 'musicxml'}</span>
          <h3>${escapeHtml(t.title || 'Sin título')}</h3>
          <div class="tab-meta">${noteCount} notas · traste máx. ${t.maxFret || 12} · ${dateStr}</div>
          <div class="tab-actions">
            <button type="button" class="btn-ghost act-open">Abrir</button>
            <button type="button" class="btn-ghost act-export">Exportar</button>
            <button type="button" class="btn-danger act-delete">Borrar</button>
          </div>
        </div>`;
    }).join('');

    libraryGrid.querySelectorAll('.tab-card').forEach(card => {
      const id = card.getAttribute('data-id');
      card.querySelector('.act-open').addEventListener('click', () => openTabInEditor(id));
      card.querySelector('.act-export').addEventListener('click', () => exportTab(id));
      card.querySelector('.act-delete').addEventListener('click', async () => {
        if (!confirm('¿Borrar esta tablatura de tu librería? No se puede deshacer.')) return;
        await L.deleteTab(id);
        renderLibrary();
      });
    });
  }

  async function openTabInEditor(id) {
    const tab = await L.getTab(id);
    if (!tab) return;
    showView('editor');
    editor.loadFrom(tab.events, tab.chosen, tab.maxFret, tab.weightMode);
    editorTabId = tab.id;
    $('editorTitleInput').value = tab.title || '';
    $('editorBpm').value = tab.tempo || 90;
    $('editorMaxFret').value = String(tab.maxFret || 12);
    $('editorWeightMode').value = tab.weightMode || 'balanced';
    clearMsg($('editorMsgs'));
  }

  async function exportTab(id) {
    const tab = await L.getTab(id);
    if (!tab) return;
    const json = L.exportTabAsJSON(tab);
    downloadBlob(json, (tab.title || 'tablatura').replace(/[^a-z0-9\-_]+/gi, '_') + '.campanella.json', 'application/json');
  }

  $('importTabBtn').addEventListener('click', () => $('importTabInput').click());
  $('importTabInput').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const tab = L.importTabFromJSON(ev.target.result);
        await L.saveTab(tab);
        showMsg($('libraryMsgs'), `Se importó "${tab.title || 'la tablatura'}".`, 'ok');
        renderLibrary();
      } catch (err) {
        showMsg($('libraryMsgs'), 'No se pudo importar el archivo: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  $('exportAllBtn').addEventListener('click', async () => {
    const json = await L.exportAllAsJSON();
    const count = (JSON.parse(json).count) || 0;
    if (count === 0) {
      showMsg($('libraryMsgs'), 'Tu librería está vacía, no hay nada para exportar todavía.', 'warn');
      return;
    }
    const dateStr = new Date().toISOString().slice(0, 10);
    downloadBlob(json, `campanella-libreria-completa_${dateStr}.json`, 'application/json');
    showMsg($('libraryMsgs'), `Se exportaron ${count} tablatura(s) en un solo archivo. Pasalo al otro dispositivo (por email, Drive, cable, etc.) y usá "Importar librería completa" ahí.`, 'ok');
  });

  $('importAllBtn').addEventListener('click', () => $('importAllInput').click());
  $('importAllInput').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        // peek at how many tabs are already here vs. in the bundle, so the
        // confirm dialog is informative instead of a blind yes/no
        const existing = await L.listTabs();
        const preview = JSON.parse(ev.target.result);
        const incomingCount = (preview && preview.tabs && preview.tabs.length) || 0;
        const overwrite = confirm(
          `Este archivo trae ${incomingCount} tablatura(s).\n\n` +
          `Aceptar = fusionar: las que coincidan por id se ACTUALIZAN con la versión del archivo, las nuevas se agregan (tenés ${existing.length} guardadas ahora).\n` +
          `Cancelar = importar como copias nuevas, sin tocar las que ya tenés.`
        );
        const result = await L.importAllFromJSON(ev.target.result, { mode: overwrite ? 'merge' : 'copy' });
        showMsg($('libraryMsgs'), `Importadas ${result.imported} tablatura(s)${result.skipped ? ` (${result.skipped} se saltearon por estar incompletas)` : ''}.`, 'ok');
        renderLibrary();
      } catch (err) {
        showMsg($('libraryMsgs'), 'No se pudo importar el archivo: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ============================================================
     PWA install prompt
     ============================================================ */
  let deferredInstallPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    $('installBanner').classList.add('show');
  });
  $('installBtn').addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    $('installBanner').classList.remove('show');
  });
  $('installDismissBtn').addEventListener('click', () => $('installBanner').classList.remove('show'));
  window.addEventListener('appinstalled', () => $('installBanner').classList.remove('show'));

  /* ============ service worker registration ============ */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js').catch(() => {
        // offline-first is best-effort; app still works without SW, just not installable/offline
      });
    });
  }

  /* ============ initial view ============ */
  showView('generator');
})();
