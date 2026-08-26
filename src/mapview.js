/*
   The map canvas: placement, orientation and the room bitmap cache.
*/

import { ROOM_SIZE, GRID_PITCH, CELL_COUNT, cellIndex, toTemplate,
         applyPlacementTransform, placementKey } from './geometry.js';
import { parseHexColor, SLOT_PASSAGE, SLOT_WALL } from './palette.js';
import { sharedPassages, edgeConnects, edgeOpenable, isEdgeOpen, toggleEdge,
         edgesTouching, pruneEdgesAt, eachAdjacency, edgeTile, runsOf,
         parseEdgeKey, EDGE_LO, EDGE_HI } from './edges.js';
import { state, templateBitmaps } from './store.js';
import { markDirty, saveMapView, loadMapView } from './storage.js';
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
  hoverEdge: null,    // { gx, gy, dir } while in doors mode
  mode: "place",      // "place" | "doors"
  drag: null,
};

const mapWrapEl   = document.getElementById("map-wrap");
const mapCanvasEl = document.getElementById("map-canvas");
const mctx        = mapCanvasEl.getContext("2d");

let mapW = 0, mapH = 0;

/* Cleared by the first measurement worth restoring or fitting to. */
let mapNeedsFit = true;

function resizeMapCanvas() {
  setDpr(window.devicePixelRatio || 1);
  const rect = mapWrapEl.getBoundingClientRect();
  if (!rect.width || !rect.height) return;   // panel is hidden
  mapW = rect.width;
  mapH = rect.height;
  mapCanvasEl.width  = Math.max(1, Math.round(mapW * dpr));
  mapCanvasEl.height = Math.max(1, Math.round(mapH * dpr));
  mctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  /*
     The first time the canvas has a real size, put the viewport where the
     last session left it -- or fit the map if there is nothing stored.
     Without this the map opened on grid cell 0,0 in the top-left corner
     however far away the rooms actually were.
  */
  if (mapNeedsFit) {
    mapNeedsFit = false;
    const stored = loadMapView();
    if (stored) applyMapView(stored);
    else fitMapView();
  }

  drawMap();
}

/* Restores a stored viewport, re-centring it for the current window size. */
function applyMapView(v) {
  mapUI.view.scale = Math.max(MIN_MAP_SCALE, Math.min(MAX_MAP_SCALE, v.scale));
  mapUI.view.ox = mapW / 2 - v.cu * mapUI.view.scale;
  mapUI.view.oy = mapH / 2 - v.cv * mapUI.view.scale;
}

function rememberMapView() {
  if (!mapW || !mapH || !mapUI.view.scale) return;
  saveMapView({
    scale: mapUI.view.scale,
    cu: (mapW / 2 - mapUI.view.ox) / mapUI.view.scale,
    cv: (mapH / 2 - mapUI.view.oy) / mapUI.view.scale,
  });
}

/* ---------- Bitmap cache ---------- */

