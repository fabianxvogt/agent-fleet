import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { test } from "node:test";
import { attentionFeed } from "../src/notifications.mjs";
import { createDashboardServer } from "../src/server.mjs";
import { readTurnState } from "../src/attention.mjs";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const iso = (offset = 0) => new Date(NOW + offset).toISOString();
const requestId = (value = "request") => createHash("sha256").update(value).digest("hex");
const pending = (value = "request", extra = {}) => ({ requestId: requestId(value), kind: "question", at: iso(-60_000), ...extra });
const node = (value = "test", extra = {}) => ({
  id: `codex:${value}`, agent: "codex", kind: "session", status: "waiting",
  title: "PRIVATE TITLE", cwd: "/private/project", source: "/private/source",
  attention: { kind: "question", evidence: "explicit", reason: "PRIVATE REASON", requests: [pending(value)], requestsComplete: true },
  meta: { dataSource: "codex" }, ...extra,
});
const source = (id = "codex", extra = {}) => ({ id, observedAt: iso(-1000), lastSuccessAt: iso(), stale: false, error: null, ...extra });
const snapshot = (extra = {}) => ({
  generatedAt: iso(), intervalMs: 4000, processObservedAt: iso(-1000), processError: null,
  nodes: [node()], adapters: [source()], ...extra,
});
const feed = (value = snapshot(), extra = {}) => attentionFeed(value, { instanceId: "synthetic-instance", now: NOW, ...extra });

test("attention feed contains only explicit pending metadata from one fresh observation", () => {
  const value = feed();
  assert.deepEqual(value, {
    version: 1, instanceId: "synthetic-instance", observedAt: iso(), staleAfterMs: 12_000,
    process: { observedAt: iso(-1000), current: true },
    sources: [{ id: "codex", observedAt: iso(-1000), current: true }],
    requests: [{ sessionId: "codex:test", requestId: requestId("test"), sourceId: "codex", kind: "question", at: iso(-60_000) }],
    truncated: false,
  });
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE|private|reason|title|cwd|input/);
});

test("terminal, inferred, stale, placeholder and non-session nodes do not notify", () => {
  const candidates = [
    ...["done", "failed", "stale", "working", "idle", "queued"].map((status) => node(status, { status })),
    ...["process", "fleet", "placeholder", null].map((kind) => node(String(kind), { kind })),
    node("stale-meta", { meta: { dataSource: "codex", dataStale: true } }),
    node("placeholder-meta", { meta: { dataSource: "codex", placeholder: true } }),
    node("inferred", { attention: { ...node().attention, evidence: "inferred" } }),
    node("completed", { attention: { ...node().attention, kind: "completed" } }),
    node("legacy", { attention: { kind: "question", evidence: "explicit" } }),
    node("unknown-source", { meta: { dataSource: "unknown" } }),
  ];
  assert.deepEqual(feed(snapshot({ nodes: candidates })).requests, []);
  for (const kind of ["session", "subagent", "worker"]) assert.equal(feed(snapshot({ nodes: [node(kind, { kind, pid: null })] })).requests.length, 1);
});

test("unrelated source failures do not block healthy sources and empty sources are included", () => {
  const value = feed(snapshot({
    adapters: [source("codex"), source("omp", { error: "PRIVATE FAILURE" }), source("empty")],
    nodes: [node(), node("failed-source", { meta: { dataSource: "omp" } })],
  }));
  assert.equal(value.requests.length, 1);
  assert.deepEqual(value.sources.map((s) => [s.id, s.current]), [["codex", true], ["empty", true], ["omp", false]]);
  assert.doesNotMatch(JSON.stringify(value), /FAILURE/);
  for (const extra of [{ stale: true }, { retained: true }, { observedAt: iso(-12_001) }, { observedAt: null }, { observedAt: "bad" }, { observedAt: iso(1) }]) {
    const changed = feed(snapshot({ adapters: [source("codex", extra)] }));
    assert.equal(changed.sources[0].current, false, JSON.stringify(extra));
    assert.deepEqual(changed.requests, []);
  }
});

test("missing, malformed, stale, future or failed process observations cannot produce alerts", () => {
  for (const extra of [
    { processObservedAt: null }, { processObservedAt: "bad" }, { processObservedAt: iso(1) },
    { processObservedAt: iso(-12_001) }, { processError: "PRIVATE PROCESS ERROR" },
    { collectionError: "PRIVATE COLLECTION ERROR" },
    { generatedAt: null }, { generatedAt: "bad" }, { generatedAt: iso(1) }, { generatedAt: iso(-12_001) },
    { generatedAt: iso(-2000), processObservedAt: iso(-1000) },
    { intervalMs: NaN }, { intervalMs: Infinity }, { intervalMs: 0 }, { intervalMs: "4000" }, { intervalMs: 300_001 },
  ]) {
    const value = feed(snapshot(extra));
    assert.equal(value.process.current, false, JSON.stringify(extra));
    assert.deepEqual(value.requests, []);
    assert.equal(Number.isFinite(value.staleAfterMs), true);
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE/);
  }
  assert.deepEqual(feed(null).sources, []);
  assert.deepEqual(feed(null).requests, []);
  assert.equal(feed(null).process.current, false);
  assert.equal(feed(snapshot({ adapters: {} })).process.current, false);
});

