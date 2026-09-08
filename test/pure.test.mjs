/*
   Unit tests over the DOM-free modules. These import src/ directly: no stub,
   no bundler, no canvas.
*/
import * as geometry from '../src/geometry.js';
import * as palette from '../src/palette.js';
import * as doc from '../src/document.js';
import * as store from '../src/store.js';
import * as history from '../src/history.js';
import * as paint from '../src/paint.js';
import * as ops from '../src/ops.js';
import * as edges from '../src/edges.js';
import * as storage from '../src/storage.js';
import * as world from '../src/world.js';
import * as route from '../src/route.js';
import * as sections from '../src/sections.js';
import * as rooms from '../src/rooms.js';
import { ui as hooks } from '../src/hooks.js';
import { flatten, checker } from './util.mjs';

/*
   ops.js asks its questions through the UI hooks. Their defaults decline, so
   tests must opt in explicitly -- which is the point: a confirmation that
   defaults to yes is how destructive code slips through untested.
*/
let answerConfirm = true;
hooks.askConfirm = () => Promise.resolve(answerConfirm);
hooks.askText = () => Promise.resolve('renamed');
hooks.showError = () => Promise.resolve();

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const T = flatten({ geometry, palette, doc, store, history, paint, ops, edges, storage, world, route, rooms, sections });
const { ok, totals } = checker('pure');

/* ---- geometry: the transform pair ---- */
let bad = '';
for (let rot = 0; rot < 4 && !bad; rot++) for (const mir of [false, true]) {
  for (let r = 0; r < T.ROOM_SIZE && !bad; r++) for (let c = 0; c < T.ROOM_SIZE; c++) {
    const t = T.toTemplate(r, c, rot, mir);
    const back = T.fromTemplate(t.r, t.c, rot, mir);
    if (back.r !== r || back.c !== c) { bad = `rot=${rot} mir=${mir} (${r},${c})`; break; }
  }
}
ok('toTemplate/fromTemplate round-trip, all 8 orientations', !bad, bad);

let bij = true, ring = true;
for (let rot = 0; rot < 4; rot++) for (const mir of [false, true]) {
  const seen = new Set();
  for (let r = 0; r < T.ROOM_SIZE; r++) for (let c = 0; c < T.ROOM_SIZE; c++) {
    const t = T.toTemplate(r, c, rot, mir);
    seen.add(t.r * T.ROOM_SIZE + t.c);
    if (T.isBoundary(r, c) !== T.isBoundary(t.r, t.c)) ring = false;
    if (T.isCorner(r, c) !== T.isCorner(t.r, t.c)) ring = false;
  }
  if (seen.size !== T.CELL_COUNT) bij = false;
}
ok('every orientation is a bijection', bij);
ok('transforms preserve the wall ring and corners', ring);

/* the canvas blit matrix must agree with the model transform */
function matrixCtx() {
  let m = [1, 0, 0, 1, 0, 0];
  const mul = (n) => {
    m = [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
         m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
         m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  };
  return {
    translate: (x, y) => mul([1, 0, 0, 1, x, y]),
    scale: (x, y) => mul([x, 0, 0, y, 0, 0]),
    rotate: (a) => mul([Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]),
    apply: (x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }),
  };
}
let blitBad = '', footprint = true;
for (let rot = 0; rot < 4 && !blitBad; rot++) for (const mir of [false, true]) {
  const g = matrixCtx();
  T.applyPlacementTransform(g, rot, mir);
  for (let tr = 0; tr < T.ROOM_SIZE && !blitBad; tr++) for (let tc = 0; tc < T.ROOM_SIZE; tc++) {
    const got = g.apply(tc + 0.5, tr + 0.5);
    const want = T.fromTemplate(tr, tc, rot, mir);
    if (Math.abs(got.x - (want.c + 0.5)) > 1e-6 || Math.abs(got.y - (want.r + 0.5)) > 1e-6) {
      blitBad = `rot=${rot} mir=${mir} tile(${tr},${tc})`;
      break;
    }
  }
  for (const [x, y] of [[0, 0], [T.ROOM_SIZE, 0], [0, T.ROOM_SIZE], [T.ROOM_SIZE, T.ROOM_SIZE]]) {
    const q = g.apply(x, y);
    if (q.x < -1e-6 || q.y < -1e-6 || q.x > T.ROOM_SIZE + 1e-6 || q.y > T.ROOM_SIZE + 1e-6) footprint = false;
  }
}
ok('blit matrix matches fromTemplate for all 8 orientations', !blitBad, blitBad);
ok('every orientation stays inside the 47x47 footprint', footprint);

/* ---- grid pitch ---- */
ok('grid pitch is one less than the room', T.GRID_PITCH === T.ROOM_SIZE - 1);
const hiA = 0 * T.GRID_PITCH + T.ROOM_MAX, loB = 1 * T.GRID_PITCH;
ok('adjacent cells overlap on exactly one tile',
   Math.min(hiA, loB + T.ROOM_MAX) - Math.max(0, loB) + 1 === 1);
ok('the shared tile is one room\'s far wall and the next room\'s near wall', hiA === loB);

/* ---- painting rules ---- */
const P = T.defaultPalette();
ok('corner rejects passage', !T.canPaint(0, 0, P[T.SLOT_PASSAGE]));
ok('corner rejects floor', !T.canPaint(0, 0, P[T.SLOT_FLOOR]));
ok('corner accepts wall', T.canPaint(0, 0, P[T.SLOT_WALL]));
ok('boundary accepts passage', T.canPaint(0, 5, P[T.SLOT_PASSAGE]));
ok('boundary rejects floor', !T.canPaint(0, 5, P[T.SLOT_FLOOR]));
ok('interior rejects passage', !T.canPaint(5, 5, P[T.SLOT_PASSAGE]));
ok('interior accepts void', T.canPaint(5, 5, P[T.SLOT_VOID]));
ok('lamps are paintable in the interior', T.canPaint(3, 3, P[T.SLOT_LAMP]));
ok('lamps are rejected on the wall ring', !T.canPaint(0, 3, P[T.SLOT_LAMP]));

