/*
   The map canvas: placement, orientation and the room bitmap cache.
*/

import { ROOM_SIZE, GRID_PITCH, CENTER_TILE, CELL_COUNT, cellIndex, toTemplate,
         applyPlacementTransform, placementKey } from './geometry.js';
import { parseHexColor, SLOT_PASSAGE, SLOT_WALL } from './palette.js';
import { sharedPassages, edgeConnects, edgeOpenable, isEdgeOpen, toggleEdge,
         edgesTouching, pruneEdgesAt, eachAdjacency, edgeTile, runsOf,
         parseEdgeKey, EDGE_LO, EDGE_HI } from './edges.js';
import { state, templateBitmaps } from './store.js';
import { markDirty, saveMapView, loadMapView } from './storage.js';
import { withUndo } from './history.js';
import { dpr, setDpr, spaceHeld } from './screen.js';
import { isAnchored, anchorOrigin, worldOfTile, tileOfWorld, setAnchor,
         roomAtTile, parseWorldXZ, formatXZ } from './world.js';
import { findRoute, routeStillValid, routePoints, routeLength } from './route.js';
import { roomName, hasOwnName, setRoomLabel, isBookmarked, toggleBookmark,
         dropBookmark, bookmarkList } from './rooms.js';
import { ui } from './hooks.js';

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
  selected: null,     // placement key
  hover: null,        // { gx, gy }
  hoverEdge: null,    // { gx, gy, dir } while in doors mode
  mode: "select",     // see MAP_MODES; the sidebar follows from it
  marker: null,       // { u, v, x, z } from the last position lookup
  routeFrom: null,    // first room picked in route mode
  route: null,        // { cells, edges } once both ends are picked
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

/* A ring and crosshair on a tile, sized so it stays visible at any zoom. */
function drawTileMarker(u, v, color, width) {
  const s = mapUI.view.scale;
  const x = mapUI.view.ox + (u + 0.5) * s;
  const y = mapUI.view.oy + (v + 0.5) * s;
  if (x < -40 || y < -40 || x > mapW + 40 || y > mapH + 40) return;

  const rad = Math.max(4, Math.min(12, s * 1.5));
  mctx.strokeStyle = color;
  mctx.lineWidth = width;
  mctx.beginPath();
  mctx.arc(x, y, rad, 0, Math.PI * 2);
  mctx.stroke();
  mctx.beginPath();
  mctx.moveTo(x - rad * 1.9, y); mctx.lineTo(x - rad * 0.6, y);
  mctx.moveTo(x + rad * 0.6, y); mctx.lineTo(x + rad * 1.9, y);
  mctx.moveTo(x, y - rad * 1.9); mctx.lineTo(x, y - rad * 0.6);
  mctx.moveTo(x, y + rad * 0.6); mctx.lineTo(x, y + rad * 1.9);
  mctx.stroke();
}

/*
   A dark casing under a bright line, so the route reads over any room colour
   the palette happens to hold.
*/
/*
   Names sit on the rooms that carry one. Only explicitly named rooms are
   labelled: stamping every room with its template name would bury the map
   under repeated text.
*/
function drawRoomLabels() {
  const s = mapUI.view.scale;
  if (ROOM_SIZE * s < 70) return;   // nothing legible would fit

  mctx.font = "600 12px system-ui, 'Segoe UI', sans-serif";
  mctx.textAlign = "center";
  mctx.textBaseline = "middle";

  Object.keys(state.map.placements).forEach(function (key) {
    if (!hasOwnName(key)) return;
    const parts = key.split(",");
    const rect = roomScreenRect(parseInt(parts[0], 10), parseInt(parts[1], 10));
    if (rect.x > mapW || rect.y > mapH || rect.x + rect.w < 0 || rect.y + rect.h < 0) return;

    const text = roomName(key);
    const x = rect.x + rect.w / 2;
    const y = rect.y + rect.h / 2;
    const w = mctx.measureText(text).width + 10;

    mctx.fillStyle = "rgba(16,19,23,0.78)";
    mctx.fillRect(x - w / 2, y - 9, w, 18);
    mctx.fillStyle = "#eaf0f8";
    mctx.fillText(text, x, y);
  });
}

