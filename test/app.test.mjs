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
T.rotateAction();
T.mirrorAction();
ok('rotate and mirror do nothing with no room selected',
   T.state.map.placements['2,-1'].rot === 0 && T.state.map.placements['2,-1'].mir === false);

T.mapUI.brush = brushId;
T.placeRoom(3, -1);
ok('rooms are always placed unrotated',
   T.state.map.placements['3,-1'].rot === 0 && T.state.map.placements['3,-1'].mir === false);
ok('there is no brush orientation left to carry',
   !('rot' in T.mapUI) && !('mir' in T.mapUI));

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

T.setMapMode('select');
ok('leaving route mode clears both ends',
   T.mapUI.route === null && T.mapUI.routeFrom === null);

/* ================= bookmarks panel and room names ================= */
ok('the map starts in select mode', T.mapUI.mode === 'select');
T.setMapMode('place');
ok('Add room enters place mode', T.mapUI.mode === 'place');

T.mapUI.brush = brushId;
T.placeRoom(12, 10);
ok('placing a room drops back to select mode', T.mapUI.mode === 'select');

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

/* ================= map modes ================= */
{
  const doc = T.__document;
  const btn = (n) => doc.getElementById('btn-map-' + n);
  const roomButtons = ['name', 'bookmark', 'rotate', 'mirror', 'delete'];
  const shown = () => roomButtons.filter((n) => btn(n).style.display !== 'none').join(',');
  const enabled = () => roomButtons
    .filter((n) => btn(n).style.display !== 'none' && !btn(n).disabled).join(',');
  const barName = () => doc.getElementById('map-brush').textContent;

  T.mapUI.view.scale = 3;
  T.mapUI.view.ox = 0;
  T.mapUI.view.oy = 0;
  const pitch = T.GRID_PITCH * 3;
  const inCell = (gx, gy) => ({ x: gx * pitch + pitch / 2, y: gy * pitch + pitch / 2 });

  /* the reported bug: Doors on, then Add room, then place */
  T.setMapMode('doors');
  ok('doors mode hides every per-room button', shown() === '', shown());

  T.setMapMode('place');
  ok('Add room leaves doors mode', T.mapUI.mode === 'place');

  T.mapUI.brush = brushId;
  const before = Object.keys(T.state.map.placements).length;
  T.MAP_MODES.place.click(inCell(20, 20));
  ok('a click in place mode places the room even after doors was on',
     Object.keys(T.state.map.placements).length === before + 1 &&
     !!T.state.map.placements['20,20']);
  ok('and drops back to select with the new room selected',
     T.mapUI.mode === 'select' && T.mapUI.selected === '20,20');

  /* button enablement follows the mode, not luck */
  ok('select mode with a room selected enables all of them',
     enabled() === roomButtons.join(','), enabled());
  ok('and shows them', shown() === roomButtons.join(','), shown());

  T.MAP_MODES.select.click(inCell(30, 30));   // empty cell: deselects
  ok('clicking empty space clears the selection', T.mapUI.selected === null);
  ok('select mode with nothing selected disables all of them', enabled() === '', enabled());
  ok('but still shows them', shown() === roomButtons.join(','), shown());

  T.setMapMode('place');
  ok('place mode hides them too', shown() === '', shown());
  T.setMapMode('anchor');
  ok('anchor mode hides them', shown() === '', shown());
  T.setMapMode('route');
  ok('route mode hides them', shown() === '', shown());

  /* they come back, greyed, as soon as select mode returns */
  T.setMapMode('select');
  ok('select mode shows all five again', shown() === roomButtons.join(','), shown());
  ok('but greyed with nothing selected', enabled() === '', enabled());

  /* the shortcuts follow the buttons, or hiding them would be cosmetic */
  ok('per-room shortcuts are dead with no selection', !T.mapRoomActionsLive());
  T.mapUI.selected = '20,20';
  ok('and live once a room is selected', T.mapRoomActionsLive());
  T.setMapMode('doors');
  ok('and dead again outside select mode', !T.mapRoomActionsLive());
  T.setMapMode('select');

  /* the toolbar no longer talks about a brush when nothing is being placed */
  T.setMapMode('select');
  ok('an idle map does not claim to be missing a brush',
     barName() !== 'no brush' && barName() === 'map', barName());
  T.setMapMode('place');
  ok('place mode says what it is waiting for', barName() === 'add room', barName());
  ok('the mode label and its hint live below the canvas, not in the toolbar',
     !!doc.getElementById('map-brush') && !!doc.getElementById('map-orient'));
  T.setMapMode('select');

  /* modes clear up after themselves */
  T.setMapMode('route');
  T.mapUI.routeFrom = '10,10';
  T.setMapMode('doors');
  ok('leaving route mode forgets its first pick', T.mapUI.routeFrom === null);
  T.setMapMode('place');
  T.mapUI.brush = brushId;
  T.setMapMode('select');
  ok('leaving place mode puts the brush down', T.mapUI.brush === null);

  T.mapUI.selected = '20,20';
  T.setMapMode('doors');
  ok('a mode with no use for a selection clears it', T.mapUI.selected === null);
  T.setMapMode('select');
}

