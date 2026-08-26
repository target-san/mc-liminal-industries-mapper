/*
   Painting primitives. Pure: these mutate template cells and nothing else,
   which keeps the rules testable without a canvas anywhere in sight.
*/

import { ROOM_SIZE, ROOM_MAX, CELL_COUNT, cellIndex } from './geometry.js';
import { canPaint, defaultSlotAt } from './palette.js';
import { state, templateBitmaps } from './store.js';
import { recordCell } from './history.js';

/* ---------- Painting ---------- */

function paintCell(t, r, c, slot) {
  const entry = state.palette[slot];
  if (!entry || !canPaint(r, c, entry)) return false;
  const i = cellIndex(r, c);
  if (t.cells[i] === slot) return false;
  recordCell(i, t.cells[i]);
  templateBitmaps.delete(t.id);   // invalidate at the write, not at the call site
  t.cells[i] = slot;
  return true;
}

/* Straight line between two tiles, so a fast drag does not leave gaps. */
function paintLine(t, a, b, slotFor) {
  let r = a.r, c = a.c;
  const dr = Math.abs(b.r - r), sr = r < b.r ? 1 : -1;
  const dc = Math.abs(b.c - c), sc = c < b.c ? 1 : -1;
  let err = dc - dr;
  let changed = false;
  for (;;) {
    if (paintCell(t, r, c, slotFor(r, c))) changed = true;
    if (r === b.r && c === b.c) break;
    const e2 = 2 * err;
    if (e2 > -dr) { err -= dr; c += sc; }
    if (e2 <  dc) { err += dc; r += sr; }
  }
  return changed;
}

function paintRect(t, a, b, slotFor) {
  const r0 = Math.min(a.r, b.r), r1 = Math.max(a.r, b.r);
  const c0 = Math.min(a.c, b.c), c1 = Math.max(a.c, b.c);
  let changed = false;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (paintCell(t, r, c, slotFor(r, c))) changed = true;
    }
  }
  return changed;
}

/*
   Flood fill spreads over tiles holding the same slot that the target colour
   is actually allowed on. Because corners reject everything but wall, filling
   a boundary ring with wall passage stops at the corners and covers exactly
   one wall edge -- which is the usual way to open a full width doorway.
*/
function floodFill(t, r0, c0, slot) {
  const entry = state.palette[slot];
  if (!entry) return false;
  const target = t.cells[cellIndex(r0, c0)];
  if (target === slot) return false;
  if (!canPaint(r0, c0, entry)) return false;

  const seen = new Uint8Array(CELL_COUNT);
  const stack = [r0 * ROOM_SIZE + c0];
  let changed = false;
  templateBitmaps.delete(t.id);

  while (stack.length) {
    const i = stack.pop();
    if (seen[i]) continue;
    seen[i] = 1;
    const r = (i / ROOM_SIZE) | 0;
    const c = i % ROOM_SIZE;
    if (t.cells[i] !== target) continue;
    if (!canPaint(r, c, entry)) continue;
    recordCell(i, t.cells[i]);
    t.cells[i] = slot;
    changed = true;
    if (r > 0)        stack.push(i - ROOM_SIZE);
    if (r < ROOM_MAX) stack.push(i + ROOM_SIZE);
    if (c > 0)        stack.push(i - 1);
    if (c < ROOM_MAX) stack.push(i + 1);
  }
  return changed;
}

/* Left button paints the selected colour, right button erases to the tile
   default -- which depends on whether the tile is boundary or interior. */
function slotChooser(erase, slot) {
  return erase ? defaultSlotAt : function () { return slot; };
}

export {
  paintCell,
  paintLine,
  paintRect,
  floodFill,
  slotChooser,
};
