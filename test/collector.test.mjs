import assert from "node:assert/strict";
import { test } from "node:test";
import { createCollector, snapshotHealth } from "../src/collector.mjs";
import { createClaudeAdapter } from "../src/adapters/claude.mjs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const config = { home: "/synthetic", windowHours: 12, parkAfterMinutes: 120, intervalMs: 4000, adapterTimeoutMs: 30, retainStaleMs: 120_000 };
const emptyProcesses = async () => ({ procs: new Map(), openFileOwners: new Map() });
const session = () => ({ id: "fake:one", agent: "fake", kind: "session", status: "working", meta: {} });

test("collector retains failed source data, labels its age, and clears staleness on recovery", async () => {
  let now = Date.parse("2026-10-18T10:00:00Z");
  let fail = false;
  const adapter = { id: "fake", label: "Fake", collect: async () => {
    if (fail) throw new Error("fixture offline");
    return { nodes: [session()], edges: [] };
  } };
  const collector = createCollector(config, [adapter], { snapshotProcesses: emptyProcesses, now: () => now });
  const first = await collector.collectOnce();
  fail = true; now += 4000;
  const stale = await collector.collectOnce();
  assert.equal(stale.nodes.find(n => n.id === "fake:one")?.meta.dataStale, true);
  assert.equal(stale.adapters[0].lastSuccessAt, first.adapters[0].lastSuccessAt);
  assert.equal(stale.adapters[0].retained, true);
  now += 120_001;
  assert.equal((await collector.collectOnce()).nodes.length, 0, "old cached data expires");
  fail = false;
  const recovered = await collector.collectOnce();
  assert.equal(recovered.nodes[0].meta.dataStale, undefined);
  assert.equal(recovered.adapters[0].stale, false);
  assert.equal(recovered.adapters[0].error, null);
});

test("collector bounds a stuck adapter, keeps others fresh and never overlaps the stuck call", async () => {
  let release;
  let calls = 0;
  const stuck = { id: "stuck", label: "Stuck", collect: () => { calls++; return new Promise(r => { release = r; }); } };
  const good = { id: "fake", label: "Fake", collect: async () => ({ nodes: [session()], edges: [] }) };
  const collector = createCollector(config, [stuck, good], { snapshotProcesses: emptyProcesses });
  const first = await collector.collectOnce();
  assert.match(first.adapters[0].error, /timed out/i);
  assert.equal(first.adapters[1].stale, false);
  await collector.collectOnce();
  assert.equal(calls, 1, "do not pile up work behind a timed-out read");
  release({ nodes: [{ ...session(), id: "stuck:late" }], edges: [] });
  await new Promise(r => setImmediate(r));
  assert.equal(collector.latest(), null, "late calls never publish graph state");
});

test("process collection failure retains last-known sessions without inventing completion", async () => {
  let fail = false;
  let calls = 0;
  const collector = createCollector(config, [{ id: "fake", label: "Fake", collect: async () => { calls++; return { nodes: [session()], edges: [] }; } }], {
    snapshotProcesses: async () => { if (fail) throw new Error("fixture ps timeout"); return emptyProcesses(); },
  });
  await collector.collectOnce();
  fail = true;
  const stale = await collector.collectOnce();
  assert.equal(calls, 1, "adapters do not infer dead sessions from a failed process table");
  assert.equal(stale.nodes[0].status, "working");
  assert.equal(stale.nodes[0].meta.dataStale, true);
  assert.match(stale.processError, /fixture ps timeout/);
});

test("unchanged graph sends fresh health without triggering graph renders", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let now = Date.parse("2026-10-18T10:00:00Z");
  const collector = createCollector(config, [{ id: "fake", label: "Fake", collect: async () => ({ nodes: [session()], edges: [] }) }], { snapshotProcesses: emptyProcesses, now: () => now });
  let graphs = 0;
  const health = [];
  collector.events.on("snapshot", () => graphs++);
  collector.events.on("health", h => health.push(h));
  t.after(() => collector.stop());
  await collector.start();
  now += 4000; t.mock.timers.tick(4000);
  await flush();
  assert.equal(graphs, 1);
  assert.equal(health.length, 2);
  assert.equal(health[1].adapters[0].lastSuccessAt, new Date(now).toISOString());
  assert.equal(collector.health().ok, true);
  now += 12_001;
  assert.equal(collector.health().ok, false);
  assert.equal(collector.health().stale, true);
  assert.equal(collector.health().ready, true, "stale data does not prevent opening the dashboard");
});

