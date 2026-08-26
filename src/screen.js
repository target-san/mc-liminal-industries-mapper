/*
   Display state shared by both canvases.
*/

/* Device pixel ratio, refreshed on every resize. Tile edges are snapped to
   this grid: at fractional ratios a whole CSS pixel falls between device
   pixels and neighbouring tiles antialias into a visible seam. */
let dpr = 1;

function setDpr(v) {
  dpr = v || 1;
  return dpr;
}

/* Held space pans whichever canvas is under the mouse, on both tabs. */
let spaceHeld = false;

function setSpaceHeld(v) {
  spaceHeld = v;
}

export {
  dpr,
  setDpr,
  spaceHeld,
  setSpaceHeld,
};
