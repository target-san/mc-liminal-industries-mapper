/*
   Reserved colours, painting rules and colour maths. Pure.
*/

import { isBoundary, isCorner } from './geometry.js';

/* ============================================================
   Palette
   ------------------------------------------------------------
   The four reserved entries always occupy the first four slots and
   cannot be deleted or have their role changed. User colours are
   appended after them.
   ============================================================ */

const RESERVED_KINDS = ["wall", "passage", "floor", "void", "lamp"];
const RESERVED_COUNT = RESERVED_KINDS.length;
const MAX_PALETTE = 256;   // template cells are one byte per tile

function defaultPalette() {
  return [
    { id: "wall",    name: "Wall",         color: "#31363f", passable: false, kind: "wall"    },
    { id: "passage", name: "Wall passage", color: "#c89b3c", passable: true,  kind: "passage" },
    { id: "floor",   name: "Floor",        color: "#cfcabe", passable: true,  kind: "floor"   },
    { id: "void",    name: "Void",         color: "#0b0d10", passable: false, kind: "void"    },
    { id: "lamp",    name: "Ceiling lamp",  color: "#e9e9e6", passable: true,  kind: "lamp"    },
  ];
}

const SLOT_WALL    = 0;
const SLOT_PASSAGE = 1;
const SLOT_FLOOR   = 2;
const SLOT_VOID    = 3;
const SLOT_LAMP    = 4;

/* Colours handed out to successive "Add colour" clicks. */
const NEW_COLORS = [
  "#7a9e6b", "#6b8fae", "#a06b8f", "#b0803f", "#5f7f7a",
  "#8f6b6b", "#7d6ba0", "#9aa03f", "#4f6d8f", "#a0705a",
];

function paletteSlotById(state, id) {
  return state.palette.findIndex(function (e) { return e.id === id; });
}

/*
   Painting rules:
     - corner tiles are always plain wall,
     - the rest of the boundary ring takes wall or wall passage only,
     - the interior takes anything except wall passage.
*/
function canPaint(r, c, entry) {
  if (isCorner(r, c))   return entry.kind === "wall";
  if (isBoundary(r, c)) return entry.kind === "wall" || entry.kind === "passage";
  return entry.kind !== "passage";
}

/* The slot a tile falls back to when erased. */
function defaultSlotAt(r, c) {
  return isBoundary(r, c) ? SLOT_WALL : SLOT_FLOOR;
}

function parseHexColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return [128, 128, 128];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/* Photographic negative of a colour. Anything near mid grey inverts to
   something almost identical, so those fall back to plain black or white. */
function invertColor(hex) {
  const rgb = parseHexColor(hex);
  const inv = [255 - rgb[0], 255 - rgb[1], 255 - rgb[2]];
  const spread = Math.abs(inv[0] - rgb[0]) + Math.abs(inv[1] - rgb[1]) +
                 Math.abs(inv[2] - rgb[2]);
  if (spread < 160) {
    const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    return lum > 128 ? "#000000" : "#ffffff";
  }
  return "rgb(" + inv[0] + "," + inv[1] + "," + inv[2] + ")";
}

export {
  RESERVED_KINDS,
  RESERVED_COUNT,
  MAX_PALETTE,
  defaultPalette,
  NEW_COLORS,
  SLOT_WALL,
  SLOT_PASSAGE,
  SLOT_FLOOR,
  SLOT_VOID,
  SLOT_LAMP,
  paletteSlotById,
  canPaint,
  defaultSlotAt,
  parseHexColor,
  invertColor,
};
