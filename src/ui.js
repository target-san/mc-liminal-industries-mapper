/*
   Shell: tabs, file actions, the template and palette sidebars,
   global keyboard handling and all the wiring.
*/

import { RESERVED_COUNT } from './palette.js';
import { state, currentTemplate, selectedTemplateId, setSelectedTemplate,
         paletteSlot, setPaletteSlot } from './store.js';
import { scheduleSave, markDirty, flushSave } from './storage.js';
import { undo, redo, undoHistory, withUndo, snapshot, pushSnapshotEntry } from './history.js';
import { addTemplate, duplicateTemplate, deleteTemplate, renameTemplate,
         addPaletteColor, deletePaletteColor } from './ops.js';
import { editor, wrapEl, resizeCanvas, fitView, centerView, drawEditor, setTool,
         renderEditorHeader, updateEditorFoot, endDrag } from './editor.js';
import { mapUI, mapWrapEl, resizeMapCanvas, drawMap, fitMapView, fitMapCenter,
         renderMapTemplateList, updateMapBar, updateMapFoot,
         rotateAction, mirrorAction, deleteSelection, setMapMode,
         locatePosition, endMapDrag } from './mapview.js';
import { isAnchored, anchorOrigin, formatXZ } from './world.js';
import { newDocument, exportDocument, importDocument } from './files.js';
import { setSpaceHeld } from './screen.js';
import { askText, askConfirm, showError } from './dialog.js';
import { ui } from './hooks.js';

const statusEl = document.getElementById("status");

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || "";
}

function updateHistoryButtons() {
  const u = document.getElementById("btn-undo");
  const r = document.getElementById("btn-redo");
  if (u) u.disabled = undoHistory.past.length === 0;
  if (r) r.disabled = undoHistory.future.length === 0;
}

/* ============================================================
   UI
   ============================================================ */

const tplListEl   = document.getElementById("tpl-list");
const tplEmptyEl  = document.getElementById("tpl-empty");
const palResEl    = document.getElementById("pal-reserved");
const palCustomEl = document.getElementById("pal-custom");
const palEmptyEl  = document.getElementById("pal-empty");
const palEditEl   = document.getElementById("pal-edit");
const mapInfoEl   = document.getElementById("map-info");


let activeTab = "map";

function showTab(name) {
  activeTab = name;
  document.querySelectorAll(".tab-btn").forEach(function (b) {
    b.classList.toggle("active", b.dataset.tab === name);
  });
  document.querySelectorAll(".panel").forEach(function (p) {
    p.classList.toggle("active", p.id === "panel-" + name);
  });
  /* Canvases inside a hidden panel measure zero, so each is sized on the way
     in rather than up front. */
  if (name === "rooms") resizeCanvas();
  if (name === "map") { resizeMapCanvas(); updateMapFoot(); }
}



/*
   One row button. Clicks are stopped so they do not also select the row.
*/
function templateRowButton(label, title, extra, onClick) {
  const b = document.createElement("button");
  b.className = "tpl-btn" + (extra ? " " + extra : "");
  b.textContent = label;
  b.title = title;
  b.addEventListener("click", function (ev) {
    ev.stopPropagation();
    onClick();
  });
  return b;
}

function renderTemplateList() {
  tplListEl.textContent = "";
  tplEmptyEl.style.display = state.templates.length ? "none" : "";

  state.templates.forEach(function (t) {
    const li = document.createElement("li");
    li.className = "tpl-item" + (t.id === selectedTemplateId ? " selected" : "");
    li.title = "Click to edit this template";

    const name = document.createElement("span");
    name.className = "tpl-name";
    name.textContent = t.name;
    li.appendChild(name);

    li.appendChild(templateRowButton("R", "Rename this template", "", function () {
      renameTemplate(t.id);
    }));
    li.appendChild(templateRowButton("+", "Duplicate this template", "", function () {
      duplicateTemplate(t.id);
    }));
    li.appendChild(templateRowButton("x", "Delete this template", "del", function () {
      deleteTemplate(t.id);
    }));

    li.addEventListener("click", function () {
      setSelectedTemplate(t.id);
      renderTemplateList();
      renderEditorHeader();
      drawEditor();
    });

    tplListEl.appendChild(li);
  });
}

function makePaletteItem(entry, slot) {
  const li = document.createElement("li");
  li.className = "pal-item" + (slot === paletteSlot ? " selected" : "");

  const sw = document.createElement("span");
  sw.className = "swatch";
  sw.style.background = entry.color;
  li.appendChild(sw);

  const name = document.createElement("span");
  name.className = "pal-name";
  name.textContent = entry.name;
  li.appendChild(name);

  const flag = document.createElement("span");
  flag.className = "pal-flag";
  flag.textContent = entry.passable ? "walk" : "solid";
  flag.title = entry.passable ? "Passable" : "Blocks movement";
  li.appendChild(flag);

  li.addEventListener("click", function () {
    setPaletteSlot(slot);
    renderPalette();
  });

  return li;
}