/* ---- lamp grid and default doorways ---- */
ok('11 lamp rows/columns', T.LAMP_LINES.length === 11, `n=${T.LAMP_LINES.length}`);
ok('lamps run 3..43 in steps of 4',
   T.LAMP_LINES.every((v, i) => v === 3 + 4 * i) && T.LAMP_LINES[10] === 43);
ok('the centre lamp is the room centre', T.LAMP_LINES.includes(T.CENTER_TILE));
ok('lamp spacing is symmetric about the walls', T.LAMP_LINES[0] === T.ROOM_MAX - T.LAMP_LINES[10]);
ok('lamps never touch the wall ring', T.LAMP_LINES.every((i) => i > 0 && i < T.ROOM_MAX));

const fresh = T.createTemplate('fresh');
let lamps = 0, offGrid = 0, doors = 0, doorsOffWall = 0;
for (let r = 0; r < T.ROOM_SIZE; r++) for (let c = 0; c < T.ROOM_SIZE; c++) {
  const v = fresh.cells[T.cellIndex(r, c)];
  if (v === T.SLOT_LAMP) {
    lamps++;
    if (!T.LAMP_LINES.includes(r) || !T.LAMP_LINES.includes(c)) offGrid++;
  }
  if (v === T.SLOT_PASSAGE) {
    doors++;
    if (!T.isBoundary(r, c) || T.isCorner(r, c)) doorsOffWall++;
  }
}
ok('a default room has 121 lamps', lamps === 121, `n=${lamps}`);
ok('every lamp sits on a grid intersection', offGrid === 0);
ok('four 5-tile doorways', doors === 20, `n=${doors}`);
ok('no doorway tile is off-wall or on a corner', doorsOffWall === 0);
ok('each doorway spans 21..25 centred on 23',
   [21, 22, 23, 24, 25].every((i) =>
     fresh.cells[T.cellIndex(0, i)] === T.SLOT_PASSAGE &&
     fresh.cells[T.cellIndex(T.ROOM_MAX, i)] === T.SLOT_PASSAGE &&
     fresh.cells[T.cellIndex(i, 0)] === T.SLOT_PASSAGE &&
     fresh.cells[T.cellIndex(i, T.ROOM_MAX)] === T.SLOT_PASSAGE));
ok('the tiles flanking a doorway are still wall',
   fresh.cells[T.cellIndex(0, 20)] === T.SLOT_WALL &&
   fresh.cells[T.cellIndex(0, 26)] === T.SLOT_WALL);

/* ---- flood fill against the default doorway ---- */
T.addTemplate();
const wallId = T.sel;
const tpl = () => T.state.templates.find((t) => t.id === wallId);
const rowPass = (r) => {
  let n = 0;
  for (let c = 0; c < T.ROOM_SIZE; c++)
    if (tpl().cells[T.cellIndex(r, c)] === T.SLOT_PASSAGE) n++;
  return n;
};
ok('a fresh wall carries only its 5-tile doorway', rowPass(0) === 5, `n=${rowPass(0)}`);

T.beginStroke(tpl()); T.floodFill(tpl(), 0, 5, T.SLOT_PASSAGE); T.endStroke();
ok('flood fill stops at the existing doorway instead of crossing it',
   rowPass(0) === 25 && tpl().cells[T.cellIndex(0, 26)] === T.SLOT_WALL, `n=${rowPass(0)}`);
ok('the fill does not leak past a corner into the next wall',
   rowPass(T.ROOM_MAX) === 5 && tpl().cells[T.cellIndex(0, 0)] === T.SLOT_WALL);

T.beginStroke(tpl()); T.floodFill(tpl(), 0, 30, T.SLOT_PASSAGE); T.endStroke();
ok('a second fill opens the remainder', rowPass(0) === 45, `n=${rowPass(0)}`);

T.undo();
ok('undo closes the second segment', rowPass(0) === 25, `n=${rowPass(0)}`);
T.undo();
ok('undo closes the first segment too', rowPass(0) === 5, `n=${rowPass(0)}`);
T.redo(); T.redo();
ok('redo reopens the whole edge', rowPass(0) === 45, `n=${rowPass(0)}`);

/* ---- a stroke that nets to nothing records nothing ---- */
const depth = T.undoHistory.past.length;
T.beginStroke(tpl());
T.paintCell(tpl(), 10, 10, T.SLOT_VOID);
T.paintCell(tpl(), 10, 10, T.SLOT_FLOOR);
T.endStroke();
ok('a stroke that nets to no change adds no undo entry', T.undoHistory.past.length === depth);

/* ---- serialization ---- */
T.beginStroke(tpl());
for (let r = 5; r < 20; r++) for (let c = 5; c < 30; c++) T.paintCell(tpl(), r, c, T.SLOT_VOID);
T.endStroke();
const before = JSON.stringify(T.serialize(T.state));
const round = JSON.stringify(T.serialize(T.deserialize(JSON.parse(before))));
ok('document survives a serialize/deserialize round-trip', before === round);

const runs = T.encodeCells(tpl().cells);
const back = T.decodeCells(runs, 'test');
ok('RLE round-trips cells exactly', back.every((v, i) => v === tpl().cells[i]));
ok('RLE compresses a default room well under its tile count',
   T.encodeCells(T.createTemplate('x').cells).length < T.CELL_COUNT / 4);