function drawRoute() {
  if (mapUI.route && !routeStillValid(mapUI.route)) {
    mapUI.route = null;   // a room or wall along it changed
  }
  if (!mapUI.route) return;

  const pts = routePoints(mapUI.route);
  if (pts.length < 2) return;
  const s = mapUI.view.scale;

  mctx.lineJoin = "round";
  mctx.lineCap = "round";
  [[Math.max(5, s * 2.4), "rgba(0,0,0,0.55)"],
   [Math.max(2.5, s * 1.1), "#57d08a"]].forEach(function (pass) {
    mctx.lineWidth = pass[0];
    mctx.strokeStyle = pass[1];
    mctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const x = mapUI.view.ox + pts[i].u * s;
      const y = mapUI.view.oy + pts[i].v * s;
      if (i === 0) mctx.moveTo(x, y);
      else mctx.lineTo(x, y);
    }
    mctx.stroke();
  });

  drawTileMarker(pts[0].u - 0.5, pts[0].v - 0.5, "#57d08a", 2.5);
  const last = pts[pts.length - 1];
  drawTileMarker(last.u - 0.5, last.v - 0.5, "#57d08a", 2.5);
}

function drawMarkers() {
  const o = anchorOrigin();
  if (o) drawTileMarker(o.u, o.v, "rgba(122,162,247,0.9)", 1.5);
  const m = mapUI.marker;
  if (m) drawTileMarker(m.u, m.v, "#e0574f", 2.5);
}

function centreOnTile(u, v) {
  if (!mapW || !mapH) return;
  mapUI.view.ox = mapW / 2 - (u + 0.5) * mapUI.view.scale;
  mapUI.view.oy = mapH / 2 - (v + 0.5) * mapUI.view.scale;
  rememberMapView();
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
             { templateId: mapUI.brush, rot: 0, mir: false }, 0.45);
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

  drawRoomLabels();
  drawRoute();
  drawMarkers();

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

/*
   Binds one tile to a world position. Prefills with whatever the current
   binding says that tile should be, so re-anchoring against a second known
   point is a matter of correcting the number rather than retyping it.
*/
async function askAnchor(gx, gy, r, c) {
  const u = gx * GRID_PITCH + c;
  const v = gy * GRID_PITCH + r;
  const current = worldOfTile(u, v);

  const text = await ui.askText(
    "Bind this tile to the world",
    current ? current.x + " " + current.z : "",
    "Bind",
    "Stand on this tile in game and paste your F3 coordinates, or type X and Z.");
  if (text === null) return;

  const parsed = parseWorldXZ(text);
  if (!parsed) {
    await ui.showError("Could not read that",
      "Give an X and a Z, for example \"128 -340\", or paste a whole F3 line.");
    return;
  }
  setAnchor(gx, gy, r, c, parsed.x, parsed.z);
  setMapMode("place");
}

/* Finds the room containing a world position and centres the view on it. */
async function locatePosition() {
  /* The button and its shortcut are both off until the map is bound, so
     reaching here unbound would be a wiring fault, not a user error. */
  if (!isAnchored()) return;
  const text = await ui.askText("Where are you?", "", "Find",
    "Paste your F3 coordinates, or type X and Z.");
  if (text === null) return;

  const parsed = parseWorldXZ(text);
  if (!parsed) {
    await ui.showError("Could not read that",
      "Give an X and a Z, for example \"128 -340\", or paste a whole F3 line.");
    return;
  }

  const tile = tileOfWorld(parsed.x, parsed.z);
  mapUI.marker = { u: tile.u, v: tile.v, x: parsed.x, z: parsed.z };

  const room = roomAtTile(tile.u, tile.v);
  mapUI.selected = room ? room.key : null;
  centreOnTile(tile.u, tile.v);
  updateMapBar();
  updateMapFoot();
  drawMap();

  if (!room) {
    await ui.showError("Outside the map",
      formatXZ(parsed.x, parsed.z) + " falls on no placed room. " +
      "The position is marked so you can see where it lands.");
  }
}

/*
   Switching modes. Each mode owns whatever transient state it introduced and
   drops it on the way out, so this does not grow an if-statement per feature.
   A mode that has no use for a selected room loses the selection on entry,
   which is what keeps the toolbar's per-room buttons honest.
*/
function setMapMode(next) {
  const from = MAP_MODES[mapUI.mode];
  const to = MAP_MODES[next] || MAP_MODES.select;

  if (from && from.leave) from.leave();
  mapUI.mode = to.id;
  if (!to.usesSelection) mapUI.selected = null;

  renderMapSidebar();
  updateMapBar();
  updateMapFoot();
  drawMap();
}

