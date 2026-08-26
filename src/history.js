/*
   Undo and redo: tile-level deltas for strokes, whole-document
   snapshots for everything else.
*/

import { state, selectedTemplateId, paletteSlot,
         setState, setSelectedTemplate, setPaletteSlot } from './store.js';
import { serialize, deserialize } from './document.js';
import { scheduleSave } from './storage.js';
import { ui } from './hooks.js';

/* ============================================================
   Undo / redo
   ------------------------------------------------------------
   Two kinds of entry share one stack, both exposing undo()/redo():

     - paint strokes record only the tiles they touched, since a stroke
       can fire thousands of times and full snapshots would be wasteful;
     - everything else (templates, palette) stores a whole-document
       snapshot, which is cheap because cells are run-length encoded.
   ============================================================ */

const HISTORY_LIMIT = 100;

const undoHistory = { past: [], future: [] };

function pushHistory(entry) {
  undoHistory.past.push(entry);
  if (undoHistory.past.length > HISTORY_LIMIT) undoHistory.past.shift();
  undoHistory.future.length = 0;
  ui.updateHistoryButtons();
}

function clearHistory() {
  undoHistory.past.length = 0;
  undoHistory.future.length = 0;
  ui.updateHistoryButtons();
}

function undo() {
  const entry = undoHistory.past.pop();
  if (!entry) return;
  entry.undo();
  undoHistory.future.push(entry);
  ui.updateHistoryButtons();
}

function redo() {
  const entry = undoHistory.future.pop();
  if (!entry) return;
  entry.redo();
  undoHistory.past.push(entry);
  ui.updateHistoryButtons();
}

/* ---------- Whole document snapshots ---------- */

/* Selection and the active colour ride along, so undoing a delete puts you
   back where you were rather than on some arbitrary template. */
function snapshot() {
  return JSON.stringify({
    doc: serialize(state),
    sel: selectedTemplateId,
    slot: paletteSlot,
  });
}

function restoreDoc(text) {
  const snap = JSON.parse(text);
  setState(deserialize(snap.doc));
  setSelectedTemplate(
    snap.sel && state.templates.some(function (t) { return t.id === snap.sel; })
      ? snap.sel
      : (state.templates.length ? state.templates[0].id : null));
  setPaletteSlot(Math.max(0, Math.min(snap.slot | 0, state.palette.length - 1)));
  scheduleSave();
  ui.refreshAll();
}

function pushSnapshotEntry(before, after) {
  if (before === after) return;
  pushHistory({
    undo: function () { restoreDoc(before); },
    redo: function () { restoreDoc(after); },
  });
}

/* Runs a structural change and records it. A change that turns out to be a
   no-op -- a cancelled confirm, a rename to the same text -- records nothing. */
function withUndo(fn) {
  const before = snapshot();
  fn();
  pushSnapshotEntry(before, snapshot());
}

/* ---------- Paint strokes ---------- */

let strokeRec = null;   // { templateId, before: Map<cellIndex, slot> }

function beginStroke(t) {
  strokeRec = { templateId: t.id, before: new Map() };
}

/* Called by paintCell for every tile it is about to overwrite. */
function recordCell(i, oldSlot) {
  if (strokeRec && !strokeRec.before.has(i)) strokeRec.before.set(i, oldSlot);
}

function applyCells(templateId, indices, values) {
  const t = state.templates.find(function (x) { return x.id === templateId; });
  if (!t) return;
  for (let k = 0; k < indices.length; k++) t.cells[indices[k]] = values[k];
  setSelectedTemplate(templateId);   // show what just changed
  scheduleSave();
  ui.refreshAll();
}

function endStroke() {
  const rec = strokeRec;
  strokeRec = null;
  if (!rec || rec.before.size === 0) return;
  const t = state.templates.find(function (x) { return x.id === rec.templateId; });
  if (!t) return;

  /* A tile painted and then painted back within one stroke is not a change. */
  const indices = [];
  const before = [];
  const after = [];
  rec.before.forEach(function (oldSlot, i) {
    if (t.cells[i] === oldSlot) return;
    indices.push(i);
    before.push(oldSlot);
    after.push(t.cells[i]);
  });
  if (!indices.length) return;

  const idx  = Int32Array.from(indices);
  const from = Uint8Array.from(before);
  const to   = Uint8Array.from(after);
  const id   = rec.templateId;

  pushHistory({
    undo: function () { applyCells(id, idx, from); },
    redo: function () { applyCells(id, idx, to); },
  });
}

export {
  undoHistory,
  pushHistory,
  clearHistory,
  undo,
  redo,
  snapshot,
  restoreDoc,
  pushSnapshotEntry,
  withUndo,
  beginStroke,
  recordCell,
  endStroke,
  applyCells,
};