/* ---- loading a pre-lamp (v1) document remaps its custom slots ---- */
const P4 = [
  { id: 'wall', name: 'Wall', color: '#31363f', passable: false, kind: 'wall' },
  { id: 'passage', name: 'Wall passage', color: '#c89b3c', passable: true, kind: 'passage' },
  { id: 'floor', name: 'Floor', color: '#cfcabe', passable: true, kind: 'floor' },
  { id: 'void', name: 'Void', color: '#0b0d10', passable: false, kind: 'void' },
];
const custom = { id: 'col-old', name: 'Old', color: '#ff0000', passable: true, kind: 'custom' };
const legacyDoc = (pal, slotInFile) => ({
  format: 'liminal-industries-mapper', version: 1, roomSize: 47, palette: pal,
  templates: [{ id: 't-legacy', name: 'Legacy', cells:
    [[T.SLOT_FLOOR, 100], [slotInFile, 1], [T.SLOT_FLOOR, T.CELL_COUNT - 101]] }],
  map: { placements: {}, openEdges: [], anchor: null },
});

const legacy = T.deserialize(legacyDoc(P4.concat([custom]), 4));
ok('lamp is inserted as reserved slot 4', legacy.palette[4].id === 'lamp');
ok('the legacy custom colour moves to slot 5', legacy.palette[5].id === 'col-old');
ok('legacy cells are remapped to the new slot', legacy.templates[0].cells[100] === 5);
ok('legacy palette keeps its custom colour value', legacy.palette[5].color === '#ff0000');

const shuffled = T.deserialize(legacyDoc([custom].concat(P4), 0));
ok('a reordered palette still remaps cells',
   shuffled.palette[5].id === 'col-old' && shuffled.templates[0].cells[100] === 5);
ok('a reordered palette keeps reserved entries in place',
   shuffled.palette.slice(0, 5).map((e) => e.id).join(',') === 'wall,passage,floor,void,lamp');

let rejected = false;
try { T.deserialize(legacyDoc(P4, 9)); } catch { rejected = true; }
ok('a cell referencing a missing palette slot is rejected', rejected);

/* ---- structural undo ---- */
const nBefore = T.state.templates.length;
const doomed = wallId;
await T.deleteTemplate(doomed);
ok('delete removes the template', T.state.templates.length === nBefore - 1);
T.undo();
ok('undo restores the deleted template', T.state.templates.length === nBefore);
ok('undo restores its id', T.state.templates.some((t) => t.id === doomed));
ok('undo restores the selection', T.sel === doomed, `sel=${T.sel}`);

/* ---- palette delete remaps every template ---- */
await T.addPaletteColor();
const newSlot = T.state.palette.length - 1;
const t2 = T.state.templates.find((t) => t.id === doomed);
T.beginStroke(t2);
T.paintCell(t2, 8, 8, newSlot);
T.paintCell(t2, 8, 9, newSlot);
T.endStroke();
ok('painted with the new custom colour', t2.cells[T.cellIndex(8, 8)] === newSlot);
await T.deletePaletteColor(newSlot);
const t3 = T.state.templates.find((t) => t.id === doomed);
ok('deleting a colour falls its tiles back to floor',
   t3.cells[T.cellIndex(8, 8)] === T.SLOT_FLOOR && t3.cells[T.cellIndex(8, 9)] === T.SLOT_FLOOR);
ok('no cell references a slot past the palette end',
   T.state.templates.every((t) => t.cells.every((v) => v < T.state.palette.length)));
T.undo();
const t4 = T.state.templates.find((t) => t.id === doomed);
ok('undoing a colour delete restores the painted tiles', t4.cells[T.cellIndex(8, 8)] === newSlot);

/* ---- history bookkeeping ---- */
const capTpl = () => T.state.templates.find((t) => t.id === doomed);
for (let i = 0; i < 140; i++) {
  const r = 20, c = 5 + (i % 30);
  const cur = capTpl().cells[T.cellIndex(r, c)];
  T.beginStroke(capTpl());
  T.paintCell(capTpl(), r, c, cur === T.SLOT_VOID ? T.SLOT_FLOOR : T.SLOT_VOID);
  T.endStroke();
}
ok('history is capped at 100 entries', T.undoHistory.past.length === 100,
   `len=${T.undoHistory.past.length}`);
T.undo(); T.undo();
ok('undo populates the redo stack', T.undoHistory.future.length === 2);
T.beginStroke(capTpl());
T.paintCell(capTpl(), 30, 30, T.SLOT_VOID);
T.endStroke();
ok('a new action clears the redo stack', T.undoHistory.future.length === 0);

/* ---- declining a dialog must change nothing ---- */
answerConfirm = false;
const keepId = T.state.templates[0].id;
const keepCount = T.state.templates.length;
await T.deleteTemplate(keepId);
ok('a declined confirmation leaves the template in place',
   T.state.templates.length === keepCount &&
   T.state.templates.some((t) => t.id === keepId));

const histBefore = T.undoHistory.past.length;
const palBefore = T.state.palette.length;
await T.deletePaletteColor(T.state.palette.length - 1);
ok('a declined colour delete leaves the palette in place',
   T.state.palette.length === palBefore);
ok('a declined dialog records no undo entry',
   T.undoHistory.past.length === histBefore, `${histBefore} -> ${T.undoHistory.past.length}`);

/* the shipped defaults refuse, so an unbound UI cannot delete anything */
const savedConfirm = hooks.askConfirm;
hooks.askConfirm = () => Promise.resolve(false);
await T.deleteTemplate(keepId);
ok('the default hook declines rather than assuming yes',
   T.state.templates.some((t) => t.id === keepId));
hooks.askConfirm = savedConfirm;
answerConfirm = true;

/* ================= phase 4: walls between rooms ================= */

/* A clean document, so earlier tests' paint strokes cannot skew this. */
T.setState(T.createDocument());
const roomA = T.createTemplate('A');
const roomB = T.createTemplate('B');
T.state.templates.push(roomA, roomB);

