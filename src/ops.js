/*
   Template and palette operations, each one an undo step.
*/

import { createTemplate, uid } from './document.js';
import { state, selectedTemplateId, setSelectedTemplate,
         paletteSlot, setPaletteSlot } from './store.js';
import { RESERVED_COUNT, MAX_PALETTE, NEW_COLORS, SLOT_FLOOR } from './palette.js';
import { withUndo } from './history.js';
import { markDirty } from './storage.js';
import { ui } from './hooks.js';

/* ============================================================
   Template operations
   ============================================================ */

function addTemplate() {
  if (state.templates.length >= 999) return;
  withUndo(function () {
    const t = createTemplate("Room " + (state.templates.length + 1));
    state.templates.push(t);
    setSelectedTemplate(t.id);
    ui.fitEditorView();
    markDirty();
  });
}

function duplicateTemplate(id) {
  withUndo(function () {
    const src = state.templates.find(function (x) { return x.id === id; });
    if (!src) return;
    const copy = { id: uid("tpl"), name: src.name + " copy", cells: src.cells.slice() };
    state.templates.splice(state.templates.indexOf(src) + 1, 0, copy);
    setSelectedTemplate(copy.id);
    markDirty();
  });
}

function deleteTemplate(id) {
  const used = Object.keys(state.map.placements).some(function (key) {
    return state.map.placements[key].templateId === id;
  });
  if (used) {
    alert("This template is still placed on the map.");
    return;
  }
  const t = state.templates.find(function (x) { return x.id === id; });
  if (t && !confirm("Delete template \"" + t.name + "\"?")) return;
  withUndo(function () {
    state.templates = state.templates.filter(function (x) { return x.id !== id; });
    if (selectedTemplateId === id) {
      setSelectedTemplate(state.templates.length ? state.templates[0].id : null);
    }
    markDirty();
  });
}

function renameTemplate(id) {
  const t = state.templates.find(function (x) { return x.id === id; });
  if (!t) return;
  const name = prompt("Template name:", t.name);
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed || trimmed === t.name) return;
  withUndo(function () {
    t.name = trimmed;
    markDirty();
  });
}

/* ============================================================
   Palette operations
   ============================================================ */

function addPaletteColor() {
  if (state.palette.length >= MAX_PALETTE) {
    alert("The palette is full (" + MAX_PALETTE + " colours).");
    return;
  }
  withUndo(function () {
    const customCount = state.palette.length - RESERVED_COUNT;
    state.palette.push({
      id: uid("col"),
      name: "Colour " + (customCount + 1),
      color: NEW_COLORS[customCount % NEW_COLORS.length],
      passable: true,
      kind: "custom",
    });
    setPaletteSlot(state.palette.length - 1);
    markDirty();
  });
}

/*
   Deleting a custom colour rewrites every template: tiles using it fall back
   to floor, and every slot above it shifts down by one. The remap runs before
   the splice so it can still read the old indices.
*/
function deletePaletteColor(slot) {
  if (slot < RESERVED_COUNT || slot >= state.palette.length) return;
  const entry = state.palette[slot];

  let used = 0;
  state.templates.forEach(function (t) {
    for (let i = 0; i < t.cells.length; i++) if (t.cells[i] === slot) used++;
  });
  const question = used
    ? "Delete colour \"" + entry.name + "\"? " + used +
      " painted tile(s) will fall back to floor."
    : "Delete colour \"" + entry.name + "\"?";
  if (!confirm(question)) return;

  withUndo(function () {
    state.templates.forEach(function (t) {
      for (let i = 0; i < t.cells.length; i++) {
        const v = t.cells[i];
        if (v === slot) t.cells[i] = SLOT_FLOOR;
        else if (v > slot) t.cells[i] = v - 1;
      }
    });
    state.palette.splice(slot, 1);

    if (paletteSlot === slot) setPaletteSlot(SLOT_FLOOR);
    else if (paletteSlot > slot) setPaletteSlot(paletteSlot - 1);

    markDirty();
  });
}

export {
  addTemplate,
  duplicateTemplate,
  deleteTemplate,
  renameTemplate,
  addPaletteColor,
  deletePaletteColor,
};
