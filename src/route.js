/*
   Walking routes between rooms.

   Nodes are not rooms but (room, exit group) pairs. A room built in two
   disjoint pieces contributes two nodes, and no arc ever joins them, so a
   route can never cross from the hall into the corridor above it. Rooms that
   are one connected space -- nearly all of them -- have a single group and
   behave exactly as they did when nodes were rooms.

   Breadth first, so a route crosses the fewest rooms.
*/

import { ROOM_MAX, GRID_PITCH, toTemplate, fromTemplate, placementKey } from './geometry.js';
import { state } from './store.js';
import { sharedPassages, isEdgeOpen, edgeLocal, edgeTile } from './edges.js';
import { sectionsOf, groupAtCell } from './sections.js';

function templateOf(id) {
  return state.templates.find(function (x) { return x.id === id; }) || null;
}

function placementSections(p) {
  const t = templateOf(p.templateId);
  return t ? sectionsOf(t) : null;
}

/* The exit group a placed room shows at one of its own local tiles. */
function groupAtPlacement(p, r, c) {
  const t = templateOf(p.templateId);
  if (!t) return -1;
  /* Undo the placement's own rotation and mirroring first. */
  const src = toTemplate(r, c, p.rot, p.mir);
  return groupAtCell(t, src.r, src.c);
}

/*
   The four walls of a cell. `first` records whether this cell is the "a" side
   of the edge, which is what edgeLocal's two halves are keyed on.
*/
function wallsOf(gx, gy) {
  return [
    { dir: "V", ex: gx - 1, ey: gy, nx: gx - 1, ny: gy, first: false },
    { dir: "V", ex: gx,     ey: gy, nx: gx + 1, ny: gy, first: true },
    { dir: "H", ex: gx, ey: gy - 1, nx: gx, ny: gy - 1, first: false },
    { dir: "H", ex: gx, ey: gy,     nx: gx, ny: gy + 1, first: true },
  ];
}

function nodeId(key, group) {
  return key + "#" + group;
}

function parseNode(id) {
  const at = id.lastIndexOf("#");
  return { key: id.slice(0, at), group: parseInt(id.slice(at + 1), 10) };
}

/*
   Where one exit group of one room can step to. Each shared doorway tile is
   examined on both sides: it links this room's group at that tile to the
   neighbour's group at the matching tile, and nothing else.
*/
function nodeNeighbours(key, group) {
  const p = state.map.placements[key];
  if (!p) return [];
  const parts = key.split(",");
  const gx = parseInt(parts[0], 10);
  const gy = parseInt(parts[1], 10);

  const out = [];
  const seen = new Set();

  wallsOf(gx, gy).forEach(function (w) {
    const nkey = placementKey(w.nx, w.ny);
    const np = state.map.placements[nkey];
    if (!np) return;
    if (!isEdgeOpen(w.ex, w.ey, w.dir)) return;

    sharedPassages(w.ex, w.ey, w.dir).forEach(function (i) {
      const loc = edgeLocal(w.dir, i);
      const mine = w.first ? loc.a : loc.b;
      const theirs = w.first ? loc.b : loc.a;
      if (groupAtPlacement(p, mine.r, mine.c) !== group) return;
      const theirGroup = groupAtPlacement(np, theirs.r, theirs.c);
      if (theirGroup < 0) return;
      const id = nodeId(nkey, theirGroup);
      if (seen.has(id)) return;
      seen.add(id);
      out.push({ node: id, edge: { gx: w.ex, gy: w.ey, dir: w.dir } });
    });
  });
  return out;
}

function rebuild(prev, startIds, endId) {
  const nodes = [endId];
  let cur = endId;
  const edges = [];
  while (!startIds.has(cur)) {
    const step = prev.get(cur);
    nodes.unshift(step.from);
    edges.unshift(step.edge);
    cur = step.from;
  }
  const parsed = nodes.map(parseNode);
  return {
    cells: parsed.map(function (n) { return n.key; }),
    sections: parsed.map(function (n) { return n.group; }),
    edges: edges,
  };
}

