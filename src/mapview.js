/*
   The map canvas: placement, orientation and the room bitmap cache.
*/

import { ROOM_SIZE, GRID_PITCH, CELL_COUNT, cellIndex, toTemplate,
         applyPlacementTransform, placementKey } from './geometry.js';
import { parseHexColor } from './palette.js';
import { state, templateBitmaps } from './store.js';
import { markDirty } from './storage.js';
import { withUndo } from './history.js';
import { dpr, setDpr, spaceHeld } from './screen.js';

/* ============================================================
   Map
   ------------------------------------------------------------
   Grid cell (gx, gy) starts at global tile (gx * 46, gy * 46) and covers 47
   tiles, so neighbours overlap on exactly the wall tile they share. Rooms are
   blitted from a cached one-pixel-per-tile bitmap through the placement
   transform, which keeps redraws cheap however many rooms are down.
   ============================================================ */

const MIN_MAP_SCALE = 0.08;
const MAX_MAP_SCALE = 12;

const mapUI = {
  view: { scale: 2, ox: 0, oy: 0 },
  brush: null,        // templateId being placed
  rot: 0,             // orientation applied to the next placement
  mir: false,
  selected: null,     // placement key
  hover: null,        // { gx, gy }
  drag: null,
};

const mapWrapEl   = document.getElementById("map-wrap");
const mapCanvasEl = document.getElementById("map-canvas");
const mctx        = mapCanvasEl.getContext("2d");

let mapW = 0, mapH = 0;

function resizeMapCanvas() {
  const rect = mapWrapEl.getBoundingClientRect();
  if (!rect.width || !rect.height) return;   // panel is hidden
  mapW = rect.width;
  mapH = rect.height;
  mapCanvasEl.width  = Math.max(1, Math.round(mapW * dpr));
  mapCanvasEl.height = Math.max(1, Math.round(mapH * dpr));
  mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawMap();
}

/* ---------- Bitmap cache ---------- */

