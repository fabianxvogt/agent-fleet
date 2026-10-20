import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createInspector, mergeContent } from "../ui/inspector.js";
import { liveActivity } from "../ui/live-view.js";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDetailsService } from "../src/details.mjs";

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

test("matching archive and local notices are shown once without merging them with user text", () => {
  const archived = { id: "archive-notice:1", kind: "notice", label: "Background task stopped", text: "Completion was not confirmed.", noticeStatus: "stopped", at: "2026-10-20T12:00:00Z" };
  const local = { ...archived, id: "notice:local", at: "2026-10-20T12:00:01Z" };
  const user = { id: "user", kind: "message", role: "user", text: archived.text, at: archived.at };
  const entries = mergeContent([archived], [local, user]);
  assert.equal(entries.length, 2);
  assert.equal(entries.find((entry) => entry.kind === "notice").origin, "local");
  assert.equal(entries.find((entry) => entry.kind === "notice").id, archived.id);
  assert.equal(entries.find((entry) => entry.kind === "message").role, "user");
  assert.equal(mergeContent([archived], [{ ...local, noticeStatus: "failed" }]).length, 2);
});

const response = (id, text, extra = {}) => new Response(JSON.stringify({
  id, local: { state: "available", entries: [{ id: text, kind: "message", role: "assistant", text, final: true, at: "2026-10-16T12:00:00Z" }], activity: { label: "Posted a response", detail: text } },
  archive: { state: "not-indexed", entries: [], hasMore: false }, ...extra,
}));
function root() {
  const thread = { scrollTop: 0, scrollHeight: 1000, clientHeight: 500 };
  const archiveDisclosure = { open: false };
  const artifacts = {
    innerHTML: "", scrollTop: 0, hidden: true,
    querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, replaceWith() {},
  };
  return {
    innerHTML: "", handler: null, thread, artifacts, archiveDisclosure,
    querySelector(selector) {
      if (selector === ".session-artifacts") return artifacts;
      if (selector === "[data-archive-history]") return this.innerHTML.includes("data-archive-history") ? archiveDisclosure : null;
      return thread;
    },
    querySelectorAll: () => [],
    addEventListener(_, fn) { this.handler = fn; },
    click(dataset = {}, attribute = null) { this.handler({ target: { closest: () => ({ dataset, hasAttribute: (a) => a === attribute }) } }); },
  };
}

const branchMessage = (id) => ({ id, kind: "message", role: "assistant", text: id, final: true, at: "2026-10-20T12:00:00Z" });
const branchResponse = (revision, entries, archive, extra = {}) => response("a", "unused", {
  branchScoped: true,
  local: { state: "available", revision, entries, activity: entries.length ? { label: "Posted a response", detail: entries.at(-1).text } : null },
  archive: archive ?? { state: "not-indexed", entries: [], hasMore: false },
  ...extra,
});

test("branch revisions revoke retained current content while archive history stays secondary and collapsed", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const previousDocument = globalThis.document;
  globalThis.document = { hidden: false };
  t.after(() => { globalThis.document = previousDocument; });
  const r = root(), updates = [];
  let current = branchResponse("initial", [branchMessage("OLD BRANCH")], {
    state: "available", revision: "archive", entries: [{ ...branchMessage("ARCHIVED OTHER BRANCH"), ordinal: 10 }], hasMore: true, before: 9,
  });
  const inspector = createInspector(r, {
    fetcher: async () => current.clone(),
    browserView: { select: (id, context) => updates.push({ id, context }), destroy() {} },
  });
  t.after(() => inspector.destroy());
  inspector.select("a"); await setImmediate();
  assert.match(r.innerHTML, /<summary>Archive history/);
  assert.match(r.innerHTML, /These older messages may belong to another conversation branch/);
  assert.equal(r.archiveDisclosure.open, false);
  assert.ok(r.innerHTML.indexOf("ARCHIVED OTHER BRANCH") > r.innerHTML.indexOf("data-archive-history"));
  inspector.showTab("results");
  assert.doesNotMatch(r.innerHTML, /ARCHIVED OTHER BRANCH/);
  inspector.showTab("live");
  assert.deepEqual(updates.at(-1).context.entries.map((entry) => entry.text), ["OLD BRANCH"]);
  for (const [revision, entries] of [["fork", [branchMessage("NEW BRANCH")]], ["cleared", []], ["missing-leaf", []]]) {
    current = branchResponse(revision, entries, {
      state: "available", revision: "archive", entries: [{ ...branchMessage("ARCHIVED OTHER BRANCH"), ordinal: 10 }], hasMore: false,
    });
    t.mock.timers.tick(4000); await setImmediate();
    assert.deepEqual(updates.at(-1).context.entries.map((entry) => entry.text), entries.map((entry) => entry.text));
    assert.doesNotMatch(r.innerHTML, /OLD BRANCH|ARCHIVED OTHER BRANCH/);
    assert.equal(updates.at(-1).context.activity?.detail ?? null, entries.at(-1)?.text ?? null);
  }
  inspector.showTab("chat");
  assert.match(r.innerHTML, /No messages observed in the current conversation/);
  assert.match(r.innerHTML, /ARCHIVED OTHER BRANCH/);
  assert.equal(r.archiveDisclosure.open, false);
});

