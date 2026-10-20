import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTurnState } from "../src/attention.mjs";
import { localContent } from "../src/session-content.mjs";
import { selectSessionBranch } from "../src/session-branch.mjs";
import { createDetailsService } from "../src/details.mjs";

const at = "2026-10-20T12:00:00Z";
const message = (id, parentId, text) => ({
  type: "message", id, parentId, timestamp: at,
  message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
});
const records = () => [
  message("base", null, "Initial work."),
  message("old", "base", "Would you prefer the old branch?"),
  message("current", "base", "Current output: [report](current.md)"),
];
const usage = (fields = {}) => ({ type: "model_usage", id: "late", parentId: "old", timestamp: at, ...fields });

test("late OMP usage preserves the selected branch for content, file evidence and attention", () => {
  const input = [...records(), usage({ activeLeafId: "current" })];
  const local = localContent(input, "omp");
  assert.deepEqual(local.entries.map(e => e.id), ["message:base", "message:current"]);
  assert.deepEqual(local.branch, { head: "current", ancestry: ["current", "base"] });
  assert.equal(local.entries.at(-1).artifactCandidates[0].path, "current.md");
  assert.equal(readTurnState(input, "omp").attention.kind, "completed");
});

test("a cleared OMP leaf does not resurrect the usage owner's conversation", () => {
  const input = [...records(), usage({ activeLeafId: null })];
  assert.deepEqual(localContent(input, "omp").entries, []);
  assert.equal(localContent(input, "omp").branch, undefined);
  assert.equal(readTurnState(input, "omp").phase, "unknown");
});

test("a selected leaf outside the bounded tail remains unknown instead of guessing an old branch", () => {
  const input = [...records(), usage({ activeLeafId: "outside-tail" })];
  const local = localContent(input, "omp");
  assert.deepEqual(local.entries, []);
  assert.deepEqual(local.branch, { head: "outside-tail", ancestry: [] });
  assert.equal(readTurnState(input, "omp").phase, "unknown");
});

test("ordinary usage and following entries retain normal branch selection", () => {
  const normalUsage = usage({ parentId: "current" });
  assert.equal(localContent([...records(), normalUsage], "omp").entries.at(-1).text, "Current output: [report](current.md)");
  const followed = [...records(), usage({ activeLeafId: "old" }), message("next", "current", "Next turn.")];
  assert.equal(localContent(followed, "omp").entries.at(-1).text, "Next turn.");
  assert.deepEqual(localContent(followed, "omp").branch.ancestry, ["next", "current", "base"]);
});

test("OMP-specific leaf metadata does not reinterpret other runtimes or unbranched legacy records", () => {
  const input = [...records(), usage({ activeLeafId: "current" })];
  for (const agent of ["pi", "fleet"]) {
    assert.match(localContent(input, agent).entries.at(-1).text, /old branch/);
  }
  const legacy = [{ type: "message", message: { role: "assistant", content: "Legacy output." } }];
  assert.equal(localContent(legacy, "omp").entries[0].text, "Legacy output.");
});

test("duplicate IDs retain only the canonical selected record, never superseded branch evidence", () => {
  const superseded = {
    type: "custom_message", id: "dup", parentId: "base", timestamp: at,
    customType: "irc:incoming", content: "Obsolete report",
    details: { id: "old-report", from: "Worker", wakeRelay: true },
  };
  const current = message("dup", "base", "Replacement output.");
  const input = [message("base", null, "Initial work."), superseded, current];
  for (const agent of ["omp", "pi", "fleet"]) {
    const selected = selectSessionBranch(input, agent);
    assert.deepEqual(selected.records, [input[0], current]);
    assert.equal(selected.records.includes(superseded), false);
    assert.deepEqual(localContent(input, agent).entries.map(entry => entry.text), ["Initial work.", "Replacement output."]);
  }
});

test("source rewrites revoke retained file associations even when the previous head is still an ancestor", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-fleet-branch-files-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cwd = join(home, "workspace");
  const dir = join(home, ".omp", "agent", "sessions");
  await mkdir(cwd);
  await mkdir(dir, { recursive: true });
  await writeFile(join(cwd, "old.md"), "Old branch file.");
  const source = join(dir, "synthetic.jsonl");
  const encode = (rows) => rows.map(JSON.stringify).join("\n") + "\n";
  await writeFile(source, encode([message("a", null, "[Old file](old.md)"), message("b", "a", "Previous head.")]));
  const service = createDetailsService({ home });
  const node = { id: "omp:branch-files", agent: "omp", kind: "session", cwd, source };
  const first = await service.get(node);
  assert.equal(first.artifacts.length, 1);
  const fileId = first.artifacts[0].id;
  await appendFile(source, encode([message("usage-like-append", "b", "Ordinary append.")]));
  const appended = await service.get(node);
  assert.equal(appended.local.revision, first.local.revision);
  assert.equal(appended.artifacts[0].id, fileId);
  await writeFile(source, encode([
    message("b", null, "Previous head."),
    message("usage-like-append", "b", "Ordinary append."),
    message("c", "usage-like-append", "A longer replacement branch. ".repeat(80)),
  ]));
  const replaced = await service.get(node);
  assert.notEqual(replaced.local.revision, first.local.revision);
  assert.deepEqual(replaced.artifacts, []);
  assert.equal((await service.artifact(node, fileId)).state, "expired");
});