test("health separates transport readiness, source failures and data age", () => {
  const now = Date.parse("2026-10-18T10:00:00Z");
  const snap = { generatedAt: new Date(now).toISOString(), intervalMs: 4000, collectMs: 9000, adapters: [{ id: "fake", lastSuccessAt: new Date(now).toISOString(), error: null }] };
  assert.equal(snapshotHealth(null, { now }).ready, false);
  assert.equal(snapshotHealth(snap, { now }).ok, true);
  assert.equal(snapshotHealth(snap, { now: now + 12_001 }).stale, true, "slow prior collection does not hide stale data");
  const degraded = snapshotHealth({ ...snap, adapters: [{ ...snap.adapters[0], error: "offline", retained: true }] }, { now });
  assert.equal(degraded.ready, true);
  assert.equal(degraded.ok, false);
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.adapters[0].stale, true);
});

test("real unanswered requests do not disappear into parked sessions", async () => {
  const old = "2026-10-01T10:00:00Z";
  const collector = createCollector(config, [{ id: "fake", label: "Fake", collect: async () => ({ nodes: [
    { ...session(), status: "waiting", lastActivityAt: old, attention: { kind: "question", at: old, evidence: "explicit" } },
    { ...session(), id: "fake:finished", status: "idle", lastActivityAt: old, attention: { kind: "completed", at: old, evidence: "explicit" } },
  ], edges: [] }) }], { snapshotProcesses: emptyProcesses });
  const snap = await collector.collectOnce();
  assert.equal(snap.nodes.find(n => n.id === "fake:one").status, "waiting");
  assert.equal(snap.nodes.find(n => n.id === "fake:one").meta.parked, undefined);
  assert.equal(snap.nodes.find(n => n.id === "fake:finished").meta.parked, true);
});

test("a real adapter source permission failure retains its sessions until access recovers", async (t) => {
  if (process.getuid?.() === 0 || process.platform === "win32") { t.skip("POSIX non-root permission check"); return; }
  const home = await mkdtemp(join(tmpdir(), "af-source-failure-"));
  const dir = join(home, ".claude", "projects", "fixture");
  await mkdir(dir, { recursive: true });
  const source = join(dir, "one.jsonl");
  await writeFile(source, JSON.stringify({ type: "user", cwd: "/synthetic", timestamp: new Date().toISOString(), message: { role: "user", content: "Synthetic" } }) + "\n");
  t.after(async () => { await chmod(dir, 0o700); await rm(home, { recursive: true, force: true }); });
  const collector = createCollector({ ...config, home, adapterTimeoutMs: 1000 }, [createClaudeAdapter()], { snapshotProcesses: emptyProcesses });
  assert.equal((await collector.collectOnce()).nodes.length, 1);
  await chmod(dir, 0);
  const failed = await collector.collectOnce();
  assert.match(failed.adapters[0].error, /EACCES/);
  assert.equal(failed.nodes[0].meta.dataStale, true);
  await chmod(dir, 0o700);
  const recovered = await collector.collectOnce();
  assert.equal(recovered.adapters[0].error, null);
  assert.equal(recovered.nodes[0].meta.dataStale, undefined);
});

const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };

test("live collection publishes and refreshes healthy sources while a slow source is pending", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let now = Date.parse("2026-10-18T10:00:00Z");
  let release;
  let slowCalls = 0, fastCalls = 0;
  const collector = createCollector({ ...config, intervalMs: 100, adapterTimeoutMs: 1000 }, [
    { id: "fast", label: "Fast", collect: async () => ({ nodes: [{ ...session(), title: `Revision ${++fastCalls}` }], edges: [] }) },
    { id: "slow", label: "Slow", collect: () => { slowCalls++; return new Promise(resolve => { release = resolve; }); } },
  ], { snapshotProcesses: emptyProcesses, now: () => now });
  const started = collector.start();
  t.after(async () => { collector.stop(); release?.({ nodes: [], edges: [] }); await started; });
  await flush();
  assert.equal(collector.latest()?.nodes[0]?.title, "Revision 1", "a pending source must not hold healthy data behind a barrier");
  assert.equal(collector.health().ok, false, "an unobserved source is not healthy just because another source published");
  for (let revision = 2; revision <= 3; revision++) {
    now += 100; t.mock.timers.tick(100); await flush();
    assert.equal(collector.latest().nodes[0].title, `Revision ${revision}`, "healthy sources keep their own refresh cadence");
  }
  assert.equal(slowCalls, 1, "slow reads never overlap");
  release({ nodes: [], edges: [] }); await started; await flush();
  assert.equal(collector.health().ok, true);
});