function place(gx, gy, id, rot, mir) {
  T.state.map.placements[T.placementKey(gx, gy)] =
    { templateId: id, rot: rot || 0, mir: mir === true };
}

place(0, 0, roomA.id);
place(1, 0, roomB.id);

const shared = T.sharedPassages(0, 0, 'V');
ok('two default rooms share their 5 doorway tiles',
   shared.join(',') === '21,22,23,24,25', shared.join(','));
ok('the shared line never includes a corner',
   shared.every((i) => i >= T.EDGE_LO && i <= T.EDGE_HI) &&
   T.EDGE_LO === 1 && T.EDGE_HI === T.ROOM_MAX - 1);
ok('the edge is openable', T.edgeOpenable(0, 0, 'V'));
ok('the edge starts closed', !T.isEdgeOpen(0, 0, 'V'));

/* the shared tile really is one room's far wall and the other's near wall */
const loc = T.edgeLocal('V', 23);
ok('a vertical edge is A\'s right wall and B\'s left wall',
   loc.a.c === T.ROOM_MAX && loc.b.c === 0 && loc.a.r === 23 && loc.b.r === 23);
const gt = T.edgeTile(0, 0, 'V', 23);
ok('the shared tile is at the pitch boundary', gt.u === T.GRID_PITCH && gt.v === 23);

/* rotation and mirroring must not break a symmetric room's doorways */
let alignedEverywhere = true;
for (let rot = 0; rot < 4; rot++) for (const mir of [false, true]) {
  place(1, 0, roomB.id, rot, mir);
  if (T.sharedPassages(0, 0, 'V').join(',') !== '21,22,23,24,25') alignedEverywhere = false;
}
ok('a default room stays aligned in all 8 orientations', alignedEverywhere);
place(1, 0, roomB.id);

/* horizontal edges work the same way */
place(0, 1, roomB.id);
ok('a horizontal edge shares the same 5 tiles',
   T.sharedPassages(0, 1 - 1, 'H').join(',') === '21,22,23,24,25');
delete T.state.map.placements[T.placementKey(0, 1)];

/* ---- toggling ---- */
ok('toggle opens the edge', T.toggleEdge(0, 0, 'V') && T.isEdgeOpen(0, 0, 'V'));
ok('toggle closes it again', T.toggleEdge(0, 0, 'V') && !T.isEdgeOpen(0, 0, 'V'));
T.toggleEdge(0, 0, 'V');
T.undo();
ok('opening a wall is one undo step', !T.isEdgeOpen(0, 0, 'V'));

/* ---- a wall with no overlap cannot be opened ---- */
const sealed = T.createTemplate('sealed');
for (let i = 21; i <= 25; i++) {
  sealed.cells[T.cellIndex(i, 0)] = T.SLOT_WALL;         // brick up the left wall
  sealed.cells[T.cellIndex(i, T.ROOM_MAX)] = T.SLOT_WALL;
}
T.state.templates.push(sealed);
place(1, 0, sealed.id);
ok('a bricked-up wall shares nothing', T.sharedPassages(0, 0, 'V').length === 0);
ok('and cannot be opened', !T.edgeOpenable(0, 0, 'V'));
ok('toggling it is refused', T.toggleEdge(0, 0, 'V') === false && !T.isEdgeOpen(0, 0, 'V'));

/* ---- an edge that stops lining up gets pruned ---- */
place(1, 0, roomB.id);
T.toggleEdge(0, 0, 'V');
ok('reopened after restoring the neighbour', T.isEdgeOpen(0, 0, 'V'));
place(1, 0, sealed.id);
T.pruneEdgesAt(1, 0);
ok('pruning drops a wall that no longer lines up', !T.isEdgeOpen(0, 0, 'V'));

/* ---- an edge needs rooms on both sides ---- */
delete T.state.map.placements[T.placementKey(1, 0)];
ok('a wall with nothing behind it does not connect', !T.edgeConnects(0, 0, 'V'));
ok('and shares nothing', T.sharedPassages(0, 0, 'V').length === 0);

/* ---- run grouping, used for drawing doorways ---- */
ok('consecutive indices collapse into one run',
   JSON.stringify(T.runsOf([21, 22, 23, 24, 25])) === '[[21,25]]');
ok('gaps split runs',
   JSON.stringify(T.runsOf([3, 4, 10, 11, 12, 20])) === '[[3,4],[10,12],[20,20]]');
ok('an empty list yields no runs', T.runsOf([]).length === 0);

/* ---- adjacency enumeration visits each wall once ---- */
place(0, 0, roomA.id); place(1, 0, roomA.id); place(0, 1, roomA.id);
const seenEdges = [];
T.eachAdjacency((gx, gy, dir) => seenEdges.push(dir + ':' + gx + ',' + gy));
ok('each adjacency is visited exactly once',
   seenEdges.length === 2 && new Set(seenEdges).size === 2, seenEdges.join(' '));

/* ================= phase 6: routing ================= */

T.setState(T.createDocument());
const rt = T.createTemplate('R');
T.state.templates.push(rt);
const put = (gx, gy) => {
  T.state.map.placements[T.placementKey(gx, gy)] = { templateId: rt.id, rot: 0, mir: false };
};
const open = (gx, gy, dir) => T.state.map.openEdges.add(T.edgeKey(gx, gy, dir));

put(0, 0); put(1, 0); put(2, 0);

ok('with every wall shut there is no route', T.findRoute('0,0', '2,0') === null);
const self = T.findRoute('0,0', '0,0');
ok('a room routes to itself in one step',
   self.cells.join() === '0,0' && self.edges.length === 0);
ok('a room that is not placed has no route', T.findRoute('0,0', '9,9') === null);

open(0, 0, 'V');
ok('one open wall is still not enough to reach the far room',
   T.findRoute('0,0', '2,0') === null);