/* Toggling a mode button returns to select rather than doing nothing. */
function toggleMapMode(mode) {
  setMapMode(mapUI.mode === mode ? "select" : mode);
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
      /* Rooms are always stamped unrotated; Rotate and Mirror then act on
         the placed room, which is selected the moment it lands. */
      templateId: templateId, rot: 0, mir: false,
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
    markDirty();
  });

  /*
     Placement is one shot. The brush is consumed here rather than being left
     to the mode's leave hook, so placing always spends it however placeRoom
     was reached. The room just placed becomes the selection and the map drops
     back to select mode, so Rotate, Mirror, Name and Delete act on it straight
     away. Mode and brush are view state, so undo does not restore them.
  */
  mapUI.brush = null;
  mapUI.selected = key;
  setMapMode("select");
}

/* Rotate and Mirror act on the selected room, or set the orientation for the
   next placement when nothing is selected. */
function rotateAction() {
  const p = selectedPlacement();
  if (!p) return;
  const at = mapUI.selected.split(",");
  withUndo(function () {
    p.rot = (p.rot + 1) & 3;
    /* Turning a room can slide its doorways out of line with a neighbour's,
       and an edge with no overlap left is no longer a door. */
    pruneEdgesAt(parseInt(at[0], 10), parseInt(at[1], 10));
    markDirty();
  });
}

function mirrorAction() {
  const p = selectedPlacement();
  if (!p) return;
  const at = mapUI.selected.split(",");
  withUndo(function () {
    p.mir = !p.mir;
    pruneEdgesAt(parseInt(at[0], 10), parseInt(at[1], 10));
    markDirty();
  });
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
    dropBookmark(key);
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

/* Named rather than inline so the tests can drive them directly: these are
   the only place the map reacts to the pointer, and a listener silently going
   missing is not something a data-level test can see. */
function onMapPointerDown(ev) {
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

  const mode = MAP_MODES[mapUI.mode] || MAP_MODES.select;
  mode.click(p);
}

function onMapPointerMove(ev) {
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
}

mapCanvasEl.addEventListener("pointerdown", onMapPointerDown);
mapCanvasEl.addEventListener("pointermove", onMapPointerMove);

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
const mapBmListEl   = document.getElementById("map-bm-list");
const mapBmEmptyEl  = document.getElementById("map-bm-empty");
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
      renderMapSidebar();
      updateMapBar();
      drawMap();
    });

    mapTplListEl.appendChild(li);
  });
}

/*
   One end of a route. Called from a click on the map and from the bookmark
   list alike, so a route can be picked either way -- or one end each.
*/
function pickRouteRoom(key) {
  if (!state.map.placements[key]) return;
  if (!mapUI.routeFrom || mapUI.route) {
    /* First pick, or starting over after a finished route. */
    mapUI.routeFrom = key;
    mapUI.route = null;
  } else {
    mapUI.route = findRoute(mapUI.routeFrom, key);
    if (!mapUI.route) mapUI.routeFrom = key;   // unreachable: treat as a new start
  }
}

/*
   Centres the view on a room. In route mode the click picks a route end
   rather than a selection, so bookmarks drive routing directly.
*/
function goToRoom(key) {
  if (!state.map.placements[key]) return;
  if (mapUI.mode === "route") {
    pickRouteRoom(key);
  } else {
    /* Anywhere else a bookmark means "take me to this room", so it also
       leaves whatever transient mode was running. */
    if (mapUI.mode !== "select") setMapMode("select");
    mapUI.selected = key;
  }
  const parts = key.split(",");
  centreOnTile(parseInt(parts[0], 10) * GRID_PITCH + CENTER_TILE,
               parseInt(parts[1], 10) * GRID_PITCH + CENTER_TILE);
  renderMapSidebar();
  updateMapBar();
  updateMapFoot();
  drawMap();
}

async function nameSelectedRoom() {
  const key = mapUI.selected;
  if (!key || !state.map.placements[key]) return;
  const text = await ui.askText("Name this room",
    hasOwnName(key) ? roomName(key) : "", "Save",
    "Leave it empty to go back to the template name.");
  if (text === null) return;
  setRoomLabel(key, text);
}

function bookmarkSelectedRoom() {
  const key = mapUI.selected;
  if (!key || !state.map.placements[key]) return;
  toggleBookmark(key);
}

/* What a bookmark row should look active for: the selection normally, the
   route ends while routing. */
function bookmarkIsCurrent(key) {
  if (mapUI.mode === "route") {
    if (mapUI.route) {
      return key === mapUI.route.cells[0] ||
             key === mapUI.route.cells[mapUI.route.cells.length - 1];
    }
    return key === mapUI.routeFrom;
  }
  return key === mapUI.selected;
}

