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

/* ---- the editor fits the room on load ----
   The stub reports a 900x700 container, so the expected fit is computable:
   the ruler bands take (18 + 10) * 2 px, and the room squares off in what
   is left of the shorter side. */
{
  const v = T.editor.view;
  const expected = (Math.min(900, 700) - (18 + 10) * 2) / T.ROOM_SIZE;
  const span = T.ROOM_SIZE * v.scale;
  ok('the editor fits the room on load', Math.abs(v.scale - expected) < 1e-9,
     `scale=${v.scale} expected=${expected}`);
  ok('and centres it', Math.abs(v.ox + span / 2 - 450) < 1e-6 &&
                       Math.abs(v.oy + span / 2 - 350) < 1e-6);
  ok('so the whole room is on screen',
     v.ox >= 0 && v.oy >= 0 && v.ox + span <= 900 && v.oy + span <= 700);

  /* A hidden panel measures zero; that must not collapse the view. */
  const kept = { scale: v.scale, ox: v.ox, oy: v.oy };
  T.wrapEl.rect = { left: 0, top: 0, width: 0, height: 0 };
  T.resizeCanvas();
  ok('a zero-sized container leaves the view alone',
     v.scale === kept.scale && v.ox === kept.ox && v.oy === kept.oy);
  T.wrapEl.rect = { left: 0, top: 0, width: 900, height: 700 };

  /* Only the first real measurement refits: a chosen zoom must survive. */
  v.scale = 3;
  v.ox = 11;
  T.resizeCanvas();
  ok('a later resize keeps the zoom you chose', v.scale === 3 && v.ox === 11);
  T.fitView();
}

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

/* ================= phase 5: world binding =================
   The dialogs are driven through the hooks, so the flows can be exercised
   end to end without a real modal ever opening. */
T.ui.showError = () => Promise.resolve();

T.setMapMode('anchor');
ok('anchor mode clears the room selection',
   T.mapUI.mode === 'anchor' && T.mapUI.selected === null);

T.ui.askText = () => Promise.resolve('600 -200');
await T.askAnchor(10, 10, 23, 23);
ok('binding records an anchor', !!T.state.map.anchor);
ok('binding drops back to place mode', T.mapUI.mode === 'place');
ok('the bound tile reports exactly what was typed',
   T.worldOfTile(10 * T.GRID_PITCH + 23, 10 * T.GRID_PITCH + 23).x === 600);

/* look up a position inside the neighbouring room */
const target = T.worldOfTile(11 * T.GRID_PITCH + 23, 10 * T.GRID_PITCH + 23);
T.ui.askText = () => Promise.resolve(target.x + ' ' + target.z);
await T.locatePosition();
ok('locating marks the position',
   T.mapUI.marker && T.mapUI.marker.x === target.x && T.mapUI.marker.z === target.z);
ok('and selects the room it falls in', T.mapUI.selected === '11,10', T.mapUI.selected);
ok('and centres the view on it',
   Math.abs(T.mapUI.view.ox + (T.mapUI.marker.u + 0.5) * T.mapUI.view.scale - 450) < 1e-6 &&
   Math.abs(T.mapUI.view.oy + (T.mapUI.marker.v + 0.5) * T.mapUI.view.scale - 350) < 1e-6);

T.ui.askText = () => Promise.resolve('999999 999999');
await T.locatePosition();
ok('a position off the map still marks but selects nothing',
   !!T.mapUI.marker && T.mapUI.selected === null);

const boundTo = JSON.stringify(T.state.map.anchor);
T.ui.askText = () => Promise.resolve(null);
await T.askAnchor(10, 10, 1, 1);
ok('cancelling the bind dialog changes nothing',
   JSON.stringify(T.state.map.anchor) === boundTo);

T.ui.askText = () => Promise.resolve('over by the vending machines');
await T.askAnchor(10, 10, 1, 1);
ok('unreadable coordinates are rejected rather than guessed at',
   JSON.stringify(T.state.map.anchor) === boundTo);

T.mapUI.marker = null;

/* ================= phase 6: routing ================= */
T.setMapMode('route');
ok('route mode clears the room selection',
   T.mapUI.mode === 'route' && T.mapUI.selected === null);

T.mapUI.routeFrom = '10,10';
T.mapUI.route = T.findRoute('10,10', '11,10');
ok('the two adjoining rooms are connected through their opened wall',
   T.mapUI.route && T.mapUI.route.cells.join('|') === '10,10|11,10');

T.drawRoute();
ok('drawing a live route keeps it', !!T.mapUI.route);

T.mapUI.route = { cells: ['99,99'], edges: [] };
T.drawRoute();
ok('drawing drops a route whose rooms are gone', T.mapUI.route === null);

T.setMapMode('place');
ok('leaving route mode clears both ends',
   T.mapUI.route === null && T.mapUI.routeFrom === null);

