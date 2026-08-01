/* ============================================================
   library.js — Librería local de tablaturas (IndexedDB, 100% offline)
   Cada tab guardada es un objeto plano:
   {
     id, title, createdAt, updatedAt,
     divisions, tempo, maxFret, weightMode,
     events: [{midi,isRest,duration,measureIndex}],
     chosen: [{string,fret}|null],
     source: 'musicxml'|'manual'
   }
   ============================================================ */
(function (global) {
  'use strict';

  const DB_NAME = 'campanella-library';
  const DB_VERSION = 1;
  const STORE = 'tabs';

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
          store.createIndex('title', 'title', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function uid() {
    return 'tab_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  async function saveTab(tab) {
    const db = await openDB();
    const now = Date.now();
    const record = Object.assign({}, tab);
    if (!record.id) record.id = uid();
    if (!record.createdAt) record.createdAt = now;
    record.updatedAt = now;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve(record);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function deleteTab(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getTab(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function listTabs() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => {
        const items = req.result || [];
        items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        resolve(items);
      };
      req.onerror = () => reject(req.error);
    });
  }

  function exportTabAsJSON(tab) {
    return JSON.stringify(tab, null, 2);
  }

  function importTabFromJSON(jsonText) {
    const parsed = JSON.parse(jsonText);
    // strip id so importing never collides with an existing local tab;
    // a fresh id is assigned on save
    delete parsed.id;
    return parsed;
  }

  global.CampanellaLibrary = {
    saveTab, deleteTab, getTab, listTabs, uid,
    exportTabAsJSON, importTabFromJSON
  };
})(typeof window !== 'undefined' ? window : globalThis);
