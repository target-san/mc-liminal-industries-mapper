/*
   The live document plus the selection that follows it around.
*/

import { createDocument } from './document.js';
import { SLOT_FLOOR } from './palette.js';

let state = createDocument();
let selectedTemplateId = null;

/* templateId -> 47x47 offscreen canvas, one pixel per tile. Rebuilt lazily and
   dropped wholesale whenever the document changes. */
const templateBitmaps = new Map();

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
  currentTemplate,
  setState,
  setSelectedTemplate,
  setPaletteSlot,
};
