import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import * as graphLayout from "../ui/layout.js";

const source = (await readFile(new URL("../ui/app.js", import.meta.url), "utf8")).replace(/^import .*;\n/gm, "");
const NOW = Date.parse("2026-10-18T12:00:00Z");
const snapshot = (count = 8, chain = false) => ({
  nodes: Array.from({ length: count }, (_, i) => ({
    id: `test:${i}`, agent: "claude", kind: "session", title: `Session ${i}`,
    project: chain ? "Test project" : `Project ${i % 3}`, status: i ? "working" : "waiting", meta: {},
  })),
  edges: chain ? Array.from({ length: count - 1 }, (_, i) => ({ from: `test:${i}`, to: `test:${i + 1}`, kind: "spawn" })) : [],
  counts: { working: count - 1, waiting: 1 }, adapters: [], windowHours: 12, collectMs: 1, intervalMs: 4000, generatedAt: new Date(NOW).toISOString(),
});

// Run the production event handlers with synthetic data and only the DOM surface they use.
// Browser verification covers actual SVG rendering and element geometry separately.
function app(snap = snapshot(), overflow = 0, preferences = {}) {
  const elements = new Map();
  const writes = new Map();
  const storage = new Map(Object.entries(preferences));
  let width = 1200;
  let height = 760;
  const eventHandlers = {};
  let eventSource;
  let onTick;
  let now = NOW;
  let layoutCalls = 0;
  let inspectorCalls = 0;
  let onResize;
  const openedTabs = [];
  const selections = [];
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, {
      hidden: id === "panel", dataset: {}, handlers: {},
      get innerHTML() { return this.html ?? ""; },
      set innerHTML(value) { this.html = value; writes.set(id, (writes.get(id) ?? 0) + 1); },
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(type, fn) { this.handlers[type] = fn; },
      querySelectorAll: () => [],
      getBBox() {
        const L = vm.runInContext("state.lastLayout", context);
        return { x: -overflow, y: 0, width: L.width + overflow * 2, height: L.height };
      },
      setAttribute(name, value) { this[name] = value; },
      getAttribute(name) { return this[name]; },
      setPointerCapture() {},
      getBoundingClientRect() { return { width: width - (get("panel").hidden ? 0 : 360), height, left: 0, top: 0 }; },
      get clientWidth() { return this.getBoundingClientRect().width; },
      get clientHeight() { return height; },
    });
    return elements.get(id);
  };
  const scopes = ["live", "all"].map((scope) => {
    const button = get(`scope-${scope}`);
    button.dataset.scope = scope;
    return button;
  });
  const context = vm.createContext({
    ...graphLayout, URL, console,
    layout(...args) { layoutCalls++; return graphLayout.layout(...args); },
    Date: class extends Date { static now() { return now; } },
    createInspector: () => ({ select(...args) { inspectorCalls++; selections.push(args); }, showTab(tab) { openedTabs.push(tab); } }),
    createBrowserView: () => ({ select() {} }),
    document: { getElementById: get, querySelectorAll: (selector) => selector === "[data-scope]" ? scopes : [], addEventListener() {} },
    window: { addEventListener() {} },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    setInterval(fn) { onTick = fn; }, setTimeout() {}, clearTimeout() {},
    ResizeObserver: class {
      constructor(fn) { onResize = fn; }
      observe() {}
    },
    EventSource: class {
      constructor() { eventSource = this; }
      addEventListener(type, fn) { eventHandlers[type] = fn; }
    },
  });
  vm.runInContext(source, context);
  const send = (value) => eventHandlers.snapshot({ data: JSON.stringify(value) });
  send(snap);
  return {
    send,
    get,
    openedTabs,
    selections,
    preferences: () => Object.fromEntries(storage),
    writes: (id) => writes.get(id) ?? 0,
    state: () => JSON.parse(vm.runInContext("JSON.stringify({ selected: state.selected, display: state.display, project: state.project, status: state.status, query: state.query, hiddenAgents: [...state.hiddenAgents], scope: state.scope, visibleIds: [...state.visibleIds] })", context)),
    folds: () => JSON.parse(vm.runInContext("JSON.stringify([...state.collapsedParents])", context)),
    health: (value) => eventHandlers.health({ data: JSON.stringify(value) }),
    disconnect: () => eventSource.onerror(),
    tick(ms = 1000) { now += ms; onTick(); },
    layoutCalls: () => layoutCalls,
    inspectorCalls: () => inspectorCalls,
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

test("verified live views get a graph badge that opens Live by click or keyboard", () => {
  const snap = snapshot(2);
  snap.nodes[0].liveView = { available: true, mode: "attached" };
  const a = app(snap);
  assert.equal((a.get("viewport").innerHTML.match(/class="live-badge"/g) ?? []).length, 1);
  const target = { closest: (selector) => selector === ".node" ? { dataset: { id: snap.nodes[0].id } } : selector === "[data-live-view]" ? {} : null };
  a.get("viewport").handlers.click({ target });
  assert.equal(a.openedTabs.at(-1), "live");
  let prevented = false;
  a.get("viewport").handlers.keydown({ target, key: "Enter", preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(a.openedTabs.length, 2);
  snap.nodes[0].liveView = null;
  a.send(snap);
  assert.equal(a.get("viewport").innerHTML.includes('class="live-badge"'), false);
});

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

test("health ticks refresh age without relayout or reselecting the inspector and detect stalled/disconnected updates", () => {
  const snap = snapshot(2);
  snap.adapters = [{ id: "claude", label: "Claude", nodes: 2, ms: 3, lastSuccessAt: snap.generatedAt }];
  const a = app(snap);
  assert.match(a.get("pulse-text").textContent, /^Current/);
  a.get("waiting").handlers.click({ target: { closest: () => ({ dataset: { id: "test:0" } }) } });
  const layouts = a.layoutCalls();
  const selections = a.inspectorCalls();
  a.tick(13_000);
  assert.match(a.get("pulse-text").textContent, /^Delayed/);
  assert.match(a.get("sources").innerHTML, /updated 13s ago/);
  assert.equal(a.get("canvas").dataset.freshness, "stale");
  assert.equal(a.get("data-notice").hidden, false);
  assert.equal(a.get("panel-data-notice").hidden, false);
  a.health({ ...snap, generatedAt: new Date(NOW + 13_000).toISOString(), adapters: [{ ...snap.adapters[0], lastSuccessAt: new Date(NOW + 13_000).toISOString() }] });
  assert.match(a.get("pulse-text").textContent, /^Current/);
  assert.match(a.get("sources").innerHTML, /updated just now/);
  assert.equal(a.get("canvas").dataset.freshness, "current");
  assert.equal(a.get("data-notice").hidden, true);
  a.disconnect();
  assert.match(a.get("pulse-text").textContent, /^Disconnected/);
  assert.equal(a.get("canvas").dataset.freshness, "stale");
  a.tick();
  assert.match(a.get("pulse-text").textContent, /^Disconnected/);
  assert.equal(a.layoutCalls(), layouts);
  assert.equal(a.inspectorCalls(), selections);
});

test("a slow collection does not extend freshness and source failures explain retained data", () => {
  const snap = snapshot(2);
  const a = app(snap);
  a.health({ ...snap, collectMs: 20_000 });
  assert.match(a.get("pulse-text").textContent, /^Slow update/);
  a.tick(13_000);
  assert.match(a.get("pulse-text").textContent, /^Delayed/);
  a.health({ ...snap, generatedAt: new Date(NOW + 13_000).toISOString(), degraded: true, adapters: [{ label: "Claude", nodes: 2, error: "Cannot read <private path>", stale: true, retained: true, lastSuccessAt: snap.generatedAt }] });
  assert.match(a.get("pulse-text").textContent, /^Source unavailable/);
  assert.match(a.get("sources").innerHTML, /cached · unavailable/);
  assert.match(a.get("sources").innerHTML, /updated 13s ago/);
  assert.doesNotMatch(a.get("sources").innerHTML, /<private path>/);
});

test("failure counts and attention groups remain distinct, filter together and expire completed entries", () => {
  const snap = snapshot(0);
  snap.nodes = [
    { id: "q", title: "Fix collector", agent: "claude", kind: "session", project: "fleet", status: "waiting", attention: { kind: "question", reason: "Input requested", evidence: "explicit" } },
    { id: "e", title: "Fix browser", agent: "claude", kind: "session", project: "fleet", status: "failed", meta: { parked: true } },
    { id: "a", title: "Collector done", agent: "codex", kind: "session", project: "fleet", status: "idle", attention: { kind: "completed", reason: "Answer finished", evidence: "inferred", at: new Date(NOW - 599_000).toISOString() } },
  ];
  const a = app(snap);
  assert.match(a.get("viewport").innerHTML, /data-id="e"/);
  assert.match(a.get("stats").innerHTML, /<b>1<\/b>Failed/);
  assert.match(a.get("waiting").innerHTML, /<button[^>]*data-id="q"/);
  assert.doesNotMatch(a.get("waiting").innerHTML, /data-id="a"/);
  assert.match(a.get("failed").innerHTML, /data-id="e"/);
  assert.match(a.get("completed").innerHTML, /Answer finished · inferred/);
  a.get("search").handlers.input({ target: { value: "collector" } });
  assert.doesNotMatch(a.get("failed").innerHTML, /data-id="e"/);
  assert.doesNotMatch(a.get("viewport").innerHTML, /data-id="e"/);
  a.tick(1001);
  assert.doesNotMatch(a.get("completed").innerHTML, /data-id="a"/);
  assert.equal(a.get("completed-count").textContent, 0);
});

test("retained source activity is marked last known and does not animate as working", () => {
  const snap = snapshot(1);
  snap.nodes[0].status = "working";
  snap.nodes[0].meta = { dataStale: true };
  const a = app(snap);
  assert.match(a.get("viewport").innerHTML, /data-stale/);
  assert.match(a.get("viewport").innerHTML, /Last known: Working/);
  assert.doesNotMatch(a.get("viewport").innerHTML, /class="halo"/);
  assert.match(a.get("stats").innerHTML, /<b>0<\/b>Working/);
  assert.match(a.get("stats").innerHTML, /<b>1<\/b>Last known/);
});

const rowIds = (a, id = "session-rows") => [...a.get(id).innerHTML.matchAll(/data-id="([^"]+)"/g)].map((match) => match[1]);
const clickSession = (a, id, { live = false, element = "session-rows" } = {}) => {
  const sessionSelector = element === "viewport" ? ".node" : element === "session-rows" ? "[data-id]" : "button[data-id]";
  a.get(element).handlers.click({ target: { closest: (selector) => selector === "[data-live-view]" ? (live ? {} : null) : selector === sessionSelector ? { dataset: { id } } : null } });
};
const changeFilter = (a, id, value) => a.get(`${id}-filter`).handlers.change({ target: { value } });

test("switching graph and list preserves the selected session and persists the chosen display", () => {
  const snap = snapshot(3);
  const a = app(snap);
  clickSession(a, "test:0", { element: "waiting" });
  const layouts = a.layoutCalls();
  a.get("view-list").onclick();
  assert.equal(a.layoutCalls(), layouts, "list rendering must not calculate a graph layout");
  assert.equal(a.state().selected, "test:0");
  assert.equal(a.get("panel").hidden, false);
  assert.equal(a.selections.at(-1)[0], "test:0");
  assert.equal(a.get("graph").hidden, true);
  assert.equal(a.get("session-list").hidden, false);
  assert.equal(a.get("view-list").getAttribute("aria-pressed"), "true");
  const reopened = app(snap, 0, a.preferences());
  assert.equal(reopened.state().display, "list");
  assert.equal(reopened.layoutCalls(), 0, "a saved list preference must skip the initial graph layout");
  assert.deepEqual(rowIds(reopened), ["test:0", "test:1", "test:2"]);
  clickSession(a, "test:1");
  a.get("view-graph").onclick();
  assert.equal(a.state().selected, "test:1");
  assert.equal(a.selections.at(-1)[0], "test:1");
  assert.equal(a.get("session-list").hidden, true);
  assert.equal(a.get("graph").hidden, false);
  assert.equal(a.get("view-graph").getAttribute("aria-pressed"), "true");
  assert.equal(a.preferences()["agent-fleet:display"], '"graph"');
});

test("list scrolling and pointer gestures leave graph navigation untouched", () => {
  const a = app(snapshot(30, true));
  a.get("zoom-in").onclick();
  const before = JSON.stringify(a.view());
  a.get("view-list").onclick();
  let prevented = 0;
  a.fire("wheel", { deltaY: 180, preventDefault() { prevented++; } });
  a.fire("wheel", { ctrlKey: true, deltaY: -50, preventDefault() { prevented++; } });
  a.fire("pointerdown");
  a.fire("pointermove", { clientX: 900, clientY: 600 });
  a.fire("pointerup");
  assert.equal(prevented, 0, "the list must retain browser scrolling and zoom gestures");
  assert.equal(JSON.stringify(a.view()), before);
});

test("project, status, search and agent filters agree across graph, list, attention and counts", () => {
  const snap = snapshot(0);
  const base = { agent: "claude", kind: "session", project: "Alpha", status: "waiting", title: "Build target", attention: { kind: "question", reason: "Choose target", evidence: "explicit" } };
  snap.nodes = [
    { ...base, id: "match" },
    { ...base, id: "other-project", project: "Alpha tools" },
    { ...base, id: "other-status", status: "working" },
    { ...base, id: "other-title", title: "Review results" },
    { ...base, id: "other-agent", agent: "codex" },
  ];
  snap.edges = [{ from: "other-status", to: "match", kind: "spawn" }];
  const a = app(snap);
  changeFilter(a, "project", "project:Alpha");
  changeFilter(a, "status", "waiting");
  a.get("search").handlers.input({ target: { value: "BUILD" } });
  a.get("agent-filters").handlers.change({ target: { dataset: { agent: "codex" }, checked: false } });
  assert.deepEqual(rowIds(a, "viewport"), ["match"], "an excluded ancestor must not return as graph context");
  assert.deepEqual(rowIds(a, "waiting"), ["match"]);
  assert.equal(a.get("waiting-count").textContent, 1);
  assert.equal(a.get("failed-count").textContent, 0);
  assert.equal(a.get("completed-count").textContent, 0);
  assert.match(a.get("stats").innerHTML, /<b>1<\/b>Needs you/);
  assert.match(a.get("stats").innerHTML, /<b>0<\/b>Working/);
  assert.match(a.get("filter-summary").textContent, /^1 shown · Live · Alpha · Needs you$/);
  a.get("view-list").onclick();
  assert.deepEqual(rowIds(a), ["match"]);
  assert.deepEqual(rowIds(a, "waiting"), ["match"]);
  assert.match(a.get("stats").innerHTML, /<b>1<\/b>Needs you/);
  changeFilter(a, "status", "failed");
  assert.deepEqual(rowIds(a), []);
  assert.equal(a.get("waiting-count").textContent, 0);
  assert.match(a.get("stats").innerHTML, /<b>0<\/b>Needs you/);
  assert.equal(a.get("empty").hidden, false);
  assert.equal(a.get("empty-title").textContent, "No matching sessions");
});

test("reset clears explicit filters and hidden agents while retaining list and time scope", () => {
  const snap = snapshot(2);
  snap.nodes[1].agent = "codex";
  snap.nodes[1].status = "done";
  const a = app(snap);
  a.get("scope-all").onclick();
  a.get("view-list").onclick();
  clickSession(a, "test:0");
  changeFilter(a, "project", "project:Project 1");
  assert.equal(a.state().selected, null, "changing filters must clear details for a hidden selection");
  assert.equal(a.selections.at(-1)[0], null);
  assert.equal(a.get("panel").hidden, true);
  changeFilter(a, "status", "done");
  a.get("search").handlers.input({ target: { value: "Session 1" } });
  a.get("agent-filters").handlers.change({ target: { dataset: { agent: "codex" }, checked: false } });
  assert.deepEqual(rowIds(a), []);
  assert.equal(a.get("reset-filters").hidden, false);
  a.get("reset-filters").onclick();
  assert.deepEqual(rowIds(a), ["test:0", "test:1"]);
  assert.deepEqual(a.state(), { selected: null, display: "list", project: null, status: null, query: "", hiddenAgents: [], scope: "all", visibleIds: ["test:0", "test:1"] });
  assert.equal(a.get("search").value, "");
  assert.equal(a.get("project-filter").value, "all");
  assert.equal(a.get("status-filter").value, "all");
  assert.equal(a.get("reset-filters").hidden, true);
  assert.equal(a.preferences()["agent-fleet:hiddenAgents"], "[]");
});

test("a project disappearing on refresh preserves the selected zero-result filter", () => {
  const snap = snapshot(2);
  const a = app(snap);
  a.get("view-list").onclick();
  changeFilter(a, "project", "project:Project 0");
  assert.deepEqual(rowIds(a), ["test:0"]);
  a.send({ ...snap, nodes: snap.nodes.slice(1) });
  assert.equal(a.state().project, "Project 0");
  assert.equal(a.get("project-filter").value, "project:Project 0");
  assert.match(a.get("project-filter").innerHTML, /value="project:Project 0">Project 0 \(0\)/);
  assert.match(a.get("project-filter").innerHTML, /value="project:Project 1">Project 1 \(1\)/);
  assert.deepEqual(rowIds(a), []);
  assert.equal(a.get("empty-title").textContent, "No matching sessions");
  a.get("reset-filters").onclick();
  assert.deepEqual(rowIds(a), ["test:1"]);
  assert.doesNotMatch(a.get("project-filter").innerHTML, /Project 0/);
});

test("empty views distinguish scope emptiness from an active filter", () => {
  const a = app(snapshot(0));
  assert.equal(a.get("empty-title").textContent, "No live agent sessions");
  a.get("scope-all").onclick();
  assert.equal(a.get("empty-title").textContent, "No sessions in this time window");
  a.get("view-list").onclick();
  changeFilter(a, "status", "waiting");
  assert.equal(a.get("empty-title").textContent, "No matching sessions");
  assert.equal(a.get("empty-description").textContent, "Change or reset the filters.");
  a.get("scope-live").onclick();
  assert.match(a.get("empty-description").textContent, /longer time window/);
  a.get("reset-filters").onclick();
  assert.equal(a.get("empty-title").textContent, "No live agent sessions");
});

test("list orders activity, distinguishes uncertain states and opens the existing Live inspector", () => {
  const snap = snapshot(0);
  snap.nodes = [
    { id: "cached", title: "Cached worker", agent: "claude", kind: "session", project: "Alpha", status: "working", lastActivityAt: new Date(NOW - 30_000).toISOString(), meta: { dataStale: true }, liveView: { available: true } },
    { id: "question", title: "Choose <branch>", agent: "codex", kind: "session", project: "Alpha", status: "waiting", lastActivityAt: new Date(NOW - 10_000).toISOString(), attention: { kind: "question", evidence: "inferred" } },
    { id: "completed", title: "Finished reply", agent: "claude", kind: "session", project: "Alpha", status: "idle", lastActivityAt: new Date(NOW - 20_000).toISOString(), attention: { kind: "completed" } },
  ];
  const a = app(snap);
  a.get("view-list").onclick();
  assert.deepEqual(rowIds(a), ["question", "completed", "cached"]);
  const rows = a.get("session-rows").innerHTML;
  assert.match(rows, /Choose &lt;branch&gt;/);
  assert.match(rows, /Inferred question/);
  assert.match(rows, /Reply finished/);
  assert.match(rows, /Last known/);
  assert.match(a.get("stats").innerHTML, /<b>0<\/b>Working/);
  assert.match(a.get("stats").innerHTML, /<b>1<\/b>Last known/);
  clickSession(a, "cached", { live: true });
  assert.equal(a.state().selected, "cached");
  assert.deepEqual(a.selections.at(-1), ["cached", "Last known: Working"]);
  assert.equal(a.openedTabs.at(-1), "live");
  clickSession(a, "question");
  assert.equal(a.state().selected, "question");
  assert.equal(a.openedTabs.length, 1, "ordinary list selection must not force the Live tab");
});

test("health-only updates and age ticks leave list rows, scroll and inspector intact", () => {
  const snap = snapshot(2);
  const a = app(snap);
  a.get("view-list").onclick();
  clickSession(a, "test:0");
  a.get("session-list").scrollTop = 250;
  const layouts = a.layoutCalls();
  const writes = a.writes("session-rows");
  const selections = a.inspectorCalls();
  a.tick(13_000);
  assert.match(a.get("pulse-text").textContent, /^Delayed/);
  a.health({ ...snap, generatedAt: new Date(NOW + 13_000).toISOString() });
  assert.match(a.get("pulse-text").textContent, /^Current/);
  assert.equal(a.writes("session-rows"), writes);
  assert.equal(a.layoutCalls(), layouts);
  assert.equal(a.inspectorCalls(), selections);
  assert.equal(a.state().selected, "test:0");
  assert.equal(a.get("session-list").scrollTop, 250);
});

function foldSnapshot() {
  const snap = snapshot(0);
  const completed = { kind: "completed", at: new Date(NOW).toISOString(), evidence: "explicit" };
  const base = { agent: "claude", kind: "session", project: "Alpha", lastActivityAt: new Date(NOW).toISOString() };
  snap.nodes = [
    { ...base, id: "root", title: "Coordinator", status: "working" },
    { ...base, id: "finished", title: "Finished branch", status: "idle", attention: completed },
    { ...base, id: "leaf", title: "Finished leaf", status: "idle", attention: completed },
    { ...base, id: "active", title: "Active worker", status: "working" },
    { ...base, id: "error", title: "Failed worker", status: "failed" },
    { ...base, id: "question", title: "Question worker", status: "waiting", attention: { kind: "question", evidence: "explicit" } },
    { ...base, id: "idle", title: "Unconfirmed idle", status: "idle" },
    { ...base, id: "stale", title: "Cached finished", status: "idle", attention: completed, meta: { dataStale: true } },
    { ...base, id: "live", title: "Attached browser", status: "idle", attention: completed, liveView: { available: true } },
  ];
  snap.edges = snap.nodes.slice(1).map((node) => ({ from: node.id === "leaf" ? "finished" : "root", to: node.id, kind: "spawn" }));
  return snap;
}

function toggleFold(a, id, key) {
  let prevented = false;
  const target = { closest: (selector) => selector === "[data-collapse]" ? { dataset: { collapse: id } } : selector === ".node" ? { dataset: { id } } : null };
  const event = { target, key, preventDefault() { prevented = true; } };
  a.get("viewport").handlers[key === undefined ? "click" : "keydown"](event);
  return prevented;
}

test("finished-branch controls toggle by mouse, Enter and Space without selecting the parent", () => {
  const snap = foldSnapshot();
  const a = app(snap);
  toggleFold(a, "root");
  assert.deepEqual(rowIds(a, "viewport"), ["root", "active", "error", "question", "idle", "stale", "live"]);
  assert.equal(a.state().selected, null);
  assert.match(a.get("viewport").innerHTML, /data-collapse="root"[^>]*aria-expanded="false"/);
  assert.equal(toggleFold(a, "root", "Enter"), true);
  assert.deepEqual(rowIds(a, "viewport"), snap.nodes.map((node) => node.id));
  assert.match(a.get("viewport").innerHTML, /data-collapse="root"[^>]*aria-expanded="true"/);
  assert.equal(toggleFold(a, "root", " "), true);
  assert.deepEqual(a.folds(), ["root"]);
  assert.equal(toggleFold(a, "root", "ArrowDown"), false);
  assert.deepEqual(a.folds(), ["root"]);
  assert.equal(a.inspectorCalls(), 0);
});

test("global folding preserves mixed active branches and matched totals while list stays complete", () => {
  const snap = foldSnapshot();
  const a = app(snap);
  const stats = a.get("stats").innerHTML;
  const completed = a.get("completed-count").textContent;
  assert.equal(a.get("expand-finished").disabled, true);
  a.get("collapse-finished").onclick();
  assert.deepEqual(new Set(a.folds()), new Set(["root", "finished"]));
  assert.deepEqual(rowIds(a, "viewport"), ["root", "active", "error", "question", "idle", "stale", "live"]);
  assert.equal(a.get("filter-summary").textContent, "9 matches · 7 shown · 2 folded · Live");
  assert.equal(a.get("stats").innerHTML, stats, "folding changes presentation, not the matched session totals");
  assert.equal(a.get("completed-count").textContent, completed);
  assert.equal(a.get("waiting-count").textContent, 1);
  assert.equal(a.get("failed-count").textContent, 1);
  assert.equal(a.get("collapse-finished").disabled, true);
  assert.equal(a.get("expand-finished").disabled, false);
  a.get("view-list").onclick();
  assert.deepEqual(new Set(rowIds(a)), new Set(snap.nodes.map((node) => node.id)));
  assert.equal(a.get("filter-summary").textContent, "9 shown · Live");
  assert.equal(a.get("graph-fold-controls").hidden, true);
  a.get("view-graph").onclick();
  assert.equal(a.state().visibleIds.length, 7);
  a.get("expand-finished").onclick();
  assert.deepEqual(rowIds(a, "viewport"), snap.nodes.map((node) => node.id));
  assert.deepEqual(a.folds(), []);
  assert.equal(a.get("collapse-finished").disabled, false);
  assert.equal(a.get("expand-finished").disabled, true);
});

test("selecting a finished leaf from attention opens every folded ancestor", () => {
  const snap = foldSnapshot();
  const a = app(snap);
  a.get("collapse-finished").onclick();
  assert.deepEqual(new Set(a.folds()), new Set(["root", "finished"]));
  assert.equal(a.state().visibleIds.includes("leaf"), false);
  assert.ok(rowIds(a, "completed").includes("leaf"), "a folded reply must remain reachable in attention");
  clickSession(a, "leaf", { element: "completed" });
  assert.deepEqual(a.folds(), []);
  assert.deepEqual(rowIds(a, "viewport"), snap.nodes.map((node) => node.id));
  assert.equal(a.state().selected, "leaf");
  assert.equal(a.selections.at(-1)[0], "leaf");
  assert.equal(a.get("panel").hidden, false);
  assertBounded(a);
});

test("explicit folding moves selected child details to the visible ancestor", () => {
  const a = app(foldSnapshot());
  clickSession(a, "leaf", { element: "completed" });
  toggleFold(a, "finished");
  assert.equal(a.state().selected, "finished");
  assert.equal(a.selections.at(-1)[0], "finished");
  assert.equal(a.state().visibleIds.includes("leaf"), false);
  assert.equal(a.state().visibleIds.includes("finished"), true);
  a.get("collapse-finished").onclick();
  assert.equal(a.state().selected, "root");
  assert.equal(a.selections.at(-1)[0], "root");
  assert.equal(a.state().visibleIds.includes("finished"), false);
  assert.equal(a.get("panel").hidden, false);
});

test("a resumed child reappears from a folded branch on the next snapshot", () => {
  const snap = foldSnapshot();
  const a = app(snap);
  a.get("collapse-finished").onclick();
  a.send({ ...snap, nodes: snap.nodes.map((node) => node.id === "leaf" ? { ...node, status: "working", attention: undefined } : node) });
  assert.ok(a.state().visibleIds.includes("leaf"));
  assert.ok(a.state().visibleIds.includes("finished"), "a finished ancestor of active work must remain exposed");
  assert.deepEqual(new Set(a.folds()), new Set(["root", "finished"]), "resume does not discard folding preference");
  assert.match(a.get("stats").innerHTML, /<b>3<\/b>Working/);
  a.send(snap);
  assert.equal(a.state().visibleIds.includes("leaf"), false, "unselected work folds again when it finishes");
});

test("a selected resumed child stays exposed when a snapshot marks it completed", () => {
  const snap = foldSnapshot();
  const a = app(snap);
  a.get("collapse-finished").onclick();
  a.send({ ...snap, nodes: snap.nodes.map((node) => node.id === "leaf" ? { ...node, status: "working", attention: undefined } : node) });
  clickSession(a, "leaf", { element: "viewport" });
  assert.equal(a.state().selected, "leaf");
  assert.deepEqual(new Set(a.folds()), new Set(["root", "finished"]));
  a.send(snap);
  assert.equal(a.state().selected, "leaf");
  assert.ok(a.state().visibleIds.includes("leaf"));
  assert.equal(a.selections.at(-1)[0], "leaf");
  assert.deepEqual(a.folds(), [], "automatic completion opens the selected path instead of hiding its inspector target");
});

test("filters and view switches preserve folds while their parents remain in the snapshot", () => {
  const snap = foldSnapshot();
  const a = app(snap);
  a.get("collapse-finished").onclick();
  const folds = a.folds();
  changeFilter(a, "project", "project:Other project");
  assert.deepEqual(a.state().visibleIds, []);
  assert.deepEqual(a.folds(), folds);
  a.get("view-list").onclick();
  a.get("reset-filters").onclick();
  assert.equal(a.state().visibleIds.length, 9);
  assert.deepEqual(a.folds(), folds);
  a.get("view-graph").onclick();
  assert.equal(a.state().visibleIds.length, 7);
  changeFilter(a, "status", "working");
  assert.deepEqual(a.state().visibleIds, ["root", "active"]);
  assert.deepEqual(a.folds(), folds);
  changeFilter(a, "status", "all");
  assert.equal(a.state().visibleIds.length, 7);
  assert.deepEqual(a.folds(), folds);
  a.send({ ...snap, nodes: snap.nodes.filter((node) => !["root", "finished", "leaf"].includes(node.id)), edges: [] });
  assert.deepEqual(a.folds(), [], "parents leaving the collector window must not leave orphan folding state");
});

test("health and age updates preserve a folded graph without layout or inspector work", () => {
  const snap = foldSnapshot();
  const a = app(snap);
  a.get("collapse-finished").onclick();
  clickSession(a, "root", { element: "viewport" });
  const layouts = a.layoutCalls();
  const writes = a.writes("viewport");
  const selections = a.inspectorCalls();
  const shown = a.state().visibleIds;
  const folds = a.folds();
  a.tick(13_000);
  a.health({ ...snap, generatedAt: new Date(NOW + 13_000).toISOString() });
  assert.equal(a.layoutCalls(), layouts);
  assert.equal(a.writes("viewport"), writes);
  assert.equal(a.inspectorCalls(), selections);
  assert.deepEqual(a.state().visibleIds, shown);
  assert.deepEqual(a.folds(), folds);
  assert.equal(a.state().selected, "root");
});

test("an old process observation expires locally even after a recent graph publication", () => {
  const snap = snapshot(2);
  snap.processObservedAt = new Date(NOW - 8000).toISOString();
  snap.adapters = [{ id: "claude", label: "Claude", nodes: 2, ms: 8, observedAt: snap.processObservedAt, lastSuccessAt: snap.generatedAt }];
  const a = app(snap); const layouts = a.layoutCalls();
  assert.match(a.get("pulse-text").textContent, /^Current/);
  a.tick(5000);
  assert.match(a.get("pulse-text").textContent, /^Delayed/);
  assert.equal(a.get("canvas").dataset.freshness, "stale");
  assert.equal(a.get("data-notice").hidden, false);
  assert.match(a.get("sources").innerHTML, /updated 13s ago/);
  assert.equal(a.layoutCalls(), layouts);
});

test("source age marks only affected rows and edges without relayout while healthy sources stay current", () => {
  const snap = snapshot(2);
  snap.nodes[0].meta = { dataSource: "custom-source" };
  snap.nodes[1].agent = "codex";
  snap.processObservedAt = snap.generatedAt;
  snap.adapters = [
    { id: "custom-source", label: "Custom", nodes: 1, ms: 1, observedAt: new Date(NOW - 8000).toISOString(), lastSuccessAt: snap.generatedAt },
    { id: "codex", label: "Codex", nodes: 1, ms: 1, observedAt: snap.generatedAt, lastSuccessAt: snap.generatedAt },
  ];
  const a = app(snap); const layouts = a.layoutCalls();
  const element = dataset => ({ dataset, classes: new Map(), classList: { toggle(name, value) { this.owner.classes.set(name, value); } } });
  const old = element({ id: "test:0" }), fresh = element({ id: "test:1" }), edge = element({ from: "test:0", to: "test:1" });
  for (const el of [old, fresh, edge]) el.classList.owner = el;
  a.get("canvas").querySelectorAll = () => [old, fresh];
  a.get("viewport").querySelectorAll = selector => selector === ".edge" ? [edge] : [];
  a.tick(5000);
  assert.match(a.get("pulse-text").textContent, /^Source unavailable/);
  assert.equal(a.get("canvas").dataset.freshness, "current", "healthy sources are not globally paused");
  assert.equal(old.classes.get("data-stale"), true);
  assert.equal(fresh.classes.get("data-stale"), false);
  assert.equal(edge.classes.get("data-stale"), true);
  assert.equal(a.layoutCalls(), layouts);
});
