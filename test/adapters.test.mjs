import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createClaudeAdapter } from "../src/adapters/claude.mjs";
import { createCodexAdapter } from "../src/adapters/codex.mjs";
import { createFleetAdapter } from "../src/adapters/fleet.mjs";
import { createOmpAdapter } from "../src/adapters/omp.mjs";
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
  assert.equal(byId.get("codex:p1").status, "waiting");
  assert.equal(byId.get("codex:p1").surface, "app");
  assert.equal(byId.get("codex:c1").status, "working");
  assert.equal(byId.get("codex:c1").role, "worker");
  assert.deepEqual(r.edges.map((e) => [e.kind, e.from, e.to]), [["spawn", "codex:p1", "codex:c1"]]);
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
