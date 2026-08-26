/*
   Room and grid geometry. Pure: no DOM, no document state.
*/

/* ============================================================
   Geometry
   ------------------------------------------------------------
   A room template is 47x47 tiles: a 45x45 interior surrounded by
   a one tile wall ring. Adjacent rooms on the map share their
   touching wall tile, so the map grid pitch is 46, not 47.
   ============================================================ */

const ROOM_SIZE  = 47;
const ROOM_MAX   = ROOM_SIZE - 1;   // 46, last valid row/column index
const GRID_PITCH = ROOM_SIZE - 1;   // 46, neighbours overlap by one tile
const CELL_COUNT = ROOM_SIZE * ROOM_SIZE;

function cellIndex(r, c) {
  return r * ROOM_SIZE + c;
}

function isBoundary(r, c) {
  return r === 0 || c === 0 || r === ROOM_MAX || c === ROOM_MAX;
}

function isCorner(r, c) {
  return (r === 0 || r === ROOM_MAX) && (c === 0 || c === ROOM_MAX);
}

/*
   Ceiling lamp grid. Counting in from a wall the pattern is two ceiling
   tiles, a lamp, then three ceiling tiles between every later lamp -- so
   lamps sit on tiles 3, 7, 11 ... 43. Eleven rows and eleven columns, with
   the middle one landing on tile 23, which is also the room centre. The
   spacing is symmetric: 43 is as far from the far wall as 3 is from the near.
*/
const LAMP_FIRST = 3;
const LAMP_STEP  = 4;

const LAMP_LINES = (function () {
  const out = [];
  for (let i = LAMP_FIRST; i <= ROOM_MAX - LAMP_FIRST; i += LAMP_STEP) out.push(i);
  return out;
})();

const CENTER_TILE = ROOM_MAX / 2;   // 23, centre of the room, its interior and the lamp grid

/*
   Default doorway: five tiles wide, centred on the middle of each wall, so
   tiles 21..25. Well clear of the corners, which only ever take plain wall.
*/
const DOOR_WIDTH = 5;
const DOOR_LO = CENTER_TILE - (DOOR_WIDTH - 1) / 2;   // 21
const DOOR_HI = CENTER_TILE + (DOOR_WIDTH - 1) / 2;   // 25

/*
   Placement transform: rot is 0..3 quarter turns clockwise, mir mirrors
   horizontally before the rotation is applied. toTemplate() maps a
   placement-local coordinate back into template space and is the single
   place where the transform is defined -- renderer, edge resolution and
   hit testing all go through it.
*/
function toTemplate(r, c, rot, mir) {
  let tr, tc;
  switch (rot & 3) {
    case 0: tr = r;             tc = c;             break;
    case 1: tr = ROOM_MAX - c;  tc = r;             break;
    case 2: tr = ROOM_MAX - r;  tc = ROOM_MAX - c;  break;
    default: tr = c;            tc = ROOM_MAX - r;  break;
  }
  if (mir) tc = ROOM_MAX - tc;
  return { r: tr, c: tc };
}

function fromTemplate(tr, tc, rot, mir) {
  if (mir) tc = ROOM_MAX - tc;
  switch (rot & 3) {
    case 0:  return { r: tr,            c: tc };
    case 1:  return { r: tc,            c: ROOM_MAX - tr };
    case 2:  return { r: ROOM_MAX - tr, c: ROOM_MAX - tc };
    default: return { r: ROOM_MAX - tc, c: tr };
  }
}

/*
   The same transform as a canvas matrix, for blitting a template bitmap into
   its placed orientation. Canvas composes so the last call applies first to
   source coordinates, so the rotation is issued before the mirror to get
   rotate(mirror(p)) -- the order fromTemplate() uses.

   A quarter turn clockwise on the N wide square is (x, y) -> (N - y, x), and
   the horizontal mirror is (x, y) -> (N - x, y).
*/
function applyPlacementTransform(g, rot, mir) {
  for (let k = (rot & 3); k > 0; k--) {
    g.translate(ROOM_SIZE, 0);
    g.rotate(Math.PI / 2);
  }
  if (mir) {
    g.translate(ROOM_SIZE, 0);
    g.scale(-1, 1);
  }
}

/* Map keys. Only open edges are stored; anything absent is a closed wall. */
function placementKey(gx, gy) {
  return gx + "," + gy;
}

/* dir "V": edge between (gx,gy) and (gx+1,gy). "H": between (gx,gy) and (gx,gy+1). */
function edgeKey(gx, gy, dir) {
  return dir + ":" + gx + "," + gy;
}

export {
  ROOM_SIZE,
  ROOM_MAX,
  GRID_PITCH,
  CELL_COUNT,
  cellIndex,
  isBoundary,
  isCorner,
  LAMP_FIRST,
  LAMP_STEP,
  LAMP_LINES,
  CENTER_TILE,
  DOOR_WIDTH,
  DOOR_LO,
  DOOR_HI,
  toTemplate,
  fromTemplate,
  applyPlacementTransform,
  placementKey,
  edgeKey,
};