function renderPalette() {
  palResEl.textContent = "";
  palCustomEl.textContent = "";

  state.palette.forEach(function (entry, slot) {
    const li = makePaletteItem(entry, slot);
    if (slot < RESERVED_COUNT) palResEl.appendChild(li);
    else palCustomEl.appendChild(li);
  });

  palEmptyEl.style.display = state.palette.length > RESERVED_COUNT ? "none" : "";
  renderPaletteEditor();
}

function renderPaletteEditor() {
  palEditEl.textContent = "";
  const slot = paletteSlot;
  const entry = state.palette[slot];
  if (!entry) return;

  const isCustom = slot >= RESERVED_COUNT;

  function row(labelText, control) {
    const label = document.createElement("label");
    label.textContent = labelText;
    palEditEl.appendChild(label);
    palEditEl.appendChild(control);
  }

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = entry.name;
  nameInput.addEventListener("change", function () {
    const v = nameInput.value.trim();
    if (!v || v === entry.name) { nameInput.value = entry.name; return; }
    withUndo(function () {
      entry.name = v;
      markDirty();
    });
  });
  row("Name", nameInput);

  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.value = /^#[0-9a-f]{6}$/i.test(entry.color) ? entry.color : "#808080";
  /* The picker streams "input" events while it is being dragged. One
     snapshot is taken at the start of that stream and committed on "change",
     so a colour tweak is a single undo step rather than dozens. */
  let colorBefore = null;
  colorInput.addEventListener("input", function () {
    if (colorBefore === null) colorBefore = snapshot();
    entry.color = colorInput.value;
    drawEditor();
    scheduleSave();
  });
  colorInput.addEventListener("change", function () {
    const before = colorBefore;
    colorBefore = null;
    if (before !== null) pushSnapshotEntry(before, snapshot());
    markDirty();
  });
  row("Colour", colorInput);

  if (isCustom) {
    const walkWrap = document.createElement("div");
    const walk = document.createElement("input");
    walk.type = "checkbox";
    walk.checked = entry.passable;
    walk.id = "pal-passable";
    walk.addEventListener("change", function () {
      withUndo(function () {
        entry.passable = walk.checked;
        markDirty();
      });
    });
    const walkLabel = document.createElement("label");
    walkLabel.htmlFor = "pal-passable";
    walkLabel.textContent = " can be walked through";
    walkWrap.appendChild(walk);
    walkWrap.appendChild(walkLabel);
    row("Movement", walkWrap);

    const del = document.createElement("button");
    del.className = "full danger";
    del.textContent = "Delete this colour";
    del.addEventListener("click", function () { deletePaletteColor(slot); });
    palEditEl.appendChild(del);
  } else {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Reserved colour: its role and passability are fixed, " +
                       "but you can retint and rename it.";
    palEditEl.appendChild(hint);
  }
}



function refreshStats() {
  const o = isAnchored() ? anchorOrigin() : null;
  mapInfoEl.textContent =
    Object.keys(state.map.placements).length + " rooms  |  " +
    state.map.openEdges.size + " open walls  |  " +
    (o ? "bound at " + formatXZ(o.x, o.z) : "not bound to the world");
}

function refreshAll() {
  renderTemplateList();
  renderPalette();
  renderEditorHeader();
  renderMapTemplateList();
  updateMapBar();
  refreshStats();
  updateEditorFoot();
  updateHistoryButtons();
  drawEditor();
  drawMap();
}

/* ---------- Wiring ---------- */

document.querySelectorAll(".tab-btn").forEach(function (b) {
  b.addEventListener("click", function () { showTab(b.dataset.tab); });
});

document.querySelectorAll(".tool-btn").forEach(function (b) {
  b.addEventListener("click", function () { setTool(b.dataset.tool); });
});

document.getElementById("btn-new-template").addEventListener("click", addTemplate);
document.getElementById("btn-add-color").addEventListener("click", addPaletteColor);
document.getElementById("btn-rename").addEventListener("click", function () {
  if (selectedTemplateId) renameTemplate(selectedTemplateId);
});
document.getElementById("btn-undo").addEventListener("click", undo);
document.getElementById("btn-redo").addEventListener("click", redo);
document.getElementById("btn-zoom-fit").addEventListener("click", function () {
  fitView();
  updateEditorFoot();
  drawEditor();
});
document.getElementById("btn-zoom-1").addEventListener("click", function () {
  editor.view.scale = 8;
  centerView();
  updateEditorFoot();
  drawEditor();
});

