/*
   The room editor canvas: painting, rulers and the hover cursor.
*/

import { ROOM_SIZE, ROOM_MAX, CELL_COUNT, cellIndex, isBoundary,
         LAMP_LINES, LAMP_STEP, CENTER_TILE } from './geometry.js';
import { canPaint, defaultSlotAt, invertColor, SLOT_VOID } from './palette.js';
import { state, currentTemplate, paletteSlot, setPaletteSlot } from './store.js';
import { scheduleSave } from './storage.js';
import { beginStroke, endStroke } from './history.js';
import { dpr, setDpr, spaceHeld } from './screen.js';
import { paintCell, paintLine, paintRect, floodFill, slotChooser } from './paint.js';
import { sectionsOf } from './sections.js';
import { defaultRot, defaultMir } from './document.js';
import { ui } from './hooks.js';

const editorName  = document.getElementById("editor-name");
const editorPos   = document.getElementById("editor-pos");
const editorCell  = document.getElementById("editor-cell");
const editorZoom  = document.getElementById("editor-zoom");

function setTool(tool) {
  editor.tool = tool;
  document.querySelectorAll(".tool-btn").forEach(function (b) {
    b.classList.toggle("on", b.dataset.tool === tool);
  });
}

/* ============================================================
   Room editor
   ============================================================ */

const editor = {
  view: { scale: 8, ox: 0, oy: 0 },   // px per tile, and room origin in CSS px
  tool: "pencil",
  hover: null,                       // { r, c }
  drag: null,                        // active pointer gesture
};

const MIN_SCALE = 1;
const MAX_SCALE = 40;

const RULER_SIZE = 18;              // px band drawn just outside the room
const RULER_FONT = "11px ui-monospace, SFMono-Regular, Menlo, monospace";



const wrapEl   = document.getElementById("editor-wrap");
const canvasEl = document.getElementById("editor-canvas");
const ctx      = canvasEl.getContext("2d");

let canvasW = 0, canvasH = 0;

/* Cleared by the first measurement worth fitting to. See resizeCanvas. */
let needsFit = true;

function resizeCanvas() {
  setDpr(window.devicePixelRatio || 1);
  const rect = wrapEl.getBoundingClientRect();

  /* A hidden panel measures zero. Keeping the last good size means a trip to
     the map tab does not collapse the view on the way back. */
  if (!rect.width || !rect.height) return;

  canvasW = rect.width;
  canvasH = rect.height;
  canvasEl.width  = Math.max(1, Math.round(canvasW * dpr));
  canvasEl.height = Math.max(1, Math.round(canvasH * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  /*
     Fit to the first real measurement rather than to whatever the box
     happened to be during boot. An embedded browser can report a tiny or
     zero-height container on its first layout pass, and a fit computed
     against that leaves the room stranded small in a corner with nothing
     ever recomputing it. Only the first one refits, so a zoom you chose
     yourself survives every later resize.
  */
  if (needsFit) {
    needsFit = false;
    fitView();
  }

  drawEditor();
}

function fitView() {
  if (!canvasW || !canvasH) return;
  /* Leave room for the rulers and their labels on both sides. */
  const pad = (RULER_SIZE + 10) * 2;
  const avail = Math.max(ROOM_SIZE, Math.min(canvasW, canvasH) - pad);
  editor.view.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, avail / ROOM_SIZE));
  centerView();
}

function centerView() {
  const span = ROOM_SIZE * editor.view.scale;
  editor.view.ox = (canvasW - span) / 2;
  editor.view.oy = (canvasH - span) / 2;
}

function tileAt(px, py) {
  const v = editor.view;
  const c = Math.floor((px - v.ox) / v.scale);
  const r = Math.floor((py - v.oy) / v.scale);
  if (r < 0 || c < 0 || r >= ROOM_SIZE || c >= ROOM_SIZE) return null;
  return { r: r, c: c };
}

/* ---------- Drawing ---------- */

