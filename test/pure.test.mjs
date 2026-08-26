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

const T = flatten({ geometry, palette, doc, store, history, paint, ops });
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

/* ---- colour maths ---- */
ok('mid grey inverts to a contrasting colour', T.invertColor('#808080') === '#ffffff');
ok('dark colours invert to something light', T.invertColor('#31363f') === 'rgb(206,201,192)');

export default totals();
