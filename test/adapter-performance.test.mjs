import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createClaudeAdapter } from "../src/adapters/claude.mjs";
import { createCodexAdapter } from "../src/adapters/codex.mjs";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const jsonl = (...records) => records.map(JSON.stringify).join("\n") + "\n";
async function put(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  await utimes(path, NOW / 1000, NOW / 1000);
}

test("batched session reads preserve stable metadata and recompute live ownership on cached files", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "af-batched-adapters-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const ctx = { now: NOW, home, windowMs: 3600000, config: {}, procs: new Map(), openFileOwners: new Map() };
  const count = 24; // More sessions than one concurrent batch.
  await Promise.all(Array.from({ length: count }, async (_, i) => {
    const sid = `session-${i}`;
    const cwd = `/fixture/project-${i % 4}`;
    const pid = 1000 + i;
    ctx.procs.set(pid, { pid, agent: "claude", cwd, comm: "claude" });
    await put(join(home, ".claude", "sessions", `${pid}.json`), { pid, sessionId: sid, cwd, status: "idle" });
    await put(join(home, ".claude", "projects", `project-${i % 4}`, `${sid}.jsonl`), jsonl(
      { type: "user", cwd, timestamp: new Date(NOW).toISOString() },
      { type: "assistant", timestamp: new Date(NOW).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Fixture complete." }], stop_reason: "end_turn" } },
    ));
    const path = join(home, ".codex", "sessions", "2026", "10", "18", `rollout-${i}.jsonl`);
    await put(path, jsonl(
      { type: "session_meta", payload: { id: sid, cwd, originator: "codex_work_desktop" } },
      { type: "event_msg", payload: { type: "task_complete" }, timestamp: new Date(NOW).toISOString() },
    ));
    ctx.openFileOwners.set(path, 500);
  }));
  ctx.procs.set(500, { pid: 500, agent: "codex", comm: "codex" });
  for (const adapter of [createClaudeAdapter(), createCodexAdapter()]) {
    const first = await adapter.collect(ctx);
    assert.equal(first.nodes.length, count);
    assert.ok(first.nodes.every((n) => n.status === "idle" && n.attention?.kind === "completed"));
    for (let i = 0; i < count; i++) {
      assert.equal(first.nodes.find((n) => n.id === `${adapter.id}:session-${i}`).cwd, `/fixture/project-${i % 4}`);
    }
    assert.deepEqual(await adapter.collect(ctx), first, "concurrent completion order must not change graph order");
    const ended = await adapter.collect({ ...ctx, procs: new Map(), openFileOwners: new Map() });
    assert.equal(ended.nodes.length, count);
    assert.ok(ended.nodes.every((n) => n.status === "done" && n.pid === null), "cached file metadata cannot cache process ownership");
  }
});