function drawEditor() {
  const t = currentTemplate();
  const hasTemplate = !!t;
  wrapEl.style.display = hasTemplate ? "" : "none";
  document.getElementById("editor-bar").style.display = hasTemplate ? "" : "none";
  document.getElementById("editor-empty").style.display = hasTemplate ? "none" : "";
  if (!hasTemplate) return;

  const v = editor.view;
  const s = v.scale;

  ctx.fillStyle = "#101317";
  ctx.fillRect(0, 0, canvasW, canvasH);

  /* Cells. Edges are snapped to the *device* pixel grid, not the CSS one.
     The context is scaled by devicePixelRatio, so a whole CSS pixel lands
     between device pixels whenever the ratio is fractional (1.25, 1.5, ...).
     Two neighbouring fillRects then both antialias against that shared edge
     and roughly a fifth of the backdrop survives between them, which reads
     as a one pixel border around every tile. */
  const colX = new Array(ROOM_SIZE + 1);
  const rowY = new Array(ROOM_SIZE + 1);
  for (let i = 0; i <= ROOM_SIZE; i++) {
    colX[i] = Math.round((v.ox + i * s) * dpr) / dpr;
    rowY[i] = Math.round((v.oy + i * s) * dpr) / dpr;
  }

  for (let r = 0; r < ROOM_SIZE; r++) {
    const y = rowY[r];
    const h = rowY[r + 1] - y;
    if (y + h < 0 || y > canvasH) continue;
    for (let c = 0; c < ROOM_SIZE; c++) {
      const x = colX[c];
      const w = colX[c + 1] - x;
      if (x + w < 0 || x > canvasW) continue;
      const entry = state.palette[t.cells[cellIndex(r, c)]] || state.palette[SLOT_VOID];
      ctx.fillStyle = entry.color;
      ctx.fillRect(x, y, w, h);
    }
  }

  /* No tile grid: at this density the lines drown out the colours. Tile
     counting is done off the rulers instead. Only the room outline stays,
     to separate the room from the backdrop. */
  ctx.strokeStyle = "rgba(255,255,255,0.28)";
  ctx.lineWidth = 1;
  ctx.strokeRect(colX[0] + 0.5, rowY[0] + 0.5,
                 colX[ROOM_SIZE] - colX[0] - 1, rowY[ROOM_SIZE] - rowY[0] - 1);

  /* Rectangle tool preview. */
  const drag = editor.drag;
  if (drag && drag.mode === "rect" && drag.current) {
    const r0 = Math.min(drag.start.r, drag.current.r);
    const r1 = Math.max(drag.start.r, drag.current.r);
    const c0 = Math.min(drag.start.c, drag.current.c);
    const c1 = Math.max(drag.start.c, drag.current.c);
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = state.palette[drag.slot].color;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (!canPaint(r, c, state.palette[drag.slot])) continue;
        ctx.fillRect(colX[c], rowY[r], colX[c + 1] - colX[c], rowY[r + 1] - rowY[r]);
      }
    }
    ctx.restore();
    ctx.strokeStyle = "#7aa2f7";
    ctx.strokeRect(colX[c0] + 0.5, rowY[r0] + 0.5,
                   colX[c1 + 1] - colX[c0] - 1, rowY[r1 + 1] - rowY[r0] - 1);
  }

  drawRulers(colX, rowY, s);
  drawHover(colX, rowY, s, t);
}

/* ---------- Rulers ----------
   Drawn just outside the room so they pan and zoom with it. Ticks sit on the
   ceiling lamp rows and columns, which is the grid rooms are actually built
   against. The centre lamp is singled out by the colour of its number alone,
   with no marker line: a line there would just overdraw the number. */

function drawRulers(colX, rowY, s) {
  const x0 = colX[0], x1 = colX[ROOM_SIZE];
  const y0 = rowY[0], y1 = rowY[ROOM_SIZE];

  ctx.fillStyle = "#181c22";
  ctx.fillRect(x0 - RULER_SIZE, y0 - RULER_SIZE, (x1 - x0) + RULER_SIZE, RULER_SIZE);
  ctx.fillRect(x0 - RULER_SIZE, y0 - RULER_SIZE, RULER_SIZE, (y1 - y0) + RULER_SIZE);

  /* A lamp every LAMP_STEP tiles: ticks turn to mush below a few pixels of
     spacing, and labels need roughly 24px before they start colliding. */
  const lampPx     = LAMP_STEP * s;
  const showTicks  = lampPx >= 4;
  const labelEvery = lampPx >= 24 ? 1 : lampPx >= 12 ? 2 : lampPx >= 8 ? 5 : 0;

  /* Room outline ticks, so the wall ring is locatable at any zoom. */
  ctx.strokeStyle = "#39404d";
  ctx.lineWidth = 1;
  ctx.beginPath();
  [0, ROOM_SIZE].forEach(function (i) {
    ctx.moveTo(colX[i] + 0.5, y0 - RULER_SIZE); ctx.lineTo(colX[i] + 0.5, y0);
    ctx.moveTo(x0 - RULER_SIZE, rowY[i] + 0.5); ctx.lineTo(x0, rowY[i] + 0.5);
  });
  ctx.stroke();

  /* Lamp ticks are centred on the lamp tile, not on a tile boundary. */
  if (showTicks) {
    ctx.strokeStyle = "#4a5160";
    ctx.beginPath();
    for (let k = 0; k < LAMP_LINES.length; k++) {
      const i = LAMP_LINES[k];
      const x = Math.round((colX[i] + colX[i + 1]) / 2) + 0.5;
      const y = Math.round((rowY[i] + rowY[i + 1]) / 2) + 0.5;
      ctx.moveTo(x, y0 - 5);  ctx.lineTo(x, y0);
      ctx.moveTo(x0 - 5, y);  ctx.lineTo(x0, y);
    }
    ctx.stroke();
  }

  if (labelEvery) {
    ctx.font = RULER_FONT;
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#8b93a1";
    for (let k = 0; k < LAMP_LINES.length; k++) {
      const i = LAMP_LINES[k];
      /* The centre lamp is always labelled, however far the rest are thinned. */
      if (k % labelEvery && i !== CENTER_TILE) continue;
      const x = (colX[i] + colX[i + 1]) / 2;
      const y = (rowY[i] + rowY[i + 1]) / 2;
      ctx.fillStyle = i === CENTER_TILE ? "#7aa2f7" : "#8b93a1";
      ctx.textAlign = "center";
      ctx.fillText(String(i), x, y0 - RULER_SIZE / 2);
      ctx.textAlign = "right";
      ctx.fillText(String(i), x0 - 6, y);
    }
  }

}

