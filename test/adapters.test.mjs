import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createClaudeAdapter } from "../src/adapters/claude.mjs";
import { createCodexAdapter } from "../src/adapters/codex.mjs";
import { createFleetAdapter } from "../src/adapters/fleet.mjs";
import { createOmpAdapter } from "../src/adapters/omp.mjs";
import { createPiAdapter } from "../src/adapters/pi.mjs";
import { link } from "../src/linker.mjs";
import { mergeEdges, mergeNodes } from "../src/model.mjs";
import { classifyProcess } from "../src/procs.mjs";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const jsonl = (...records) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

async function put(path, content, mtime = NOW) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
  await utimes(path, mtime / 1000, mtime / 1000);
}

function proc(pid, ppid, agent, extra = {}) {
  return { pid, ppid, etime: "01:00:00", comm: `/bin/${agent ?? "zsh"}`, args: agent ?? "zsh", agent, cwd: null, openFiles: [], ...extra };
}

const ctxFor = (home, procs = [], openFileOwners = new Map(), config = {}) => ({
  now: NOW,
  home,
  windowMs: 12 * 3_600_000,
  procs: new Map(procs.map((p) => [p.pid, p])),
  openFileOwners,
  config: { fleetRoots: [], fleetScanDepth: 3, ...config },
});

test("claude: live registry, desktop spawn/message/report links and subagents", async () => {
  const home = await mkdtemp(join(tmpdir(), "af-claude-"));
  const desk = join(home, "Library", "Application Support", "Claude", "claude-code-sessions", "acct", "org");
  await put(join(home, ".claude", "sessions", "100.json"), { pid: 100, sessionId: "parent-sid", cwd: "/w/app", status: "busy", entrypoint: "claude-desktop", name: "Parent" });
  await put(join(desk, "local_p.json"), {
    sessionId: "local_p",
    cliSessionId: "parent-sid",
    title: "Parent task",
    cwd: "/w/app",
    lastActivityAt: NOW - 1000,
    peerReceipts: [{ targetSessionId: "local_c", sentAt: NOW - 5000, delivery: "delivered" }],
    sideSessionNotes: [{ sessionId: "local_c", title: "Child", report: "done with it", at: NOW - 4000 }],
  });
  await put(join(desk, "local_c.json"), { sessionId: "local_c", cliSessionId: "child-sid", title: "Child task", cwd: "/w/app/.claude/worktrees/x", lastActivityAt: NOW - 60_000, spawnedFrom: { sessionId: "local_p", name: "child" } });
  const proj = join(home, ".claude", "projects", "-w-app");
  await put(join(proj, "parent-sid.jsonl"), jsonl({ type: "user", cwd: "/w/app", entrypoint: "claude-desktop", timestamp: new Date(NOW - 9000).toISOString() }));
  await put(join(proj, "parent-sid", "subagents", "agent-a1.jsonl"), jsonl({ type: "user", agentId: "a1" }), NOW - 10_000);
  await put(join(proj, "parent-sid", "subagents", "agent-a1.meta.json"), { agentType: "Explore", description: "Find the thing", model: "haiku" });

  const r = await createClaudeAdapter().collect(ctxFor(home, [proc(100, 1, "claude")]));
  const byId = new Map(r.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get("claude:parent-sid").status, "working");
  assert.equal(byId.get("claude:parent-sid").title, "Parent task");
  assert.equal(byId.get("claude:parent-sid").openUrl, "claude://claude.ai/epitaxy/local_p");
  assert.equal(byId.get("claude:parent-sid").transcript, join(proj, "parent-sid.jsonl"));
  assert.equal(byId.get("claude:child-sid").status, "done");
  assert.equal(byId.get("claude:child-sid").project, "app", "worktree maps back to its repository");
  const sub = byId.get("claude-sub:parent-sid:agent-a1");
  assert.equal(sub.status, "working");
  assert.equal(sub.role, "Explore");
  const kinds = r.edges.map((e) => `${e.kind}:${e.from}->${e.to}`).sort();
  assert.deepEqual(kinds, [
    "message:claude:parent-sid->claude:child-sid",
    "report:claude:child-sid->claude:parent-sid",
    "spawn:claude:parent-sid->claude-sub:parent-sid:agent-a1",
    "spawn:claude:parent-sid->claude:child-sid",
  ]);
});