function renderTemplateCanvas(t, wallInsteadOfPassage) {
  const cv = document.createElement("canvas");
  cv.width = ROOM_SIZE;
  cv.height = ROOM_SIZE;
  const g = cv.getContext("2d");
  const img = g.createImageData(ROOM_SIZE, ROOM_SIZE);
  const data = img.data;

  const rgb = state.palette.map(function (e) { return parseHexColor(e.color); });
  const fallback = [255, 0, 255];
  for (let i = 0; i < CELL_COUNT; i++) {
    let slot = t.cells[i];
    if (wallInsteadOfPassage && slot === SLOT_PASSAGE) slot = SLOT_WALL;
    const c = rgb[slot] || fallback;
    const o = i * 4;
    data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return cv;
}

function bitmapEntry(id) {
  const cached = templateBitmaps.get(id);
  if (cached) return cached;
  const t = state.templates.find(function (x) { return x.id === id; });
  if (!t) return null;
  const entry = {
    marks: renderTemplateCanvas(t, false),
    map: renderTemplateCanvas(t, true),
  };
  templateBitmaps.set(id, entry);
  return entry;
}

/* Possible doorways shown as passages: the editor and the sidebar thumbnails. */
function templateBitmap(id) {
  const e = bitmapEntry(id);
  return e && e.marks;
}

/* Possible doorways shown as wall: the map, where only opened edges are holes. */
function roomBitmap(id) {
  const e = bitmapEntry(id);
  return e && e.map;
}

/* ---------- View ---------- */

function mapCellAt(px, py) {
  const pitch = GRID_PITCH * mapUI.view.scale;
  return {
    gx: Math.floor((px - mapUI.view.ox) / pitch),
    gy: Math.floor((py - mapUI.view.oy) / pitch),
  };
}

/*
   The edge nearest the pointer, or null. Only edges with rooms on both sides
   are candidates: a wall with nothing behind it is not a door.
*/
function edgeAt(px, py) {
  const pitch = GRID_PITCH * mapUI.view.scale;
  if (pitch <= 0) return null;
  const fx = (px - mapUI.view.ox) / pitch;
  const fy = (py - mapUI.view.oy) / pitch;
  const gx = Math.floor(fx), gy = Math.floor(fy);
  const dx = fx - gx, dy = fy - gy;

  /* Grab band: a slice of the cell, but never so thin that it becomes an
     unhittable target when zoomed out. */
  const near = Math.min(0.3, Math.max(0.08, 8 / pitch));

  const cands = [];
  if (dx < near)     cands.push({ gx: gx - 1, gy: gy, dir: "V", d: dx });
  if (1 - dx < near) cands.push({ gx: gx,     gy: gy, dir: "V", d: 1 - dx });
  if (dy < near)     cands.push({ gx: gx, gy: gy - 1, dir: "H", d: dy });
  if (1 - dy < near) cands.push({ gx: gx, gy: gy,     dir: "H", d: 1 - dy });
  cands.sort(function (a, b) { return a.d - b.d; });

  for (let i = 0; i < cands.length; i++) {
    if (edgeConnects(cands[i].gx, cands[i].gy, cands[i].dir)) return cands[i];
  }
  return null;
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
  rememberMapView();
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
  rememberMapView();
}

/* ---------- Drawing ---------- */

function blitRoom(g, gx, gy, placement, alpha) {
  const bmp = roomBitmap(placement.templateId);
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

function snap(v) {
  return Math.round(v * dpr) / dpr;
}

/*
   Opened doorways. Room bitmaps paint every possible passage as solid wall,
   so the tiles both neighbours agree on are painted back in here -- which
   also means a doorway automatically narrows or disappears if either room is
   rotated out of alignment.
*/
function drawDoorways() {
  const s = mapUI.view.scale;
  const entry = state.palette[SLOT_PASSAGE];
  mctx.fillStyle = entry ? entry.color : "#c89b3c";

  state.map.openEdges.forEach(function (key) {
    const e = parseEdgeKey(key);
    const tiles = sharedPassages(e.gx, e.gy, e.dir);
    if (!tiles.length) return;
    runsOf(tiles).forEach(function (run) {
      const t0 = edgeTile(e.gx, e.gy, e.dir, run[0]);
      const len = run[1] - run[0] + 1;
      const x = snap(mapUI.view.ox + t0.u * s);
      const y = snap(mapUI.view.oy + t0.v * s);
      const x1 = snap(mapUI.view.ox + (t0.u + (e.dir === "V" ? 1 : len)) * s);
      const y1 = snap(mapUI.view.oy + (t0.v + (e.dir === "V" ? len : 1)) * s);
      mctx.fillRect(x, y, x1 - x, y1 - y);
    });
  });
}

/* In doors mode every wall between two rooms is marked, so it is obvious
   which ones can be opened before clicking anything. */
function drawEdgeOverlay() {
  const s = mapUI.view.scale;
  const hovered = mapUI.hoverEdge;

  eachAdjacency(function (gx, gy, dir) {
    const open = isEdgeOpen(gx, gy, dir);
    const openable = edgeOpenable(gx, gy, dir);
    const isHover = hovered && hovered.gx === gx && hovered.gy === gy && hovered.dir === dir;

    const a = edgeTile(gx, gy, dir, EDGE_LO);
    const b = edgeTile(gx, gy, dir, EDGE_HI);
    const x0 = mapUI.view.ox + a.u * s;
    const y0 = mapUI.view.oy + a.v * s;
    const x1 = mapUI.view.ox + (b.u + 1) * s;
    const y1 = mapUI.view.oy + (b.v + 1) * s;

    mctx.strokeStyle = isHover
      ? (openable || open ? "#eaf0f8" : "#d05c5c")
      : open ? "rgba(200,155,60,0.85)"
      : openable ? "rgba(122,200,140,0.6)"
      : "rgba(190,90,90,0.35)";
    mctx.lineWidth = isHover ? 3 : 2;
    mctx.beginPath();
    if (dir === "V") {
      const x = (x0 + x1) / 2;
      mctx.moveTo(x, y0); mctx.lineTo(x, y1);
    } else {
      const y = (y0 + y1) / 2;
      mctx.moveTo(x0, y); mctx.lineTo(x1, y);
    }
    mctx.stroke();
  });
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

  drawDoorways();
  if (mapUI.mode === "doors") drawEdgeOverlay();

  /* Ghost of what the brush would drop on the hovered slot. */
  const h = mapUI.mode === "place" ? mapUI.hover : null;
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

function setMapMode(mode) {
  mapUI.mode = mode;
  if (mode === "doors") mapUI.selected = null;
  mapUI.hoverEdge = null;
  updateMapBar();
  updateMapFoot();
  drawMap();
}

function selectedPlacement() {
  if (!mapUI.selected) return null;
  return state.map.placements[mapUI.selected] || null;
}

function placeRoom(gx, gy) {
  const templateId = mapUI.brush;
  if (!templateId) return;
  const key = placementKey(gx, gy);
  if (state.map.placements[key]) return;
  if (!state.templates.some(function (t) { return t.id === templateId; })) return;
  withUndo(function () {
    state.map.placements[key] = {
      templateId: templateId, rot: mapUI.rot, mir: mapUI.mir,
    };
    /*
       Rooms that meet through matching doorways are almost always connected
       in game, so those walls open by default rather than needing a visit to
       doors mode for each one. Walls with no overlap stay shut, and any
       deliberately closed wall can be shut again -- it is a default, not a
       rule, and it lands in the same undo step as the placement.
    */
    edgesTouching(gx, gy).forEach(function (k) {
      const e = parseEdgeKey(k);
      if (edgeOpenable(e.gx, e.gy, e.dir)) state.map.openEdges.add(k);
    });
    /*
       Placement is one shot: the brush is put down after a single room, and
       the new room becomes the selection so Rotate, Mirror and Delete act on
       what was just placed. Picking the template again places another.
       This is view state, so undo does not restore the brush.
    */
    mapUI.brush = null;
    mapUI.selected = key;
    markDirty();
  });
}

/* Rotate and Mirror act on the selected room, or set the orientation for the
   next placement when nothing is selected. */
function rotateAction() {
  const p = selectedPlacement();
  if (p) {
    const at = mapUI.selected.split(",");
    withUndo(function () {
      p.rot = (p.rot + 1) & 3;
      /* Turning a room can slide its doorways out of line with a neighbour's,
         and an edge with no overlap left is no longer a door. */
      pruneEdgesAt(parseInt(at[0], 10), parseInt(at[1], 10));
      markDirty();
    });
  } else {
    mapUI.rot = (mapUI.rot + 1) & 3;
    updateMapBar();
    drawMap();
  }
}

function mirrorAction() {
  const p = selectedPlacement();
  if (p) {
    const at = mapUI.selected.split(",");
    withUndo(function () {
      p.mir = !p.mir;
      pruneEdgesAt(parseInt(at[0], 10), parseInt(at[1], 10));
      markDirty();
    });
  } else {
    mapUI.mir = !mapUI.mir;
    updateMapBar();
    drawMap();
  }
}

function deleteSelection() {
  const key = mapUI.selected;
  if (!key || !state.map.placements[key]) return;
  const at = key.split(",");
  withUndo(function () {
    delete state.map.placements[key];
    /* A door needs rooms on both sides; with one gone the edge is meaningless. */
    edgesTouching(parseInt(at[0], 10), parseInt(at[1], 10)).forEach(function (k) {
      state.map.openEdges.delete(k);
    });
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

  /* Right and middle drag both pan, as does holding space. */
  if (ev.button === 1 || ev.button === 2 || spaceHeld) {
    mapUI.drag = { mode: "pan", lastX: p.x, lastY: p.y };
    mapWrapEl.classList.add("panning");
    ev.preventDefault();
    return;
  }
  if (ev.button !== 0) return;

  if (mapUI.mode === "doors") {
    const e = edgeAt(p.x, p.y);
    if (e) toggleEdge(e.gx, e.gy, e.dir);
    updateMapFoot();
    drawMap();
    return;
  }

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
    rememberMapView();
    drawMap();
    return;
  }

  mapUI.hover = mapCellAt(p.x, p.y);
  mapUI.hoverTile = globalTileAt(p.x, p.y);
  mapUI.hoverEdge = mapUI.mode === "doors" ? edgeAt(p.x, p.y) : null;
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
  mapUI.hoverEdge = null;
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
  rememberMapView();
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
  const doors = mapUI.mode === "doors";

  const btnDoors = document.getElementById("btn-map-doors");
  if (btnDoors) btnDoors.classList.toggle("on", doors);

  if (doors) {
    mapBrushEl.textContent = "doors";
    mapOrientEl.textContent = "click a wall between two rooms";
    document.getElementById("btn-map-delete").disabled = true;
    return;
  }
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
  if (mapUI.mode === "doors") {
    const e = mapUI.hoverEdge;
    if (e) {
      const tiles = sharedPassages(e.gx, e.gy, e.dir);
      mapPosEl.textContent = "wall " + e.dir + " " + e.gx + ", " + e.gy;
      mapCellEl.textContent = tiles.length
        ? (isEdgeOpen(e.gx, e.gy, e.dir) ? "open" : "closed") + ", " +
          tiles.length + " shared doorway tile(s)"
        : "cannot open: no doorway tiles in common";
    } else {
      mapPosEl.textContent = "wall -, -";
      mapCellEl.textContent = "hover a wall between two rooms";
    }
    mapZoomEl.textContent = mapUI.view.scale.toFixed(2) + " px/tile";
    return;
  }

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
  MIN_MAP_SCALE,
  MAX_MAP_SCALE,
  mapWrapEl,
  templateBitmap,
  roomBitmap,
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
  setMapMode,
  edgeAt,
  applyMapView,
  rememberMapView,
  endMapDrag,
};