function renderBookmarkList() {
  mapBmListEl.textContent = "";
  const items = bookmarkList();
  mapBmEmptyEl.style.display = items.length ? "none" : "";

  items.forEach(function (item) {
    const li = document.createElement("li");
    li.className = "tpl-item" + (bookmarkIsCurrent(item.key) ? " selected" : "");
    li.title = mapUI.mode === "route"
      ? "Use this room as a route end"
      : "Go to this room";

    const name = document.createElement("span");
    name.className = "tpl-name";
    name.textContent = item.name;
    li.appendChild(name);

    const at = document.createElement("span");
    at.className = "pal-flag";
    at.textContent = item.key;
    li.appendChild(at);

    li.addEventListener("click", function () { goToRoom(item.key); });
    mapBmListEl.appendChild(li);
  });
}

function renderMapSidebar() {
  const templates = (MAP_MODES[mapUI.mode] || MAP_MODES.select).sidebar === "templates";
  document.getElementById("map-side-title").textContent =
    templates ? "Place room" : "Bookmarks";
  document.getElementById("map-panel-bookmarks").style.display = templates ? "none" : "";
  document.getElementById("map-panel-templates").style.display = templates ? "" : "none";
  document.getElementById("btn-map-add-room").style.display = templates ? "none" : "";
  document.getElementById("btn-map-cancel-add").style.display = templates ? "" : "none";
  renderBookmarkList();
  renderMapTemplateList();
}

/*
   Per-room actions. They act on a selected room, and only select mode has
   one, so everywhere else they are hidden outright rather than sitting there
   greyed: a mode that cannot use them should not show them at all.
*/
const ROOM_BUTTONS = ["name", "bookmark", "rotate", "mirror", "delete"];

function setButtons(show, enable) {
  ROOM_BUTTONS.forEach(function (name) {
    const el = document.getElementById("btn-map-" + name);
    if (!el) return;
    el.style.display = show ? "" : "none";
    el.disabled = !enable;
  });
  const sep = document.getElementById("sep-map-rooms");
  if (sep) sep.style.display = show ? "" : "none";
}

/* Whether the per-room actions are live, for the keyboard shortcuts. Without
   this, hiding the buttons would only hide them: R would still rotate. */
function mapRoomActionsLive() {
  const mode = MAP_MODES[mapUI.mode] || MAP_MODES.select;
  return mode.roomButtons === true && !!selectedPlacement();
}

function updateMapBar() {
  const sel = selectedPlacement();
  const mode = MAP_MODES[mapUI.mode] || MAP_MODES.select;

  ["doors", "anchor", "route"].forEach(function (name) {
    const el = document.getElementById("btn-map-" + name);
    if (el) el.classList.toggle("on", mapUI.mode === name);
  });

  /* Looking up a world position means nothing until a tile has been bound. */
  const locate = document.getElementById("btn-map-locate");
  if (locate) {
    locate.disabled = !isAnchored();
    locate.title = isAnchored()
      ? "Find a world position on the map (L)"
      : "Bind a tile with Anchor first";
  }
  const showRoomButtons = mode.roomButtons === true;
  setButtons(showRoomButtons, showRoomButtons && !!sel);

  const text = mode.bar(sel);
  mapBrushEl.textContent = text[0];
  mapOrientEl.textContent = text[1];
}

/* Hovered cell, what is under the cursor there, and the world position. */
function defaultFoot() {
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
        mapCellEl.textContent = roomName(placementKey(h.gx, h.gy)) +
                                "  tile " + src.r + ", " + src.c +
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

  const tile = mapUI.hoverTile;
  if (tile) {
    const w = worldOfTile(tile.u, tile.v);
    if (w) {
      mapCellEl.textContent = (mapCellEl.textContent ? mapCellEl.textContent + "   " : "") +
                              formatXZ(w.x, w.z);
    }
  }
}

function updateMapFoot() {
  const mode = MAP_MODES[mapUI.mode] || MAP_MODES.select;
  if (mode.foot) mode.foot();
  else defaultFoot();
  mapZoomEl.textContent = mapUI.view.scale.toFixed(2) + " px/tile";
}

/* ============================================================
   Map modes
   ------------------------------------------------------------
   One entry per mode, each describing what the sidebar shows, which room
   buttons are live, what a click does, and what the toolbar says. Everything
   the map does with the pointer or the toolbar goes through this table, so a
   mode cannot half-apply the way "add a room while Doors is on" used to.
   ============================================================ */

