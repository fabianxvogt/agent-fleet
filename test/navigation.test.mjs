import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import * as graphLayout from "../ui/layout.js";

const source = (await readFile(new URL("../ui/app.js", import.meta.url), "utf8")).replace(/^import .*;\n/gm, "");
const snapshot = (count = 8, chain = false) => ({
  nodes: Array.from({ length: count }, (_, i) => ({
    id: `test:${i}`, agent: "claude", kind: "session", title: `Session ${i}`,
    project: chain ? "Test project" : `Project ${i % 3}`, status: i ? "working" : "waiting", meta: {},
  })),
  edges: chain ? Array.from({ length: count - 1 }, (_, i) => ({ from: `test:${i}`, to: `test:${i + 1}`, kind: "spawn" })) : [],
  counts: { working: count - 1, waiting: 1 }, adapters: [], windowHours: 12, collectMs: 1,
});

// Run the production event handlers with synthetic data and only the DOM surface they use.
// Browser verification covers actual SVG rendering and element geometry separately.
function app(snap = snapshot(), overflow = 0) {
  const elements = new Map();
  let width = 1200;
  let height = 760;
  let onSnapshot;
  let onResize;
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, {
      hidden: id === "panel", dataset: {}, handlers: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(type, fn) { this.handlers[type] = fn; },
      querySelectorAll: () => [],
      getBBox() {
        const L = vm.runInContext("state.lastLayout", context);
        return { x: -overflow, y: 0, width: L.width + overflow * 2, height: L.height };
      },
      setAttribute(name, value) { this[name] = value; },
      setPointerCapture() {},
      getBoundingClientRect() { return { width: width - (get("panel").hidden ? 0 : 360), height, left: 0, top: 0 }; },
      get clientWidth() { return this.getBoundingClientRect().width; },
      get clientHeight() { return height; },
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    ...graphLayout, URL, console,
    createInspector: () => ({ select() {} }),
    createBrowserView: () => ({ select() {} }),
    document: { getElementById: get, querySelectorAll: () => [], addEventListener() {} },
    window: { addEventListener() {} },
    localStorage: { getItem: () => null },
    setInterval() {}, setTimeout() {}, clearTimeout() {},
    ResizeObserver: class {
      constructor(fn) { onResize = fn; }
      observe() {}
    },
    EventSource: class {
      addEventListener(type, fn) { if (type === "snapshot") onSnapshot = fn; }
    },
  });
  vm.runInContext(source, context);
  const send = (value) => onSnapshot({ data: JSON.stringify(value) });
  send(snap);
  return {
    send,
    get,
    view: () => vm.runInContext("({ ...state.view })", context),
    bounds: () => get("viewport").getBBox(),
    size: () => get("canvas").getBoundingClientRect(),
    fire: (type, extra = {}) => get("canvas").handlers[type]({
      preventDefault() {}, target: { closest: () => null }, clientX: 500, clientY: 350, deltaX: 0, deltaY: 0, ...extra,
    }),
    resize(w, h) { width = w; height = h; onResize?.(); },
  };
}

function assertBounded(a) {
  const v = a.view();
  const bounds = a.bounds();
  const size = a.size();
  const minimum = Math.min(1.05, (size.width - 60) / bounds.width, (size.height - 60) / bounds.height);
  assert.ok(v.k >= minimum - 1e-9, `zoom ${v.k} is below fit ${minimum}`);
  for (const [axis, dimension] of [["x", "width"], ["y", "height"]]) {
    const span = bounds[dimension] * v.k;
    const available = size[dimension];
    const start = v[axis] + bounds[axis] * v.k;
    if (span <= available - 60) {
      assert.ok(Math.abs(start - (available - span) / 2) < 1e-6, `${axis}: small graph must stay centered`);
    } else {
      assert.ok(start <= 30 + 1e-6, `${axis}: blank space before graph`);
      assert.ok(start + span >= available - 30 - 1e-6, `${axis}: blank space after graph`);
    }
  }
}

test("wheel panning cannot leave the graph in empty space in either direction", () => {
  const a = app();
  for (const delta of [1e6, -1e6]) {
    a.fire("wheel", { deltaX: delta, deltaY: delta });
    assertBounded(a);
  }
});

test("zoom buttons and pinch cannot zoom out beyond the graph overview", () => {
  const a = app();
  for (let i = 0; i < 60; i++) a.get("zoom-out").onclick();
  assertBounded(a);
  a.fire("wheel", { ctrlKey: true, deltaY: 10000 });
  assertBounded(a);
});

test("Fit includes an entire deep graph even below the old fixed minimum zoom", () => {
  const a = app(snapshot(30, true));
  const v = a.view();
  assert.ok(v.k < 0.2);
  assert.ok(a.bounds().width * v.k <= a.size().width - 60 + 1e-6);
  assertBounded(a);
});

test("dragging a zoomed graph stops at all four boundaries", () => {
  const a = app();
  for (let i = 0; i < 10; i++) a.get("zoom-in").onclick();
  for (const point of [1e6, -1e6]) {
    a.fire("pointerdown");
    a.fire("pointermove", { clientX: point, clientY: point });
    a.fire("pointerup");
    assertBounded(a);
  }
});

test("opening and closing session details keeps navigation bounded", () => {
  const a = app();
  a.get("waiting").handlers.click({ target: { closest: () => ({ dataset: { id: "test:0" } }) } });
  assertBounded(a);
  a.get("panel-close").onclick();
  assertBounded(a);
});

test("resizing and live graph shrinkage recalculate navigation boundaries", () => {
  const a = app(snapshot(30, true));
  for (let i = 0; i < 20; i++) a.get("zoom-in").onclick();
  a.fire("wheel", { deltaX: 1e6 });
  a.send(snapshot(2));
  assertBounded(a);
  a.resize(800, 500);
  assertBounded(a);
});

test("bounds include relation curves outside lane rectangles and negative origins", () => {
  const a = app(snapshot(8, true), 150);
  assert.ok(a.bounds().width * a.view().k <= a.size().width - 60 + 1e-6, "Fit must include every drawn curve");
  assertBounded(a);
  for (let i = 0; i < 10; i++) a.get("zoom-in").onclick();
  for (const delta of [-1e6, 1e6]) {
    a.fire("wheel", { deltaX: delta, deltaY: delta });
    assertBounded(a);
    const start = a.view().x + a.bounds().x * a.view().k;
    const edge = delta < 0 ? start : start + a.bounds().width * a.view().k;
    assert.ok(Math.abs(edge - (delta < 0 ? 30 : a.size().width - 30)) < 1e-6, "outermost drawn edge must be reachable");
  }
});
