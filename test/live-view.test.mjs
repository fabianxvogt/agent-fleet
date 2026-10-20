import assert from "node:assert/strict";
import { test } from "node:test";
import { createLiveView, liveActivity } from "../ui/live-view.js";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const at = (delta = 0) => new Date(NOW + delta).toISOString();
const terminal = (id = "one", state = "running", delta = 0) => ({
  id, kind: "tool", name: "exec_command", input: "npm test", text: "Building…", at: at(delta), resultAt: at(delta),
  status: "completed", origin: "local",
  terminal: { command: "npm test", cwd: "/synthetic/demo", state, sessionId: "process-1", exitCode: state === "exited" ? 0 : null },
});
const context = (entries = [terminal()], extra = {}) => ({ localState: "available", entries, session: { status: "working", title: "Synthetic agent" }, ...extra });

test("terminal evidence distinguishes a pending call, observed execution, completion and failure", () => {
  assert.match(liveActivity(context([terminal("one", "pending")]), NOW).label, /waiting for output/);
  assert.match(liveActivity(context(), NOW).label, /Running when last observed/);
  assert.match(liveActivity(context([terminal("one", "exited")]), NOW).label, /finished · exit 0/);
  assert.equal(liveActivity(context([{ ...terminal(), status: "failed" }]), NOW).label, "Command failed");
  const unknown = liveActivity(context([terminal("one", "unknown")]), NOW);
  assert.equal(unknown.label, "Last observed terminal activity");
});

test("a later process result supersedes historical running evidence even after a newer response", () => {
  const finished = terminal("two", "exited", 1000);
  const reply = { id: "reply", kind: "message", role: "assistant", text: "Tests passed.", at: at(2000) };
  const selected = liveActivity(context([terminal(), finished, reply]), NOW + 2000);
  assert.equal(selected.kind, "activity");
  assert.equal(selected.detail, "Tests passed.");
  assert.equal(liveActivity(context([terminal(), finished]), NOW + 2000).label, "Command finished · exit 0");
});

test("newer active process evidence outranks commentary but stale, archived and ended observations never claim running", () => {
  const reply = { id: "reply", kind: "message", role: "assistant", text: "Checking the output.", at: at(1000) };
  assert.equal(liveActivity(context([terminal(), reply]), NOW + 1000).kind, "terminal");
  for (const changes of [{ error: "Refresh failed" }, { session: { status: "done" } }, { localState: "unavailable" }, { activity: { label: "Turn finished", at: at() } }]) {
    assert.doesNotMatch(liveActivity(context([terminal()], changes), NOW).label, /Running when/);
  }
  assert.doesNotMatch(liveActivity(context([{ ...terminal(), origin: "archive" }]), NOW).label, /Running when/);
  const old = liveActivity(context(), NOW + 120_001);
  assert.equal(old.stale, true);
  assert.doesNotMatch(old.label, /Running when/);
});

test("latest non-terminal tools, responses, activity events and metadata provide useful fallbacks", () => {
  const read = { id: "read", kind: "tool", name: "read_file", input: "demo.txt", text: "example", at: at(1000) };
  assert.equal(liveActivity(context([terminal("one", "exited"), read]), NOW + 1000).kind, "tool");
  assert.equal(liveActivity(context([], { activity: { label: "Turn started", at: at() } }), NOW).label, "Turn started");
  assert.equal(liveActivity(context([]), NOW).label, "No recorded activity yet");
  assert.equal(liveActivity(context([], { loading: true }), NOW).label, "Loading recorded activity…");
  const restricted = liveActivity(context([terminal()], { localState: "restricted" }), NOW);
  assert.equal(restricted.kind, "restricted");
  assert.ok(!JSON.stringify(restricted).includes("npm test"));
});