test("claude: registry entry of a dead process is ignored", async () => {
  const home = await mkdtemp(join(tmpdir(), "af-claude-dead-"));
  await put(join(home, ".claude", "sessions", "200.json"), { pid: 200, sessionId: "gone", cwd: "/w", status: "busy" });
  const r = await createClaudeAdapter().collect(ctxFor(home, []));
  assert.equal(r.nodes.length, 0);
});

test("claude: a reused PID cannot keep an older registry session alive", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "af-claude-reused-pid-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const before = "Fri Oct 16 09:00:00 2026";
  const current = "Fri Oct 16 11:00:00 2026";
  const registry = join(home, ".claude", "sessions", "200.json");
  const adapter = createClaudeAdapter();
  await put(registry, { pid: 200, sessionId: "old-session", cwd: "/synthetic", status: "busy", procStart: before });
  const process = proc(200, 1, "claude", { procStart: before });
  assert.equal((await adapter.collect(ctxFor(home, [process]))).nodes[0].status, "working");
  process.procStart = current;
  assert.deepEqual((await adapter.collect(ctxFor(home, [process]))).nodes, [], "the new process does not own the stale registry");
  await put(registry, { pid: 200, sessionId: "current-session", cwd: "/synthetic", status: "busy", procStart: ` ${current}\n` });
  const result = await adapter.collect(ctxFor(home, [process]));
  assert.equal(result.nodes[0].id, "claude:current-session");
  assert.equal(result.nodes[0].pid, 200);
  assert.equal(result.nodes[0].status, "working");
});

test("claude: present invalid or unobserved process identity rejects ownership while legacy absence remains compatible", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "af-claude-process-identity-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const start = "Fri Oct 16 11:00:00 2026";
  const registry = join(home, ".claude", "sessions", "200.json");
  const adapter = createClaudeAdapter();
  const record = { pid: 200, sessionId: "fixture", cwd: "/synthetic", status: "busy" };
  for (const procStart of [null, 123, "", " ", {}, "not-a-date", "2026-10-16T11:00:00Z"]) {
    await put(registry, { ...record, procStart });
    assert.deepEqual((await adapter.collect(ctxFor(home, [proc(200, 1, "claude", { procStart: start })]))).nodes, [],
      `invalid registry identity: ${JSON.stringify(procStart)}`);
  }
  for (const procStart of [
    "Fri Feb 30 11:00:00 2026", "Fri Oct 16 24:00:00 2026",
    "Mon Oct 16 11:00:00 2026", "Tue Oct 06 11:00:00 2026",
  ]) {
    await put(registry, { ...record, procStart });
    assert.deepEqual((await adapter.collect(ctxFor(home, [proc(200, 1, "claude", { procStart })]))).nodes, [],
      `matching malformed identities must still reject ownership: ${procStart}`);
  }
  await put(registry, { ...record, procStart: start });
  for (const observed of [undefined, null, "", "not-a-date"]) {
    assert.deepEqual((await adapter.collect(ctxFor(home, [proc(200, 1, "claude", { procStart: observed })]))).nodes, []);
  }
  assert.deepEqual((await adapter.collect(ctxFor(home, []))).nodes, []);
  await put(registry, record);
  assert.equal((await adapter.collect(ctxFor(home, [proc(200, 1, "claude")]))).nodes[0].pid, 200,
    "older registries without a start token keep existing ownership behavior");
});