test("slow process rounds retry at completion instead of skipping the next interval", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let now = Date.parse("2026-10-18T10:00:00Z");
  let processCalls = 0, release;
  const collector = createCollector({ ...config, intervalMs: 100, processTimeoutMs: 1000 }, [], {
    now: () => now,
    snapshotProcesses: () => { processCalls++; return processCalls === 2 ? new Promise(resolve => { release = resolve; }) : emptyProcesses(); },
  });
  t.after(() => collector.stop());
  await collector.start();
  now += 100; t.mock.timers.tick(100); await flush();
  assert.equal(processCalls, 2);
  now += 150; t.mock.timers.tick(150); await flush();
  assert.equal(processCalls, 2);
  release(await emptyProcesses()); await flush();
  t.mock.timers.tick(1); await flush();
  assert.equal(processCalls, 3, "an overdue round starts promptly after the previous read finishes");
});

test("a result spanning successful process rounds keeps its original observation time", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let now = Date.parse("2026-10-18T10:00:00Z");
  const original = new Date(now).toISOString();
  let release;
  const collector = createCollector({ ...config, intervalMs: 100, adapterTimeoutMs: 30_000 }, [
    { id: "slow", label: "Slow", collect: () => new Promise(resolve => { release = resolve; }) },
  ], { snapshotProcesses: emptyProcesses, now: () => now });
  collector.start(); t.after(() => collector.stop()); await flush();
  now += 11_000; t.mock.timers.tick(100); await flush();
  release({ nodes: [session()], edges: [] }); await flush();
  const snap = collector.latest();
  assert.equal(snap.adapters[0].observedAt, original);
  assert.equal(snap.adapters[0].lastSuccessAt, new Date(now).toISOString());
  assert.equal(snap.nodes[0].meta.dataStale, true, "completion cannot freshen an old process observation");
  assert.equal(collector.health().ok, false);
});

test("process timeout cancels observation, retains working state, and prevents overlapping readers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let now = Date.parse("2026-10-18T10:00:00Z");
  let processCalls = 0, sourceCalls = 0, release, signal;
  const collector = createCollector({ ...config, intervalMs: 100, processTimeoutMs: 50 }, [
    { id: "fast", label: "Fast", collect: async () => { sourceCalls++; return { nodes: [session()], edges: [] }; } },
  ], { now: () => now, snapshotProcesses: options => {
    processCalls++;
    if (processCalls === 2) { signal = options.signal; return new Promise(resolve => { release = resolve; }); }
    return emptyProcesses();
  } });
  t.after(() => collector.stop()); await collector.start();
  now += 100; t.mock.timers.tick(100); await flush();
  now += 50; t.mock.timers.tick(50); await flush();
  assert.equal(signal.aborted, true);
  assert.match(collector.latest().processError, /timed out/);
  assert.equal(collector.latest().nodes[0].status, "working");
  assert.equal(collector.latest().nodes[0].meta.dataStale, true);
  now += 100; t.mock.timers.tick(100); await flush();
  assert.equal(processCalls, 2); assert.equal(sourceCalls, 1);
  release(await emptyProcesses()); await flush();
  now += 100; t.mock.timers.tick(100); await flush();
  assert.equal(processCalls, 3); assert.equal(sourceCalls, 2);
  assert.equal(collector.health().ok, true);
});

test("process failure and recovery invalidate older in-flight source results", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let now = Date.parse("2026-10-18T10:00:00Z");
  let processCalls = 0, sourceCalls = 0, release;
  const collector = createCollector({ ...config, intervalMs: 100, adapterTimeoutMs: 1000 }, [
    { id: "fast", label: "Fast", collect: () => {
      sourceCalls++;
      if (sourceCalls === 2) return new Promise(resolve => { release = resolve; });
      return Promise.resolve({ nodes: [{ ...session(), title: `Fresh ${sourceCalls}` }], edges: [] });
    } },
  ], { now: () => now, snapshotProcesses: async () => {
    if (++processCalls === 3) throw new Error("process fixture failed");
    return emptyProcesses();
  } });
  t.after(() => collector.stop()); await collector.start();
  for (let i = 0; i < 3; i++) { now += 100; t.mock.timers.tick(100); await flush(); }
  assert.equal(collector.latest().processError, null, "process observation recovered while old source was still reading");
  release({ nodes: [{ ...session(), title: "Invalid late result" }], edges: [] }); await flush();
  assert.equal(collector.latest().nodes[0].title, "Fresh 1");
  assert.equal(collector.latest().nodes[0].meta.dataStale, true);
  now += 100; t.mock.timers.tick(100); await flush();
  assert.equal(collector.latest().nodes[0].title, "Fresh 3");
  assert.equal(collector.health().ok, true);
});

