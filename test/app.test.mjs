/*
   Integration tests: the bundled app booted against a stub DOM. Covers the
   parts that cannot be reached without one -- the map canvas, the bitmap
   cache, and the fact that the whole graph wires itself up at all.
*/
import { bootApp } from './harness.mjs';
import { checker } from './util.mjs';
import { makeSandbox } from './dom.mjs';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const T = await bootApp();
const { ok, totals } = checker('app');

/* Booting at all is the first assertion: module-level wiring, every
   getElementById, and one full draw pass have already run by this point. */
ok('the bundle boots against a DOM', typeof T.drawMap === 'function');
ok('late-bound UI hooks were registered', typeof T.refreshAll === 'function');

/* ---- placement, orientation, deletion ---- */
T.addTemplate();
const brushId = T.state.templates[T.state.templates.length - 1].id;
T.mapUI.brush = brushId;
T.mapUI.rot = 0;
T.mapUI.mir = false;

const before = Object.keys(T.state.map.placements).length;
T.placeRoom(2, -1);
ok('placing adds a room', Object.keys(T.state.map.placements).length === before + 1);
ok('negative grid coordinates work', !!T.state.map.placements['2,-1']);
ok('placing selects the new room', T.mapUI.selected === '2,-1');
ok('placing puts the brush down', T.mapUI.brush === null);

T.placeRoom(2, -1);
ok('a spent brush places nothing', Object.keys(T.state.map.placements).length === before + 1);

T.mapUI.brush = brushId;
T.placeRoom(2, -1);
ok('placing on an occupied slot is a no-op',
   Object.keys(T.state.map.placements).length === before + 1);
ok('a refused placement keeps the brush armed', T.mapUI.brush === brushId);

T.rotateAction();
ok('rotate turns the selected room', T.state.map.placements['2,-1'].rot === 1);
T.mirrorAction();
ok('mirror flips the selected room', T.state.map.placements['2,-1'].mir === true);
T.undo();
ok('undo reverts the mirror', T.state.map.placements['2,-1'].mir === false);
T.undo();
ok('undo reverts the rotation', T.state.map.placements['2,-1'].rot === 0);

T.mapUI.selected = '2,-1';
T.deleteSelection();
ok('delete removes the room', !T.state.map.placements['2,-1']);
T.undo();
ok('undo restores the deleted room', !!T.state.map.placements['2,-1']);

T.mapUI.selected = null;
const rotBefore = T.mapUI.rot;
T.rotateAction();
ok('rotate with no selection steers the brush instead',
   T.mapUI.rot === (rotBefore + 1) % 4 && T.state.map.placements['2,-1'].rot === 0);
T.mapUI.brush = brushId;
T.placeRoom(3, -1);
ok('a new room takes the brush orientation',
   T.state.map.placements['3,-1'].rot === T.mapUI.rot);

/* ---- hit testing inverts placement ---- */
T.mapUI.view.scale = 3;
T.mapUI.view.ox = 137;
T.mapUI.view.oy = -82;
let hitOk = true;
for (const [gx, gy] of [[0, 0], [3, 5], [-2, -7], [12, -1]]) {
  const pitch = T.GRID_PITCH * T.mapUI.view.scale;
  const cell = T.mapCellAt(T.mapUI.view.ox + gx * pitch + 1, T.mapUI.view.oy + gy * pitch + 1);
  if (cell.gx !== gx || cell.gy !== gy) hitOk = false;
}
ok('mapCellAt inverts placement position, negatives included', hitOk);

/* ---- bitmap cache ---- */
T.templateBitmaps.clear();
const bmp = T.templateBitmap(brushId);
ok('a template bitmap is 47x47', bmp.width === T.ROOM_SIZE && bmp.height === T.ROOM_SIZE);
ok('the bitmap is cached', T.templateBitmap(brushId) === bmp);

const tpl = T.state.templates.find((t) => t.id === brushId);
const was = tpl.cells[T.cellIndex(12, 12)];
const flip = was === T.SLOT_VOID ? T.SLOT_FLOOR : T.SLOT_VOID;
T.beginStroke(tpl);
const changed = T.paintCell(tpl, 12, 12, flip);
T.endStroke();
ok('the test actually changed a tile', changed);
ok('editing a template drops its cached bitmap', !T.templateBitmaps.has(brushId));

