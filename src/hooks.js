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

  /*
     Dialogs. The defaults stand in for "no UI attached" and deliberately
     decline: a default that confirmed would turn a missing binding into
     silent data loss.
  */
  askText: () => Promise.resolve(null),
  askConfirm: () => Promise.resolve(false),
  showError: (title, message) => {
    console.error(title + ": " + message);
    return Promise.resolve();
  },
};

export {
  ui,
};