/*
   Every exit group of the starting room is a source: you could be standing in
   any of its pieces, and the route that comes back tells you which piece it
   assumes by way of sections[0].
*/
function findRoute(fromKey, toKey) {
  const from = state.map.placements[fromKey];
  const to = state.map.placements[toKey];
  if (!from || !to) return null;
  if (fromKey === toKey) return { cells: [fromKey], sections: [0], edges: [] };

  const info = placementSections(from);
  if (!info) return null;

  const startIds = new Set();
  info.ids.forEach(function (g) { startIds.add(nodeId(fromKey, g)); });

  const prev = new Map();
  const seen = new Set(startIds);
  const queue = Array.from(startIds);
  let head = 0;

  while (head < queue.length) {
    const cur = queue[head++];
    const at = parseNode(cur);
    if (at.key === toKey) return rebuild(prev, startIds, cur);
    const next = nodeNeighbours(at.key, at.group);
    for (let i = 0; i < next.length; i++) {
      if (seen.has(next[i].node)) continue;
      seen.add(next[i].node);
      prev.set(next[i].node, { from: cur, edge: next[i].edge });
      queue.push(next[i].node);
    }
  }
  return null;
}

/* Shared doorway tiles that join two particular exit groups. */
function hopTiles(edge, fromKey, fromGroup, toKey, toGroup) {
  const pa = state.map.placements[fromKey];
  const pb = state.map.placements[toKey];
  if (!pa || !pb) return [];
  const parts = fromKey.split(",");
  const gx = parseInt(parts[0], 10);
  const gy = parseInt(parts[1], 10);
  const first = edge.gx === gx && edge.gy === gy;

  return sharedPassages(edge.gx, edge.gy, edge.dir).filter(function (i) {
    const loc = edgeLocal(edge.dir, i);
    const mine = first ? loc.a : loc.b;
    const theirs = first ? loc.b : loc.a;
    return groupAtPlacement(pa, mine.r, mine.c) === fromGroup &&
           groupAtPlacement(pb, theirs.r, theirs.c) === toGroup;
  });
}

/*
   A route goes stale when a room disappears, a wall shuts, or a template is
   repainted so the two groups it joined no longer meet.
*/
function routeStillValid(route) {
  if (!route) return false;
  for (let i = 0; i < route.cells.length; i++) {
    if (!state.map.placements[route.cells[i]]) return false;
  }
  for (let i = 0; i < route.edges.length; i++) {
    const e = route.edges[i];
    if (!isEdgeOpen(e.gx, e.gy, e.dir)) return false;
    if (!hopTiles(e, route.cells[i], route.sections[i],
                  route.cells[i + 1], route.sections[i + 1]).length) return false;
  }
  return true;
}

/* A point inside a room, per exit group, in global tile coordinates. */
function sectionCentreTile(key, group) {
  const p = state.map.placements[key];
  const parts = key.split(",");
  const gx = parseInt(parts[0], 10);
  const gy = parseInt(parts[1], 10);
  const fallback = { r: ROOM_MAX / 2, c: ROOM_MAX / 2 };

  const info = p ? placementSections(p) : null;
  const centre = (info && info.centres.get(group)) || fallback;
  /* The transform is plain arithmetic, so it carries a fractional centroid
     through as happily as a tile index. */
  const local = fromTemplate(centre.r, centre.c, p.rot, p.mir);
  return {
    u: gx * GRID_PITCH + local.c + 0.5,
    v: gy * GRID_PITCH + local.r + 0.5,
  };
}

/* Room point, doorway, room point, doorway ... in tile coordinates. */
function routePoints(route) {
  const pts = [];
  route.cells.forEach(function (key, i) {
    pts.push(sectionCentreTile(key, route.sections[i]));
    const e = route.edges[i];
    if (!e) return;
    const tiles = hopTiles(e, key, route.sections[i],
                           route.cells[i + 1], route.sections[i + 1]);
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

export {
  wallsOf,
  nodeNeighbours,
  findRoute,
  routeStillValid,
  routePoints,
  routeLength,
  sectionCentreTile,
  hopTiles,
  groupAtPlacement,
};