const MAP_MODES = {

  select: {
    id: "select",
    sidebar: "bookmarks",
    usesSelection: true,
    roomButtons: true,
    click: function (p) {
      const cell = mapCellAt(p.x, p.y);
      const key = placementKey(cell.gx, cell.gy);
      mapUI.selected = state.map.placements[key] ? key : null;
      renderMapSidebar();
      updateMapBar();
      drawMap();
    },
    bar: function (sel) {
      if (sel) {
        return ["selected: " + roomName(mapUI.selected),
                orientationText(sel.rot, sel.mir)];
      }
      return ["map", "click a room to select it, or Add room to place one"];
    },
  },

  place: {
    id: "place",
    sidebar: "templates",
    usesSelection: false,
    roomButtons: false,
    leave: function () { mapUI.brush = null; },
    click: function (p) {
      const cell = mapCellAt(p.x, p.y);
      placeRoom(cell.gx, cell.gy);
    },
    bar: function () {
      if (!mapUI.brush) return ["add room", "pick a room on the left"];
      const t = state.templates.find(function (x) { return x.id === mapUI.brush; });
      return ["add room", "placing " + (t ? t.name : "?") +
              ": click an empty cell, then Rotate or Mirror it"];
    },
  },

  doors: {
    id: "doors",
    sidebar: "bookmarks",
    usesSelection: false,
    roomButtons: false,
    leave: function () { mapUI.hoverEdge = null; },
    click: function (p) {
      const e = edgeAt(p.x, p.y);
      if (e) toggleEdge(e.gx, e.gy, e.dir);
      updateMapFoot();
      drawMap();
    },
    bar: function () { return ["doors", "click a wall between two rooms"]; },
    foot: function () {
      const e = mapUI.hoverEdge;
      if (!e) {
        mapPosEl.textContent = "wall -, -";
        mapCellEl.textContent = "hover a wall between two rooms";
        return;
      }
      const tiles = sharedPassages(e.gx, e.gy, e.dir);
      mapPosEl.textContent = "wall " + e.dir + " " + e.gx + ", " + e.gy;
      mapCellEl.textContent = tiles.length
        ? (isEdgeOpen(e.gx, e.gy, e.dir) ? "open" : "closed") + ", " +
          tiles.length + " shared doorway tile(s)"
        : "cannot open: no doorway tiles in common";
    },
  },

  anchor: {
    id: "anchor",
    sidebar: "bookmarks",
    usesSelection: false,
    roomButtons: false,
    click: function (p) {
      const cell = mapCellAt(p.x, p.y);
      const tile = globalTileAt(p.x, p.y);
      if (!state.map.placements[placementKey(cell.gx, cell.gy)]) {
        ui.showError("No room there", "Pick a tile inside a placed room.");
        return;
      }
      askAnchor(cell.gx, cell.gy,
                tile.v - cell.gy * GRID_PITCH, tile.u - cell.gx * GRID_PITCH);
    },
    bar: function () {
      return ["anchor", "click the tile whose coordinates you know"];
    },
  },

  route: {
    id: "route",
    sidebar: "bookmarks",
    usesSelection: false,
    roomButtons: false,
    leave: function () {
      mapUI.routeFrom = null;
      mapUI.route = null;
    },
    click: function (p) {
      const cell = mapCellAt(p.x, p.y);
      pickRouteRoom(placementKey(cell.gx, cell.gy));
      renderMapSidebar();
      updateMapBar();
      updateMapFoot();
      drawMap();
    },
    bar: function () {
      return ["route", mapUI.route
        ? mapUI.route.cells.length + " rooms, about " + routeLength(mapUI.route) + " blocks"
        : mapUI.routeFrom
          ? "now click where you want to get to"
          : "click the room you are starting from"];
    },
    foot: function () {
      if (mapUI.route) {
        mapPosEl.textContent = mapUI.route.cells.join("  >  ");
        mapCellEl.textContent = "";
      } else if (mapUI.routeFrom) {
        mapPosEl.textContent = "from " + mapUI.routeFrom;
        mapCellEl.textContent = "pick a destination room";
      } else {
        mapPosEl.textContent = "route";
        mapCellEl.textContent = "pick two rooms";
      }
    },
  },
};

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
  renderMapSidebar,
  renderBookmarkList,
  toggleMapMode,
  MAP_MODES,
  mapRoomActionsLive,
  onMapPointerDown,
  onMapPointerMove,
  goToRoom,
  pickRouteRoom,
  nameSelectedRoom,
  bookmarkSelectedRoom,
  updateMapBar,
  updateMapFoot,
  setMapMode,
  edgeAt,
  askAnchor,
  locatePosition,
  drawRoute,
  centreOnTile,
  applyMapView,
  rememberMapView,
  endMapDrag,
};
