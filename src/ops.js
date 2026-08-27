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
    if (Array.isArray(src.exitGroups)) copy.exitGroups = src.exitGroups.slice();
    state.templates.splice(state.templates.indexOf(src) + 1, 0, copy);
    setSelectedTemplate(copy.id);
    markDirty();
  });
}

async function deleteTemplate(id) {
  const used = Object.keys(state.map.placements).some(function (key) {
    return state.map.placements[key].templateId === id;
  });
  if (used) {
    await ui.showError("Template in use",
      "This template is still placed on the map. Delete those rooms first.");
    return;
  }
  const t = state.templates.find(function (x) { return x.id === id; });
  if (!t) return;
  const yes = await ui.askConfirm("Delete template",
    "Delete \"" + t.name + "\"?", "Delete", true);
  if (!yes) return;
  /* The document can move on while a dialog is open, so nothing established
     before the await may be trusted afterwards. */
  if (!state.templates.some(function (x) { return x.id === id; })) return;
  withUndo(function () {
    state.templates = state.templates.filter(function (x) { return x.id !== id; });
    if (selectedTemplateId === id) {
      setSelectedTemplate(state.templates.length ? state.templates[0].id : null);
    }
    markDirty();
  });
}

async function renameTemplate(id) {
  const t = state.templates.find(function (x) { return x.id === id; });
  if (!t) return;
  const name = await ui.askText("Rename template", t.name, "Rename");
  if (name === null) return;
  const trimmed = name.trim();
  const target = state.templates.find(function (x) { return x.id === id; });
  if (!target || !trimmed || trimmed === target.name) return;
  withUndo(function () {
    target.name = trimmed;
    markDirty();
  });
}

/* ============================================================
   Palette operations
   ============================================================ */

async function addPaletteColor() {
  if (state.palette.length >= MAX_PALETTE) {
    await ui.showError("Palette full",
      "The palette already holds " + MAX_PALETTE + " colours.");
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
async function deletePaletteColor(slot) {
  if (slot < RESERVED_COUNT || slot >= state.palette.length) return;
  const entry = state.palette[slot];
  const entryId = entry.id;

  let used = 0;
  state.templates.forEach(function (t) {
    for (let i = 0; i < t.cells.length; i++) if (t.cells[i] === slot) used++;
  });
  const question = used
    ? "Delete \"" + entry.name + "\"? " + used +
      " painted tile(s) will fall back to floor."
    : "Delete \"" + entry.name + "\"?";
  const yes = await ui.askConfirm("Delete colour", question, "Delete", true);
  if (!yes) return;

  /* Re-resolve by identity: the palette may have been reordered or edited
     while the dialog was open, which would leave the index pointing at a
     different colour entirely. */
  slot = state.palette.findIndex(function (e) { return e.id === entryId; });
  if (slot < RESERVED_COUNT) return;

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
