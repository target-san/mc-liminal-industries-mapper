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
         addPaletteColor, deletePaletteColor,
         rotateTemplateDefault, mirrorTemplateDefault } from './ops.js';
import { editor, wrapEl, resizeCanvas, fitView, centerView, drawEditor, setTool,
         renderEditorHeader, updateEditorFoot, endDrag } from './editor.js';
import { mapUI, mapWrapEl, resizeMapCanvas, drawMap, fitMapView, fitMapCenter,
         renderMapTemplateList, updateMapBar, updateMapFoot,
         rotateAction, mirrorAction, deleteSelection, setMapMode, toggleMapMode,
         renderMapSidebar, nameSelectedRoom, bookmarkSelectedRoom,
         locatePosition, mapRoomActionsLive, endMapDrag } from './mapview.js';
import { isAnchored, anchorOrigin, formatXZ } from './world.js';
import { sectionsOf, setExitGroup, clearExitGroups } from './sections.js';
import { ROOM_SIZE, ROOM_MAX, fromTemplate } from './geometry.js';
import { defaultRot, defaultMir } from './document.js';
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
  if (name === "rooms") {
    resizeCanvas();
    renderExitGroups();
    renderEditorHeader();
  }
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

/*
   Everything that depends on which template is being edited, refreshed in one
   place. Selection used to be changed inline by the list, which meant each
   new panel had to remember to add itself here -- the exits panel did not,
   and went stale the moment you picked a different room.
*/
function selectTemplate(id) {
  setSelectedTemplate(id);
  renderTemplateList();
  renderExitGroups();
  renderEditorHeader();
  updateEditorFoot();
  drawEditor();
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

    li.addEventListener("click", function () { selectTemplate(t.id); });

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

/*
   Browsers restore form control values on reload and on session restore, and
   fire input/change for the restored value as though the user had typed it.

   These controls are rebuilt on every render and bound to whichever palette
   entry is selected -- floor, at every boot, since that is what paletteSlot
   starts as. So a value restored from the last session was written straight
   into the floor entry and then autosaved: edit the wall colour, reopen the
   browser, and floor came back wearing it.

   autocomplete="off" asks browsers not to do this; they do not all listen.
   So the handlers additionally require evidence that the person actually
   touched the control before anything is written.
*/
function userDriven(el) {
  let touched = false;
  const mark = function () { touched = true; };
  el.setAttribute("autocomplete", "off");
  el.addEventListener("pointerdown", mark);
  el.addEventListener("keydown", mark);
  return function () { return touched; };
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
  const nameTouched = userDriven(nameInput);
  nameInput.addEventListener("change", function () {
    if (!nameTouched()) { nameInput.value = entry.name; return; }
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
  /*
     A colour input can only hold #rrggbb. Anything else shows as grey, and
     the first event would then write that grey back over a colour nobody
     asked to change -- so the write is gated on the input actually holding a
     value the user produced.
  */
  const shown = /^#[0-9a-f]{6}$/i.test(entry.color) ? entry.color.toLowerCase() : null;
  colorInput.value = shown || "#808080";
  const colorTouched = userDriven(colorInput);

  /* The picker streams "input" events while it is being dragged. One
     snapshot is taken at the start of that stream and committed on "change",
     so a colour tweak is a single undo step rather than dozens. */
  let colorBefore = null;
  colorInput.addEventListener("input", function () {
    if (!colorTouched()) { colorInput.value = shown || "#808080"; return; }
    const next = colorInput.value;
    if (!/^#[0-9a-f]{6}$/i.test(next)) return;
    if (shown === null && next === "#808080") return;   // the placeholder, not a choice
    if (next === entry.color) return;
    if (colorBefore === null) colorBefore = snapshot();
    entry.color = next;
    drawEditor();
    scheduleSave();
  });
  colorInput.addEventListener("change", function () {
    if (!colorTouched()) { colorInput.value = shown || "#808080"; return; }
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
    const walkTouched = userDriven(walk);
    walk.addEventListener("change", function () {
      if (!walkTouched()) { walk.checked = entry.passable; return; }
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



const SIDE_NAMES = { N: "North", E: "East", S: "South", W: "West" };
const SIDE_ORDER = { N: 0, E: 1, S: 2, W: 3 };
const GROUP_LETTERS = "ABCDEFGH";

/*
   Which edge of the canvas a doorway appears on, once the room's placement
   orientation has been applied. Doorways belong to the room, so they turn
   with it -- unlike the rulers, which measure the drawing board and stay put.

   Run indices stay in template order regardless: exitGroups is stored against
   them, so only the labelling and the row order follow the display.
*/
function displayedRun(t, run, index) {
  const cell = run.tiles[0];
  const at = fromTemplate((cell / ROOM_SIZE) | 0, cell % ROOM_SIZE,
                          defaultRot(t), defaultMir(t));
  let side;
  if (at.r === 0) side = "N";
  else if (at.r === ROOM_MAX) side = "S";
  else if (at.c === 0) side = "W";
  else side = "E";
  return {
    run: run,
    index: index,
    side: side,
    along: side === "N" || side === "S" ? at.c : at.r,
  };
}

/*
   One row per doorway, showing which group it belongs to. Clicking a group
   cycles it, including onto a group of its own -- which is how a room whose
   plan view cannot show its own disjointness gets told the truth.
*/
function renderExitGroups() {
  const box = document.getElementById("exit-groups");
  box.textContent = "";

  const t = currentTemplate();
  if (!t) return;

  const info = sectionsOf(t);
  if (!info.runs.length) {
    const note = document.createElement("div");
    note.className = "exit-note";
    note.textContent = "This room has no doorways.";
    box.appendChild(note);
    return;
  }

  const rows = info.runs.map(function (run, i) { return displayedRun(t, run, i); });
  rows.sort(function (a, b) {
    return SIDE_ORDER[a.side] - SIDE_ORDER[b.side] || a.along - b.along;
  });

  const perSide = {};
  rows.forEach(function (d) { perSide[d.side] = (perSide[d.side] || 0) + 1; });
  const usedOnSide = {};

  rows.forEach(function (d) {
    const run = d.run;
    const i = d.index;
    usedOnSide[d.side] = (usedOnSide[d.side] || 0) + 1;

    const row = document.createElement("div");
    row.className = "exit-row";

    const name = document.createElement("span");
    name.textContent = SIDE_NAMES[d.side] +
      (perSide[d.side] > 1 ? " " + usedOnSide[d.side] : "") +
      "  (" + run.tiles.length + " tiles)";
    row.appendChild(name);

    const btn = document.createElement("button");
    btn.className = "group-btn g" + (run.group % 4);
    btn.textContent = GROUP_LETTERS[run.group] || String(run.group);
    btn.title = "Which part of the room this doorway opens into. " +
                "Click to move it to another group.";
    btn.addEventListener("click", function () {
      /* Resolved at click time, not at render time: if this panel is showing
         a room that is no longer the selected one, do nothing rather than
         quietly regroup the doorways of some other room. */
      const live = currentTemplate();
      if (!live || live.id !== t.id) {
        renderExitGroups();
        return;
      }
      /* One past the current count, so a doorway can always be split off. */
      setExitGroup(live, i, (run.group + 1) % (info.count + 1));
    });
    row.appendChild(btn);

    box.appendChild(row);
  });

  const note = document.createElement("div");
  note.className = "exit-note";
  note.textContent = info.count === 1
    ? "All doorways connect to each other."
    : info.count + " separate parts; routes never cross between them.";
  box.appendChild(note);

  if (info.manual) {
    const reset = document.createElement("button");
    reset.style.width = "100%";
    reset.style.marginTop = "6px";
    reset.textContent = "Back to automatic";
    reset.title = "Work the groups out from the painting again";
    reset.addEventListener("click", function () { clearExitGroups(t); });
    box.appendChild(reset);
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
  renderExitGroups();
  renderEditorHeader();
  renderMapSidebar();
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
document.getElementById("btn-tpl-rotate").addEventListener("click", function () {
  if (selectedTemplateId) rotateTemplateDefault(selectedTemplateId);
});
document.getElementById("btn-tpl-mirror").addEventListener("click", function () {
  if (selectedTemplateId) mirrorTemplateDefault(selectedTemplateId);
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
  toggleMapMode("doors");
});
document.getElementById("btn-map-anchor").addEventListener("click", function () {
  toggleMapMode("anchor");
});
document.getElementById("btn-map-locate").addEventListener("click", locatePosition);
document.getElementById("btn-map-route").addEventListener("click", function () {
  toggleMapMode("route");
});
document.getElementById("btn-map-rotate").addEventListener("click", rotateAction);
document.getElementById("btn-map-mirror").addEventListener("click", mirrorAction);
document.getElementById("btn-map-delete").addEventListener("click", deleteSelection);
document.getElementById("btn-map-add-room").addEventListener("click", function () {
  setMapMode("place");
});
document.getElementById("btn-map-cancel-add").addEventListener("click", function () {
  setMapMode("select");
});
document.getElementById("btn-map-name").addEventListener("click", nameSelectedRoom);
document.getElementById("btn-map-bookmark").addEventListener("click", bookmarkSelectedRoom);
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
    if (key === "d") { ev.preventDefault(); toggleMapMode("doors"); return; }
    if (key === "a") { ev.preventDefault(); toggleMapMode("anchor"); return; }
    if (key === "l") {
      ev.preventDefault();
      /* Off until a tile has been bound, matching the button. */
      if (isAnchored()) locatePosition();
      return;
    }
    if (key === "f") { ev.preventDefault(); toggleMapMode("route"); return; }
    /* The per-room shortcuts are live exactly where their buttons are. */
    if (mapRoomActionsLive()) {
      if (key === "n") { ev.preventDefault(); nameSelectedRoom(); return; }
      if (key === "b") { ev.preventDefault(); bookmarkSelectedRoom(); return; }
    }
    if (mapRoomActionsLive()) {
      if (key === "r") { ev.preventDefault(); rotateAction(); return; }
      if (key === "m") { ev.preventDefault(); mirrorAction(); return; }
      if (ev.key === "Delete" || ev.key === "Backspace") {
        ev.preventDefault();
        deleteSelection();
        return;
      }
    }
    if (ev.key === "Escape") {
      /* Escape unwinds one step at a time: out of a mode, then the located
         position marker, then the selection. */
      if (mapUI.mode !== "select") { setMapMode("select"); return; }
      if (mapUI.marker) { mapUI.marker = null; drawMap(); return; }
      mapUI.selected = null;
      renderMapSidebar();
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
  selectTemplate,
  renderExitGroups,
  refreshAll,
  renderPalette,
  renderTemplateList,
  refreshStats,
  updateHistoryButtons,
  setStatus,
  activeTab,
};
