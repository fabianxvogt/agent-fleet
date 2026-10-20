import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createOmpAdapter } from "../src/adapters/omp.mjs";
import { createPiAdapter } from "../src/adapters/pi.mjs";
import { readRelationObservations, resolveSessionRelations } from "../src/adapters/session-relations.mjs";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const AT = new Date(NOW - 5000).toISOString();
const jsonl = (records) => records.map(JSON.stringify).join("\n") + "\n";
const communication = (result) => result.edges.filter((e) => ["message", "report"].includes(e.kind));
const irc = (id, from, extra = {}) => ({
  type: "custom_message", id: `row-${id}`, timestamp: AT, customType: "irc:incoming",
  content: "PRIVATE MESSAGE BODY", details: { id, from, message: "PRIVATE MESSAGE BODY", ...extra },
});
const tools = (id, action, details, extra = {}) => [
  { type: "message", id: `${id}-call`, timestamp: AT, message: { role: "assistant",
    content: [{ type: "toolCall", id, name: "l1_session", arguments: { op: action, message: "PRIVATE TOOL INPUT" } }] } },
  { type: "message", id: `${id}-result`, timestamp: AT, message: { role: "toolResult",
    toolCallId: id, toolName: "l1_session", content: [{ type: "text", text: "PRIVATE TOOL OUTPUT" }],
    details, isError: false, ...extra } },
];
async function fixture(t, agent = "omp") {
  const home = await mkdtemp(join(tmpdir(), "af-relations-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const project = join(home, `.${agent}`, "agent", "sessions", "synthetic");
  const ctx = { home, now: NOW, windowMs: 3600000, procs: new Map(), openFileOwners: new Map(), config: {} };
  async function session(name, id, records = [], { parent = null, mtime = NOW } = {}) {
    const file = join(project, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, jsonl([{ type: "session", id, cwd: "/synthetic/project", timestamp: AT,
      ...(parent ? { parentSession: parent } : {}) }, ...records]));
    await utimes(file, mtime / 1000, mtime / 1000);
    return file;
  }
  return { home, project, ctx, session, adapter: agent === "omp" ? createOmpAdapter() : createPiAdapter() };
}

test("OMP scoped native identities show messages/reports and fix flattened grandchildren", async (t) => {
  const f = await fixture(t);
  const parent = await f.session("root.jsonl", "root", [
    irc("m1", "Worker"), irc("m1", "Worker"), irc("m2", "Worker", { wakeRelay: true }),
    { type: "custom_message", id: "async-row", timestamp: AT, customType: "async-result",
      details: { jobs: [{ jobId: "collision", type: "task", agentId: "Worker", status: "completed", output: "PRIVATE ASYNC BODY" }] } },
  ]);
  const child = await f.session("root/Worker.jsonl", "child", [irc("m3", "Main")], { parent });
  await f.session("root/Worker.Helper.jsonl", "grandchild", [], { parent: child });
  await f.session("root/collision.jsonl", "collision", [], { parent });
  const result = await f.adapter.collect(f.ctx);
  const edges = communication(result);
  assert.deepEqual(edges.map((e) => [e.kind, e.from, e.to, e.count]).sort(), [
    ["message", "omp:child", "omp:root", 1],
    ["message", "omp:root", "omp:child", 1],
    ["report", "omp:child", "omp:root", 2],
  ]);
  assert.ok(result.edges.some((e) => e.kind === "spawn" && e.from === "omp:child" && e.to === "omp:grandchild"));
  assert.ok(!result.edges.some((e) => e.kind === "spawn" && e.from === "omp:root" && e.to === "omp:grandchild"));
  assert.equal(result.nodes.find((n) => n.id === "omp:grandchild").role, "L2");
  assert.ok(edges.every((e) => e.at === AT && !e.inferred));
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  assert.deepEqual(await f.adapter.collect(f.ctx), result, "polling does not inflate event counts");
});

test("OMP aliases stay within each root and require exact observed parent paths", async (t) => {
  const f = await fixture(t);
  const first = await f.session("a.jsonl", "a", [irc("a-message", "Worker")]);
  const second = await f.session("b.jsonl", "b", [irc("b-message", "Worker"), irc("wrong", "main"), irc("missing", "Unknown")]);
  await f.session("a/Worker.jsonl", "first-child", [], { parent: first });
  await f.session("b/Worker.jsonl", "second-child", [], { parent: second });
  await f.session("b/Unverified.jsonl", "unverified", [irc("wrong-owner", "Worker")], { parent: "/unobserved/other.jsonl" });
  const result = await f.adapter.collect(f.ctx);
  assert.deepEqual(communication(result).map((e) => [e.from, e.to]), [
    ["omp:first-child", "omp:a"], ["omp:second-child", "omp:b"],
  ]);
  await f.session("b.jsonl", "b", [irc("bad-alias", "Unverified")]);
  assert.ok(!communication(await f.adapter.collect(f.ctx)).some((e) => e.from === "omp:unverified"));
});

test("OMP managed L1 receipt identifies a sibling file before process assignment", async (t) => {
  const f = await fixture(t);
  const worker = await f.session("managed.jsonl", "managed", [
    { type: "message", id: "reply", timestamp: AT, message: { role: "assistant", stopReason: "stop", content: "Would you prefer A or B?" } },
  ]);
  const parent = await f.session("root.jsonl", "root", [
    ...tools("launch", "start", { workers: [{ name: "PRIVATE NAME", id: "runtime-child", state: "running", sessionFile: worker }] }),
    ...tools("send", "send", { sent: "PRIVATE NAME", id: "runtime-child" }),
    ...tools("result", "results", { results: [{ id: "runtime-child", name: "PRIVATE NAME", ok: false, summary: "PRIVATE SUMMARY", error: "PRIVATE ERROR", outputFile: `${worker}.l1-result.txt` }] }),
  ], { mtime: NOW - 5000 });
  f.ctx.procs.set(50, { pid: 50, agent: "omp", cwd: "/synthetic/project", etime: "01:00:00", openFiles: [] });
  const result = await f.adapter.collect(f.ctx);
  const byId = new Map(result.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get("omp:root").pid, 50);
  assert.equal(byId.get("omp:managed").pid, null);
  assert.equal(byId.get("omp:managed").kind, "subagent");
  assert.equal(byId.get("omp:managed").role, "L1");
  assert.equal(byId.get("omp:managed").attention.kind, "completed");
  assert.equal(byId.get("omp:managed").source, worker);
  assert.ok(result.edges.some((e) => e.kind === "spawn" && e.from === "omp:root" && e.to === "omp:managed"));
  assert.deepEqual(communication(result).map((e) => [e.kind, e.label, e.from, e.to]), [
    ["message", "Message queued", "omp:root", "omp:managed"],
    ["report", "Result received", "omp:managed", "omp:root"],
  ]);
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  assert.equal(byId.get("omp:root").source, parent);
});

test("OMP list/status receipts bind known files but do not assert a launch", async (t) => {
  const f = await fixture(t);
  const worker = await f.session("managed.jsonl", "managed");
  const root = join(f.project, "root.jsonl");
  f.ctx.procs.set(50, { pid: 50, agent: "omp", cwd: "/synthetic/project", etime: "01:00:00", openFiles: [] });
  for (const [action, details] of [
    ["list", [{ id: "runtime", sessionFile: worker }]],
    ["status", { host: { sessionFile: root, sessionId: "root" }, workers: [{ id: "runtime", sessionFile: worker }] }],
  ]) {
    await f.session("root.jsonl", "root", [...tools("binding", action, details), ...tools("send", "send", { sent: "Name", id: "runtime" })], { mtime: NOW - 5000 });
    const result = await f.adapter.collect(f.ctx);
    assert.equal(communication(result).length, 1);
    assert.equal(result.nodes.find((n) => n.id === "omp:managed").kind, "subagent");
    assert.equal(result.nodes.find((n) => n.id === "omp:managed").pid, null);
    assert.equal(result.nodes.find((n) => n.id === "omp:root").pid, 50);
    assert.ok(!result.edges.some((e) => e.kind === "spawn" && e.to === "omp:managed"));
  }
});

test("OMP results/close can identify a known result source without previous launch evidence", async (t) => {
  const f = await fixture(t);
  const worker = await f.session("managed.jsonl", "managed");
  const result = { id: "runtime", ok: true, summary: "PRIVATE SUMMARY", outputFile: `${worker}.l1-result.txt` };
  await f.session("root.jsonl", "root", [
    ...tools("close", "close", { closed: "Name", result, results: [result] }),
    ...tools("unknown", "results", { results: [{ ...result, id: "unseen", outputFile: "/unobserved/worker.jsonl.l1-result.txt" }] }),
    ...tools("bad-suffix", "results", { results: [{ ...result, outputFile: `${worker}.txt` }] }),
  ]);
  const edges = communication(await f.adapter.collect(f.ctx));
  assert.equal(edges.length, 1);
  assert.deepEqual([edges[0].from, edges[0].to, edges[0].count], ["omp:managed", "omp:root", 1]);
});

test("OMP a recent result retains its known quiet worker without reading a result file", async (t) => {
  const f = await fixture(t);
  const worker = await f.session("managed.jsonl", "managed", [], { mtime: NOW - 86400000 });
  await f.session("root.jsonl", "root", tools("result", "results", {
    results: [{ id: "runtime", ok: true, outputFile: `${worker}.l1-result.txt` }],
  }));
  const result = await f.adapter.collect(f.ctx);
  assert.equal(result.nodes.find((n) => n.id === "omp:managed").status, "done");
  assert.equal(communication(result).length, 1);
  await assert.rejects(stat(`${worker}.l1-result.txt`), { code: "ENOENT" });
});

test("OMP conflicting aliases, native cross-root result paths and invalid host identity do not link", async (t) => {
  const f = await fixture(t);
  const root = join(f.project, "root.jsonl");
  const other = await f.session("other.jsonl", "other");
  const localChild = await f.session("root/Worker.jsonl", "local", [], { parent: root });
  const foreignChild = await f.session("other/Worker.jsonl", "foreign", [], { parent: other });
  const managed = await f.session("managed.jsonl", "managed");
  await f.session("root.jsonl", "root", [
    ...tools("conflict", "results", { results: [{ id: "Worker", ok: true, outputFile: `${foreignChild}.l1-result.txt` }] }),
    ...tools("foreign", "results", { results: [{ id: "Unknown", ok: false, outputFile: `${foreignChild}.l1-result.txt` }] }),
    ...tools("invalid", "status", { host: { sessionFile: root, sessionId: "wrong-root" }, workers: [{ id: "runtime", sessionFile: managed }] }),
    ...tools("missing", "status", { workers: [{ id: "runtime", sessionFile: managed }] }),
    ...tools("conflicting-files", "start", { workers: [{ id: "runtime", sessionFile: managed, outputFile: `${localChild}.l1-result.txt` }] }),
    ...tools("wrong-native-launch", "start", { workers: [{ id: "foreign", sessionFile: foreignChild }] }),
    ...tools("send", "send", { sent: "Name", id: "runtime" }),
  ]);
  const result = await f.adapter.collect(f.ctx);
  assert.equal(communication(result).length, 0);
  assert.ok(!result.edges.some((e) => e.kind === "spawn" && e.from === "omp:root" && e.to === "omp:foreign"));
  assert.ok(result.edges.some((e) => e.kind === "spawn" && e.from === "omp:root" && e.to === "omp:local"));
  assert.equal(result.nodes.find((n) => n.id === "omp:local").source, localChild);
});

test("OMP failed, pending, unmatched or text-only launcher results do not create relations", async (t) => {
  const f = await fixture(t);
  const worker = await f.session("managed.jsonl", "managed");
  const details = { workers: [{ id: "runtime", sessionFile: worker }] };
  const failed = tools("failed", "start", details, { isError: true });
  const missingErrorFlag = tools("missing-error-flag", "start", details);
  delete missingErrorFlag[1].message.isError;
  const textOnly = tools("text-only", "start", details);
  delete textOnly[1].message.details;
  textOnly[1].message.content = [{ type: "text", text: JSON.stringify(details) }];
  await f.session("root.jsonl", "root", [
    ...failed, ...missingErrorFlag, ...textOnly, tools("pending", "start", details)[0],
    tools("unmatched", "start", details)[1],
    ...tools("send", "send", { sent: "Name", id: "runtime" }),
  ]);
  const result = await f.adapter.collect(f.ctx);
  assert.equal(communication(result).length, 0);
  assert.ok(!result.edges.some((e) => e.to === "omp:managed"));
});

test("OMP communication uses event time, ages with cached files and rejects unknown time", async (t) => {
  const f = await fixture(t);
  const root = await f.session("root.jsonl", "root", [
    { ...irc("old", "Worker"), timestamp: new Date(NOW - 3600001).toISOString() },
    { ...irc("future", "Worker"), timestamp: new Date(NOW + 7200000).toISOString() },
    { ...irc("invalid", "Worker"), timestamp: "not-a-time" },
    { ...irc("missing", "Worker"), timestamp: undefined },
    irc("valid", "Worker"),
  ]);
  await f.session("root/Worker.jsonl", "child", [], { parent: root });
  const result = await f.adapter.collect(f.ctx);
  assert.equal(communication(result)[0].count, 1);
  assert.equal(communication(result)[0].at, AT);
  const later = await f.adapter.collect({ ...f.ctx, now: NOW + 3600000 });
  assert.equal(communication(later).length, 0);
});

test("OMP branching retracts old messages and prevents cross-branch tool pairing", async (t) => {
  const f = await fixture(t);
  const root = join(f.project, "root.jsonl");
  await f.session("root/Worker.jsonl", "child", [], { parent: root });
  const start = { type: "message", id: "start", parentId: null, timestamp: AT, message: { role: "user", content: "Start" } };
  const old = { ...irc("old", "Worker"), id: "old", parentId: "start" };
  await f.session("root.jsonl", "root", [start, old]);
  assert.equal(communication(await f.adapter.collect(f.ctx)).length, 1);
  const pair = tools("send", "send", { sent: "Name", id: "Worker" });
  await f.session("root.jsonl", "root", [
    start, old, { ...pair[0], parentId: "old" },
    { ...pair[1], parentId: "start" },
  ]);
  assert.equal(communication(await f.adapter.collect(f.ctx)).length, 0);
  await f.session("root.jsonl", "root", [
    start, old, { type: "model_usage", id: "late-usage", parentId: "old", activeLeafId: "start" },
  ]);
  assert.equal(communication(await f.adapter.collect(f.ctx)).length, 0);
});

test("OMP active usage pointers outside the bounded tail do not replay an abandoned message", async (t) => {
  const f = await fixture(t);
  const parent = await f.session("root.jsonl", "root", [
    { ...irc("old", "Worker"), parentId: null },
    { type: "model_usage", id: "late", parentId: "row-old", activeLeafId: "outside-tail" },
  ]);
  await f.session("root/Worker.jsonl", "child", [], { parent });
  assert.equal(communication(await f.adapter.collect(f.ctx)).length, 0);
});

test("OMP a branch switch removes managed aliases and launcher ownership evidence", async (t) => {
  const f = await fixture(t);
  const worker = await f.session("managed.jsonl", "managed");
  const start = { type: "message", id: "start", parentId: null, timestamp: AT, message: { role: "user", content: "Start" } };
  const launch = tools("launch", "launch", { workers: [{ id: "runtime", sessionFile: worker }] });
  const send = tools("send", "send", { sent: "Name", id: "runtime" });
  const previous = [start, { ...launch[0], parentId: "start" }, { ...launch[1], parentId: launch[0].id }];
  await f.session("root.jsonl", "root", [...previous, { ...send[0], parentId: launch[1].id }, { ...send[1], parentId: send[0].id }]);
  assert.equal(communication(await f.adapter.collect(f.ctx)).length, 1);
  await f.session("root.jsonl", "root", [...previous, { ...send[0], parentId: "start" }, { ...send[1], parentId: send[0].id }]);
  const result = await f.adapter.collect(f.ctx);
  assert.equal(communication(result).length, 0);
  assert.ok(!result.edges.some((e) => e.to === "omp:managed"));
  assert.equal(result.nodes.find((n) => n.id === "omp:managed").kind, "session");
});

test("OMP observed communication requires a real session ID and does not pair beyond the read tail", async (t) => {
  const f = await fixture(t);
  const root = join(f.project, "root.jsonl");
  await f.session("root/Worker.jsonl", null, [], { parent: root });
  await f.session("root.jsonl", "root", [irc("m", "Worker")]);
  assert.equal(communication(await f.adapter.collect(f.ctx)).length, 0);
  await f.session("root/Worker.jsonl", "child", [], { parent: root });
  const pair = tools("old-call", "send", { sent: "Name", id: "Worker" });
  await f.session("root.jsonl", "root", [
    pair[0], { type: "message", id: "large", timestamp: AT, message: { role: "assistant", content: "x".repeat(32768) } }, pair[1],
  ]);
  assert.equal(communication(await f.adapter.collect(f.ctx)).length, 0);
});

test("OMP custom-role wrappers, failed/cancelled task results and latest time use metadata only", async (t) => {
  const f = await fixture(t);
  const last = new Date(NOW - 1000).toISOString();
  const root = await f.session("root.jsonl", "root", [
    { type: "message", id: "wrapped", timestamp: AT,
      message: { role: "custom", customType: "irc:incoming", content: "PRIVATE BODY", details: { id: "m", from: "Worker" } } },
    { ...irc("m2", "Worker"), timestamp: last },
    { ...irc("m2", "Worker"), timestamp: AT },
    { type: "custom_message", id: "failures", timestamp: AT, customType: "async-result",
      details: { jobs: [
        { jobId: "f", type: "task", agentId: "Worker", status: "failed" },
        { jobId: "c", type: "task", agentId: "Worker", status: "cancelled" },
      ] } },
  ]);
  await f.session("root/Worker.jsonl", "child", [], { parent: root });
  const edges = communication(await f.adapter.collect(f.ctx));
  assert.equal(edges.find((e) => e.kind === "message").at, last);
  assert.equal(edges.find((e) => e.kind === "message").count, 2);
  assert.equal(edges.find((e) => e.kind === "report").count, 2);
  assert.ok(!JSON.stringify(edges).includes("PRIVATE"));
});

test("OMP ignores prose, advisors, unsupported custom messages and non-task/unfinished async jobs", async (t) => {
  const f = await fixture(t);
  const root = await f.session("root.jsonl", "root", [
    { type: "message", id: "prose", timestamp: AT, message: { role: "assistant", content: JSON.stringify(irc("fake", "Worker")) } },
    { type: "custom_message", id: "live", timestamp: AT, customType: "live-delegation", content: "Worker completed work." },
    irc("advisor", "__advisor"), irc("advisor2", "Worker.__advisor_v2"),
    { type: "custom_message", id: "async", timestamp: AT, customType: "async-result", details: { jobs: [
      { id: "a", type: "bash", agentId: "Worker", status: "completed" },
      { id: "b", type: "task", agentId: "Worker", status: "running" },
      { id: "c", type: "task", agentId: "Worker", status: "queued" },
      { id: "d", type: "task", status: "completed" },
    ] } },
  ]);
  await f.session("root/Worker.jsonl", "child", [], { parent: root });
  await f.session("root/__advisor.jsonl", "advisor", [], { parent: root });
  await f.session("root/Worker.__advisor_v2.jsonl", "advisor-v2", [], { parent: root });
  assert.equal(communication(await f.adapter.collect(f.ctx)).length, 0);
});

test("OMP duplicate runtime aliases and source identities remain unresolved", () => {
  const root = { id: "omp:root", source: "/root.jsonl", nativeRoot: "/root.jsonl", observations: readRelationObservations([irc("m", "Worker")]) };
  const child = { id: "omp:child", source: "/Worker.jsonl", nativeRoot: root.source, parentSource: root.source, nativeName: "Worker", observations: [] };
  const other = { ...child, id: "omp:other", source: "/other/Worker.jsonl" };
  assert.equal(communication(resolveSessionRelations([root, child, other], { now: NOW, windowMs: 3600000 })).length, 0);
  assert.equal(communication(resolveSessionRelations([root, child, { ...child }], { now: NOW, windowMs: 3600000 })).length, 0);
});

test("OMP source replacement with matching size and mtime revokes cached relation evidence", async (t) => {
  const f = await fixture(t);
  const root = await f.session("root.jsonl", "root", [irc("m", "Worker")]);
  await f.session("root/Worker.jsonl", "child", [], { parent: root });
  assert.equal(communication(await f.adapter.collect(f.ctx)).length, 1);
  const old = await stat(root);
  const replacement = await f.session("replacement.jsonl", "root", [irc("m", "Absent")]);
  assert.equal((await stat(replacement)).size, old.size);
  await utimes(replacement, old.atime, old.mtime);
  await rename(replacement, root);
  assert.equal(communication(await f.adapter.collect(f.ctx)).length, 0);
});

test("Pi keeps its existing hierarchy without consuming OMP-specific envelopes", async (t) => {
  const f = await fixture(t, "pi");
  const root = await f.session("root.jsonl", "root", [irc("message", "Worker")]);
  await f.session("root/Worker.jsonl", "child", [], { parent: root });
  const result = await f.adapter.collect(f.ctx);
  assert.equal(communication(result).length, 0);
  assert.deepEqual(result.edges.map((e) => [e.kind, e.from, e.to]), [["spawn", "pi:root", "pi:child"]]);
});

test("OMP observation extraction bounds arrays and excludes all body and schema fields", () => {
  const records = Array.from({ length: 1000 }, (_, i) => irc(`m${i}`, "Worker"));
  const result = readRelationObservations(records);
  assert.equal(result.length, 128);
  assert.equal(result[0].eventId, "irc:m872", "bounded observations keep the newest evidence");
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  const jobs = Array.from({ length: 1000 }, (_, i) => ({ type: "task", jobId: `j${i}`, agentId: "Worker", status: "completed" }));
  assert.equal(readRelationObservations([{ type: "custom_message", id: "async", timestamp: AT, customType: "async-result", details: { jobs } }]).length, 64);
});