test("claude: rejecting stale process ownership preserves recently recorded session history", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "af-claude-reused-history-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await put(join(home, ".claude", "sessions", "200.json"), {
    pid: 200, sessionId: "fixture", cwd: "/synthetic", status: "busy", procStart: "Fri Oct 16 09:00:00 2026",
  });
  const transcript = join(home, ".claude", "projects", "synthetic", "fixture.jsonl");
  await put(transcript, jsonl({ type: "user", timestamp: "2026-10-16T11:00:00Z", cwd: "/synthetic", message: { content: "Fixture task" } }));
  const result = await createClaudeAdapter().collect(ctxFor(home, [proc(200, 1, "claude", { procStart: "Fri Oct 16 11:00:00 2026" })]));
  assert.equal(result.nodes[0].id, "claude:fixture");
  assert.equal(result.nodes[0].pid, null);
  assert.equal(result.nodes[0].status, "done");
  assert.equal(result.nodes[0].transcript, transcript);
});

test("claude: child errors and completed replies override recency, and only explicit child asks need the human", async () => {
  const home = await mkdtemp(join(tmpdir(), "af-claude-child-attention-"));
  const proj = join(home, ".claude", "projects", "-w-app");
  await put(join(home, ".claude", "sessions", "100.json"), { pid: 100, sessionId: "parent", cwd: "/w/app", status: "busy" });
  await put(join(proj, "parent.jsonl"), jsonl({ type: "user", cwd: "/w/app", message: { content: "Build it" } }));
  const child = join(proj, "parent", "subagents", "agent-child.jsonl");
  const adapter = createClaudeAdapter();
  const reply = (content, stop_reason = "end_turn", extra = {}) => ({ type: "assistant", timestamp: new Date(NOW - 1000).toISOString(), message: { content, stop_reason }, ...extra });
  let iteration = 0;
  for (const [record, status, kind] of [
    [reply([], "error"), "failed", undefined],
    [reply([], null, { isApiErrorMessage: true }), "failed", undefined],
    [reply([{ type: "text", text: "Finished the implementation." }]), "done", "completed"],
    [reply([{ type: "text", text: "Would you prefer A or B?" }]), "done", "completed"],
    [reply([{ type: "tool_use", id: "q", name: "AskUserQuestion", input: {} }], "tool_use"), "waiting", "question"],
  ]) {
    await put(child, jsonl(record), NOW - 1000 + iteration++);
    const collect = (now) => adapter.collect({ ...ctxFor(home, [proc(100, 1, "claude")]), now });
    for (const now of [NOW, NOW + 120_000]) {
      const result = await collect(now);
      const n = result.nodes.find(n => n.id === "claude-sub:parent:agent-child");
      assert.equal(n.status, status);
      assert.equal(n.attention?.kind, kind);
    }
  }
});