ok('but the adjacent room is reachable',
   T.findRoute('0,0', '1,0').cells.join('|') === '0,0|1,0');

open(1, 0, 'V');
const line = T.findRoute('0,0', '2,0');
ok('opening the second wall completes the route',
   line && line.cells.join('|') === '0,0|1,0|2,0', line && line.cells.join('|'));
ok('there is one wall crossing per room gap', line.edges.length === line.cells.length - 1);

/* the polyline alternates room centre and doorway */
const pts = T.routePoints(line);
ok('the path runs centre, door, centre, door, centre', pts.length === 5);
ok('it starts at the first room centre',
   Math.abs(pts[0].u - (T.CENTER_TILE + 0.5)) < 1e-9);
ok('the doorways sit on the shared wall columns',
   Math.abs(pts[1].u - (T.GRID_PITCH + 0.5)) < 1e-9 &&
   Math.abs(pts[3].u - (2 * T.GRID_PITCH + 0.5)) < 1e-9);
ok('the walk is roughly two room pitches long',
   Math.abs(T.routeLength(line) - 2 * T.GRID_PITCH) <= 2, String(T.routeLength(line)));

/* neighbours honour the walls */
ok('a shut wall is not a neighbour',
   T.nodeNeighbours('2,0', 0).map((n) => n.node).join('|') === '1,0#0');

/* breadth first must return the fewest rooms, not merely some route */
put(0, 1); put(1, 1); put(2, 1);
open(0, 1, 'V'); open(1, 1, 'V');
open(0, 0, 'H'); open(2, 0, 'H');
const short = T.findRoute('0,0', '2,1');
ok('the route crosses the fewest rooms', short.cells.length === 4, short.cells.join('|'));

/* A route goes stale when the map underneath it changes. Both checks work
   off the route that was actually found: with two equally short options,
   which one BFS returns is an implementation detail. */
ok('a fresh route is valid', T.routeStillValid(short));

const cut = short.edges[0];
T.state.map.openEdges.delete(T.edgeKey(cut.gx, cut.gy, cut.dir));
ok('closing a wall along the route invalidates it', !T.routeStillValid(short));
open(cut.gx, cut.gy, cut.dir);
ok('reopening it makes the route good again', T.routeStillValid(short));

const midKey = short.cells[1];
const midRoom = T.state.map.placements[midKey];
delete T.state.map.placements[midKey];
ok('removing a room along the route invalidates it', !T.routeStillValid(short));
T.state.map.placements[midKey] = midRoom;
ok('putting it back makes the route good again', T.routeStillValid(short));

/* an unopenable wall is never walked, even if the edge got marked open */
const brick = T.createTemplate('brick');
for (let i = 21; i <= 25; i++) {
  brick.cells[T.cellIndex(i, 0)] = T.SLOT_WALL;
  brick.cells[T.cellIndex(i, T.ROOM_MAX)] = T.SLOT_WALL;
}
T.state.templates.push(brick);
T.setState(T.state);
T.state.map.placements = {};
T.state.map.openEdges.clear();
put(0, 0);
T.state.map.placements['1,0'] = { templateId: brick.id, rot: 0, mir: false };
open(0, 0, 'V');
ok('a wall with no shared doorway is not walkable even when marked open',
   T.findRoute('0,0', '1,0') === null);

/* ---- exit groups: which doorways reach each other ---- */
const plain = T.createTemplate('plain');
const plainInfo = T.sectionsOf(plain);
ok('a default room has four doorways', plainInfo.runs.length === 4, String(plainInfo.runs.length));
ok('walked north, east, south, west',
   plainInfo.runs.map((r) => r.side).join('') === 'NESW');
ok('each doorway is five tiles wide',
   plainInfo.runs.every((r) => r.tiles.length === 5));
ok('and they all connect, so one group',
   plainInfo.count === 1 && !plainInfo.manual);

const split = T.createTemplate('split');
for (let i = 21; i <= 25; i++) {
  split.cells[T.cellIndex(i, 0)] = T.SLOT_WALL;          // leave only north and south
  split.cells[T.cellIndex(i, T.ROOM_MAX)] = T.SLOT_WALL;
}
for (let c = 1; c <= 45; c++) split.cells[T.cellIndex(23, c)] = T.SLOT_VOID;
const splitInfo = T.sectionsOf(split);
ok('a room cut in half has two doorways in two groups',
   splitInfo.runs.length === 2 && splitInfo.count === 2, JSON.stringify(splitInfo.groups));

const walledOff = T.createTemplate('walledOff');
for (let c = 1; c <= 45; c++) walledOff.cells[T.cellIndex(1, c)] = T.SLOT_VOID;  // brick behind north
const sealedInfo = T.sectionsOf(walledOff);
ok('a doorway walled off from inside gets a group to itself',
   sealedInfo.count === 2 && sealedInfo.groups[0] !== sealedInfo.groups[1],
   JSON.stringify(sealedInfo.groups));

/* the derivation is cached, so it must die when the painting changes */
const cacheT = T.createTemplate('cache');
T.state.templates.push(cacheT);
const cacheId = cacheT.id;
const cached = () => T.state.templates.find((x) => x.id === cacheId);
ok('starts as one group', T.sectionsOf(cached()).count === 1);
T.beginStroke(cached());
for (let c = 1; c <= 45; c++) T.paintCell(cached(), 1, c, T.SLOT_VOID);
T.endStroke();
ok('repainting a room re-derives its exit groups',
   T.sectionsOf(cached()).count === 2, String(T.sectionsOf(cached()).count));

/* ---- the manual override, for rooms a flat plan cannot express ---- */
const overT = T.createTemplate('over');
T.state.templates.push(overT);
const overId = overT.id;
const over = () => T.state.templates.find((x) => x.id === overId);