function fixture(t) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const oldDocument = globalThis.document;
  globalThis.document = { hidden: false };
  const elements = new Map();
  const element = (key) => {
    if (!elements.has(key)) elements.set(key, { hidden: false, innerHTML: "", textContent: "", dataset: {}, scrollTop: 0, scrollHeight: 800, clientHeight: 300, querySelector: (s) => element(`${key} ${s}`) });
    return elements.get(key);
  };
  const root = element("root");
  const selections = [];
  let notify;
  let destroyed = false;
  let now = NOW;
  const view = createLiveView(root, { now: () => now, browserFactory: (_, { onState }) => {
    notify = onState;
    return { select(id) { selections.push(id); onState({ id, state: "connecting", hasFrame: false }); }, destroy() { destroyed = true; } };
  } });
  t.after(() => { view.destroy(); globalThis.document = oldDocument; });
  return { view, root, selections, el: (s) => root.querySelector(s), notify: (...args) => notify(...args), advance(ms) { now += ms; t.mock.timers.tick(ms); }, destroyed: () => destroyed };
}

test("fresh browser frames take priority and disconnects fall back immediately without reconnecting on content polls", (t) => {
  const f = fixture(t);
  f.view.select("a", context());
  assert.equal(f.el(".live-source-label").textContent, "Terminal");
  assert.equal(f.el(".live-browser").hidden, false, "browser selection and setup stay accessible");
  assert.equal(f.el(".live-browser").dataset.hasFrame, "false");
  assert.ok(f.el(".live-fallback").innerHTML.includes("npm test"));
  f.notify({ id: "a", state: "live", hasFrame: true });
  assert.equal(f.el(".live-source-label").textContent, "Browser");
  assert.equal(f.el(".live-fallback").hidden, true);
  f.view.select("a", context([terminal("two", "exited")]));
  assert.deepEqual(f.selections, ["a"]);
  f.notify({ id: "a", state: "disconnected", hasFrame: false });
  assert.equal(f.el(".live-source-label").textContent, "Terminal");
  assert.equal(f.el(".live-fallback").hidden, false);
  assert.match(f.el(".live-fallback").innerHTML, /Command finished/);
  f.notify({ id: "a", state: "live", hasFrame: true });
  assert.equal(f.el(".live-fallback").hidden, true);
});

test("selection clears old fallback data and late browser callbacks cannot replace the new session", (t) => {
  const f = fixture(t);
  f.view.select("old", context());
  f.view.select("new", context([], { session: { title: "New session", status: "idle" } }));
  f.notify({ id: "old", state: "live", hasFrame: true });
  assert.equal(f.el(".live-source-label").textContent, "Agent activity");
  assert.doesNotMatch(f.el(".live-fallback").innerHTML, /npm test/);
  assert.equal(f.el(".live-status-label").textContent, "Agent is idle");
  assert.match(f.el(".live-fallback").innerHTML, /No recorded activity yet/);
  f.view.select(null);
  assert.equal(f.root.hidden, true);
  assert.deepEqual(f.selections, ["old", "new", null]);
});