test("codex: subagent thread links to its parent; open file means alive", async () => {
  const home = await mkdtemp(join(tmpdir(), "af-codex-"));
  const day = join(home, ".codex", "sessions", "2026", "10", "16");
  const parent = join(day, "rollout-a.jsonl");
  const child = join(day, "rollout-b.jsonl");
  await put(parent, jsonl({ type: "session_meta", payload: { id: "p1", cwd: "/w/site", originator: "codex_work_desktop", timestamp: "2026-10-16T11:00:00Z" } }, { type: "event_msg", payload: { type: "task_complete" } }), NOW - 20 * 60_000);
  await put(child, jsonl({ type: "session_meta", payload: { id: "c1", cwd: "/w/site", originator: "codex_work_desktop", source: { subagent: { thread_spawn: { parent_thread_id: "p1", agent_role: "worker", agent_nickname: "Ada" } } } } }, { type: "event_msg", payload: { type: "task_started" } }), NOW - 5000);
  await put(join(home, ".codex", "session_index.jsonl"), jsonl({ id: "p1", thread_name: "Build the site" }));
  const owners = new Map([[parent, 300], [child, 300]]);
  const r = await createCodexAdapter().collect(ctxFor(home, [proc(300, 1, "codex")], owners));
  const byId = new Map(r.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get("codex:p1").title, "Build the site");
  assert.equal(byId.get("codex:p1").status, "idle");
  assert.equal(byId.get("codex:p1").attention.kind, "completed");
  assert.equal(byId.get("codex:p1").surface, "app");
  assert.equal(byId.get("codex:c1").status, "working");
  assert.equal(byId.get("codex:c1").role, "worker");
  assert.deepEqual(r.edges.map((e) => [e.kind, e.from, e.to]), [["spawn", "codex:p1", "codex:c1"]]);
  await put(child, jsonl(
    { type: "session_meta", payload: { id: "c1", parent_thread_id: "p1" } },
    { type: "response_item", payload: { type: "message", role: "assistant", phase: "final", content: [{ type: "output_text", text: "Would you prefer A or B?" }] } },
    { type: "event_msg", payload: { type: "task_complete" } },
  ));
  const completed = await createCodexAdapter().collect(ctxFor(home, [proc(300, 1, "codex")], owners));
  assert.equal(completed.nodes.find(n => n.id === "codex:c1").status, "idle");
  assert.equal(completed.nodes.find(n => n.id === "codex:c1").attention.kind, "completed", "subagent prose asks its parent, not necessarily the human");
});

test("omp: directory nesting becomes the L0/L1/L2 hierarchy", async () => {
  const home = await mkdtemp(join(tmpdir(), "af-omp-"));
  const proj = join(home, ".omp", "agent", "sessions", "-w-lab");
  const root = join(proj, "2026-10-16T10-00-00-000Z_r1.jsonl");
  const head = (id, title) => jsonl({ type: "title", title }, { type: "session", id, cwd: "/w/lab", timestamp: "2026-10-16T10:00:00Z" }, { type: "model_change", model: "anthropic/claude-opus-5-5" });
  await put(root, head("r1", "Coordinate lab"), NOW - 30_000);
  await put(join(proj, "2026-10-16T10-00-00-000Z_r1", "Scout.jsonl"), head("k1", ""), NOW - 10_000);
  await put(join(proj, "2026-10-16T10-00-00-000Z_r1", "Scout", "Probe.jsonl"), head("g1", ""), NOW - 3 * 3_600_000);
  const p = proc(400, 1, "omp", { cwd: "/w/lab", etime: "02:00:00" });
  const r = await createOmpAdapter().collect(ctxFor(home, [p]));
  const byId = new Map(r.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get("omp:r1").role, "L0");
  assert.equal(byId.get("omp:r1").pid, 400, "process assigned by matching cwd");
  assert.equal(byId.get("omp:r1").status, "working");
  assert.equal(byId.get("omp:r1").model, "claude-opus-5-5");
  assert.equal(byId.get("omp:k1").role, "L1");
  assert.equal(byId.get("omp:k1").title, "Scout");
  assert.equal(byId.get("omp:g1").role, "L2");
  assert.equal(byId.get("omp:g1").status, "idle", "old child of a live root is idle, not done");
  assert.deepEqual(r.edges.map((e) => [e.from, e.to]).sort(), [["omp:k1", "omp:g1"], ["omp:r1", "omp:k1"]]);
  await put(join(proj, "2026-10-16T10-00-00-000Z_r1", "Scout.jsonl"), head("k1", "") + jsonl({ type: "message", message: { role: "assistant", stopReason: "stop", content: "Would you prefer A or B?" } }));
  const completed = await createOmpAdapter().collect(ctxFor(home, [p]));
  assert.equal(completed.nodes.find(n => n.id === "omp:k1").attention.kind, "completed");
});

