/*
   Test entry point. Re-exports every module as a namespace and then runs the
   real entry point, so the app boots exactly as it does in the browser and the
   test can still reach inside it.
*/
export * as geometry from '../src/geometry.js';
export * as palette from '../src/palette.js';
export * as document_ from '../src/document.js';
export * as store from '../src/store.js';
export * as storage from '../src/storage.js';
export * as history from '../src/history.js';
export * as paint from '../src/paint.js';
export * as ops from '../src/ops.js';
export * as files from '../src/files.js';
export * as editor from '../src/editor.js';
export * as mapview from '../src/mapview.js';
export * as ui from '../src/ui.js';

import '../src/main.js';