test("fallback escapes output, preserves reading position, shows refresh failure and ages without new events", (t) => {
  const f = fixture(t);
  f.view.select("a", context([{ ...terminal(), text: "<script>unsafe()</script>" }]));
  assert.match(f.el(".live-fallback").innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(f.el(".live-fallback").innerHTML, /<script>/);
  const output = f.el(".live-fallback").querySelector(".live-output");
  output.scrollTop = 70;
  f.view.select("a", context([{ ...terminal(), text: "More output" }], { error: "Refresh failed" }));
  assert.equal(output.scrollTop, 70);
  assert.match(f.el(".live-source-note").textContent, /Refresh failed.*Last known/);
  f.view.select("a", context());
  f.advance(121_000);
  assert.match(f.el(".live-source-note").textContent, /Last known/);
  assert.doesNotMatch(f.el(".live-fallback").innerHTML, /Running when last observed/);
});

test("a restricted context suppresses both previous content and a browser frame", (t) => {
  const f = fixture(t);
  f.view.select("a", context());
  f.notify({ id: "a", state: "live", hasFrame: true });
  f.view.select("a", context([terminal()], { localState: "restricted" }));
  assert.equal(f.el(".live-browser").hidden, true);
  assert.equal(f.el(".live-fallback").hidden, false);
  assert.match(f.el(".live-fallback").innerHTML, /private context/);
  assert.doesNotMatch(f.el(".live-fallback").innerHTML, /npm test/);
  assert.deepEqual(f.selections, ["a", null], "revocation closes the browser stream");
  f.view.select("a", context());
  assert.deepEqual(f.selections, ["a", null, "a"]);
  assert.equal(f.el(".live-browser").dataset.hasFrame, "false", "recovery waits for a new frame");
});

const notice = {
  id: "notice", kind: "notice", label: "Background commands stopped",
  text: "4 background commands were marked stopped after the previous session ended. Completion was not confirmed.",
  at: at(2000), noticeStatus: "stopped",
};

test("session notices stay secondary to useful evidence and never become instructions", () => {
  const reply = { id: "reply", kind: "message", role: "assistant", text: "The build is ready.", at: at(1000) };
  const activity = { kind: "notice", label: notice.label, detail: notice.text, at: notice.at };
  const result = liveActivity(context([reply, notice], { activity, session: { status: "idle" } }), NOW + 2000);
  assert.equal(result.label, "Latest agent response");
  assert.equal(result.detail, "The build is ready.");
  assert.equal(result.notice.label, notice.label);
  const alone = liveActivity(context([notice], { activity, session: { status: "idle" } }), NOW + 2000);
  assert.equal(alone.kind, "notice");
  assert.equal(alone.detail, notice.text);
  assert.equal(alone.notice, undefined);
  const instruction = liveActivity(context([{ id: "user", kind: "message", role: "user", text: "Run the build.", at: at() }]), NOW);
  assert.equal(instruction.label, "Latest instruction");
  assert.equal(instruction.notice, null);
  const updatedNotice = liveActivity(context([notice], {
    activity: { kind: "notice", label: "Background task completed", detail: "The task completed.", at: at(3000) },
  }), NOW + 3000);
  assert.equal(updatedNotice.label, "Background task completed");
  assert.equal(updatedNotice.detail, "The task completed.");
});

test("Live distinguishes current idle state from the recorded work and renders notices separately", (t) => {
  const f = fixture(t);
  const idle = context([terminal(), notice], { session: { status: "idle" } });
  f.view.select("a", idle);
  assert.equal(f.el(".live-status-label").textContent, "Agent is idle");
  assert.match(f.el(".live-fallback").innerHTML, /Recorded /);
  assert.doesNotMatch(f.el(".live-fallback").innerHTML, /Running when last observed/);
  assert.equal(f.el(".live-notice").hidden, false);
  assert.match(f.el(".live-notice").innerHTML, /Session notice/);
  assert.match(f.el(".live-notice").innerHTML, /Completion was not confirmed/);
  f.view.select("a", { ...idle, session: { status: "working" } });
  assert.equal(f.el(".live-status-label").textContent, "Agent is working");
  f.notify({ id: "a", state: "live", hasFrame: true });
  assert.equal(f.el(".live-notice").hidden, true);
  f.notify({ id: "a", state: "disconnected", hasFrame: false });
  assert.equal(f.el(".live-notice").hidden, false);
  f.view.select("a", { ...idle, session: { status: "idle", stale: true } });
  assert.equal(f.el(".live-status-label").textContent, "Last known status: agent is idle");
});

test("notice-only fallback is clearly labeled and ordinary newer output retires an older notice", (t) => {
  const f = fixture(t);
  f.view.select("a", context([notice], { session: { status: "idle" } }));
  assert.match(f.el(".live-fallback").innerHTML, /Session notice/);
  assert.doesNotMatch(f.el(".live-fallback").innerHTML, /Latest instruction/);
  assert.equal(f.el(".live-notice").hidden, true);
  f.view.select("a", context([notice, { id: "reply", kind: "message", role: "assistant", text: "Recovered.", at: at(3000) }]));
  assert.match(f.el(".live-fallback").innerHTML, /Recovered/);
  assert.equal(f.el(".live-notice").hidden, true);
});