test("fleet: workers, dependencies and stale controller detection", async () => {
  const home = await mkdtemp(join(tmpdir(), "af-fleet-"));
  const run = join(home, "proj", ".fleet", "build-20261016");
  await put(join(run, "fleet.json"), { fleet_name: "build", workers: [{ id: "research", type: "research", depends_on: [] }, { id: "code", type: "code-run", depends_on: ["research"] }] });
  await put(join(run, "state.json"), { fleet_name: "build", status: "running", created_at: "2026-10-16T11:00:00Z", pid: 999, heartbeat_at: new Date(NOW - 10 * 60_000).toISOString(), nodes: { research: { status: "completed" }, code: { status: "running" } } });
  const r = await createFleetAdapter().collect(ctxFor(home, [], new Map(), { fleetRoots: [home] }));
  const byId = new Map(r.nodes.map((n) => [n.id, n]));
  const fleetId = `fleet:${run}`;
  assert.equal(byId.get(fleetId).status, "stale", "running state without live controller is stale");
  assert.equal(byId.get(`${fleetId}#research`).status, "done");
  assert.equal(byId.get(`${fleetId}#code`).status, "stale");
  assert.ok(r.edges.some((e) => e.kind === "dependency" && e.from === `${fleetId}#research` && e.to === `${fleetId}#code`));
});

test("linker: cross-tool process ancestry and unmatched agent processes", () => {
  const nodes = mergeNodes([[{ id: "claude:s1", agent: "claude", kind: "session", pid: 10, status: "working", meta: {} }]]);
  const edges = mergeEdges([]);
  // claude(10) -> zsh(11) -> codex exec(12) without a session file
  const procs = new Map([proc(10, 1, "claude"), proc(11, 10, null), proc(12, 11, "codex", { cwd: "/w/x", args: "codex exec fix" })].map((p) => [p.pid, p]));
  link(nodes, edges, procs);
  assert.equal(nodes.get("process:12").agent, "codex");
  const e = [...edges.values()].find((x) => x.kind === "process");
  assert.deepEqual([e.from, e.to, e.inferred], ["claude:s1", "process:12", true]);
});

test("linker: placeholder parent keeps a tree connected", () => {
  const nodes = mergeNodes([[{ id: "codex:c", agent: "codex", kind: "subagent", status: "working", meta: {} }]]);
  const edges = mergeEdges([[{ id: "spawn:codex:p->codex:c", from: "codex:p", to: "codex:c", kind: "spawn", count: 1 }]]);
  link(nodes, edges, new Map());
  assert.equal(nodes.get("codex:p").meta.placeholder, true);
  assert.equal(nodes.get("codex:p").agentsviewId, "codex:p");
});

test("classifyProcess recognises agent runtimes and skips helpers", () => {
  assert.equal(classifyProcess("/Users/x/Library/Application Support/Claude/claude-code/2/claude.app/Contents/MacOS/claude", "claude --output-format stream-json"), "claude");
  assert.equal(classifyProcess("/Applications/Claude.app/Contents/MacOS/Claude", ""), null);
  assert.equal(classifyProcess("/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex", "codex app-server"), "codex");
  assert.equal(classifyProcess("/x/codex", "codex exec-server --remote x"), null);
  assert.equal(classifyProcess("/usr/local/bin/node", "node /x/codex-router/src/router.mjs"), null);
  assert.equal(classifyProcess("/opt/homebrew/bin/pi", "pi"), "pi");
  assert.equal(classifyProcess("/opt/homebrew/bin/opencode", "opencode"), "opencode");
});

test("fleet: malformed spec and hostile status strings do not break or leak through", async () => {
  const home = await mkdtemp(join(tmpdir(), "af-fleet-bad-"));
  const run = join(home, "repo", ".fleet", "evil-1");
  await put(join(run, "fleet.json"), { config: {}, workers: "nope" });
  await put(join(run, "state.json"), { fleet_name: "evil", status: 'done" onmouseover="alert(1)', created_at: "2026-10-16T11:00:00Z", nodes: { w: { status: "<img src=x>" } } });
  const r = await createFleetAdapter().collect(ctxFor(home, [], new Map(), { fleetRoots: [home] }));
  assert.ok(r.nodes.length >= 2);
  for (const n of r.nodes) assert.ok(["idle", "queued", "done", "working", "stale", "failed"].includes(n.status), n.status);
});