test("request timestamps and stable identities must be valid without requiring recent request creation", () => {
  const badTimes = [null, undefined, "bad", 123, "2026-02-31T12:00:00Z", iso(1)];
  const badIds = [null, "", "raw-call-id", "a".repeat(63), "A".repeat(64), "a".repeat(65)];
  const values = [
    ...badTimes.map((at, index) => pending(`time${index}`, { at })),
    ...badIds.map((requestId) => pending("bad-id", { requestId })),
    pending("bad-kind", { kind: "completed" }),
    pending("valid-old", { kind: "approval", at: iso(-86_400_000) }),
  ];
  const result = feed(snapshot({ nodes: [node("many", { attention: { ...node().attention, requests: values } })] }));
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].kind, "approval");
  assert.equal(result.requests[0].at, iso(-86_400_000));
  const invalidNodes = ["", " x", "x\n", "x\u0000", "x\u0080", "x\u200b", "x\ud800", "x\udfff", "x".repeat(513), "😀".repeat(129)].map((id) => node("bad", { id }));
  assert.deepEqual(feed(snapshot({ nodes: invalidNodes })).requests, []);
  assert.equal(feed(snapshot({ nodes: [node("unicode", { id: "😀".repeat(128) })] })).requests.length, 1);
  assert.deepEqual(feed(snapshot({ adapters: [source("bad\n")], nodes: [node("bad", { meta: { dataSource: "bad\n" } })] })).sources, []);
});

test("duplicate source identities fail closed and distinct request pairs remain distinct", () => {
  assert.equal(feed(snapshot({ adapters: [source(), source()] })).sources[0].current, false);
  assert.deepEqual(feed(snapshot({ adapters: [source(), source()] })).requests, []);
  const shared = pending("shared");
  const attention = { ...node().attention, requests: [shared, shared] };
  const result = feed(snapshot({ nodes: [node("one", { attention }), node("two", { attention })] }));
  assert.equal(result.requests.length, 2, "session identity is part of the notification key");
  assert.deepEqual(result.requests.map((r) => r.sessionId), ["codex:one", "codex:two"]);
});

test("any extraction or feed overflow is explicit, empty and deterministic", () => {
  const values = Array.from({ length: 1024 }, (_, index) => pending(`bounded-${index}`));
  const a = node("a", { attention: { ...node().attention, requests: values } });
  assert.equal(feed(snapshot({ nodes: [a] })).requests.length, 1024);
  for (const nodes of [
    [a, node("overflow")], [node("overflow"), a],
    [node("incomplete", { attention: { ...node().attention, requestsComplete: false } })],
    [node("oversized", { attention: { ...node().attention, requests: [...values, pending("extra")] } })],
  ]) {
    const value = feed(snapshot({ nodes }));
    assert.equal(value.truncated, true);
    assert.deepEqual(value.requests, []);
  }
});

test("reducer metadata keeps all concurrent identities and does not notify timestamp-less calls", () => {
  const call = (id, timestamp = iso(-1000)) => ({ type: "response_item", timestamp, payload: { type: "function_call", name: "functions.request_user_input_async", call_id: id } });
  const observations = [call("older"), call("newer")];
  const first = feed(snapshot({ nodes: [node("runtime", { attention: readTurnState(observations, "codex").attention })] }));
  assert.equal(first.requests.length, 2);
  const withAck = [...observations, { type: "response_item", payload: { type: "function_call_output", call_id: "newer", output: "Acknowledged" } }];
  assert.deepEqual(feed(snapshot({ nodes: [node("runtime", { attention: readTurnState(withAck, "codex").attention })] })).requests, first.requests);
  const untimed = readTurnState([call("untimed", null)], "codex", NOW).attention;
  assert.equal(untimed.requests.length, 1);
  assert.deepEqual(feed(snapshot({ nodes: [node("untimed", { attention: untimed })] })).requests, []);
});

async function http(server, { path = "/api/attention", method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.address().port, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end();
  });
}
async function serverFixture(t, collector) {
  const server = createDashboardServer(collector, {}, { now: () => NOW });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server;
}

test("HTTP attention uses one captured snapshot, stable server identity, no-store and no content", async (t) => {
  let reads = 0, healthReads = 0;
  const captured = snapshot();
  const server = await serverFixture(t, { latest() { reads++; return captured; }, health() { healthReads++; throw new Error("must not use independently changing health"); } });
  const first = await http(server);
  assert.equal(first.status, 200);
  assert.equal(first.headers["cache-control"], "no-store");
  assert.equal(first.headers["x-content-type-options"], "nosniff");
  const data = JSON.parse(first.body);
  assert.match(data.instanceId, /^[a-f0-9-]{36}$/);
  assert.equal(data.observedAt, iso());
  assert.equal(data.requests.length, 1);
  assert.equal(reads, 1);
  assert.equal(healthReads, 0);
  assert.doesNotMatch(first.body, /PRIVATE|private|reason|title|cwd|input/);
  assert.equal(JSON.parse((await http(server)).body).instanceId, data.instanceId);
  const restarted = await serverFixture(t, { latest: () => captured });
  assert.notEqual(JSON.parse((await http(restarted)).body).instanceId, data.instanceId);
});

test("HTTP attention rejects cross-site access and unsafe hosts while unavailable collection remains unknown", async (t) => {
  let reads = 0;
  const server = await serverFixture(t, { latest() { reads++; return null; }, ready() { throw new Error("must not wait for collection"); } });
  for (const headers of [
    { host: "evil.example" }, { origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" },
    { origin: "http://localhost" },
  ]) assert.equal((await http(server, { headers })).status, 403);
  assert.equal(reads, 0);
  assert.equal((await http(server, { method: "POST" })).status, 405);
  const response = await http(server, { headers: { origin: `http://127.0.0.1:${server.address().port}` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  const value = JSON.parse(response.body);
  assert.equal(value.process.current, false);
  assert.deepEqual(value.sources, []);
  assert.deepEqual(value.requests, []);
});
