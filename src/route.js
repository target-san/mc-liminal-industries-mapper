/*
   Walking routes between rooms.

   The graph is room-level: nodes are placed grid cells, arcs are opened
   walls. That rests on an observation about the modpack -- inside any one
   room, every exit reaches every other -- which is why templateExitsConnected
   exists further down: it checks that assumption per template and lets the
   editor say so when a room breaks it, rather than letting a route be
   silently wrong.

   Breadth first, so a route is the one crossing the fewest rooms.
*/

import { ROOM_MAX, GRID_PITCH, CENTER_TILE, CELL_COUNT, ROOM_SIZE,
         cellIndex, placementKey } from './geometry.js';
import { SLOT_PASSAGE } from './palette.js';
import { state } from './store.js';
import { sharedPassages, isEdgeOpen, edgeTile } from './edges.js';

/* The four walls of a cell, as (edge, neighbour) pairs. */
function wallsOf(gx, gy) {
  return [
    { dir: "V", ex: gx - 1, ey: gy, nx: gx - 1, ny: gy },
    { dir: "V", ex: gx,     ey: gy, nx: gx + 1, ny: gy },
    { dir: "H", ex: gx, ey: gy - 1, nx: gx, ny: gy - 1 },
    { dir: "H", ex: gx, ey: gy,     nx: gx, ny: gy + 1 },
  ];
}

/* Neighbours reachable on foot: a room on the far side, an opened wall, and
   at least one tile the two rooms agree is a doorway. */
function neighbours(gx, gy) {
  const out = [];
  wallsOf(gx, gy).forEach(function (w) {
    const key = placementKey(w.nx, w.ny);
    if (!state.map.placements[key]) return;
    if (!isEdgeOpen(w.ex, w.ey, w.dir)) return;
    if (!sharedPassages(w.ex, w.ey, w.dir).length) return;
    out.push({ key: key, edge: { gx: w.ex, gy: w.ey, dir: w.dir } });
  });
  return out;
}

function rebuild(prev, fromKey, toKey) {
  const cells = [toKey];
  const edges = [];
  let cur = toKey;
  while (cur !== fromKey) {
    const step = prev.get(cur);
    cells.unshift(step.from);
    edges.unshift(step.edge);
    cur = step.from;
  }
  return { cells: cells, edges: edges };
}

/*
   Returns { cells, edges } with edges[i] joining cells[i] to cells[i + 1],
   or null when the two rooms are not connected by opened walls.
*/
function findRoute(fromKey, toKey) {
  if (!state.map.placements[fromKey] || !state.map.placements[toKey]) return null;
  if (fromKey === toKey) return { cells: [fromKey], edges: [] };

  const prev = new Map();
  const seen = new Set([fromKey]);
  const queue = [fromKey];
  let head = 0;

  while (head < queue.length) {
    const cur = queue[head++];
    const parts = cur.split(",");
    const next = neighbours(parseInt(parts[0], 10), parseInt(parts[1], 10));
    for (let i = 0; i < next.length; i++) {
      const n = next[i];
      if (seen.has(n.key)) continue;
      seen.add(n.key);
      prev.set(n.key, { from: cur, edge: n.edge });
      if (n.key === toKey) return rebuild(prev, fromKey, toKey);
      queue.push(n.key);
    }
  }
  return null;
}

/* A route goes stale as soon as a room or a wall along it changes. */
function routeStillValid(route) {
  if (!route) return false;
  for (let i = 0; i < route.cells.length; i++) {
    if (!state.map.placements[route.cells[i]]) return false;
  }
  for (let i = 0; i < route.edges.length; i++) {
    const e = route.edges[i];
    if (!isEdgeOpen(e.gx, e.gy, e.dir)) return false;
    if (!sharedPassages(e.gx, e.gy, e.dir).length) return false;
  }
  return true;
}

function cellCentreTile(key) {
  const parts = key.split(",");
  return {
    u: parseInt(parts[0], 10) * GRID_PITCH + CENTER_TILE + 0.5,
    v: parseInt(parts[1], 10) * GRID_PITCH + CENTER_TILE + 0.5,
  };
}

/* Room centre, doorway, room centre, doorway ... in tile coordinates. */
function routePoints(route) {
  const pts = [];
  route.cells.forEach(function (key, i) {
    pts.push(cellCentreTile(key));
    const e = route.edges[i];
    if (!e) return;
    const tiles = sharedPassages(e.gx, e.gy, e.dir);
    if (!tiles.length) return;
    const t = edgeTile(e.gx, e.gy, e.dir, tiles[Math.floor(tiles.length / 2)]);
    pts.push({ u: t.u + 0.5, v: t.v + 0.5 });
  });
  return pts;
}

/* Walking distance in blocks. Manhattan, because corridors are axis aligned. */
function routeLength(route) {
  const pts = routePoints(route);
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.abs(pts[i].u - pts[i - 1].u) + Math.abs(pts[i].v - pts[i - 1].v);
  }
  return Math.round(total);
}

/*
   Do all of a template's doorways connect to each other inside the room?

   Room-level routing assumes they do. Where they do not -- a room split by
   an impassable band, say -- a route through it can claim a walk that is not
   walkable, so the editor warns instead of leaving it silent.

   Returns { exits, reached, ok }. Fewer than two exits is trivially fine.
*/
function templateExitsConnected(t) {
  const inward = [];
  for (let i = 1; i <= ROOM_MAX - 1; i++) {
    if (t.cells[cellIndex(0, i)] === SLOT_PASSAGE) inward.push(cellIndex(1, i));
    if (t.cells[cellIndex(ROOM_MAX, i)] === SLOT_PASSAGE) inward.push(cellIndex(ROOM_MAX - 1, i));
    if (t.cells[cellIndex(i, 0)] === SLOT_PASSAGE) inward.push(cellIndex(i, 1));
    if (t.cells[cellIndex(i, ROOM_MAX)] === SLOT_PASSAGE) inward.push(cellIndex(i, ROOM_MAX - 1));
  }
  if (inward.length < 2) return { exits: inward.length, reached: inward.length, ok: true };

  const passable = state.palette.map(function (e) { return e.passable !== false; });
  const walkable = function (i) { return passable[t.cells[i]] === true; };

  /* An exit whose inward tile is blocked cannot be used at all. */
  if (!walkable(inward[0])) {
    return { exits: inward.length, reached: 0, ok: false };
  }

  const seen = new Uint8Array(CELL_COUNT);
  const stack = [inward[0]];
  while (stack.length) {
    const i = stack.pop();
    if (seen[i]) continue;
    seen[i] = 1;
    if (!walkable(i)) continue;
    const r = (i / ROOM_SIZE) | 0;
    const c = i % ROOM_SIZE;
    if (r > 1) stack.push(i - ROOM_SIZE);
    if (r < ROOM_MAX - 1) stack.push(i + ROOM_SIZE);
    if (c > 1) stack.push(i - 1);
    if (c < ROOM_MAX - 1) stack.push(i + 1);
  }

  let reached = 0;
  for (let k = 0; k < inward.length; k++) {
    if (seen[inward[k]] && walkable(inward[k])) reached++;
  }
  return { exits: inward.length, reached: reached, ok: reached === inward.length };
}

export {
  neighbours,
  findRoute,
  routeStillValid,
  routePoints,
  routeLength,
  cellCentreTile,
  templateExitsConnected,
};
