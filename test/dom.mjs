/*
   The smallest DOM that lets the real bundle boot: enough element and canvas
   surface for module-level wiring and a full draw pass. Anything the code
   touches that is not stubbed shows up as a ReferenceError or a TypeError
   rather than passing silently.
*/
const noop = () => {};

const ctxStub = new Proxy({
  measureText: () => ({ width: 10 }),
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  setTransform: noop, fillRect: noop, strokeRect: noop, clearRect: noop,
  beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop, fill: noop, arc: noop,
  save: noop, restore: noop, fillText: noop,
  translate: noop, scale: noop, rotate: noop,
  drawImage: noop, putImageData: noop,
}, { get: (t, k) => (k in t ? t[k] : undefined), set: () => true });

function makeEl(id) {
  const el = {
    id, style: {}, dataset: {}, children: [],
    classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
    addEventListener: noop, removeEventListener: noop,
    appendChild(c) { this.children.push(c); return c; },
    remove: noop, click: noop, focus: noop,
    setPointerCapture: noop,
    setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
    showModal: noop, close: noop, returnValue: '',
    rect: { left: 0, top: 0, width: 900, height: 700 },
    getBoundingClientRect() { return this.rect; },
    getContext: () => ctxStub,
    className: '', value: '', disabled: false,
  };
  /* Assigning textContent drops every child, as it does in a real DOM.
     Without this, panels that clear themselves before re-rendering appeared
     to accumulate rows and the tests could not see a stale render. */
  let text = '';
  Object.defineProperty(el, 'textContent', {
    get: () => text,
    set: (v) => { text = String(v); el.children.length = 0; },
    enumerable: true,
    configurable: true,
  });
  return el;
}

export function makeSandbox() {
  const els = new Map();
  const document = {
    getElementById(id) {
      if (!els.has(id)) els.set(id, makeEl(id));
      return els.get(id);
    },
    querySelectorAll: () => [],
    createElement: () => makeEl('new'),
    createDocumentFragment: () => makeEl('frag'),
    body: makeEl('body'),
  };
  const store = new Map();
  const sandbox = {
    document,
    window: { addEventListener: noop, devicePixelRatio: 1, ResizeObserver: undefined },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    console, setTimeout, clearTimeout,
    Math, JSON, Date, Object, Array, String, Number, Boolean, Error, RegExp,
    Map, Set, Uint8Array, Int16Array, Int32Array, Uint8ClampedArray, Infinity, NaN,
    parseInt, parseFloat, isNaN, isFinite,
    Blob: class {}, FileReader: class {},
    URL: { createObjectURL: () => '', revokeObjectURL: noop },
    alert: noop, confirm: () => true, prompt: () => 'renamed',
  };
  sandbox.globalThis = sandbox;
  return sandbox;
}