document.getElementById("btn-map-doors").addEventListener("click", function () {
  setMapMode(mapUI.mode === "doors" ? "place" : "doors");
});
document.getElementById("btn-map-anchor").addEventListener("click", function () {
  setMapMode(mapUI.mode === "anchor" ? "place" : "anchor");
});
document.getElementById("btn-map-locate").addEventListener("click", locatePosition);
document.getElementById("btn-map-rotate").addEventListener("click", rotateAction);
document.getElementById("btn-map-mirror").addEventListener("click", mirrorAction);
document.getElementById("btn-map-delete").addEventListener("click", deleteSelection);
document.getElementById("btn-map-clear-brush").addEventListener("click", function () {
  mapUI.brush = null;
  mapUI.selected = null;
  renderMapTemplateList();
  updateMapBar();
  drawMap();
});
document.getElementById("btn-map-fit").addEventListener("click", function () {
  fitMapView();
  updateMapFoot();
  drawMap();
});
document.getElementById("btn-map-1").addEventListener("click", function () {
  mapUI.view.scale = 2;
  fitMapCenter();
  updateMapFoot();
  drawMap();
});

document.getElementById("btn-new").addEventListener("click", newDocument);
document.getElementById("btn-export").addEventListener("click", exportDocument);

const fileInput = document.getElementById("file-input");
document.getElementById("btn-import").addEventListener("click", function () {
  fileInput.click();
});
fileInput.addEventListener("change", function () {
  if (fileInput.files && fileInput.files[0]) importDocument(fileInput.files[0]);
  fileInput.value = "";
});

window.addEventListener("beforeunload", flushSave);

if (window.ResizeObserver) {
  new ResizeObserver(resizeCanvas).observe(wrapEl);
  new ResizeObserver(resizeMapCanvas).observe(mapWrapEl);
} else {
  window.addEventListener("resize", function () {
    resizeCanvas();
    resizeMapCanvas();
  });
}


/* ---------- Keyboard ---------- */

const TOOL_KEYS = { b: "pencil", r: "rect", g: "fill", i: "pick" };

window.addEventListener("keydown", function (ev) {
  const tag = ev.target && ev.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;

  if (ev.code === "Space" && !ev.repeat) {
    setSpaceHeld(true);
    ev.preventDefault();
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && !ev.altKey) {
    const k = ev.key.toLowerCase();
    if (k === "z" && !ev.shiftKey) { ev.preventDefault(); undo(); return; }
    if (k === "y" || (k === "z" && ev.shiftKey)) { ev.preventDefault(); redo(); return; }
  }
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

  const key = ev.key.toLowerCase();

  if (activeTab === "map") {
    if (key === "d") {
      ev.preventDefault();
      setMapMode(mapUI.mode === "doors" ? "place" : "doors");
      return;
    }
    if (key === "a") {
      ev.preventDefault();
      setMapMode(mapUI.mode === "anchor" ? "place" : "anchor");
      return;
    }
    if (key === "l") {
      ev.preventDefault();
      locatePosition();
      return;
    }
    if (key === "r") { ev.preventDefault(); rotateAction(); return; }
    if (key === "m") { ev.preventDefault(); mirrorAction(); return; }
    if (ev.key === "Delete" || ev.key === "Backspace") {
      ev.preventDefault();
      deleteSelection();
      return;
    }
    if (ev.key === "Escape") {
      if (mapUI.mode !== "place") { setMapMode("place"); return; }
      if (mapUI.marker) { mapUI.marker = null; drawMap(); return; }
      mapUI.selected = null;
      mapUI.brush = null;
      renderMapTemplateList();
      updateMapBar();
      drawMap();
      return;
    }
    return;
  }

  const tool = TOOL_KEYS[key];
  if (tool) {
    setTool(tool);
    return;
  }
  /* 1..5 pick the reserved colours. */
  const n = parseInt(ev.key, 10);
  if (n >= 1 && n <= RESERVED_COUNT) {
    setPaletteSlot(n - 1);
    renderPalette();
  }
});

window.addEventListener("keyup", function (ev) {
  if (ev.code === "Space") {
    setSpaceHeld(false);
    if (editor.drag && editor.drag.mode === "pan") endDrag(ev);
    if (mapUI.drag && mapUI.drag.mode === "pan") endMapDrag(ev);
  }
});


/* Late-bind the callbacks the lower layers reach the UI through. */
Object.assign(ui, {
  refreshAll: refreshAll,
  renderPalette: renderPalette,
  updateHistoryButtons: updateHistoryButtons,
  setStatus: setStatus,
  fitEditorView: fitView,
  askText: askText,
  askConfirm: askConfirm,
  showError: showError,
});

export {
  showTab,
  refreshAll,
  renderPalette,
  renderTemplateList,
  refreshStats,
  updateHistoryButtons,
  setStatus,
  activeTab,
};