function templateBitmap(id) {
  const cached = templateBitmaps.get(id);
  if (cached) return cached;
  const t = state.templates.find(function (x) { return x.id === id; });
  if (!t) return null;

  const cv = document.createElement("canvas");
  cv.width = ROOM_SIZE;
  cv.height = ROOM_SIZE;
  const g = cv.getContext("2d");
  const img = g.createImageData(ROOM_SIZE, ROOM_SIZE);
  const data = img.data;

  const rgb = state.palette.map(function (e) { return parseHexColor(e.color); });
  const fallback = [255, 0, 255];
  for (let i = 0; i < CELL_COUNT; i++) {
    const c = rgb[t.cells[i]] || fallback;
    const o = i * 4;
    data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  templateBitmaps.set(id, cv);
  return cv;
}

/* ---------- View ---------- */

function mapCellAt(px, py) {
  const pitch = GRID_PITCH * mapUI.view.scale;
  return {
    gx: Math.floor((px - mapUI.view.ox) / pitch),
    gy: Math.floor((py - mapUI.view.oy) / pitch),
  };
}

function globalTileAt(px, py) {
  const s = mapUI.view.scale;
  return {
    u: Math.floor((px - mapUI.view.ox) / s),
    v: Math.floor((py - mapUI.view.oy) / s),
  };
}

function mapBounds() {
  const keys = Object.keys(state.map.placements);
  if (!keys.length) return { gx0: 0, gy0: 0, gx1: 0, gy1: 0, empty: true };
  let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
  keys.forEach(function (k) {
    const parts = k.split(",");
    const gx = parseInt(parts[0], 10), gy = parseInt(parts[1], 10);
    if (gx < gx0) gx0 = gx;
    if (gy < gy0) gy0 = gy;
    if (gx > gx1) gx1 = gx;
    if (gy > gy1) gy1 = gy;
  });
  return { gx0: gx0, gy0: gy0, gx1: gx1, gy1: gy1, empty: false };
}

/* Recentres on the placed rooms without touching the zoom level. */
function fitMapCenter() {
  if (!mapW || !mapH) return;
  const b = mapBounds();
  const cu = b.gx0 * GRID_PITCH + ((b.gx1 - b.gx0 + 1) * GRID_PITCH + 1) / 2;
  const cv = b.gy0 * GRID_PITCH + ((b.gy1 - b.gy0 + 1) * GRID_PITCH + 1) / 2;
  mapUI.view.ox = mapW / 2 - cu * mapUI.view.scale;
  mapUI.view.oy = mapH / 2 - cv * mapUI.view.scale;
}

function fitMapView() {
  if (!mapW || !mapH) return;
  const b = mapBounds();
  /* Span in tiles: the cells' pitch plus the one extra tile the last room
     contributes beyond its own cell. */
  const spanU = (b.gx1 - b.gx0 + 1) * GRID_PITCH + 1;
  const spanV = (b.gy1 - b.gy0 + 1) * GRID_PITCH + 1;
  const s = Math.min((mapW - 40) / spanU, (mapH - 40) / spanV);
  mapUI.view.scale = Math.max(MIN_MAP_SCALE, Math.min(MAX_MAP_SCALE, s));
  const cu = b.gx0 * GRID_PITCH + spanU / 2;
  const cv = b.gy0 * GRID_PITCH + spanV / 2;
  mapUI.view.ox = mapW / 2 - cu * mapUI.view.scale;
  mapUI.view.oy = mapH / 2 - cv * mapUI.view.scale;
}

/* ---------- Drawing ---------- */

function blitRoom(g, gx, gy, placement, alpha) {
  const bmp = templateBitmap(placement.templateId);
  if (!bmp) return;
  const s = mapUI.view.scale;
  const pitch = GRID_PITCH * s;
  g.save();
  if (alpha !== undefined) g.globalAlpha = alpha;
  g.translate(mapUI.view.ox + gx * pitch, mapUI.view.oy + gy * pitch);
  g.scale(s, s);
  applyPlacementTransform(g, placement.rot, placement.mir);
  g.drawImage(bmp, 0, 0);
  g.restore();
}

function roomScreenRect(gx, gy) {
  const s = mapUI.view.scale;
  const pitch = GRID_PITCH * s;
  return {
    x: mapUI.view.ox + gx * pitch,
    y: mapUI.view.oy + gy * pitch,
    w: ROOM_SIZE * s,
    h: ROOM_SIZE * s,
  };
}

function drawMap() {
  if (!mapW || !mapH) return;
  if (mapUI.selected && !state.map.placements[mapUI.selected]) mapUI.selected = null;

  const s = mapUI.view.scale;
  const pitch = GRID_PITCH * s;

  mctx.fillStyle = "#101317";
  mctx.fillRect(0, 0, mapW, mapH);

  /* Below one pixel per tile, nearest neighbour drops whole walls and thin
     passages out of the picture, so smoothing is turned on to let them fade
     instead of vanishing. */
  mctx.imageSmoothingEnabled = s < 1;

  /* Empty grid, so free slots are visible. Skipped once cells get too small
     for the lines to mean anything. */
  if (pitch >= 8) {
    const gx0 = Math.floor((0 - mapUI.view.ox) / pitch);
    const gx1 = Math.ceil((mapW - mapUI.view.ox) / pitch);
    const gy0 = Math.floor((0 - mapUI.view.oy) / pitch);
    const gy1 = Math.ceil((mapH - mapUI.view.oy) / pitch);
    mctx.strokeStyle = "rgba(255,255,255,0.07)";
    mctx.lineWidth = 1;
    mctx.beginPath();
    for (let gx = gx0; gx <= gx1; gx++) {
      const x = Math.round(mapUI.view.ox + gx * pitch) + 0.5;
      mctx.moveTo(x, 0); mctx.lineTo(x, mapH);
    }
    for (let gy = gy0; gy <= gy1; gy++) {
      const y = Math.round(mapUI.view.oy + gy * pitch) + 0.5;
      mctx.moveTo(0, y); mctx.lineTo(mapW, y);
    }
    mctx.stroke();
  }

  /* Rooms. */
  Object.keys(state.map.placements).forEach(function (key) {
    const parts = key.split(",");
    const gx = parseInt(parts[0], 10), gy = parseInt(parts[1], 10);
    const rect = roomScreenRect(gx, gy);
    if (rect.x > mapW || rect.y > mapH || rect.x + rect.w < 0 || rect.y + rect.h < 0) return;
    blitRoom(mctx, gx, gy, state.map.placements[key]);
  });

  /* Ghost of what the brush would drop on the hovered slot. */
  const h = mapUI.hover;
  if (h && mapUI.brush && !state.map.placements[placementKey(h.gx, h.gy)]) {
    blitRoom(mctx, h.gx, h.gy,
             { templateId: mapUI.brush, rot: mapUI.rot, mir: mapUI.mir }, 0.45);
    const rect = roomScreenRect(h.gx, h.gy);
    mctx.strokeStyle = "rgba(122,162,247,0.8)";
    mctx.lineWidth = 1;
    mctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
  } else if (h) {
    const rect = roomScreenRect(h.gx, h.gy);
    mctx.strokeStyle = "rgba(255,255,255,0.3)";
    mctx.lineWidth = 1;
    mctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
  }

  /* Selection. */
  if (mapUI.selected) {
    const parts = mapUI.selected.split(",");
    const rect = roomScreenRect(parseInt(parts[0], 10), parseInt(parts[1], 10));
    mctx.strokeStyle = "#7aa2f7";
    mctx.lineWidth = 2;
    mctx.strokeRect(rect.x - 1, rect.y - 1, rect.w + 2, rect.h + 2);
  }
}

/* ---------- Editing ---------- */

function selectedPlacement() {
  if (!mapUI.selected) return null;
  return state.map.placements[mapUI.selected] || null;
}

function placeRoom(gx, gy) {
  if (!mapUI.brush) return;
  const key = placementKey(gx, gy);
  if (state.map.placements[key]) return;
  if (!state.templates.some(function (t) { return t.id === mapUI.brush; })) return;
  withUndo(function () {
    state.map.placements[key] = {
      templateId: mapUI.brush, rot: mapUI.rot, mir: mapUI.mir,
    };
    mapUI.selected = key;
    markDirty();
  });
}

/* Rotate and Mirror act on the selected room, or set the orientation for the
   next placement when nothing is selected. */
function rotateAction() {
  const p = selectedPlacement();
  if (p) {
    withUndo(function () { p.rot = (p.rot + 1) & 3; markDirty(); });
  } else {
    mapUI.rot = (mapUI.rot + 1) & 3;
    updateMapBar();
    drawMap();
  }
}

function mirrorAction() {
  const p = selectedPlacement();
  if (p) {
    withUndo(function () { p.mir = !p.mir; markDirty(); });
  } else {
    mapUI.mir = !mapUI.mir;
    updateMapBar();
    drawMap();
  }
}

function deleteSelection() {
  const key = mapUI.selected;
  if (!key || !state.map.placements[key]) return;
  withUndo(function () {
    delete state.map.placements[key];
    mapUI.selected = null;
    markDirty();
  });
}

/* ---------- Pointer ---------- */

function mapPointerPos(ev) {
  const rect = mapCanvasEl.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}

mapCanvasEl.addEventListener("contextmenu", function (ev) { ev.preventDefault(); });

mapCanvasEl.addEventListener("pointerdown", function (ev) {
  mapCanvasEl.setPointerCapture(ev.pointerId);
  const p = mapPointerPos(ev);

  if (ev.button === 1 || spaceHeld) {
    mapUI.drag = { mode: "pan", lastX: p.x, lastY: p.y };
    mapWrapEl.classList.add("panning");
    ev.preventDefault();
    return;
  }
  if (ev.button !== 0) return;

  const cell = mapCellAt(p.x, p.y);
  const key = placementKey(cell.gx, cell.gy);
  if (state.map.placements[key]) {
    mapUI.selected = key;
    updateMapBar();
    drawMap();
  } else if (mapUI.brush) {
    placeRoom(cell.gx, cell.gy);
  } else {
    mapUI.selected = null;
    updateMapBar();
    drawMap();
  }
});

mapCanvasEl.addEventListener("pointermove", function (ev) {
  const p = mapPointerPos(ev);
  const drag = mapUI.drag;

  if (drag && drag.mode === "pan") {
    mapUI.view.ox += p.x - drag.lastX;
    mapUI.view.oy += p.y - drag.lastY;
    drag.lastX = p.x;
    drag.lastY = p.y;
    drawMap();
    return;
  }

  mapUI.hover = mapCellAt(p.x, p.y);
  mapUI.hoverTile = globalTileAt(p.x, p.y);
  updateMapFoot();
  drawMap();
});

function endMapDrag() {
  mapUI.drag = null;
  mapWrapEl.classList.remove("panning");
}

mapCanvasEl.addEventListener("pointerup", endMapDrag);
mapCanvasEl.addEventListener("pointercancel", endMapDrag);

mapCanvasEl.addEventListener("pointerleave", function () {
  mapUI.hover = null;
  mapUI.hoverTile = null;
  updateMapFoot();
  drawMap();
});

mapCanvasEl.addEventListener("wheel", function (ev) {
  ev.preventDefault();
  const p = mapPointerPos(ev);
  const v = mapUI.view;
  const factor = Math.exp(-ev.deltaY * 0.0015);
  const next = Math.max(MIN_MAP_SCALE, Math.min(MAX_MAP_SCALE, v.scale * factor));
  if (next === v.scale) return;
  v.ox = p.x - (p.x - v.ox) * (next / v.scale);
  v.oy = p.y - (p.y - v.oy) * (next / v.scale);
  v.scale = next;
  updateMapFoot();
  drawMap();
}, { passive: false });

/* ---------- Map UI ---------- */

const mapTplListEl  = document.getElementById("map-tpl-list");
const mapTplEmptyEl = document.getElementById("map-tpl-empty");
const mapBrushEl    = document.getElementById("map-brush");
const mapOrientEl   = document.getElementById("map-orient");
const mapPosEl      = document.getElementById("map-pos");
const mapCellEl     = document.getElementById("map-cell");
const mapZoomEl     = document.getElementById("map-zoom");

function orientationText(rot, mir) {
  return (rot * 90) + " deg" + (mir ? ", mirrored" : "");
}

function renderMapTemplateList() {
  mapTplListEl.textContent = "";
  mapTplEmptyEl.style.display = state.templates.length ? "none" : "";

  state.templates.forEach(function (t) {
    const li = document.createElement("li");
    li.className = "tpl-item" + (t.id === mapUI.brush ? " selected" : "");

    const thumb = document.createElement("canvas");
    thumb.className = "thumb";
    thumb.width = 30;
    thumb.height = 30;
    const bmp = templateBitmap(t.id);
    if (bmp) {
      const g = thumb.getContext("2d");
      g.imageSmoothingEnabled = true;
      g.drawImage(bmp, 0, 0, 30, 30);
    }
    li.appendChild(thumb);

    const name = document.createElement("span");
    name.className = "tpl-name";
    name.textContent = t.name;
    li.appendChild(name);

    li.addEventListener("click", function () {
      mapUI.brush = mapUI.brush === t.id ? null : t.id;
      mapUI.selected = null;
      renderMapTemplateList();
      updateMapBar();
      drawMap();
    });

    mapTplListEl.appendChild(li);
  });
}

function updateMapBar() {
  const sel = selectedPlacement();
  if (sel) {
    const t = state.templates.find(function (x) { return x.id === sel.templateId; });
    mapBrushEl.textContent = "selected: " + (t ? t.name : "?");
    mapOrientEl.textContent = orientationText(sel.rot, sel.mir);
  } else if (mapUI.brush) {
    const t = state.templates.find(function (x) { return x.id === mapUI.brush; });
    mapBrushEl.textContent = "brush: " + (t ? t.name : "?");
    mapOrientEl.textContent = orientationText(mapUI.rot, mapUI.mir);
  } else {
    mapBrushEl.textContent = "no brush";
    mapOrientEl.textContent = "pick a room on the left to place one";
  }
  document.getElementById("btn-map-delete").disabled = !sel;
}

function updateMapFoot() {
  const h = mapUI.hover;
  if (h) {
    mapPosEl.textContent = "cell " + h.gx + ", " + h.gy;
    const p = state.map.placements[placementKey(h.gx, h.gy)];
    const tile = mapUI.hoverTile;
    if (p && tile) {
      /* Which template tile the cursor is over, once the placement's
         rotation and mirroring are undone. */
      const local = { r: tile.v - h.gy * GRID_PITCH, c: tile.u - h.gx * GRID_PITCH };
      if (local.r >= 0 && local.r < ROOM_SIZE && local.c >= 0 && local.c < ROOM_SIZE) {
        const src = toTemplate(local.r, local.c, p.rot, p.mir);
        const t = state.templates.find(function (x) { return x.id === p.templateId; });
        const entry = t ? state.palette[t.cells[cellIndex(src.r, src.c)]] : null;
        mapCellEl.textContent = (t ? t.name : "?") + "  tile " + src.r + ", " + src.c +
                                (entry ? "  " + entry.name : "");
      } else {
        mapCellEl.textContent = "";
      }
    } else {
      mapCellEl.textContent = p ? "" : "empty";
    }
  } else {
    mapPosEl.textContent = "cell -, -";
    mapCellEl.textContent = "";
  }
  mapZoomEl.textContent = mapUI.view.scale.toFixed(2) + " px/tile";
}

export {
  mapUI,
  mapWrapEl,
  templateBitmap,
  resizeMapCanvas,
  mapCellAt,
  globalTileAt,
  mapBounds,
  fitMapView,
  fitMapCenter,
  blitRoom,
  drawMap,
  selectedPlacement,
  placeRoom,
  rotateAction,
  mirrorAction,
  deleteSelection,
  renderMapTemplateList,
  updateMapBar,
  updateMapFoot,
  endMapDrag,
};