test("straight branch appends retain the bounded local view, scroll and archive disclosure while failures retain last evidence", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const previousDocument = globalThis.document;
  globalThis.document = { hidden: false };
  t.after(() => { globalThis.document = previousDocument; });
  const r = root(), updates = [];
  const archive = { state: "available", revision: "archive", entries: [branchMessage("OLDER ARCHIVE")], hasMore: false };
  let current = branchResponse("same", Array.from({ length: 399 }, (_, i) => branchMessage(`LOCAL ${i}`)), archive);
  const inspector = createInspector(r, { fetcher: async () => current.clone(), browserView: { select: (id, context) => updates.push({ id, context }), destroy() {} } });
  t.after(() => inspector.destroy());
  inspector.select("a"); await setImmediate();
  r.thread.scrollTop = 100;
  r.archiveDisclosure.open = true;
  current = branchResponse("same", [399, 400, 401].map((i) => branchMessage(`LOCAL ${i}`)), archive);
  t.mock.timers.tick(4000); await setImmediate();
  assert.equal(r.thread.scrollTop, 100);
  assert.equal(r.archiveDisclosure.open, true);
  assert.equal(updates.at(-1).context.entries.length, 400);
  assert.equal(updates.at(-1).context.entries[0].text, "LOCAL 2");
  assert.equal(updates.at(-1).context.entries.at(-1).text, "LOCAL 401");
  current = branchResponse(null, [], { state: "offline", entries: [], hasMore: false }, { local: { state: "unavailable", entries: [], activity: null } });
  t.mock.timers.tick(4000); await setImmediate();
  assert.equal(updates.at(-1).context.entries.length, 400);
  assert.equal(updates.at(-1).context.activity.detail, "LOCAL 401");
  assert.equal(updates.at(-1).context.localState, "unavailable");
  current = new Response("offline", { status: 503 });
  r.click({}, "data-inspector-refresh"); await setImmediate();
  assert.equal(updates.at(-1).context.entries.length, 400);
  assert.match(updates.at(-1).context.error, /could not be loaded/);
  assert.match(r.innerHTML, /OLDER ARCHIVE/);
});

test("a branch change during archive pagination clears old local and archive content before accepting the returned page", async (t) => {
  const r = root(), updates = [], urls = [];
  const inspector = createInspector(r, {
    fetcher: async (url) => {
      urls.push(url);
      return url.includes("before=") ? branchResponse("new", [], {
        state: "available", revision: "archive", entries: [{ ...branchMessage("RETURNED OLDER PAGE"), ordinal: 1 }], hasMore: false,
      }) : branchResponse("old", [branchMessage("OLD CURRENT BRANCH")], {
        state: "available", revision: "archive", entries: [{ ...branchMessage("OLD RETAINED ARCHIVE"), ordinal: 20 }], hasMore: true, before: 19,
      });
    },
    browserView: { select: (id, context) => updates.push({ id, context }), destroy() {} },
  });
  t.after(() => inspector.destroy());
  inspector.select("a"); await setImmediate();
  r.archiveDisclosure.open = true;
  r.click({}, "data-load-history"); await setImmediate();
  assert.match(urls[1], /before=19&revision=archive/);
  assert.doesNotMatch(r.innerHTML, /OLD CURRENT BRANCH|OLD RETAINED ARCHIVE/);
  assert.match(r.innerHTML, /RETURNED OLDER PAGE/);
  assert.equal(r.archiveDisclosure.open, false);
  assert.deepEqual(updates.at(-1).context.entries, []);
  assert.equal(updates.at(-1).context.activity, null);
  inspector.showTab("live");
  assert.deepEqual(updates.at(-1).context.entries, []);
});

