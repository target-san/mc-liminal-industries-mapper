/*
   New, Import and Export.
*/

import { serialize, deserialize, createDocument } from './document.js';
import { state, setState, setSelectedTemplate, setPaletteSlot } from './store.js';
import { SLOT_FLOOR } from './palette.js';
import { clearHistory } from './history.js';
import { markDirty } from './storage.js';
import { fitView } from './editor.js';
import { fitMapView, mapUI } from './mapview.js';
import { ui } from './hooks.js';

/* ============================================================
   Import / export
   ============================================================ */

function timestamp() {
  const d = new Date();
  function pad(n) { return String(n).padStart(2, "0"); }
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
         "-" + pad(d.getHours()) + pad(d.getMinutes());
}

function exportDocument() {
  const text = JSON.stringify(serialize(state), null, 1);
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "liminal-map-" + timestamp() + ".json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 0);
}

function importDocument(file) {
  const reader = new FileReader();
  reader.onload = function () {
    let doc;
    try {
      doc = deserialize(JSON.parse(String(reader.result)));
    } catch (err) {
      ui.showError("Import failed", err.message);
      return;
    }
    setState(doc);
    setSelectedTemplate(state.templates.length ? state.templates[0].id : null);
    setPaletteSlot(SLOT_FLOOR);
    mapUI.brush = null;
    mapUI.selected = null;
    clearHistory();
    fitView();
    fitMapView();
    markDirty();
  };
  reader.onerror = function () {
    ui.showError("Import failed", "Could not read the file.");
  };
  reader.readAsText(file);
}

async function newDocument() {
  const hasContent = state.templates.length > 0 ||
                     Object.keys(state.map.placements).length > 0;
  if (hasContent) {
    const yes = await ui.askConfirm("New document",
      "Discard the current document and start over?", "Discard", true);
    if (!yes) return;
  }
  setState(createDocument());
  setSelectedTemplate(null);
  setPaletteSlot(SLOT_FLOOR);
  mapUI.brush = null;
  mapUI.selected = null;
  clearHistory();
  markDirty();
}

export {
  exportDocument,
  importDocument,
  newDocument,
};