/* ---- the exits panel names doorways by where they are drawn ---- */
{
  const box = T.__document.getElementById('exit-groups');
  const labels = () => box.children
    .filter((c) => c.className === 'exit-row')
    .map((row) => row.children[0].textContent.split(' ')[0]);

  const exitT = T.createTemplate('exits');
  T.state.templates.push(exitT);
  const exitId = exitT.id;

  T.selectTemplate(exitId);
  ok('unrotated, the four doorways read north, east, south, west',
     labels().join(',') === 'North,East,South,West', labels().join(','));

  /* a quarter turn clockwise carries the top edge to the right */
  T.rotateTemplateDefault(exitId);
  T.renderExitGroups();
  ok('a turned room still lists all four', labels().length === 4);
  ok('and still in screen order', labels().join(',') === 'North,East,South,West',
     labels().join(','));

  /* with only one doorway the label has to move with the room */
  const oneT = T.createTemplate('one exit');
  for (let i = 21; i <= 25; i++) {
    oneT.cells[T.cellIndex(i, 0)] = T.SLOT_WALL;             // drop west
    oneT.cells[T.cellIndex(i, T.ROOM_MAX)] = T.SLOT_WALL;    // drop east
    oneT.cells[T.cellIndex(T.ROOM_MAX, i)] = T.SLOT_WALL;    // drop south
  }
  T.state.templates.push(oneT);
  const oneId = oneT.id;
  T.selectTemplate(oneId);
  ok('the lone doorway starts in the north', labels().join(',') === 'North',
     labels().join(','));

  T.rotateTemplateDefault(oneId);
  T.renderExitGroups();
  ok('a quarter turn puts it on the east', labels().join(',') === 'East', labels().join(','));
  T.rotateTemplateDefault(oneId);
  T.renderExitGroups();
  ok('a half turn puts it on the south', labels().join(',') === 'South', labels().join(','));

  /* mirroring alone must flip east and west, and leave north alone */
  const mirT = T.createTemplate('mirrored');
  for (let i = 21; i <= 25; i++) {
    mirT.cells[T.cellIndex(i, T.ROOM_MAX)] = T.SLOT_WALL;    // drop east
    mirT.cells[T.cellIndex(0, i)] = T.SLOT_WALL;             // drop north
    mirT.cells[T.cellIndex(T.ROOM_MAX, i)] = T.SLOT_WALL;    // drop south
  }
  T.state.templates.push(mirT);
  const mirId = mirT.id;
  T.selectTemplate(mirId);
  ok('the lone doorway starts in the west', labels().join(',') === 'West', labels().join(','));
  T.mirrorTemplateDefault(mirId);
  T.renderExitGroups();
  ok('mirroring moves it to the east', labels().join(',') === 'East', labels().join(','));
}

