/*
   Entry point.
*/

import { state, setState, setSelectedTemplate } from './store.js';
import { loadFromStorage, storageBroken } from './storage.js';
import { setTool, resizeCanvas, fitView } from './editor.js';
import { refreshAll, setStatus } from './ui.js';

/* ---------- Boot ---------- */

const restored = loadFromStorage();
if (restored) {
  setState(restored);
  setSelectedTemplate(state.templates.length ? state.templates[0].id : null);
}

setTool("pencil");
resizeCanvas();
fitView();
refreshAll();
setStatus(storageBroken ? "autosave off -- use Export" : "saved",
          storageBroken ? "error" : "");
