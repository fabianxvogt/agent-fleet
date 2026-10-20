import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createInspector, mergeContent } from "../ui/inspector.js";
import { liveActivity } from "../ui/live-view.js";

test("tail-only returns invalidate inherited execution state while preserving the command", () => {
  const at = new Date().toISOString();
  for (const state of ["pending", "running"]) {
    const call = { id: "call", kind: "tool", name: "exec_command", text: null, at,
      terminal: { command: "npm test", state, sessionId: "123", exitCode: null } };
    const result = { id: "call", kind: "tool", name: "Tool result", text: "Tests passed", at, resultAt: at, status: "completed" };
    const entries = mergeContent([call], [result]);
    assert.equal(entries[0].terminal.command, "npm test");
    assert.equal(entries[0].terminal.state, "unknown");
    assert.equal(liveActivity({ entries, localState: "available", session: { status: "working" } }).label, "Last observed terminal activity");
  }
});

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

test("graph shortcut opens Live and later content refreshes preserve the selected viewer", async (t) => {
  const r = root(); const selected = [];
  const inspector = createInspector(r, { fetcher: async () => response("a", "reply"), browserView: { select: (id) => selected.push(id), destroy() {} } });
  t.after(() => inspector.destroy());
  inspector.select("a"); inspector.showTab("live");
  await setImmediate();
  assert.equal(selected.at(-1), "a");
  assert.ok(r.innerHTML.includes('data-content-tab="live" aria-selected="true"'));
  r.click({ contentTab: "chat" }); assert.equal(selected.at(-1), null);
  inspector.showTab("live"); inspector.select(null); assert.equal(selected.at(-1), null);
});

test("Live receives selected-session evidence and updates status before another transcript read", async (t) => {
  const r = root(), updates = [];
  const inspector = createInspector(r, { fetcher: async () => response("a", "RECORDED REPLY"), browserView: { select: (id, context) => updates.push({ id, context }), destroy() {} } });
  t.after(() => inspector.destroy());
  inspector.select("a", "Working", { title: "Synthetic session", status: "working" });
  inspector.showTab("live");
  assert.equal(updates.at(-1).context.session.title, "Synthetic session");
  await setImmediate();
  assert.equal(updates.at(-1).id, "a");
  assert.equal(updates.at(-1).context.entries.at(-1).text, "RECORDED REPLY");
  inspector.select("a", "Done", { title: "Synthetic session", status: "done" });
  assert.equal(updates.at(-1).context.session.status, "done");
});

test("restricted refreshes revoke previously retained local and archive evidence", async (t) => {
  const r = root(), updates = [];
  let restricted = false;
  const inspector = createInspector(r, { fetcher: async () => restricted
    ? response("a", "unused", { local: { state: "restricted", entries: [], activity: null }, archive: { state: "restricted", entries: [], hasMore: false } })
    : response("a", "PREVIOUS CONTENT"),
  browserView: { select: (id, context) => updates.push({ id, context }), destroy() {} } });
  t.after(() => inspector.destroy());
  inspector.select("a"); inspector.showTab("live");
  await setImmediate();
  restricted = true;
  r.click({}, "data-inspector-refresh");
  await setImmediate();
  assert.equal(updates.at(-1).context.entries.length, 0);
  assert.equal(updates.at(-1).context.localState, "restricted");
  assert.doesNotMatch(r.innerHTML, /PREVIOUS CONTENT/);
});

for (const older of [false, true]) for (const revoked of ["restricted", "mismatch"]) {
  test(`${older ? "pagination" : "polling"} revokes ${revoked} evidence before rendering`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const previousDocument = globalThis.document;
    globalThis.document = { hidden: false };
    t.after(() => { globalThis.document = previousDocument; });
    const r = root(), updates = [];
    let changed = false;
    const inspector = createInspector(r, {
      fetcher: async () => changed
        ? response("a", "LOCAL RESPONSE", {
          ...(revoked === "restricted" ? { local: { state: "restricted", entries: [], activity: null } } : older ? { local: null } : {}),
          archive: { state: revoked, entries: [], hasMore: false },
        })
        : response("a", "LOCAL RESPONSE", {
          archive: { state: "available", entries: [{ id: "archive-message:5", kind: "message", role: "assistant", text: "ARCHIVED RESPONSE", ordinal: 5 }], hasMore: true, before: 4, revision: "rev" },
        }),
      browserView: { select: (id, context) => updates.push({ id, context }), destroy() {} },
    });
    t.after(() => inspector.destroy());
    inspector.select("a"); inspector.showTab("live");
    await setImmediate();
    assert.match(r.innerHTML, /ARCHIVED RESPONSE/);
    changed = true;
    if (older) r.click({}, "data-load-history");
    else t.mock.timers.tick(4000);
    await setImmediate();
    const context = updates.at(-1).context;
    assert.doesNotMatch(r.innerHTML, /ARCHIVED RESPONSE/);
    assert.doesNotMatch(r.innerHTML, /data-load-history/);
    assert.equal(context.archiveState, revoked);
    assert.ok(!context.entries.some((entry) => entry.text === "ARCHIVED RESPONSE"));
    if (revoked === "restricted") {
      assert.doesNotMatch(r.innerHTML, /LOCAL RESPONSE/);
      assert.equal(context.localState, "restricted");
      assert.equal(context.activity, null);
      assert.deepEqual(context.entries, []);
    } else {
      assert.match(r.innerHTML, /LOCAL RESPONSE/);
      assert.ok(context.entries.some((entry) => entry.text === "LOCAL RESPONSE"));
    }
  });
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