/* ---- the room editor paints through the displayed orientation ----
   The canvas shows the room as it will be placed, so a click at a screen tile
   must land on the template tile that is being displayed there -- not on the
   tile with those coordinates. */
{
  const paintT = T.createTemplate('painted');
  T.state.templates.push(paintT);
  const paintId = paintT.id;
  const live = () => T.state.templates.find((x) => x.id === paintId);

  T.selectTemplate(paintId);
  T.setTool('pencil');
  T.setPaletteSlot(T.SLOT_VOID);
  T.editor.view.scale = 10;
  T.editor.view.ox = 0;
  T.editor.view.oy = 0;
  const at = (vr, vc) => ({
    clientX: vc * 10 + 5, clientY: vr * 10 + 5,
    button: 0, shiftKey: false, pointerId: 1, preventDefault() {},
  });

  /* unrotated: the screen tile is the template tile */
  T.onEditorPointerDown(at(5, 7));
  T.endDrag();
  ok('with no orientation a click paints the tile it is over',
     live().cells[T.cellIndex(5, 7)] === T.SLOT_VOID);

  /* a quarter turn: the same screen tile must reach a different cell */
  T.rotateTemplateDefault(paintId);
  const turned = T.toTemplate(9, 11, T.defaultRot(live()), T.defaultMir(live()));
  ok('the mapping actually moves the tile', turned.r !== 9 || turned.c !== 11);

  T.onEditorPointerDown(at(9, 11));
  T.endDrag();
  ok('a turned room paints the cell shown at that spot',
     live().cells[T.cellIndex(turned.r, turned.c)] === T.SLOT_VOID,
     `${turned.r},${turned.c}`);
  ok('and not the cell with those screen coordinates',
     live().cells[T.cellIndex(9, 11)] !== T.SLOT_VOID);

  /* mirrored as well, to catch a transform applied in the wrong order */
  T.mirrorTemplateDefault(paintId);
  const flipped = T.toTemplate(13, 4, T.defaultRot(live()), T.defaultMir(live()));
  T.onEditorPointerDown(at(13, 4));
  T.endDrag();
  ok('a turned and flipped room maps correctly too',
     live().cells[T.cellIndex(flipped.r, flipped.c)] === T.SLOT_VOID,
     `${flipped.r},${flipped.c}`);

  /* dragging a stroke stays on the mapped cells */
  T.onEditorPointerDown(at(20, 20));
  T.onEditorPointerMove(at(20, 24));
  T.endDrag();
  const dragged = [20, 21, 22, 23, 24].map((vc) =>
    T.toTemplate(20, vc, T.defaultRot(live()), T.defaultMir(live())));
  ok('a dragged stroke follows the cursor across the mapping',
     dragged.every((cell) => live().cells[T.cellIndex(cell.r, cell.c)] === T.SLOT_VOID));

  T.setPaletteSlot(T.SLOT_FLOOR);
}

/* ---- new rooms inherit the template's orientation ---- */
{
  const tplId = T.state.templates[0].id;
  const tpl = () => T.state.templates.find((x) => x.id === tplId);

  T.rotateTemplateDefault(tplId);
  T.mirrorTemplateDefault(tplId);
  const wantRot = T.defaultRot(tpl());
  const wantMir = T.defaultMir(tpl());

  T.setMapMode('place');
  T.mapUI.brush = tplId;
  T.placeRoom(40, 40);
  ok('a placed room takes the template orientation',
     T.state.map.placements['40,40'].rot === wantRot &&
     T.state.map.placements['40,40'].mir === wantMir,
     JSON.stringify(T.state.map.placements['40,40']));

  /* turning the template afterwards must not disturb it */
  T.rotateTemplateDefault(tplId);
  ok('turning the template later leaves the placed room alone',
     T.state.map.placements['40,40'].rot === wantRot &&
     T.state.map.placements['40,40'].mir === wantMir);

  /* the editor bar reports it */
  T.selectTemplate(tplId);
  const orient = T.__document.getElementById('editor-orient').textContent;
  ok('the room editor states the orientation',
     orient === (T.defaultRot(tpl()) * 90) + ' deg' +
                (T.defaultMir(tpl()) ? ', mirrored' : ''), orient);

  T.setMapMode('select');
}