test("retained data expires during a pending replacement and stop cancels without publishing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let now = Date.parse("2026-10-18T10:00:00Z");
  let calls = 0, release, signal;
  const collector = createCollector({ ...config, intervalMs: 100, adapterTimeoutMs: 100_000, retainStaleMs: 12_000 }, [
    { id: "fast", label: "Fast", collect: ctx => {
      if (++calls === 1) return Promise.resolve({ nodes: [session()], edges: [] });
      signal = ctx.signal; return new Promise(resolve => { release = resolve; });
    } },
  ], { snapshotProcesses: emptyProcesses, now: () => now });
  t.after(() => collector.stop()); await collector.start();
  now += 100; t.mock.timers.tick(100); await flush();
  now += 11_000; t.mock.timers.tick(100); await flush();
  assert.equal(collector.latest().nodes[0].meta.dataStale, true);
  now += 2000; t.mock.timers.tick(100); await flush();
  assert.equal(collector.latest().nodes.length, 0, "expiry does not wait for replacement to settle");
  const before = collector.latest(); let publications = 0;
  collector.events.on("snapshot", () => publications++);
  collector.events.on("health", () => publications++);
  collector.stop(); assert.equal(signal.aborted, true);
  release({ nodes: [{ ...session(), title: "After stop" }], edges: [] }); await flush();
  assert.equal(publications, 0); assert.equal(collector.latest(), before);
});

test("manual collections coalesce and timed-out late results never poison retained data", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let calls = 0, processCalls = 0, release;
  const collector = createCollector(config, [
    { id: "fast", label: "Fast", collect: () => {
      calls++;
      if (calls === 1) return new Promise(resolve => { release = resolve; });
      if (calls === 3) throw new Error("fixture offline");
      return Promise.resolve({ nodes: [{ ...session(), title: "Fresh result" }], edges: [] });
    } },
  ], { snapshotProcesses: async () => { processCalls++; return emptyProcesses(); } });
  const first = collector.collectOnce(), shared = collector.collectOnce(); await flush();
  assert.equal(calls, 1); assert.equal(processCalls, 1);
  t.mock.timers.tick(30); await flush();
  assert.equal(await first, await shared);
  release({ nodes: [{ ...session(), title: "Invalid late result" }], edges: [] }); await flush();
  assert.equal((await collector.collectOnce()).nodes[0].title, "Fresh result");
  assert.equal((await collector.collectOnce()).nodes[0].title, "Fresh result");
});

test("health uses observation age and carries safe process stage diagnostics", async () => {
  const now = Date.parse("2026-10-18T10:00:00Z");
  const fresh = new Date(now).toISOString(), old = new Date(now - 13_000).toISOString();
  const snap = { generatedAt: fresh, processObservedAt: fresh, intervalMs: 4000,
    processTimings: { tableMs: 8000, argsMs: 200, filesMs: 50 },
    adapters: [{ id: "fake", observedAt: old, lastSuccessAt: fresh }] };
  const health = snapshotHealth(snap, { now });
  assert.equal(health.ok, false); assert.equal(health.adapters[0].stale, true);
  assert.equal(health.stale, false, "one old source does not make fresh process data stale");
  assert.deepEqual(health.processTimings, snap.processTimings);
  assert.equal(snapshotHealth({ ...snap, processObservedAt: old }, { now }).stale, true);
  const failure = Object.assign(new Error("fixture command failure"), { processStage: "args", processTimings: snap.processTimings });
  const collector = createCollector(config, [], { snapshotProcesses: async () => { throw failure; } });
  const failed = await collector.collectOnce();
  assert.equal(failed.processStage, "args"); assert.deepEqual(failed.processTimings, snap.processTimings);
});
