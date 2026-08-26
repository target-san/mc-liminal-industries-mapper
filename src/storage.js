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


/* ---------- Map view ----------
   Pan and zoom are view state, not document state, so they get their own key.
   Keeping them out of the document means panning does not churn it on every
   mouse move, and an exported file does not carry someone else's viewport.
   The centre is stored in tile coordinates rather than pixels, so reopening
   in a differently sized window still lands on the same place. */

const VIEW_KEY = "liminal-industries-mapper.view.v1";
const VIEW_SAVE_DELAY_MS = 400;

let viewTimer = null;
let pendingView = null;

function saveViewNow() {
  viewTimer = null;
  if (!pendingView || storageBroken) return;
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(pendingView));
  } catch (err) {
    console.warn("could not store the map view:", err);
  }
  pendingView = null;
}

function saveMapView(view) {
  pendingView = view;
  if (viewTimer !== null) clearTimeout(viewTimer);
  viewTimer = setTimeout(saveViewNow, VIEW_SAVE_DELAY_MS);
}

/* Returns null for anything that is not a usable view, so a hand-edited or
   half-written entry falls back to fitting rather than throwing. */
function loadMapView() {
  let text;
  try {
    text = localStorage.getItem(VIEW_KEY);
  } catch (err) {
    return null;
  }
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object") return null;
    const ok = [v.scale, v.cu, v.cv].every(function (n) {
      return typeof n === "number" && isFinite(n);
    });
    if (!ok || v.scale <= 0) return null;
    return { scale: v.scale, cu: v.cu, cv: v.cv };
  } catch (err) {
    return null;
  }
}

/* Commit anything pending right now, for page unload. */
function flushSave() {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveNow();
  }
  if (viewTimer !== null) {
    clearTimeout(viewTimer);
    saveViewNow();
  }
}

export {
  STORAGE_KEY,
  storageBroken,
  saveNow,
  scheduleSave,
  markDirty,
  loadFromStorage,
  saveMapView,
  loadMapView,
  flushSave,
};