/* ---- Locate is off until the map is bound ---- */
{
  const locate = T.__document.getElementById('btn-map-locate');
  const savedAnchor = T.state.map.anchor;

  T.state.map.anchor = null;
  T.updateMapBar();
  ok('Locate is disabled with no anchor', locate.disabled === true);
  ok('and says why', /Anchor/.test(locate.title), locate.title);

  /* pressing it anyway must do nothing rather than pop a dialog */
  let asked = false;
  const savedAsk = T.ui.askText;
  T.ui.askText = () => { asked = true; return Promise.resolve(null); };
  await T.locatePosition();
  ok('and asks nothing if invoked while unbound', !asked);
  T.ui.askText = savedAsk;

  T.state.map.anchor = savedAnchor;
  T.updateMapBar();
  ok('Locate comes back once a tile is bound', locate.disabled === false);
}

/* ---- the canvases are actually wired to the pointer ----
   Calling a handler directly proves it works; it does not prove anything is
   still calling it. This checks the registrations themselves, which is the
   part that went missing. */
{
  const wired = (id, types) => {
    const el = T.__document.getElementById(id);
    return types.filter((ty) => !(el.listeners[ty] || []).length);
  };
  const need = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel',
                'pointerleave', 'wheel', 'contextmenu'];
  ok('the map canvas is wired to every pointer event it needs',
     wired('map-canvas', need).length === 0, wired('map-canvas', need).join(','));
  ok('the room editor canvas is too',
     wired('editor-canvas', need).length === 0, wired('editor-canvas', need).join(','));
}

/* ================= panning, in every mode ================= */
{
  const ptr = (x, y, button) => ({
    clientX: x, clientY: y, button: button === undefined ? 0 : button,
    pointerId: 1, preventDefault() {},
  });

  T.mapUI.view.scale = 3;
  ['select', 'place', 'doors', 'anchor', 'route'].forEach((mode) => {
    [1, 2].forEach((button) => {
      T.setMapMode(mode);
      T.mapUI.view.ox = 100;
      T.mapUI.view.oy = 100;

      T.onMapPointerDown(ptr(200, 200, button));
      ok(`${mode}: button ${button} starts a pan`,
         !!T.mapUI.drag && T.mapUI.drag.mode === 'pan');

      T.onMapPointerMove(ptr(230, 190, button));
      ok(`${mode}: button ${button} pans the view`,
         T.mapUI.view.ox === 130 && T.mapUI.view.oy === 90,
         `${T.mapUI.view.ox},${T.mapUI.view.oy}`);

      T.endMapDrag();
      ok(`${mode}: releasing ends the pan`, T.mapUI.drag === null);

      /* and a move afterwards must not keep dragging the view */
      T.onMapPointerMove(ptr(300, 300, 0));
      ok(`${mode}: moving after release does not pan`,
         T.mapUI.view.ox === 130 && T.mapUI.view.oy === 90);
    });
  });

  /* a plain move updates the hover readout rather than panning */
  T.setMapMode('select');
  T.onMapPointerMove(ptr(3 * T.GRID_PITCH + 10, 3 * T.GRID_PITCH + 10, 0));
  ok('a plain move tracks the hovered cell',
     T.mapUI.hover && typeof T.mapUI.hover.gx === 'number');

  /* doors mode resolves a hovered wall, other modes do not */
  T.setMapMode('doors');
  T.onMapPointerMove(ptr(10, 10, 0));
  const doorsTracks = 'hoverEdge' in T.mapUI;
  T.setMapMode('select');
  T.onMapPointerMove(ptr(10, 10, 0));
  ok('leaving doors mode stops resolving walls',
     doorsTracks && T.mapUI.hoverEdge === null);
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