T.templateBitmap(brushId);
T.beginStroke(tpl);
T.paintCell(tpl, 12, 12, flip);
T.endStroke();
ok('a no-op paint leaves the cache intact', T.templateBitmaps.has(brushId));

/* ---- bounds ---- */
const b = T.mapBounds();
ok('bounds cover every placed cell', !b.empty && b.gx0 <= 2 && b.gx1 >= 3 && b.gy0 <= -1);

/* ---- the document round-trips through storage ---- */
T.saveNow();
const reloaded = T.loadFromStorage();
ok('the autosaved document reloads',
   reloaded && reloaded.templates.length === T.state.templates.length);
ok('placements survive the round-trip',
   reloaded && Object.keys(reloaded.map.placements).length ===
   Object.keys(T.state.map.placements).length);

/* ================= phase 4: walls ================= */

T.mapUI.brush = brushId;
T.mapUI.rot = 0;
T.mapUI.mir = false;
T.mapUI.selected = null;

T.placeRoom(10, 10);
ok('a lone room opens no walls', !T.state.map.openEdges.has('V:10,10'));
T.mapUI.brush = brushId;
T.placeRoom(11, 10);
ok('placing a neighbour opens the wall between them by default',
   T.state.map.openEdges.has('V:10,10'));

T.undo();
ok('undo removes the room and the wall it opened together',
   !T.state.map.placements['11,10'] && !T.state.map.openEdges.has('V:10,10'));
T.redo();
ok('redo restores both',
   !!T.state.map.placements['11,10'] && T.state.map.openEdges.has('V:10,10'));

T.mapUI.selected = '11,10';
T.deleteSelection();
ok('deleting a room drops the walls that led to it',
   !T.state.map.openEdges.has('V:10,10'));
T.undo();
ok('undo brings the room and its wall back',
   !!T.state.map.placements['11,10'] && T.state.map.openEdges.has('V:10,10'));

/* ---- doors mode and edge hit testing ---- */
T.setMapMode('doors');
ok('doors mode clears the room selection',
   T.mapUI.mode === 'doors' && T.mapUI.selected === null);

T.mapUI.view.scale = 3;
T.mapUI.view.ox = 0;
T.mapUI.view.oy = 0;
const pitch = T.GRID_PITCH * T.mapUI.view.scale;
const onWall = T.edgeAt(11 * pitch, 10 * pitch + pitch / 2);
ok('edgeAt finds the wall under the pointer',
   onWall && onWall.dir === 'V' && onWall.gx === 10 && onWall.gy === 10,
   JSON.stringify(onWall));
ok('the middle of a room is not a wall',
   T.edgeAt(10 * pitch + pitch / 2, 10 * pitch + pitch / 2) === null);

T.toggleEdge(10, 10, 'V');
ok('toggling from the map closes the wall', !T.state.map.openEdges.has('V:10,10'));
T.toggleEdge(10, 10, 'V');
ok('and opens it again', T.state.map.openEdges.has('V:10,10'));
T.setMapMode('place');

/* ---- both bitmap variants ---- */
T.templateBitmaps.clear();
const marks = T.templateBitmap(brushId);
const room = T.roomBitmap(brushId);
ok('the two bitmap variants are distinct canvases', marks && room && marks !== room);
ok('both are cached under one entry', T.templateBitmaps.size === 1);

/* ---- the whole thing still round-trips ---- */
T.saveNow();
const withDoors = T.loadFromStorage();
ok('open walls survive a save and reload',
   withDoors && withDoors.map.openEdges.has('V:10,10'));

/* ---- the released artifact itself ----
   Everything above tests the source graph. This tests the file that actually
   ships: it must boot, and it must not reach outside itself. */
const html = await readFile('dist/mapper.html', 'utf8');
const inline = html.split('<script>\n')[1].split('\n</script>')[0];

let bootError = null;
try {
  const sandbox = makeSandbox();
  vm.createContext(sandbox);
  vm.runInContext(inline, sandbox, { filename: 'dist/mapper.html' });
} catch (err) {
  bootError = err;
}
ok('the built dist/mapper.html boots', !bootError, bootError && bootError.message);
ok('the built file carries its stylesheet inline', html.includes('.canvas-wrap canvas'));
ok('the built file has no external references',
   !/\b(?:src|href)\s*=\s*["']https?:/i.test(html));
ok('the built file has no leftover build placeholders',
   !html.includes('@CSS@') && !html.includes('@JS@'));

export default totals();