test("OMP active-leaf changes revoke already displayed Inspector and Live evidence end to end", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-fleet-inspector-branch-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = join(home, ".omp", "agent", "sessions");
  await mkdir(dir, { recursive: true });
  const source = join(dir, "branch.jsonl");
  const record = (id, parentId, text) => ({ type: "message", id, parentId, timestamp: "2026-10-20T12:00:00Z", message: { role: "assistant", content: text } });
  await writeFile(source, [record("root", null, "ROOT"), record("old", "root", "ABANDONED RESPONSE")].map((row) => JSON.stringify(row) + "\n").join(""));
  const node = { id: "omp:fixture", agent: "omp", kind: "session", cwd: home, source };
  const details = createDetailsService({ home, agentsviewUrl: "http://127.0.0.1:8080" });
  const r = root(), updates = [];
  let latest;
  const inspector = createInspector(r, {
    fetcher: async () => new Response(JSON.stringify(await (latest = details.get(node)))),
    browserView: { select: (id, context) => updates.push({ id, context }), destroy() {} },
  });
  t.after(() => inspector.destroy());
  const settle = async () => { await latest; await setImmediate(); };
  inspector.select(node.id); inspector.showTab("live"); await settle();
  assert.ok(updates.at(-1).context.entries.some((entry) => entry.text === "ABANDONED RESPONSE"));
  for (const [id, activeLeafId] of [["clear", null], ["missing", "outside-tail"], ["restore", "root"]]) {
    await appendFile(source, JSON.stringify({ type: "model_usage", id, parentId: "old", activeLeafId }) + "\n");
    r.click({}, "data-inspector-refresh"); await settle();
    const entries = updates.at(-1).context.entries;
    assert.deepEqual(entries.map((entry) => entry.text), activeLeafId === "root" ? ["ROOT"] : []);
    assert.doesNotMatch(r.innerHTML, /ABANDONED RESPONSE/);
  }
});

test("late branch pagination cannot clear or repopulate a newly selected session", async (t) => {
  const r = root(), pending = [], updates = [];
  const inspector = createInspector(r, {
    fetcher: (url, options) => new Promise((resolve) => pending.push({ url, resolve, signal: options.signal })),
    browserView: { select: (id, context) => updates.push({ id, context }), destroy() {} },
  });
  t.after(() => inspector.destroy());
  inspector.select("a");
  pending[0].resolve(branchResponse("old", [branchMessage("OLD LOCAL")], {
    state: "available", revision: "archive", entries: [], hasMore: true, before: 5,
  }));
  await setImmediate();
  r.click({}, "data-load-history");
  inspector.select("b"); inspector.showTab("live");
  assert.equal(pending[1].signal.aborted, true);
  pending[1].resolve(branchResponse("changed", [], { state: "available", revision: "archive", entries: [branchMessage("OLD ARCHIVE")], hasMore: false }));
  pending[2].resolve(response("b", "NEW SESSION"));
  await setImmediate();
  assert.equal(updates.at(-1).id, "b");
  assert.deepEqual(updates.at(-1).context.entries.map((entry) => entry.text), ["NEW SESSION"]);
  assert.doesNotMatch(r.innerHTML, /OLD LOCAL|OLD ARCHIVE/);
});

