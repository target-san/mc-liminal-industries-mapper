/*
   Binding the map to Minecraft world coordinates.

   The complex is axis aligned with the world and one tile is one block, so a
   single pinned tile fixes every other tile by arithmetic -- no rotation or
   scale factor to store. Columns run east (+X) and rows run south (+Z),
   matching the game's -Z north / -X west convention and the usual top-down
   orientation.

   The anchor is kept as a room plus a tile inside it rather than as a bare
   global tile, because that is how it reads back in the JSON: "room 2,3, its
   tile 10,20, is at X=... Z=...". The global tile is derived.
*/

import { GRID_PITCH, placementKey } from './geometry.js';
import { state } from './store.js';
import { withUndo } from './history.js';
import { markDirty } from './storage.js';

function isAnchored() {
  return !!state.map.anchor;
}

/* The anchor as a global tile plus its world position, or null. */
function anchorOrigin() {
  const a = state.map.anchor;
  if (!a) return null;
  return {
    u: a.gx * GRID_PITCH + a.c,
    v: a.gy * GRID_PITCH + a.r,
    x: a.worldX,
    z: a.worldZ,
  };
}

function worldOfTile(u, v) {
  const o = anchorOrigin();
  if (!o) return null;
  return { x: o.x + (u - o.u), z: o.z + (v - o.v) };
}

function tileOfWorld(x, z) {
  const o = anchorOrigin();
  if (!o) return null;
  return { u: o.u + (x - o.x), v: o.v + (z - o.z) };
}

function setAnchor(gx, gy, r, c, worldX, worldZ) {
  withUndo(function () {
    state.map.anchor = {
      gx: gx, gy: gy, r: r, c: c,
      worldX: Math.round(worldX), worldZ: Math.round(worldZ),
    };
    markDirty();
  });
}

function clearAnchor() {
  if (!state.map.anchor) return;
  withUndo(function () {
    state.map.anchor = null;
    markDirty();
  });
}

/*
   Which placed room owns a global tile. A tile on a shared wall belongs to
   two cells at once, so both are tried and whichever holds a room wins --
   otherwise standing in a doorway would report "outside the map".
*/
function roomAtTile(u, v) {
  const gx = Math.floor(u / GRID_PITCH);
  const gy = Math.floor(v / GRID_PITCH);
  const xs = u - gx * GRID_PITCH === 0 ? [gx, gx - 1] : [gx];
  const ys = v - gy * GRID_PITCH === 0 ? [gy, gy - 1] : [gy];

  for (let a = 0; a < ys.length; a++) {
    for (let b = 0; b < xs.length; b++) {
      const key = placementKey(xs[b], ys[a]);
      if (state.map.placements[key]) return { key: key, gx: xs[b], gy: ys[a] };
    }
  }
  return null;
}

/*
   Reads coordinates the way they actually arrive: typed as "12 -340", or
   pasted straight out of the F3 screen -- "XYZ: 123.456 / 64.00 / -678.90"
   or "Block: 123 64 -679". Three numbers means the middle one is Y and is
   dropped; two means X and Z. Fractions floor to the block they are inside,
   which is what negative coordinates require.
*/
function parseWorldXZ(text) {
  const nums = String(text == null ? "" : text).match(/-?\d+(?:\.\d+)?/g);
  if (!nums) return null;
  if (nums.length >= 3) {
    return { x: Math.floor(Number(nums[0])), z: Math.floor(Number(nums[2])) };
  }
  if (nums.length === 2) {
    return { x: Math.floor(Number(nums[0])), z: Math.floor(Number(nums[1])) };
  }
  return null;
}

function formatXZ(x, z) {
  return "X " + x + ", Z " + z;
}

export {
  isAnchored,
  anchorOrigin,
  worldOfTile,
  tileOfWorld,
  setAnchor,
  clearAnchor,
  roomAtTile,
  parseWorldXZ,
  formatXZ,
};