ok('it starts derived', T.sectionsOf(over()).count === 1 && !T.sectionsOf(over()).manual);
T.setExitGroup(over(), 1, 1);        // east doorway into a group of its own
ok('an override splits the doorways',
   T.sectionsOf(over()).count === 2 && T.sectionsOf(over()).manual);
T.undo();
ok('overriding is one undo step',
   T.sectionsOf(over()).count === 1 && !T.sectionsOf(over()).manual);
T.redo();
ok('and redoes', T.sectionsOf(over()).manual);
T.clearExitGroups(over());
ok('clearing returns to the derived grouping',
   T.sectionsOf(over()).count === 1 && !T.sectionsOf(over()).manual);

/* ---- a group is set, not cycled ---- */
const setT = T.createTemplate('set');
T.state.templates.push(setT);
const setId = setT.id;
const setL = () => T.state.templates.find((x) => x.id === setId);
const groupsOf = () => T.sectionsOf(setL()).groups.join(',');

ok('a fresh room has every doorway together', groupsOf() === '0,0,0,0');

T.setExitGroup(setL(), 1, 2);
ok('a doorway goes exactly where it was put', groupsOf() === '0,2,0,0', groupsOf());
ok('gaps in the numbering are kept, not squeezed out',
   T.sectionsOf(setL()).ids.join(',') === '0,2', T.sectionsOf(setL()).ids.join(','));
ok('and the count is the number of groups in use', T.sectionsOf(setL()).count === 2);

T.setExitGroup(setL(), 3, 2);
ok('two doorways can share a group', groupsOf() === '0,2,0,2', groupsOf());
ok('which is two groups, not three', T.sectionsOf(setL()).count === 2);

/* setting the same group again is a no-op, not another undo step */
const depthBefore = T.undoHistory.past.length;
T.setExitGroup(setL(), 3, 2);
ok('setting the group it is already in records nothing',
   T.undoHistory.past.length === depthBefore && groupsOf() === '0,2,0,2');

/* every button reaches its group directly, from anywhere */
[0, 1, 2, 3].forEach((g) => {
  T.setExitGroup(setL(), 0, g);
  ok('group ' + g + ' is one click away', T.sectionsOf(setL()).groups[0] === g);
});

/* the D group -- unreachable under the old cycling -- included */
T.setExitGroup(setL(), 0, 3);
T.setExitGroup(setL(), 1, 3);
T.setExitGroup(setL(), 2, 3);
T.setExitGroup(setL(), 3, 3);
ok('all four doorways can sit in the last group', groupsOf() === '3,3,3,3');
ok('which is still one group', T.sectionsOf(setL()).count === 1);

/* out of range is refused rather than wrapped */
T.setExitGroup(setL(), 0, T.GROUP_COUNT);
ok('a group past the last is refused', groupsOf() === '3,3,3,3');
T.setExitGroup(setL(), 0, -1);
ok('and so is a negative one', groupsOf() === '3,3,3,3');

/* routing still enumerates sparse ids correctly, on a corner of the grid
   the other tests do not touch */
const sparseT = T.createTemplate('sparse');
sparseT.exitGroups = [3, 3, 3, 3];
const plainNb = T.createTemplate('plain nb');
T.state.templates.push(sparseT, plainNb);
T.state.map.placements[T.placementKey(50, 50)] = { templateId: sparseT.id, rot: 0, mir: false };
T.state.map.placements[T.placementKey(51, 50)] = { templateId: plainNb.id, rot: 0, mir: false };
T.state.map.openEdges.add(T.edgeKey(50, 50, 'V'));
ok('a room whose only group is D still routes',
   (T.findRoute('50,50', '51,50') || {}).cells?.join('|') === '50,50|51,50');
ok('and back the other way',
   (T.findRoute('51,50', '50,50') || {}).cells?.join('|') === '51,50|50,50');
delete T.state.map.placements[T.placementKey(50, 50)];
delete T.state.map.placements[T.placementKey(51, 50)];
T.state.map.openEdges.delete(T.edgeKey(50, 50, 'V'));

/* a grouping that no longer matches the doorways is ignored, not obeyed */
over().exitGroups = [0, 1];
ok('a stale override falls back to the derivation',
   T.sectionsOf(over()).count === 1 && !T.sectionsOf(over()).manual);
delete over().exitGroups;

/* ---- routing must not cross between groups ----
   The corridor-over-hall room: north and south connect, east and west
   connect, and the two pairs never meet. No flat painting can say that, so
   the grouping is set by hand. */
T.setState(T.createDocument());
const plainT = T.createTemplate('plain');
const oddT = T.createTemplate('odd');
oddT.exitGroups = [0, 1, 0, 1];      // N and S together, E and W together
T.state.templates.push(plainT, oddT);

const at = (gx, gy, id) => {
  T.state.map.placements[T.placementKey(gx, gy)] = { templateId: id, rot: 0, mir: false };
};
at(1, 1, oddT.id);
at(1, 0, plainT.id); at(1, 2, plainT.id);   // north and south of it
at(0, 1, plainT.id); at(2, 1, plainT.id);   // west and east of it
['V:0,1', 'V:1,1', 'H:1,0', 'H:1,1'].forEach((k) => T.state.map.openEdges.add(k));

ok('the odd room really does have two groups', T.sectionsOf(oddT).count === 2);
const through = T.findRoute('1,0', '1,2');
ok('north to south passes through it',
   through && through.cells.join('|') === '1,0|1,1|1,2', through && through.cells.join('|'));
ok('west to east passes through it too',
   (T.findRoute('0,1', '2,1') || {}).cells?.join('|') === '0,1|1,1|2,1');
ok('but north to east cannot cut across inside it',
   T.findRoute('1,0', '2,1') === null);
ok('nor west to south', T.findRoute('0,1', '1,2') === null);

