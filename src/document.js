/*
   Document construction and the on-disk format. Pure.
*/

import { ROOM_SIZE, ROOM_MAX, CELL_COUNT, cellIndex, LAMP_LINES, DOOR_LO, DOOR_HI }
  from './geometry.js';
import { defaultPalette, defaultSlotAt, RESERVED_KINDS, MAX_PALETTE, SLOT_LAMP, SLOT_PASSAGE }
  from './palette.js';

/* ============================================================
   Document state
   ============================================================ */

const DOC_FORMAT  = "liminal-industries-mapper";
const DOC_VERSION = 1;

let uidCounter = 0;

function uid(prefix) {
  uidCounter += 1;
  return prefix + "-" + uidCounter.toString(36) + "-" +
         Math.floor(Math.random() * 0x10000).toString(36);
}

function createTemplate(name) {
  const cells = new Uint8Array(CELL_COUNT);
  for (let r = 0; r < ROOM_SIZE; r++) {
    for (let c = 0; c < ROOM_SIZE; c++) {
      cells[cellIndex(r, c)] = defaultSlotAt(r, c);
    }
  }
  /* Every room starts with the standard ceiling lamp grid ... */
  for (let a = 0; a < LAMP_LINES.length; a++) {
    for (let b = 0; b < LAMP_LINES.length; b++) {
      cells[cellIndex(LAMP_LINES[a], LAMP_LINES[b])] = SLOT_LAMP;
    }
  }
  /* ... and a doorway in the middle of each of its four walls. */
  for (let i = DOOR_LO; i <= DOOR_HI; i++) {
    cells[cellIndex(0, i)]        = SLOT_PASSAGE;
    cells[cellIndex(ROOM_MAX, i)] = SLOT_PASSAGE;
    cells[cellIndex(i, 0)]        = SLOT_PASSAGE;
    cells[cellIndex(i, ROOM_MAX)] = SLOT_PASSAGE;
  }
  return { id: uid("tpl"), name: name, cells: cells };
}

function createDocument() {
  return {
    palette: defaultPalette(),
    templates: [],
    map: {
      placements: {},        // "gx,gy" -> { templateId, rot, mir, label? }
      openEdges: new Set(),  // edgeKey strings
      bookmarks: [],         // placement keys, in the order they were added
      anchor: null,          // { gx, gy, r, c, worldX, worldZ }
    },
  };
}



/* ============================================================
   Serialization
   ------------------------------------------------------------
   Cells are run-length encoded as [slot, count] pairs. Rooms are
   mostly uniform, so this keeps documents small and still readable
   in a text editor.
   ============================================================ */

function encodeCells(cells) {
  const runs = [];
  let value = cells[0];
  let count = 1;
  for (let i = 1; i < cells.length; i++) {
    if (cells[i] === value) {
      count += 1;
    } else {
      runs.push([value, count]);
      value = cells[i];
      count = 1;
    }
  }
  runs.push([value, count]);
  return runs;
}

function decodeCells(runs, where) {
  if (!Array.isArray(runs)) throw new Error(where + ": cells must be an array");
  const cells = new Uint8Array(CELL_COUNT);
  let pos = 0;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (!Array.isArray(run) || run.length !== 2) {
      throw new Error(where + ": run " + i + " is not a [slot, count] pair");
    }
    const value = run[0] | 0;
    const count = run[1] | 0;
    if (count < 1) throw new Error(where + ": run " + i + " has a non-positive count");
    if (pos + count > CELL_COUNT) throw new Error(where + ": cell runs overflow the room");
    cells.fill(value, pos, pos + count);
    pos += count;
  }
  if (pos !== CELL_COUNT) {
    throw new Error(where + ": cell runs cover " + pos + " tiles, expected " + CELL_COUNT);
  }
  return cells;
}

function serialize(doc) {
  return {
    format: DOC_FORMAT,
    version: DOC_VERSION,
    roomSize: ROOM_SIZE,
    palette: doc.palette.map(function (e) {
      return { id: e.id, name: e.name, color: e.color, passable: e.passable, kind: e.kind };
    }),
    templates: doc.templates.map(function (t) {
      return { id: t.id, name: t.name, cells: encodeCells(t.cells) };
    }),
    map: {
      placements: doc.map.placements,
      openEdges: Array.from(doc.map.openEdges).sort(),
      bookmarks: doc.map.bookmarks.slice(),
      anchor: doc.map.anchor,
    },
  };
}