test("archive controls retain keyboard focus across refreshes and fall back to the summary when pagination ends", async (t) => {
  const r = root();
  let markup = "", activeElement = null, summary = null, load = null, hasMore = true, poll = 0;
  r.ownerDocument = { get activeElement() { return activeElement; } };
  r.contains = (element) => element === r.archiveDisclosure;
  const control = (selector, disabled = false) => ({
    disabled,
    closest: (target) => target === "[data-archive-history]" ? r.archiveDisclosure : null,
    matches: (target) => target === selector,
    focus(options) { assert.equal(options.preventScroll, true); activeElement = this; },
  });
  Object.defineProperty(r, "innerHTML", {
    get: () => markup,
    set(value) {
      markup = value; activeElement = null;
      summary = control("summary");
      load = value.includes("data-load-history") ? control("[data-load-history]", /class="load-history" data-load-history disabled/.test(value)) : null;
    },
  });
  r.archiveDisclosure.querySelector = (selector) => selector === "summary" ? summary : selector === "[data-load-history]" ? load : null;
  const inspector = createInspector(r, { fetcher: async () => branchResponse("same", [branchMessage(`LOCAL ${poll++}`)], {
    state: "available", revision: "archive", entries: [branchMessage("ARCHIVED")], hasMore, before: 5,
  }) });
  t.after(() => inspector.destroy());
  inspector.select("a"); await setImmediate();
  r.archiveDisclosure.open = true;
  activeElement = summary;
  const previousSummary = summary;
  r.click({}, "data-inspector-refresh"); await setImmediate();
  assert.notEqual(summary, previousSummary);
  assert.equal(activeElement, summary);
  activeElement = load;
  const previousLoad = load;
  r.click({}, "data-inspector-refresh"); await setImmediate();
  assert.notEqual(load, previousLoad);
  assert.equal(activeElement, load);
  hasMore = false;
  r.click({}, "data-load-history"); await setImmediate();
  assert.equal(load, null);
  assert.equal(activeElement, summary);
});

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

test("Live hides the duplicate activity summary and Chat restores it", async (t) => {
  const r = root();
  const inspector = createInspector(r, { fetcher: async () => response("a", "RECORDED REPLY"), browserView: { select() {}, destroy() {} } });
  t.after(() => inspector.destroy());
  inspector.select("a");
  await setImmediate();
  assert.match(r.innerHTML, /class="current-activity"/);
  inspector.showTab("live");
  assert.doesNotMatch(r.innerHTML, /class="current-activity"/);
  inspector.showTab("chat");
  assert.match(r.innerHTML, /class="current-activity"/);
});