test("collector: unknown statuses become idle and unknown edge kinds are dropped", async () => {
  const { createCollector } = await import("../src/collector.mjs");
  const adapter = {
    id: "fake",
    label: "Fake",
    async collect() {
      return {
        nodes: [{ id: "x:1", agent: "x", kind: "session", status: "pwned\" onload=\"", meta: {} }, { id: "x:2", agent: "x", kind: "session", status: "working", meta: {} }],
        edges: [{ id: "evil:x:1->x:2", from: "x:1", to: "x:2", kind: "evil\"", count: 1 }],
      };
    },
  };
  const c = createCollector({ home: tmpdir(), windowHours: 1, parkAfterMinutes: 120, intervalMs: 4000 }, [adapter]);
  const snap = await c.collectOnce();
  assert.equal(snap.nodes.find((n) => n.id === "x:1").status, "idle");
  assert.equal(snap.edges.filter((e) => e.from === "x:1").length, 0);
});

test("pi: a process that starts a new session in the same cwd follows it", async () => {
  const home = await mkdtemp(join(tmpdir(), "af-pi-switch-"));
  const proj = join(home, ".pi", "agent", "sessions", "--w-daw--");
  const head = (id) => jsonl({ type: "session", id, cwd: "/w/daw", timestamp: "2026-10-16T10:00:00Z" });
  const p = proc(500, 1, "pi", { cwd: "/w/daw", etime: "05:00:00" });
  const adapter = createPiAdapter();
  await put(join(proj, "old.jsonl"), head("old"), NOW - 3 * 3_600_000);
  let r = await adapter.collect(ctxFor(home, [p]));
  assert.equal(r.nodes.find((n) => n.id === "pi:old").pid, 500);

  await put(join(proj, "new.jsonl"), head("new"), NOW - 5_000); // e.g. /new inside the same pi process
  r = await adapter.collect(ctxFor(home, [p]));
  const byId = new Map(r.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get("pi:new").pid, 500, "the session being written gets the process");
  assert.equal(byId.get("pi:new").status, "working");
  assert.equal(byId.get("pi:old").status, "done");
});

test("pi: an open file from another project does not steal the process", async () => {
  const home = await mkdtemp(join(tmpdir(), "af-pi-open-"));
  const root = join(home, ".pi", "agent", "sessions");
  const head = (id, cwd) => jsonl({ type: "session", id, cwd, timestamp: "2026-10-16T10:00:00Z" });
  await put(join(root, "--w-a--", "mine.jsonl"), head("mine", "/w/a"), NOW - 60_000);
  const other = join(root, "--w-b--", "other.jsonl");
  await put(other, head("other", "/w/b"), NOW - 1_000);
  const p = proc(600, 1, "pi", { cwd: "/w/a", etime: "01:00:00", openFiles: [other] });
  const r = await createPiAdapter().collect(ctxFor(home, [p]));
  const byId = new Map(r.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get("pi:mine").pid, 600);
  assert.equal(byId.get("pi:other").pid, null);
});

