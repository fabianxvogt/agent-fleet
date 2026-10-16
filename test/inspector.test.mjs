import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createInspector } from "../ui/inspector.js";

const response = (id, text, extra = {}) => new Response(JSON.stringify({
  id, local: { state: "available", entries: [{ id: text, kind: "message", role: "assistant", text, final: true, at: "2026-10-16T12:00:00Z" }], activity: { label: "Posted a response", detail: text } },
  archive: { state: "not-indexed", entries: [], hasMore: false }, ...extra,
}));
function root() {
  const thread = { scrollTop: 0, scrollHeight: 1000, clientHeight: 500 };
  return {
    innerHTML: "", handler: null, thread,
    querySelector: () => thread, querySelectorAll: () => [],
    addEventListener(_, fn) { this.handler = fn; },
    click(dataset = {}, attribute = null) { this.handler({ target: { closest: () => ({ dataset, hasAttribute: (a) => a === attribute }) } }); },
  };
}

test("late responses from a previous selection cannot replace the current session", async (t) => {
  const r = root();
  const pending = [];
  const inspector = createInspector(r, { fetcher: (_, options) => new Promise((resolve) => pending.push({ resolve, signal: options.signal })) });
  t.after(() => inspector.destroy());
  inspector.select("first");
  inspector.select("second");
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve(response("first", "OLD CONTENT"));
  pending[1].resolve(response("second", "NEW CONTENT"));
  await setImmediate();
  assert.ok(r.innerHTML.includes("NEW CONTENT"));
  assert.ok(!r.innerHTML.includes("OLD CONTENT"));
  inspector.select(null);
  assert.equal(r.innerHTML, "");
});

test("chat and results render hostile log text as inert text", async (t) => {
  const r = root();
  const text = '<img src=x onerror="alert(1)">';
  const inspector = createInspector(r, { fetcher: async () => response("a", text) });
  t.after(() => inspector.destroy());
  inspector.select("a");
  await setImmediate();
  assert.ok(r.innerHTML.includes("&lt;img"));
  assert.ok(!r.innerHTML.includes("<img"));
  r.click({ contentTab: "results" });
  assert.ok(r.innerHTML.includes('aria-label="Session results"'));
  assert.ok(r.innerHTML.includes("&lt;img"));
});

test("older pages are prepended and disconnected archives keep recent messages visible", async (t) => {
  const r = root();
  const urls = [];
  const inspector = createInspector(r, { fetcher: async (url) => {
    urls.push(url);
    return url.includes("before=") ? response("a", "unused", { local: null, archive: { state: "available", entries: [{ id: "old", kind: "message", role: "user", text: "OLDER PAGE" }], hasMore: false } })
      : response("a", "LOCAL RESPONSE", { archive: { state: "available", entries: [], hasMore: true, before: 5, revision: "rev" } });
  } });
  t.after(() => inspector.destroy());
  inspector.select("a");
  await setImmediate();
  r.click({}, "data-load-history");
  await setImmediate();
  assert.ok(urls[1].includes("before=5&revision=rev"));
  assert.ok(r.innerHTML.indexOf("OLDER PAGE") < r.innerHTML.lastIndexOf("LOCAL RESPONSE"));
  assert.ok(!r.innerHTML.includes("data-load-history"));
});

test("request errors and archive failures are visible, with local fallback", async (t) => {
  const r = root();
  let failing = true;
  const inspector = createInspector(r, { fetcher: async () => failing ? new Response("unavailable", { status: 503 }) : response("a", "STILL VISIBLE", { archive: { state: "offline", entries: [], hasMore: false } }) });
  t.after(() => inspector.destroy());
  inspector.select("a");
  await setImmediate();
  assert.ok(r.innerHTML.includes("could not be loaded"));
  failing = false;
  r.click({}, "data-inspector-refresh");
  await setImmediate();
  assert.ok(r.innerHTML.includes("STILL VISIBLE"));
  assert.ok(r.innerHTML.includes("Archive unavailable"));
});

test("polling retains observed local messages and invalidates replaced archive ordinals", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const previousDocument = globalThis.document;
  globalThis.document = { hidden: false };
  t.after(() => { globalThis.document = previousDocument; });
  const r = root();
  let tick = 0;
  const inspector = createInspector(r, { fetcher: async () => response("a", tick ? "NEW LOCAL" : "OLD LOCAL", {
    archive: { state: "available", revision: `rev-${tick}`, entries: tick ? [{ id: "archive-message:0", ordinal: 0, kind: "message", role: "user", text: "REPLACEMENT" }] : [{ id: "archive-message:50", ordinal: 50, kind: "message", role: "user", text: "SUPERSEDED" }], hasMore: false },
  }) });
  t.after(() => inspector.destroy());
  inspector.select("a");
  await setImmediate();
  tick++;
  t.mock.timers.tick(4000);
  await setImmediate();
  assert.ok(r.innerHTML.includes("OLD LOCAL"));
  assert.ok(r.innerHTML.includes("NEW LOCAL"));
  assert.ok(r.innerHTML.includes("REPLACEMENT"));
  assert.ok(!r.innerHTML.includes("SUPERSEDED"));
});

test("empty archives becoming indexed expose the new pagination cursor", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const previousDocument = globalThis.document;
  globalThis.document = { hidden: false };
  t.after(() => { globalThis.document = previousDocument; });
  const r = root();
  let tick = 0;
  const inspector = createInspector(r, { fetcher: async () => response("a", "LOCAL", {
    archive: { state: "available", revision: tick ? "rev-1" : "rev-0", entries: tick ? [{ id: `archive-message:${tick * 100}`, ordinal: tick * 100, kind: "message", role: "user", text: "INDEXED" }] : [], hasMore: tick > 0, before: tick ? tick * 100 - 1 : null },
  }) });
  t.after(() => inspector.destroy());
  inspector.select("a");
  await setImmediate();
  tick++;
  t.mock.timers.tick(4000);
  await setImmediate();
  assert.ok(r.innerHTML.includes("data-load-history"));
  tick++;
  t.mock.timers.tick(4000);
  await setImmediate();
  assert.ok(r.innerHTML.includes("fill the gap"));
});