test("Chat distinguishes runtime notices from genuine user instructions and excludes them from Results", async (t) => {
  const r = root();
  const inspector = createInspector(r, { fetcher: async () => response("a", "unused", {
    local: { state: "available", entries: [
      { id: "user", kind: "message", role: "user", text: "Run the build.", at: "2026-10-20T12:00:00Z" },
      { id: "notice", kind: "notice", label: "Background commands stopped", text: "Completion was not confirmed.", at: "2026-10-20T12:00:01Z" },
    ] },
  }) });
  t.after(() => inspector.destroy());
  inspector.select("a");
  await setImmediate();
  assert.match(r.innerHTML, /<b>You<\/b>/);
  assert.match(r.innerHTML, /<b>Session notice<\/b>/);
  assert.match(r.innerHTML, /Background commands stopped/);
  assert.doesNotMatch(r.innerHTML, /<b>Agent<\/b>/);
  inspector.showTab("results");
  assert.doesNotMatch(r.innerHTML, /data-entry="notice"/);
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

test("Results retains one Files view across polls and tab changes while registry replacements remain authoritative", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const previousDocument = globalThis.document;
  globalThis.document = { hidden: false };
  t.after(() => { globalThis.document = previousDocument; });
  const r = root(), updates = [], created = [];
  let revision = 0;
  const files = [{ id: "file-a", name: "report.txt", kind: "text", state: "available", associations: [] }];
  const inspector = createInspector(r, {
    fetcher: async () => response("a", "EXISTING RESULT", { artifacts: revision ? [] : files, artifactState: "available",
      archive: { state: "available", entries: [], revision: `revision-${revision}`, hasMore: false } }),
    artifactViewFactory(element) {
      created.push(element);
      return { select: (id, artifacts, context) => updates.push({ id, artifacts, context }), destroy() {} };
    },
  });
  t.after(() => inspector.destroy());
  inspector.select("a"); inspector.showTab("results");
  await setImmediate();
  assert.equal(created.length, 1);
  assert.deepEqual(updates.at(-1).artifacts, files);
  assert.equal(r.artifacts.hidden, false);
  assert.match(r.innerHTML, /EXISTING RESULT/);
  inspector.showTab("live");
  assert.equal(r.artifacts.hidden, true);
  inspector.showTab("results");
  t.mock.timers.tick(4000); await setImmediate();
  assert.equal(created.length, 1);
  assert.deepEqual(updates.at(-1).artifacts, files);
  revision++;
  t.mock.timers.tick(4000); await setImmediate();
  assert.deepEqual(updates.at(-1).artifacts, []);
});

test("Files retain metadata on a request error but revoke it on registry failure and restriction", async (t) => {
  const r = root(), updates = [];
  let mode = "available";
  const files = [{ id: "file-a", name: "report.txt", kind: "text", state: "available" }];
  const inspector = createInspector(r, {
    fetcher: async () => mode === "request-error" ? new Response("unavailable", { status: 503 }) : response("a", "RESPONSE", {
      artifacts: mode === "available" ? files : [], artifactState: mode === "unavailable" ? "unavailable" : "available",
      ...(mode === "restricted" ? { local: { state: "restricted", entries: [] }, archive: { state: "restricted", entries: [], hasMore: false } } : {}),
    }),
    artifactViewFactory() { return { select: (id, artifacts, context) => updates.push({ id, artifacts, context }), destroy() {} }; },
  });
  t.after(() => inspector.destroy());
  inspector.select("a"); inspector.showTab("results"); await setImmediate();
  mode = "request-error"; r.click({}, "data-inspector-refresh"); await setImmediate();
  assert.deepEqual(updates.at(-1).artifacts, files);
  assert.equal(updates.at(-1).context.error, true);
  mode = "unavailable"; r.click({}, "data-inspector-refresh"); await setImmediate();
  assert.deepEqual(updates.at(-1).artifacts, []);
  assert.equal(updates.at(-1).context.error, true);
  mode = "available"; r.click({}, "data-inspector-refresh"); await setImmediate();
  assert.deepEqual(updates.at(-1).artifacts, files);
  mode = "restricted"; r.click({}, "data-inspector-refresh"); await setImmediate();
  assert.deepEqual(updates.at(-1).artifacts, []);
  assert.equal(updates.at(-1).context.restricted, true);
  inspector.select("next");
  assert.deepEqual(updates.at(-1).artifacts, []);
});

test("inspector restores logical file focus after its surrounding markup and file metadata change", async (t) => {
  const r = root(), phases = [];
  let markup = "", focused = null, liveControl = null, revision = 0;
  Object.defineProperty(r, "innerHTML", {
    get: () => markup,
    set(value) { markup = value; focused = null; phases.push("detached"); },
  });
  const inspector = createInspector(r, {
    fetcher: async () => response("a", "RESPONSE", {
      artifacts: [{ id: "file-a", name: `revision-${revision}.txt`, kind: "text", state: "available" }],
    }),
    artifactViewFactory() {
      return {
        captureFocus() {
          phases.push("capture");
          return focused ? { sessionId: "a", fileId: "file-a", control: ".artifact-text" } : null;
        },
        select() { liveControl = {}; phases.push("reconciled"); },
        restoreFocus(saved) {
          phases.push("restore");
          if (saved) {
            assert.deepEqual(saved, { sessionId: "a", fileId: "file-a", control: ".artifact-text" });
            focused = liveControl;
          }
        },
        destroy() {},
      };
    },
  });
  t.after(() => inspector.destroy());
  inspector.select("a"); inspector.showTab("results"); await setImmediate();
  focused = liveControl;
  const original = focused;
  phases.length = 0;
  revision++; r.click({}, "data-inspector-refresh"); await setImmediate();
  assert.deepEqual(phases, ["capture", "detached", "reconciled", "restore"]);
  assert.equal(focused, liveControl);
  assert.notEqual(focused, original);
});
