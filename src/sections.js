/*
   Exit groups: which of a room's doorways reach each other from the inside.

   Routing used to assume every doorway of a room reaches every other. That
   is false for rooms built in two disjoint pieces -- a corridor running above
   a hall, say, where the hall links its north and south exits and the
   corridor links east and west, with no way between them. Such a room is one
   room, not two, but a route must never cross from one piece to the other.

   So a template's doorways are partitioned into groups. Groups are derived
   from the painting by flood fill, which is right for every room whose plan
   view tells the truth. Where it cannot -- overlapping levels flattened into
   one grid -- a template may carry an explicit exitGroups array that wins.
   Absent or stale, the derivation takes over.
*/

import { ROOM_MAX, ROOM_SIZE, CELL_COUNT, cellIndex } from './geometry.js';
import { SLOT_PASSAGE } from './palette.js';
import { state, sectionCache } from './store.js';
import { withUndo } from './history.js';
import { markDirty } from './storage.js';

/*
   The boundary walked in a fixed order -- north, east, south, west -- so run
   numbering is stable across edits and an exitGroups array keeps meaning the
   same thing. Corners are skipped: they are always solid wall.
*/
function boundaryWalk() {
  const walk = [];
  for (let c = 1; c <= ROOM_MAX - 1; c++) walk.push({ side: "N", r: 0, c: c, ir: 1, ic: c });
  for (let r = 1; r <= ROOM_MAX - 1; r++) walk.push({ side: "E", r: r, c: ROOM_MAX, ir: r, ic: ROOM_MAX - 1 });
  for (let c = 1; c <= ROOM_MAX - 1; c++) walk.push({ side: "S", r: ROOM_MAX, c: c, ir: ROOM_MAX - 1, ic: c });
  for (let r = 1; r <= ROOM_MAX - 1; r++) walk.push({ side: "W", r: r, c: 0, ir: r, ic: 1 });
  return walk;
}

const WALK = boundaryWalk();

/* Doorways as runs of adjacent passage tiles. A run never spans two sides. */
function templateRuns(t) {
  const runs = [];
  let cur = null;
  for (let k = 0; k < WALK.length; k++) {
    const w = WALK[k];
    /* cur is cleared on every non-door, so a live cur means the previous
       tile was a door; only a change of side can still break the run. */
    if (t.cells[cellIndex(w.r, w.c)] !== SLOT_PASSAGE) {
      cur = null;
      continue;
    }
    if (cur && cur.side === w.side) {
      cur.tiles.push(cellIndex(w.r, w.c));
      cur.inward.push(cellIndex(w.ir, w.ic));
      continue;
    }
    cur = {
      side: w.side,
      tiles: [cellIndex(w.r, w.c)],
      inward: [cellIndex(w.ir, w.ic)],
    };
    runs.push(cur);
  }
  return runs;
}

/* Connected components of the walkable interior. */
function interiorComponents(t) {
  const passable = state.palette.map(function (e) { return e.passable !== false; });
  const label = new Int16Array(CELL_COUNT).fill(-1);
  let next = 0;

  for (let r = 1; r <= ROOM_MAX - 1; r++) {
    for (let c = 1; c <= ROOM_MAX - 1; c++) {
      const start = cellIndex(r, c);
      if (label[start] !== -1) continue;
      if (!passable[t.cells[start]]) continue;
      const id = next++;
      const stack = [start];
      while (stack.length) {
        const i = stack.pop();
        if (label[i] !== -1) continue;
        if (!passable[t.cells[i]]) continue;
        label[i] = id;
        const rr = (i / ROOM_SIZE) | 0;
        const cc = i % ROOM_SIZE;
        if (rr > 1) stack.push(i - ROOM_SIZE);
        if (rr < ROOM_MAX - 1) stack.push(i + ROOM_SIZE);
        if (cc > 1) stack.push(i - 1);
        if (cc < ROOM_MAX - 1) stack.push(i + 1);
      }
    }
  }
  return label;
}

/*
   Groups derived from the painting. Runs whose inward tiles land in the same
   walkable component share a group. A doorway walled off from the inside gets
   a group of its own, so it connects to nothing.
*/
function derivedGroups(t, runs) {
  const label = interiorComponents(t);
  const byComponent = new Map();
  const groups = [];
  let next = 0;

  runs.forEach(function (run) {
    let comp = -1;
    for (let k = 0; k < run.inward.length && comp === -1; k++) {
      if (label[run.inward[k]] !== -1) comp = label[run.inward[k]];
    }
    if (comp === -1) {
      groups.push(next++);          // sealed off: its own group
      return;
    }
    if (!byComponent.has(comp)) byComponent.set(comp, next++);
    groups.push(byComponent.get(comp));
  });
  return groups;
}

/* Renumbers arbitrary group ids into a dense 0..n-1 in run order. */
function densify(ids) {
  const seen = new Map();
  return ids.map(function (id) {
    if (!seen.has(id)) seen.set(id, seen.size);
    return seen.get(id);
  });
}

/*
   Everything routing and the editor need about one template's exits.
   Cached; the cache is dropped whenever the template changes.
*/
function sectionsOf(t) {
  const cached = sectionCache.get(t.id);
  if (cached) return cached;

  const runs = templateRuns(t);
  const manual = Array.isArray(t.exitGroups) &&
                 t.exitGroups.length === runs.length &&
                 t.exitGroups.every(function (n) { return Number.isInteger(n) && n >= 0; });
  const groups = densify(manual ? t.exitGroups : derivedGroups(t, runs));

  const tileGroup = new Map();
  runs.forEach(function (run, i) {
    run.group = groups[i];
    run.tiles.forEach(function (cell) { tileGroup.set(cell, groups[i]); });
  });

  /* A point inside the room for each group, for drawing routes through it. */
  const sums = [];
  runs.forEach(function (run, i) {
    const g = groups[i];
    if (!sums[g]) sums[g] = { r: 0, c: 0, n: 0 };
    run.inward.forEach(function (cell) {
      sums[g].r += (cell / ROOM_SIZE) | 0;
      sums[g].c += cell % ROOM_SIZE;
      sums[g].n += 1;
    });
  });
  const centres = sums.map(function (s) {
    return s && s.n ? { r: s.r / s.n, c: s.c / s.n }
                    : { r: ROOM_MAX / 2, c: ROOM_MAX / 2 };
  });

  const info = {
    runs: runs,
    groups: groups,
    count: centres.length,
    tileGroup: tileGroup,
    centres: centres,
    manual: manual,
  };
  sectionCache.set(t.id, info);
  return info;
}

/* The group a template tile belongs to, or -1 if it is not a doorway. */
function groupAtCell(t, r, c) {
  const g = sectionsOf(t).tileGroup.get(cellIndex(r, c));
  return g === undefined ? -1 : g;
}

/* Writes the current grouping down so one run can then be moved. */
function setExitGroup(t, runIndex, group) {
  const info = sectionsOf(t);
  if (runIndex < 0 || runIndex >= info.runs.length) return;
  const next = info.groups.slice();
  next[runIndex] = group;
  withUndo(function () {
    t.exitGroups = next;
    sectionCache.delete(t.id);
    markDirty();
  });
}

function clearExitGroups(t) {
  if (!Array.isArray(t.exitGroups)) return;
  withUndo(function () {
    delete t.exitGroups;
    sectionCache.delete(t.id);
    markDirty();
  });
}

export {
  templateRuns,
  interiorComponents,
  derivedGroups,
  sectionsOf,
  groupAtCell,
  setExitGroup,
  clearExitGroups,
};
