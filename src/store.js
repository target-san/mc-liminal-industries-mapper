/*
   The live document plus the selection that follows it around.
*/

import { createDocument } from './document.js';
import { SLOT_FLOOR } from './palette.js';

let state = createDocument();
let selectedTemplateId = null;

/*
   templateId -> { marks, map }: two 47x47 offscreen canvases, one pixel per
   tile. `marks` paints possible doorways in the passage colour, for the
   editor and the thumbnails. `map` paints them as solid wall, because on the
   map a doorway only exists where an edge has actually been opened -- those
   tiles are painted back over the blit. Both are dropped together whenever
   the template changes.
*/
const templateBitmaps = new Map();

/* templateId -> exit group analysis. Same lifetime as the bitmaps: both are
   derived from the cells and both die when those change. */
const sectionCache = new Map();

/* One place to forget everything derived from a template. */
function forgetTemplate(id) {
  templateBitmaps.delete(id);
  sectionCache.delete(id);
}

function forgetAllTemplates() {
  templateBitmaps.clear();
  sectionCache.clear();
}

function currentTemplate() {
  if (selectedTemplateId === null) return null;
  return state.templates.find(function (t) { return t.id === selectedTemplateId; }) || null;
}


let paletteSlot = SLOT_FLOOR;

/*
   The live document is a rebindable binding rather than a mutable wrapper:
   importers see updates through ES module live bindings, but only this module
   may reassign it, which keeps every replacement funnelled through one place.
*/
function setState(next) {
  state = next;
}

function setSelectedTemplate(id) {
  selectedTemplateId = id;
}

function setPaletteSlot(n) {
  paletteSlot = n;
}

export {
  state,
  selectedTemplateId,
  paletteSlot,
  templateBitmaps,
  sectionCache,
  forgetTemplate,
  forgetAllTemplates,
  currentTemplate,
  setState,
  setSelectedTemplate,
  setPaletteSlot,
};