test("claude: completed replies, explicit questions and answered questions have distinct states", async () => {
  const home = await mkdtemp(join(tmpdir(), "af-claude-attention-"));
  const file = join(home, ".claude", "projects", "-w-app", "sid.jsonl");
  await put(join(home, ".claude", "sessions", "100.json"), { pid: 100, sessionId: "sid", cwd: "/w/app", status: "idle" });
  const start = { type: "user", timestamp: "2026-10-16T11:00:00Z", cwd: "/w/app", message: { content: "Build it" } };
  const reply = (content, stop_reason = "end_turn") => ({ type: "assistant", timestamp: "2026-10-16T11:59:00Z", message: { content, stop_reason } });
  const request = reply([{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [{ question: "Private fixture question?" }] } }], "tool_use");
  for (const [records, expectedStatus, expectedKind] of [
    [[reply([{ type: "text", text: "Built and checked." }])], "idle", "completed"],
    [[request], "waiting", "question"],
    [[request, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "q1", content: "Option A" }] } }], "idle", undefined],
    [[request, { type: "user", message: { content: "Continue with A" } }], "idle", undefined],
    [[reply([{ type: "text", text: "Would you prefer A or B?" }])], "waiting", "question"],
    [[reply([{ type: "text", text: "> Would you prefer A or B?" }])], "idle", "completed"],
    [[reply([{ type: "text", text: "Would you prefer A or B?" }], null)], "idle", undefined],
  ]) {
    await put(file, jsonl(start, ...records));
    const r = await createClaudeAdapter().collect(ctxFor(home, [proc(100, 1, "claude")]));
    const n = r.nodes.find((n) => n.id === "claude:sid");
    assert.equal(n.status, expectedStatus);
    assert.equal(n.attention?.kind, expectedKind);
    assert.ok(!JSON.stringify(n.attention).includes("Private fixture"));
  }
});

test("codex: live ownership cannot hide failed turns, and new turns clear old attention", async () => {
  const home = await mkdtemp(join(tmpdir(), "af-codex-attention-"));
  const file = join(home, ".codex", "sessions", "2026", "10", "16", "rollout-sid.jsonl");
  const start = { type: "session_meta", payload: { id: "sid", cwd: "/w/app" } };
  const event = (type) => ({ type: "event_msg", timestamp: "2026-10-16T11:59:00Z", payload: { type } });
  const request = { type: "response_item", timestamp: "2026-10-16T11:59:00Z", payload: { type: "function_call", name: "functions.request_user_input", call_id: "q1", arguments: "{}" } };
  for (const [records, expectedStatus, expectedKind] of [
    [[event("task_complete")], "idle", "completed"],
    [[event("turn_aborted")], "failed", undefined],
    [[event("error")], "failed", undefined],
    [[event("task_started"), request], "waiting", "question"],
    [[event("task_started"), request, { type: "response_item", payload: { type: "function_call_output", call_id: "q1", output: "Answered" } }], "working", undefined],
    [[event("task_started"), request, event("task_started")], "working", undefined],
    [[event("task_complete"), event("task_started")], "working", undefined],
  ]) {
    await put(file, jsonl(start, ...records));
    const r = await createCodexAdapter().collect(ctxFor(home, [proc(300, 1, "codex")], new Map([[file, 300]])));
    const n = r.nodes.find((n) => n.id === "codex:sid");
    assert.equal(n.status, expectedStatus);
    assert.equal(n.attention?.kind, expectedKind);
  }
});

test("pi/omp: live old sessions are idle without an ask and explicit errors survive ownership", async () => {
  for (const [agent, create] of [["pi", createPiAdapter], ["omp", createOmpAdapter]]) {
    const home = await mkdtemp(join(tmpdir(), `af-${agent}-attention-`));
    const file = join(home, `.${agent}`, "agent", "sessions", "-w-app", "sid.jsonl");
    const start = { type: "session", id: "sid", cwd: "/w/app" };
    for (const [message, status, kind] of [
      [null, "idle", undefined],
      [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }] }, "idle", "completed"],
      [{ role: "assistant", stopReason: "error", content: [] }, "failed", undefined],
    ]) {
      await put(file, jsonl(start, ...(message ? [{ type: "message", message }] : [])), NOW - 90_000);
      const r = await create().collect(ctxFor(home, [proc(400, 1, agent, { cwd: "/w/app" })]));
      const n = r.nodes.find((n) => n.id === `${agent}:sid`);
      assert.equal(n.status, status);
      assert.equal(n.attention?.kind, kind);
    }
  }
});
