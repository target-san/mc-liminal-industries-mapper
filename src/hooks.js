/*
   Late-bound UI callbacks.

   Lower layers -- storage, history, the canvases -- need to ask the UI to
   redraw, but must not import it: that would make the dependency graph
   circular. ui.js fills these in once at startup.
*/

const ui = {
  refreshAll() {},
  renderPalette() {},
  updateHistoryButtons() {},
  setStatus() {},
  fitEditorView() {},
};

export {
  ui,
};