/* ---------- Hover cursor ----------
   The frame is stroked entirely outside the tile, in the tile colour's
   negative, so neither the mouse cursor nor the frame hides what is being
   painted. Guide lines run out to the rulers with the coordinates at their
   ends. */

function drawRulerChip(text, cx, cy) {
  ctx.font = RULER_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const w = Math.max(15, ctx.measureText(text).width + 8);
  ctx.fillStyle = "#7aa2f7";
  ctx.fillRect(Math.round(cx - w / 2), Math.round(cy) - 8, Math.round(w), 16);
  ctx.fillStyle = "#0d1117";
  ctx.fillText(text, Math.round(cx), Math.round(cy));
}

function drawHover(colX, rowY, s, t) {
  const h = editor.hover;
  if (!h) return;

  const x0 = colX[0], y0 = rowY[0];
  const hx = colX[h.c], hx2 = colX[h.c + 1];
  const hy = rowY[h.r], hy2 = rowY[h.r + 1];
  const midX = Math.round((hx + hx2) / 2) + 0.5;
  const midY = Math.round((hy + hy2) / 2) + 0.5;

  ctx.strokeStyle = "rgba(122,162,247,0.6)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0 - RULER_SIZE, midY); ctx.lineTo(hx, midY);
  ctx.moveTo(midX, y0 - RULER_SIZE); ctx.lineTo(midX, hy);
  ctx.stroke();

  drawRulerChip(String(h.r), x0 - RULER_SIZE / 2, midY);
  drawRulerChip(String(h.c), midX, y0 - RULER_SIZE / 2);

  const entry = state.palette[t.cells[cellIndex(h.r, h.c)]] || state.palette[SLOT_VOID];
  const lw = Math.max(2, Math.min(4, s * 0.22));
  ctx.strokeStyle = invertColor(entry.color);
  ctx.lineWidth = lw;
  ctx.strokeRect(hx - lw / 2, hy - lw / 2, (hx2 - hx) + lw, (hy2 - hy) + lw);
}

/* ---------- Pointer handling ---------- */

function pointerPos(ev) {
  const rect = canvasEl.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}


canvasEl.addEventListener("contextmenu", function (ev) { ev.preventDefault(); });

canvasEl.addEventListener("pointerdown", function (ev) {
  const t = currentTemplate();
  if (!t) return;
  canvasEl.setPointerCapture(ev.pointerId);
  const p = pointerPos(ev);

  /* Right and middle drag both pan, as does holding space. */
  const wantPan = ev.button === 1 || ev.button === 2 || spaceHeld;
  if (wantPan) {
    editor.drag = { mode: "pan", lastX: p.x, lastY: p.y };
    wrapEl.classList.add("panning");
    ev.preventDefault();
    return;
  }
  if (ev.button !== 0) return;

  const tile = tileAt(p.x, p.y);
  if (!tile) return;
  /* Erase moved to shift-drag when the right button became a pan gesture. */
  const erase = ev.shiftKey;

  if (editor.tool === "pick") {
    setPaletteSlot(t.cells[cellIndex(tile.r, tile.c)]);
    ui.renderPalette();
    drawEditor();
    return;
  }

  if (editor.tool === "rect") {
    editor.drag = {
      mode: "rect", start: tile, current: tile,
      erase: erase, slot: erase ? defaultSlotAt(tile.r, tile.c) : paletteSlot,
    };
    drawEditor();
    return;
  }

  const slotFor = slotChooser(erase, paletteSlot);
  let changed;
  beginStroke(t);
  if (editor.tool === "fill") {
    changed = floodFill(t, tile.r, tile.c, slotFor(tile.r, tile.c));
    editor.drag = { mode: "none" };
    endStroke();
  } else {
    changed = paintCell(t, tile.r, tile.c, slotFor(tile.r, tile.c));
    editor.drag = { mode: "paint", last: tile, erase: erase };
  }
  if (changed) scheduleSave();
  drawEditor();
});