function deserialize(raw) {
  if (!raw || typeof raw !== "object") throw new Error("not a JSON object");
  if (raw.format !== DOC_FORMAT) throw new Error("not a Liminal Industries Mapper document");
  if (raw.version !== DOC_VERSION) {
    throw new Error("unsupported document version " + raw.version +
                    " (this build reads version " + DOC_VERSION + ")");
  }
  if (raw.roomSize !== undefined && raw.roomSize !== ROOM_SIZE) {
    throw new Error("document uses room size " + raw.roomSize +
                    ", this build uses " + ROOM_SIZE);
  }

  const doc = createDocument();

  /* Palette. Reserved entries are re-anchored to the leading slots and custom
     ones appended in file order, then slotMap translates every stored cell
     from the file's slot numbering into the rebuilt one. Going through a map
     rather than assuming the orders agree is what lets the reserved set gain
     an entry -- ceiling lamps, say -- without corrupting older documents, and
     what makes a hand-reordered palette load correctly. */
  if (!Array.isArray(raw.palette)) throw new Error("palette is missing");
  const slotMap = new Array(raw.palette.length).fill(-1);
  const reserved = defaultPalette();

  for (let i = 0; i < raw.palette.length; i++) {
    const e = raw.palette[i];
    if (!e || typeof e !== "object") continue;
    const k = RESERVED_KINDS.indexOf(e.id);
    if (k === -1) continue;
    slotMap[i] = k;
    if (typeof e.color === "string") reserved[k].color = e.color;
    if (typeof e.name === "string" && e.name) reserved[k].name = e.name;
  }
  doc.palette = reserved;

  for (let i = 0; i < raw.palette.length; i++) {
    const e = raw.palette[i];
    if (!e || typeof e !== "object") continue;
    if (slotMap[i] !== -1) continue;
    if (typeof e.id !== "string" || typeof e.color !== "string") {
      throw new Error("palette entry " + i + " is malformed");
    }
    slotMap[i] = doc.palette.length;
    doc.palette.push({
      id: e.id,
      name: typeof e.name === "string" ? e.name : e.id,
      color: e.color,
      passable: e.passable !== false,
      kind: "custom",
    });
  }
  if (doc.palette.length > MAX_PALETTE) {
    throw new Error("palette holds more than " + MAX_PALETTE + " colours");
  }

  /* Templates. */
  if (!Array.isArray(raw.templates)) throw new Error("templates are missing");
  for (let i = 0; i < raw.templates.length; i++) {
    const t = raw.templates[i];
    if (!t || typeof t !== "object" || typeof t.id !== "string") {
      throw new Error("template " + i + " is malformed");
    }
    const where = "template " + (typeof t.name === "string" ? t.name : i);
    const cells = decodeCells(t.cells, where);
    for (let k = 0; k < cells.length; k++) {
      const mapped = slotMap[cells[k]];
      if (mapped === undefined || mapped === -1) {
        throw new Error(where + ": cell references a missing palette slot");
      }
      cells[k] = mapped;
    }
    doc.templates.push({ id: t.id, name: typeof t.name === "string" ? t.name : "Room", cells: cells });
  }

  /* Map. */
  const rawMap = raw.map && typeof raw.map === "object" ? raw.map : {};
  const knownTemplates = new Set(doc.templates.map(function (t) { return t.id; }));
  const rawPlacements = rawMap.placements && typeof rawMap.placements === "object"
    ? rawMap.placements : {};
  Object.keys(rawPlacements).forEach(function (key) {
    const p = rawPlacements[key];
    if (!p || typeof p !== "object") throw new Error("placement " + key + " is malformed");
    if (!knownTemplates.has(p.templateId)) {
      throw new Error("placement " + key + " references an unknown template");
    }
    doc.map.placements[key] = {
      templateId: p.templateId,
      rot: (p.rot | 0) & 3,
      mir: p.mir === true,
    };
    if (typeof p.label === "string" && p.label.trim()) {
      doc.map.placements[key].label = p.label.trim();
    }
  });

  if (Array.isArray(rawMap.openEdges)) {
    rawMap.openEdges.forEach(function (k) {
      if (typeof k === "string") doc.map.openEdges.add(k);
    });
  }

  /* Bookmarks pointing at rooms that are not there are dropped rather than
     kept as dead entries. */
  if (Array.isArray(rawMap.bookmarks)) {
    rawMap.bookmarks.forEach(function (key) {
      if (typeof key !== "string") return;
      if (!doc.map.placements[key]) return;
      if (doc.map.bookmarks.indexOf(key) === -1) doc.map.bookmarks.push(key);
    });
  }

  if (rawMap.anchor && typeof rawMap.anchor === "object") {
    const a = rawMap.anchor;
    doc.map.anchor = {
      gx: a.gx | 0, gy: a.gy | 0,
      r: a.r | 0, c: a.c | 0,
      worldX: a.worldX | 0, worldZ: a.worldZ | 0,
    };
  }

  return doc;
}

export {
  DOC_FORMAT,
  DOC_VERSION,
  uid,
  createTemplate,
  createDocument,
  encodeCells,
  decodeCells,
  serialize,
  deserialize,
};
