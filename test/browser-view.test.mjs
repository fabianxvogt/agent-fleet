import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserView, visibleClicks } from "../ui/browser-view.js";

function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const oldDocument = globalThis.document;
  const listeners = new Map();
  globalThis.document = { hidden: false, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) };
  const elements = new Map();
  const root = { hidden: true, innerHTML: "", querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, { textContent: "", innerHTML: "", dataset: {}, src: "", removeAttribute(name) { this[name] = ""; } });
    return elements.get(selector);
  } };
  const sources = [];
  const images = [];
  const view = createBrowserView(root, { eventSource(url) {
    const handlers = new Map();
    const source = { url, closed: false, addEventListener: (name, fn) => handlers.set(name, fn), close() { this.closed = true; }, emit(name, value) { handlers.get(name)?.({ data: JSON.stringify(value) }); } };
    sources.push(source); return source;
  }, newImage() { const image = { src: "", onload: null }; images.push(image); return image; } });
  t.after(() => { view.destroy(); globalThis.document = oldDocument; });
  return { root, view, sources, images, el: (s) => root.querySelector(s), visibility(hidden) { document.hidden = hidden; listeners.get("visibilitychange")(); } };
}
const live = (documentId = 1, extra = {}) => ({ state: "live", runId: "run", documentId, clicks: [], ...extra });
const frame = (documentId = 1, extra = {}) => ({ runId: "run", documentId, data: "/9j/", at: Date.now(), width: 1280, height: 800, ...extra });

test("click markers require the same run/document, a post-click frame, viewport coordinates and a recent timestamp", () => {
  const now = Date.now();
  const click = { id: 1, documentId: 1, x: 100, y: 200, at: now - 100 };
  const status = live(1, { clicks: [click] });
  assert.equal(visibleClicks(frame(), status).length, 1);
  for (const badFrame of [frame(2), frame(1, { runId: "other" }), frame(1, { at: now - 101 })]) assert.equal(visibleClicks(badFrame, status).length, 0);
  for (const badClick of [{ ...click, x: -1 }, { ...click, y: 800 }, { ...click, x: Infinity }, { ...click, at: now - 6000 }, { ...click, at: now + 1 }]) assert.equal(visibleClicks(frame(), { ...status, clicks: [badClick] }).length, 0);
});

test("changing session cancels streams and pending image decodes", (t) => {
  const f = fixture(t);
  f.view.select("first");
  const first = f.sources[0];
  first.emit("status", live()); first.emit("frame", frame());
  const lateLoad = f.images[0].onload;
  f.view.select("second");
  assert.equal(first.closed, true);
  lateLoad();
  first.emit("status", live(1, { url: "OLD SESSION" }));
  assert.equal(f.el(".browser-image").src, "");
  assert.notEqual(f.el(".browser-location").textContent, "OLD SESSION");
  const second = f.sources[1];
  second.emit("status", live()); second.emit("frame", frame()); f.images.at(-1).onload();
  assert.ok(f.el(".browser-image").src.startsWith("data:image/jpeg"));
  f.view.select("second"); assert.equal(f.sources.length, 2);
  f.view.select(null); assert.equal(f.root.hidden, true); assert.equal(second.closed, true);
});

test("navigation clears old frames and click rings; late frames from the previous document are ignored", (t) => {
  const f = fixture(t);
  f.view.select("session"); const source = f.sources[0];
  const click = { id: 1, documentId: 1, x: 640, y: 400, at: Date.now() };
  source.emit("status", live(1, { clicks: [click] })); source.emit("frame", frame()); f.images.at(-1).onload();
  assert.ok(f.el(".browser-clicks").innerHTML.includes("left:50%;top:50%"));
  source.emit("status", live(2, { state: "loading" }));
  assert.equal(f.el(".browser-image").src, ""); assert.equal(f.el(".browser-clicks").innerHTML, "");
  const count = f.images.length;
  source.emit("frame", frame()); source.emit("frame", frame(2, { width: 900 }));
  assert.equal(f.images.length, count);
  source.emit("status", live(2)); source.emit("frame", frame(2)); f.images.at(-1).onload();
  assert.ok(f.el(".browser-image").src);
});

test("disconnect invalidates late events immediately and reconnects with an empty view", (t) => {
  const f = fixture(t);
  f.view.select("session"); const source = f.sources[0];
  source.emit("status", live()); source.emit("frame", frame()); f.images.at(-1).onload();
  source.onerror();
  source.emit("status", live()); source.emit("frame", frame());
  assert.equal(f.el(".browser-image").src, ""); assert.equal(f.el(".browser-state").dataset.state, "disconnected");
  t.mock.timers.tick(3000); assert.equal(f.sources.length, 2);
  f.sources[1].emit("status", live());
  t.mock.timers.tick(9000);
  assert.equal(f.sources[1].closed, true); assert.equal(f.el(".browser-state").dataset.state, "disconnected");
});

test("hidden tabs stop capture; unavailable/restricted contexts never show a frozen image", (t) => {
  const f = fixture(t);
  f.view.select("session");
  f.sources[0].emit("status", live()); f.sources[0].emit("frame", frame()); f.images.at(-1).onload();
  f.visibility(true); assert.equal(f.sources[0].closed, true); assert.equal(f.el(".browser-image").src, "");
  t.mock.timers.tick(10_000); assert.equal(f.sources.length, 1);
  f.visibility(false); assert.equal(f.sources.length, 2);
  f.sources[1].emit("status", { state: "unavailable", startCommand: 'node "<script>"' });
  assert.ok(f.el(".browser-help").innerHTML.includes("&lt;script&gt;"));
  t.mock.timers.tick(3000);
  f.sources[2].emit("status", { state: "restricted" });
  t.mock.timers.tick(10_000); assert.equal(f.sources.length, 3);
  assert.equal(f.el(".browser-image").src, "");
});
