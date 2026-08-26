/*
   Entry point.
*/

import { state, setState, setSelectedTemplate } from './store.js';
import { loadFromStorage, storageBroken } from './storage.js';
import { setTool, resizeCanvas } from './editor.js';
import { resizeMapCanvas } from './mapview.js';
import { refreshAll, setStatus } from './ui.js';

/* ---------- Boot ---------- */

const restored = loadFromStorage();
if (restored) {
  setState(restored);
  setSelectedTemplate(state.templates.length ? state.templates[0].id : null);
}

setTool("pencil");
/* Each canvas restores or fits its own view on its first real measurement,
   so the hidden tab simply does it later, when it is first shown. */
resizeCanvas();
resizeMapCanvas();
refreshAll();
setStatus(storageBroken ? "autosave off -- use Export" : "saved",
          storageBroken ? "error" : "");