/* with the grouping removed the same layout routes straight through */
delete oddT.exitGroups;
T.forgetAllTemplates();
ok('without the override the corner route opens up',
   (T.findRoute('1,0', '2,1') || {}).cells?.join('|') === '1,0|1,1|2,1');

/* ================= phase 5: world coordinates ================= */

T.setState(T.createDocument());
const wRoom = T.createTemplate('W');
T.state.templates.push(wRoom);
T.state.map.placements[T.placementKey(0, 0)] = { templateId: wRoom.id, rot: 0, mir: false };
T.state.map.placements[T.placementKey(1, 0)] = { templateId: wRoom.id, rot: 0, mir: false };

ok('an unbound map has no world position', T.worldOfTile(0, 0) === null);
ok('and cannot be searched', T.tileOfWorld(0, 0) === null);

/* room 0,0 tile r=10 c=20 is at X=100, Z=-200 */
T.setAnchor(0, 0, 10, 20, 100, -200);
ok('the map reports itself bound', T.isAnchored());
ok('the anchor tile maps back to what was typed',
   JSON.stringify(T.worldOfTile(20, 10)) === JSON.stringify({ x: 100, z: -200 }));

/* one tile east is +1 X; one tile south is +1 Z */
ok('columns run east', T.worldOfTile(21, 10).x === 101 && T.worldOfTile(21, 10).z === -200);
ok('rows run south', T.worldOfTile(20, 11).z === -199 && T.worldOfTile(20, 11).x === 100);
ok('and the axes do not swap', T.worldOfTile(25, 13).x === 105 && T.worldOfTile(25, 13).z === -197);

let inverseOk = true;
for (let u = -60; u <= 120; u += 7) for (let v = -60; v <= 120; v += 11) {
  const w = T.worldOfTile(u, v);
  const back = T.tileOfWorld(w.x, w.z);
  if (back.u !== u || back.v !== v) inverseOk = false;
}
ok('tile and world coordinates invert exactly, negatives included', inverseOk);

/* the anchor is document state, so it undoes */
T.setAnchor(0, 0, 0, 0, 5, 5);
ok('re-anchoring replaces the binding', T.worldOfTile(0, 0).x === 5);
T.undo();
ok('undo restores the previous binding', T.worldOfTile(20, 10).x === 100);

/* ---- which room a tile belongs to ---- */
ok('an interior tile belongs to its room', T.roomAtTile(20, 10).key === '0,0');
ok('a tile in the second room belongs to it', T.roomAtTile(60, 10).key === '1,0');
ok('a tile past the last room belongs to nothing', T.roomAtTile(200, 10) === null);

/* the shared wall is in both cells at once; it must resolve to a real room */
const sharedU = T.GRID_PITCH;
ok('a shared wall tile resolves to a placed room',
   T.roomAtTile(sharedU, 10) !== null);
delete T.state.map.placements[T.placementKey(1, 0)];
ok('with the right-hand room gone the shared wall falls back to the left one',
   T.roomAtTile(sharedU, 10).key === '0,0');
T.state.map.placements[T.placementKey(1, 0)] = { templateId: wRoom.id, rot: 0, mir: false };

/* negative grid coordinates must not fall foul of JS modulo */
T.state.map.placements[T.placementKey(-1, -1)] = { templateId: wRoom.id, rot: 0, mir: false };
ok('a room at negative grid coordinates is found',
   T.roomAtTile(-20, -20).key === '-1,-1');

/* ---- reading coordinates the way they actually arrive ---- */
ok('two plain numbers', JSON.stringify(T.parseWorldXZ('128 -340')) === '{"x":128,"z":-340}');
ok('comma separated', JSON.stringify(T.parseWorldXZ('128, -340')) === '{"x":128,"z":-340}');
ok('an F3 XYZ line drops the Y',
   JSON.stringify(T.parseWorldXZ('XYZ: 123.456 / 64.00 / -678.90')) === '{"x":123,"z":-679}');
ok('an F3 Block line drops the Y',
   JSON.stringify(T.parseWorldXZ('Block: 123 64 -679')) === '{"x":123,"z":-679}');
ok('fractions floor into the block they are inside',
   T.parseWorldXZ('12.9 -0.5').x === 12 && T.parseWorldXZ('12.9 -0.5').z === -1);
ok('one number is not a position', T.parseWorldXZ('128') === null);
ok('no numbers is not a position', T.parseWorldXZ('somewhere over there') === null);
ok('empty input is not a position', T.parseWorldXZ('') === null);
ok('null input is handled', T.parseWorldXZ(null) === null);

/* ---- clearing ---- */
T.clearAnchor();
ok('the binding can be removed', !T.isAnchored() && T.worldOfTile(0, 0) === null);
T.undo();
ok('and that undoes too', T.isAnchored());

/* ---- the stored map view refuses anything it cannot trust ---- */
const VIEW_KEY = 'liminal-industries-mapper.view.v1';

T.saveMapView({ scale: 2.5, cu: 100, cv: -40 });
T.flushSave();
const rv = T.loadMapView();
ok('a map view round-trips through storage',
   rv && rv.scale === 2.5 && rv.cu === 100 && rv.cv === -40, JSON.stringify(rv));

mem.set(VIEW_KEY, '{"scale":"wide","cu":0,"cv":0}');
ok('a non-numeric scale is rejected', T.loadMapView() === null);
mem.set(VIEW_KEY, '{"scale":0,"cu":0,"cv":0}');
ok('a zero scale is rejected', T.loadMapView() === null);
mem.set(VIEW_KEY, '{"scale":2,"cu":null,"cv":0}');
ok('a missing centre is rejected', T.loadMapView() === null);
mem.set(VIEW_KEY, 'not json at all');
ok('unparseable view data is rejected', T.loadMapView() === null);
mem.delete(VIEW_KEY);
ok('no stored view yields null', T.loadMapView() === null);

/* ================= a template's default orientation ================= */

