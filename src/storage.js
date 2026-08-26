/*
   Autosave to localStorage, guarded because file:// origins are unreliable.
*/

import { state, templateBitmaps } from './store.js';
import { serialize, deserialize } from './document.js';
import { ui } from './hooks.js';

/* ============================================================
   Storage
   ------------------------------------------------------------
   localStorage is unreliable under file:// origins, so every access
   is guarded and a failure is surfaced rather than swallowed --
   Export is the dependable way to keep a document.
   ============================================================ */

const STORAGE_KEY = "liminal-industries-mapper.doc.v1";
const AUTOSAVE_DELAY_MS = 500;

let saveTimer = null;
let storageBroken = false;



function saveNow() {
  saveTimer = null;
  if (storageBroken) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serialize(state)));
    ui.setStatus("saved");
  } catch (err) {
    storageBroken = true;
    ui.setStatus("autosave off -- use Export", "error");
    console.warn("autosave failed:", err);
  }
}

/* Schedules a save without touching the UI. Painting calls this on every
   stroke, so it must stay cheap. */
function scheduleSave() {
  /* Any document edit can change how a template renders, so the map's
     bitmap cache is dropped here rather than at each individual call site. */
  templateBitmaps.clear();
  if (storageBroken) return;
  ui.setStatus("unsaved", "dirty");
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, AUTOSAVE_DELAY_MS);
}

/* Structural change: schedule a save and rebuild every dependent view. */
function markDirty() {
  scheduleSave();
  ui.refreshAll();
}

function loadFromStorage() {
  let text;
  try {
    text = localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    storageBroken = true;
    console.warn("storage unavailable:", err);
    return null;
  }
  if (!text) return null;
  try {
    return deserialize(JSON.parse(text));
  } catch (err) {
    console.warn("stored document is unreadable, starting empty:", err);
    return null;
  }
}


/* Commit any pending autosave right now, for page unload. */
function flushSave() {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveNow();
  }
}

export {
  STORAGE_KEY,
  storageBroken,
  saveNow,
  scheduleSave,
  markDirty,
  loadFromStorage,
  flushSave,
};