canvasEl.addEventListener("pointermove", function (ev) {
  const t = currentTemplate();
  if (!t) return;
  const p = pointerPos(ev);
  const drag = editor.drag;

  if (drag && drag.mode === "pan") {
    editor.view.ox += p.x - drag.lastX;
    editor.view.oy += p.y - drag.lastY;
    drag.lastX = p.x;
    drag.lastY = p.y;
    drawEditor();
    return;
  }

  const tile = tileAt(p.x, p.y);
  editor.hover = tile;
  updateEditorFoot();

  if (drag && drag.mode === "paint" && tile) {
    const slotFor = slotChooser(drag.erase, paletteSlot);
    if (paintLine(t, drag.last, tile, slotFor)) scheduleSave();
    drag.last = tile;
  } else if (drag && drag.mode === "rect" && tile) {
    drag.current = tile;
  }
  drawEditor();
});

function endDrag(ev) {
  const t = currentTemplate();
  const drag = editor.drag;
  editor.drag = null;
  wrapEl.classList.remove("panning");
  if (!t || !drag) return;

  if (drag.mode === "rect" && drag.current) {
    const slotFor = slotChooser(drag.erase, paletteSlot);
    beginStroke(t);
    if (paintRect(t, drag.start, drag.current, slotFor)) scheduleSave();
    endStroke();
  } else if (drag.mode === "paint") {
    endStroke();
  }
  drawEditor();
}

canvasEl.addEventListener("pointerup", endDrag);
canvasEl.addEventListener("pointercancel", endDrag);

canvasEl.addEventListener("pointerleave", function () {
  editor.hover = null;
  updateEditorFoot();
  drawEditor();
});

canvasEl.addEventListener("wheel", function (ev) {
  if (!currentTemplate()) return;
  ev.preventDefault();
  const p = pointerPos(ev);
  const v = editor.view;
  const factor = Math.exp(-ev.deltaY * 0.0015);
  const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * factor));
  if (next === v.scale) return;
  /* Keep the tile under the cursor pinned in place. */
  v.ox = p.x - (p.x - v.ox) * (next / v.scale);
  v.oy = p.y - (p.y - v.oy) * (next / v.scale);
  v.scale = next;
  updateEditorFoot();
  drawEditor();
}, { passive: false });



function renderEditorHeader() {
  const t = currentTemplate();
  editorName.textContent = t ? t.name : "-";
  document.getElementById("btn-rename").disabled = !t;

  /* The orientation new placements of this room start from. The painting
     itself is never turned, so rooms already on the map are unaffected. */
  const orient = document.getElementById("editor-orient");
  if (orient) {
    orient.textContent = t
      ? (defaultRot(t) * 90) + " deg" + (defaultMir(t) ? ", mirrored" : "")
      : "-";
  }
  document.getElementById("btn-tpl-rotate").disabled = !t;
  document.getElementById("btn-tpl-mirror").disabled = !t;

  /*
     A room in more than one piece is legitimate, so this states a fact rather
     than raising an alarm: routing keeps the pieces apart on its own.
  */
  const warn = document.getElementById("editor-warn");
  if (!warn) return;
  if (!t) {
    warn.textContent = "";
    return;
  }
  const info = sectionsOf(t);
  warn.textContent = info.count > 1
    ? info.count + " exit groups" + (info.manual ? " (set by hand)" : "")
    : "";
}

function updateEditorFoot() {
  const t = currentTemplate();
  const h = editor.hover;
  if (h && t) {
    editorPos.textContent = "tile " + h.r + ", " + h.c +
      (isBoundary(h.r, h.c) ? " (boundary)" : "");
    const entry = state.palette[t.cells[cellIndex(h.r, h.c)]];
    editorCell.textContent = entry ? entry.name : "";
  } else {
    editorPos.textContent = "tile -, -";
    editorCell.textContent = "";
  }
  editorZoom.textContent = editor.view.scale.toFixed(1) + " px/tile @ " +
                           dpr.toFixed(2) + "x";
}

export {
  editor,
  wrapEl,
  MIN_SCALE,
  MAX_SCALE,
  resizeCanvas,
  fitView,
  centerView,
  tileAt,
  drawEditor,
  setTool,
  renderEditorHeader,
  updateEditorFoot,
  endDrag,
};
