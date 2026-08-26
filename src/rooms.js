/*
   Named rooms and bookmarks.

   A name belongs to the placement, not to the template: the same template is
   placed many times, and "Reception" is a fact about one spot on the map. A
   bookmark stores only the placement key and reads the name back through
   roomName, so renaming a room renames its bookmark with no syncing to do.
*/

import { state } from './store.js';
import { withUndo } from './history.js';
import { markDirty } from './storage.js';

/* The name to show for a placed room: its own if it has one, else the
   template it was stamped from. */
function roomName(key) {
  const p = state.map.placements[key];
  if (!p) return null;
  if (p.label) return p.label;
  const t = state.templates.find(function (x) { return x.id === p.templateId; });
  return t ? t.name : "room";
}

function hasOwnName(key) {
  const p = state.map.placements[key];
  return !!(p && p.label);
}

/* An empty name clears it, falling back to the template name. */
function setRoomLabel(key, label) {
  const p = state.map.placements[key];
  if (!p) return;
  const next = String(label == null ? "" : label).trim();
  if ((p.label || "") === next) return;
  withUndo(function () {
    if (next) p.label = next;
    else delete p.label;
    markDirty();
  });
}

function isBookmarked(key) {
  return state.map.bookmarks.indexOf(key) !== -1;
}

function toggleBookmark(key) {
  if (!state.map.placements[key]) return;
  withUndo(function () {
    const at = state.map.bookmarks.indexOf(key);
    if (at === -1) state.map.bookmarks.push(key);
    else state.map.bookmarks.splice(at, 1);
    markDirty();
  });
}

/* Called from inside the undo step that removes a room. */
function dropBookmark(key) {
  const at = state.map.bookmarks.indexOf(key);
  if (at !== -1) state.map.bookmarks.splice(at, 1);
}

/* Bookmarks in the order they were added, skipping any whose room is gone. */
function bookmarkList() {
  return state.map.bookmarks
    .filter(function (key) { return !!state.map.placements[key]; })
    .map(function (key) { return { key: key, name: roomName(key) }; });
}

export {
  roomName,
  hasOwnName,
  setRoomLabel,
  isBookmarked,
  toggleBookmark,
  dropBookmark,
  bookmarkList,
};