/* ================= bookmarks panel and room names ================= */
ok('the sidebar starts on bookmarks', T.mapUI.panel === 'bookmarks');
T.setMapPanel('templates');
ok('Add room switches to the template palette', T.mapUI.panel === 'templates');

T.mapUI.brush = brushId;
T.placeRoom(12, 10);
ok('placing a room returns the sidebar to bookmarks', T.mapUI.panel === 'bookmarks');

T.mapUI.selected = '10,10';
T.bookmarkSelectedRoom();
ok('the selected room can be bookmarked', T.isBookmarked('10,10'));

T.mapUI.selected = null;
T.goToRoom('10,10');
ok('going to a bookmark selects that room', T.mapUI.selected === '10,10');
ok('and centres the view on it',
   Math.abs(T.mapUI.view.ox +
            (10 * T.GRID_PITCH + T.CENTER_TILE + 0.5) * T.mapUI.view.scale - 450) < 1e-6);

/* in route mode a bookmark picks a route end instead of a selection */
T.setMapMode('route');
T.goToRoom('10,10');
ok('a bookmark sets the route start', T.mapUI.routeFrom === '10,10');
T.goToRoom('11,10');
ok('a second bookmark completes the route',
   T.mapUI.route && T.mapUI.route.cells.join('|') === '10,10|11,10',
   T.mapUI.route && T.mapUI.route.cells.join('|'));
T.setMapMode('place');

/* naming through the dialog */
T.ui.askText = () => Promise.resolve('Reception');
T.mapUI.selected = '10,10';
await T.nameSelectedRoom();
ok('naming a room from the map sticks', T.roomName('10,10') === 'Reception');
ok('the bookmark follows the new name',
   T.bookmarkList().some((b) => b.key === '10,10' && b.name === 'Reception'));

/* deleting a room takes its bookmark with it */
T.deleteSelection();
ok('deleting a room drops its bookmark', !T.isBookmarked('10,10'));
T.undo();
ok('undo restores the room and its bookmark',
   !!T.state.map.placements['10,10'] && T.isBookmarked('10,10'));

/* ================= the exits panel tracks the selected room ================= */
{
  const box = T.__document.getElementById('exit-groups');
  const rowsFor = () => box.children.filter((c) => c.className === 'exit-row').length;

  /* two rooms with different numbers of doorways */
  const fourDoors = T.createTemplate('four doors');
  const twoDoors = T.createTemplate('two doors');
  for (let i = 21; i <= 25; i++) {
    twoDoors.cells[T.cellIndex(i, 0)] = T.SLOT_WALL;          // brick up east and west
    twoDoors.cells[T.cellIndex(i, T.ROOM_MAX)] = T.SLOT_WALL;
  }
  T.state.templates.push(fourDoors, twoDoors);

  T.selectTemplate(fourDoors.id);
  ok('the exits panel shows every doorway of the selected room', rowsFor() === 4,
     String(rowsFor()));

  T.selectTemplate(twoDoors.id);
  ok('switching room re-renders the exits panel', rowsFor() === 2, String(rowsFor()));

  T.selectTemplate(fourDoors.id);
  ok('and switching back re-renders it again', rowsFor() === 4, String(rowsFor()));

  /* leaving for the map and coming back must not leave it stale */
  T.showTab('map');
  T.selectTemplate(twoDoors.id);
  T.showTab('rooms');
  ok('returning to the rooms tab shows the current room', rowsFor() === 2, String(rowsFor()));
  T.showTab('map');
}

/* ---- the map is the default tab ---- */
ok('the map tab is the one shown on load', T.activeTab === 'map');

/* ---- the viewport survives a reload ---- */
T.mapUI.view.scale = 4;
T.mapUI.view.ox = -137;
T.mapUI.view.oy = 82;
const wantCu = (900 / 2 - T.mapUI.view.ox) / 4;
const wantCv = (700 / 2 - T.mapUI.view.oy) / 4;

T.rememberMapView();
T.flushSave();
const view = T.loadMapView();
ok('the stored view is the viewport centre in tile space',
   view && view.scale === 4 &&
   Math.abs(view.cu - wantCu) < 1e-9 && Math.abs(view.cv - wantCv) < 1e-9,
   JSON.stringify(view));

T.mapUI.view.scale = 1;
T.mapUI.view.ox = 0;
T.mapUI.view.oy = 0;
T.applyMapView(view);
ok('restoring reproduces the same viewport',
   T.mapUI.view.scale === 4 &&
   Math.abs(T.mapUI.view.ox + 137) < 1e-9 && Math.abs(T.mapUI.view.oy - 82) < 1e-9);

T.applyMapView({ scale: 9999, cu: 0, cv: 0 });
ok('an out-of-range stored scale is clamped', T.mapUI.view.scale === T.MAX_MAP_SCALE);
T.applyMapView({ scale: 0.0001, cu: 0, cv: 0 });
ok('and clamped at the other end', T.mapUI.view.scale === T.MIN_MAP_SCALE);

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