T.setState(T.createDocument());
const orientT = T.createTemplate('turned');
T.state.templates.push(orientT);
const orientId = orientT.id;
const tpl0 = () => T.state.templates.find((x) => x.id === orientId);

ok('a fresh template is placed plain',
   T.defaultRot(tpl0()) === 0 && T.defaultMir(tpl0()) === false);

T.rotateTemplateDefault(orientId);
ok('turning advances a quarter', T.defaultRot(tpl0()) === 1);
T.rotateTemplateDefault(orientId);
T.rotateTemplateDefault(orientId);
T.rotateTemplateDefault(orientId);
ok('and wraps back round', T.defaultRot(tpl0()) === 0);

T.mirrorTemplateDefault(orientId);
ok('flipping toggles', T.defaultMir(tpl0()) === true);
T.undo();
ok('flipping is one undo step', T.defaultMir(tpl0()) === false);
T.redo();

T.rotateTemplateDefault(orientId);
ok('the two combine', T.defaultRot(tpl0()) === 1 && T.defaultMir(tpl0()) === true);

/* the painting itself is untouched -- that is the whole point */
const plainCells = T.createTemplate('turned').cells;
ok('turning a template does not move a single tile',
   tpl0().cells.every((v, i) => v === plainCells[i]));

/* ...and neither are rooms already on the map */
T.state.map.placements[T.placementKey(0, 0)] =
  { templateId: orientId, rot: 0, mir: false };
T.rotateTemplateDefault(orientId);
T.mirrorTemplateDefault(orientId);
ok('a room already placed keeps the orientation it was placed with',
   T.state.map.placements['0,0'].rot === 0 &&
   T.state.map.placements['0,0'].mir === false);

/* it survives the document format, and only when it is not the default */
const orientDoc = T.deserialize(JSON.parse(JSON.stringify(T.serialize(T.state))));
ok('the orientation round-trips',
   T.defaultRot(orientDoc.templates[0]) === T.defaultRot(tpl0()) &&
   T.defaultMir(orientDoc.templates[0]) === T.defaultMir(tpl0()));

const plainDoc = T.createDocument();
plainDoc.templates.push(T.createTemplate('plain'));
const written = T.serialize(plainDoc).templates[0];
ok('a plain orientation is not written out',
   !('defaultRot' in written) && !('defaultMir' in written));

/* duplicating carries it */
T.setSelectedTemplate(orientId);
T.duplicateTemplate(orientId);
const copy = T.state.templates.find((x) => x.id !== orientId && x.name.endsWith('copy'));
ok('a duplicate inherits the orientation',
   copy && T.defaultRot(copy) === T.defaultRot(tpl0()) &&
   T.defaultMir(copy) === T.defaultMir(tpl0()));

/* ================= named rooms and bookmarks ================= */

T.setState(T.createDocument());
const nt = T.createTemplate('Corridor');
T.state.templates.push(nt);
const nkey = T.placementKey(4, 4);
T.state.map.placements[nkey] = { templateId: nt.id, rot: 0, mir: false };

ok('an unnamed room shows its template name', T.roomName(nkey) === 'Corridor');
ok('and reports that the name is not its own', !T.hasOwnName(nkey));

T.setRoomLabel(nkey, '  Reception  ');
ok('a room name is trimmed and kept',
   T.roomName(nkey) === 'Reception' && T.hasOwnName(nkey));
T.undo();
ok('naming a room is one undo step',
   T.roomName(nkey) === 'Corridor' && !T.hasOwnName(nkey));
T.redo();
ok('and redoes', T.roomName(nkey) === 'Reception');

T.setRoomLabel(nkey, '   ');
ok('a blank name falls back to the template',
   T.roomName(nkey) === 'Corridor' && !T.hasOwnName(nkey));
T.setRoomLabel(nkey, 'Reception');

ok('a room starts unbookmarked', !T.isBookmarked(nkey));
T.toggleBookmark(nkey);
ok('bookmarking records it', T.isBookmarked(nkey) && T.bookmarkList().length === 1);
ok('the bookmark shows the room name', T.bookmarkList()[0].name === 'Reception');

/* the whole point of storing a key rather than a copy */
T.setRoomLabel(nkey, 'Lobby');
ok('renaming the room renames its bookmark', T.bookmarkList()[0].name === 'Lobby');

T.toggleBookmark(nkey);
ok('bookmarking again removes it',
   !T.isBookmarked(nkey) && T.bookmarkList().length === 0);
T.undo();
ok('removing a bookmark is one undo step', T.isBookmarked(nkey));

const savedRoom = T.state.map.placements[nkey];
delete T.state.map.placements[nkey];
ok('a bookmark whose room is gone is not listed', T.bookmarkList().length === 0);
T.state.map.placements[nkey] = savedRoom;
ok('and it comes back when the room does', T.bookmarkList().length === 1);

/* ---- both survive the document format ---- */
const nameDoc = T.deserialize(JSON.parse(JSON.stringify(T.serialize(T.state))));
ok('room names survive a round-trip', nameDoc.map.placements[nkey].label === 'Lobby');
ok('bookmarks survive a round-trip', nameDoc.map.bookmarks.join() === nkey);

const rawDoc = JSON.parse(JSON.stringify(T.serialize(T.state)));
rawDoc.map.bookmarks.push('99,99');
ok('a bookmark pointing at no room is dropped on load',
   T.deserialize(rawDoc).map.bookmarks.join() === nkey);

rawDoc.map.placements[nkey].label = '   ';
ok('a blank stored name is not kept',
   T.deserialize(rawDoc).map.placements[nkey].label === undefined);

/* ---- colour maths ---- */
ok('mid grey inverts to a contrasting colour', T.invertColor('#808080') === '#ffffff');
ok('dark colours invert to something light', T.invertColor('#31363f') === 'rgb(206,201,192)');

export default totals();
