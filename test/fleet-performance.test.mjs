import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFleetAdapter } from "../src/adapters/fleet.mjs";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const context = (root, procs = []) => ({ now: NOW, windowMs: 3600000, procs: new Map(procs.map((p) => [p.pid, p])), config: { fleetRoots: [root], fleetScanDepth: 4 } });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "af-fleet-performance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function putRun(cwd, ids = ["worker"]) {
  const run = join(cwd, ".fleet", "run");
  await mkdir(run, { recursive: true });
  await writeFile(join(run, "state.json"), JSON.stringify({ fleet_name: "fixture", status: "running", pid: 10, heartbeat_at: new Date(NOW).toISOString(), nodes: Object.fromEntries(ids.map((id) => [id, { status: "running" }])) }));
  await writeFile(join(run, "fleet.json"), JSON.stringify({ workers: ids.map((id) => ({ id })) }));
  return run;
}

test("fleet discovery excludes private personal-data trees and live cwd probes", async (t) => {
  const root = await fixture(t);
  await putRun(join(root, "body-os", "engine"));
  for (const name of ["me", "people", "household"]) await putRun(join(root, "body-os", name));
  const cwd = join(root, "body-os", "me");
  const result = await createFleetAdapter().collect(context(root, [{ pid: 10, agent: "pi", cwd }]));
  assert.equal(result.nodes.filter((n) => n.kind === "fleet").length, 1);
  assert.ok(result.nodes.every((n) => n.cwd === join(root, "body-os", "engine")));
  assert.deepEqual((await createFleetAdapter().collect(context(cwd))).nodes, [], "explicit roots also respect the exclusion");
});

test("many fleet workers keep newest transcripts and fresh controller/heartbeat status", async (t) => {
  const root = await fixture(t);
  const ids = Array.from({ length: 40 }, (_, i) => `worker-${i}`);
  const run = await putRun(join(root, "project"), ids);
  await Promise.all(ids.map(async (id) => {
    const dir = join(run, "workers", id);
    await mkdir(dir, { recursive: true });
    for (const [name, time] of [["old.jsonl", NOW - 10000], ["latest.jsonl", NOW - 1000]]) {
      await writeFile(join(dir, name), "{}\n");
      await utimes(join(dir, name), time / 1000, time / 1000);
    }
  }));
  const adapter = createFleetAdapter();
  const live = context(root, [{ pid: 10, agent: "pi", cwd: null }]);
  const result = await adapter.collect(live);
  assert.equal(result.nodes.length, 41);
  assert.equal(result.edges.length, 40);
  assert.ok(result.nodes.every((n) => n.status === "working"));
  assert.ok(result.nodes.filter((n) => n.kind === "worker").every((n) => n.source.endsWith("/latest.jsonl")));
  const gone = await adapter.collect(context(root));
  assert.ok(gone.nodes.every((n) => n.status === "stale"), "an unchanged file cannot cache a dead controller as alive");
  const late = await adapter.collect({ ...live, now: NOW + 180000 });
  assert.ok(late.nodes.every((n) => n.status === "stale"), "unchanged heartbeat ages on every refresh");
});
