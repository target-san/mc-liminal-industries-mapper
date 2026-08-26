/*
   Walls between adjacent rooms.

   Two neighbours share exactly one tile line, and each template marks which
   of those tiles *may* become a doorway. Whether a doorway actually exists is
   a property of the map, not of either template, so the model splits in two:

     - the template says "a passage is possible here",
     - the map says "this particular wall is open".

   A shared tile is walkable only when the edge is open AND both templates
   mark that tile. An edge whose intersection is empty cannot be opened at
   all -- there is nowhere for the doorway to go.
*/

import { ROOM_MAX, GRID_PITCH, cellIndex, toTemplate,
         placementKey, edgeKey } from './geometry.js';
import { SLOT_PASSAGE } from './palette.js';
import { state } from './store.js';
import { withUndo } from './history.js';
import { markDirty } from './storage.js';

/* Corners belong to up to four rooms at once and are always solid wall, so a
   shared line runs 1..45 rather than the full 0..46. */
const EDGE_LO = 1;
const EDGE_HI = ROOM_MAX - 1;

/* The two grid cells an edge separates. */
function edgeCells(gx, gy, dir) {
  return dir === "V"
    ? { a: { gx: gx, gy: gy }, b: { gx: gx + 1, gy: gy } }
    : { a: { gx: gx, gy: gy }, b: { gx: gx, gy: gy + 1 } };
}

/*
   Where the i-th shared tile sits in each room's own coordinates. For a
   vertical edge that is room A's right wall and room B's left wall; for a
   horizontal one, A's bottom and B's top.
*/
function edgeLocal(dir, i) {
  return dir === "V"
    ? { a: { r: i, c: ROOM_MAX }, b: { r: i, c: 0 } }
    : { a: { r: ROOM_MAX, c: i }, b: { r: 0, c: i } };
}

/* The global tile a shared-line index maps to. */
function edgeTile(gx, gy, dir, i) {
  return dir === "V"
    ? { u: (gx + 1) * GRID_PITCH, v: gy * GRID_PITCH + i }
    : { u: gx * GRID_PITCH + i, v: (gy + 1) * GRID_PITCH };
}

function placementAt(gx, gy) {
  return state.map.placements[placementKey(gx, gy)] || null;
}

/* The palette slot a placed room shows at one of its own local tiles. */
function placementSlot(p, r, c) {
  const t = state.templates.find(function (x) { return x.id === p.templateId; });
  if (!t) return -1;
  const src = toTemplate(r, c, p.rot, p.mir);
  return t.cells[cellIndex(src.r, src.c)];
}

/* Both sides placed. Says nothing about whether a doorway is possible. */
function edgeConnects(gx, gy, dir) {
  const cells = edgeCells(gx, gy, dir);
  return !!(placementAt(cells.a.gx, cells.a.gy) && placementAt(cells.b.gx, cells.b.gy));
}

/*
   Shared-line indices both rooms agree could be a doorway. This is the
   intersection, so rotating or mirroring either room changes it.
*/
function sharedPassages(gx, gy, dir) {
  const cells = edgeCells(gx, gy, dir);
  const pa = placementAt(cells.a.gx, cells.a.gy);
  const pb = placementAt(cells.b.gx, cells.b.gy);
  if (!pa || !pb) return [];
  const out = [];
  for (let i = EDGE_LO; i <= EDGE_HI; i++) {
    const loc = edgeLocal(dir, i);
    if (placementSlot(pa, loc.a.r, loc.a.c) === SLOT_PASSAGE &&
        placementSlot(pb, loc.b.r, loc.b.c) === SLOT_PASSAGE) {
      out.push(i);
    }
  }
  return out;
}

function edgeOpenable(gx, gy, dir) {
  return sharedPassages(gx, gy, dir).length > 0;
}

function isEdgeOpen(gx, gy, dir) {
  return state.map.openEdges.has(edgeKey(gx, gy, dir));
}

/* Opening is refused when the two rooms' passage marks do not overlap. */
function toggleEdge(gx, gy, dir) {
  const key = edgeKey(gx, gy, dir);
  const open = state.map.openEdges.has(key);
  if (!open && !edgeOpenable(gx, gy, dir)) return false;
  withUndo(function () {
    if (open) state.map.openEdges.delete(key);
    else state.map.openEdges.add(key);
    markDirty();
  });
  return true;
}

/* The four edges a grid cell participates in. */
function edgesTouching(gx, gy) {
  return [
    edgeKey(gx - 1, gy, "V"),
    edgeKey(gx, gy, "V"),
    edgeKey(gx, gy - 1, "H"),
    edgeKey(gx, gy, "H"),
  ];
}

function parseEdgeKey(key) {
  const dir = key.slice(0, 1);
  const parts = key.slice(2).split(",");
  return { dir: dir, gx: parseInt(parts[0], 10), gy: parseInt(parts[1], 10) };
}

/*
   Drops any edge around a cell that can no longer carry a doorway -- the
   room was deleted, or rotated so the passage marks no longer line up.
   Call inside the withUndo that made the change so it lands in one step.
*/
function pruneEdgesAt(gx, gy) {
  edgesTouching(gx, gy).forEach(function (key) {
    if (!state.map.openEdges.has(key)) return;
    const e = parseEdgeKey(key);
    if (!edgeOpenable(e.gx, e.gy, e.dir)) state.map.openEdges.delete(key);
  });
}

/* Every adjacency on the map, visited once. */
function eachAdjacency(cb) {
  Object.keys(state.map.placements).forEach(function (key) {
    const parts = key.split(",");
    const gx = parseInt(parts[0], 10), gy = parseInt(parts[1], 10);
    if (state.map.placements[placementKey(gx + 1, gy)]) cb(gx, gy, "V");
    if (state.map.placements[placementKey(gx, gy + 1)]) cb(gx, gy, "H");
  });
}

/* Consecutive indices collapsed into [from, to] pairs, for drawing. */
function runsOf(indices) {
  const runs = [];
  let start = null, prev = null;
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    if (start === null) { start = prev = i; continue; }
    if (i === prev + 1) { prev = i; continue; }
    runs.push([start, prev]);
    start = prev = i;
  }
  if (start !== null) runs.push([start, prev]);
  return runs;
}

export {
  EDGE_LO,
  EDGE_HI,
  edgeCells,
  edgeLocal,
  edgeTile,
  placementSlot,
  edgeConnects,
  sharedPassages,
  edgeOpenable,
  isEdgeOpen,
  toggleEdge,
  edgesTouching,
  parseEdgeKey,
  pruneEdgesAt,
  eachAdjacency,
  runsOf,
};
