import assert from "node:assert/strict";
import { test } from "node:test";
import * as util from "../src/util.mjs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("metadata concurrency is bounded and preserves input order", async () => {
  let active = 0;
  let maximum = 0;
  const releases = [];
  const result = util.mapConcurrent([0, 1, 2, 3, 4], 2, async (value, index) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => releases.push(resolve));
    active--;
    return `${index}:${value}`;
  });
  await tick();
  assert.equal(releases.length, 2, "only two metadata reads start before either resolves");
  releases[1]();
  await tick();
  assert.equal(releases.length, 3, "one free slot starts exactly one new read");
  releases[2]();
  await tick();
  releases[3]();
  await tick();
  releases[4]();
  releases[0]();
  assert.deepEqual(await result, ["0:0", "1:1", "2:2", "3:3", "4:4"]);
  assert.equal(maximum, 2);
});

test("metadata concurrency drains in-flight reads after a failure without starting more", async () => {
  const failure = new Error("read failed");
  let release;
  let started = 0;
  let settled = false;
  const result = util.mapConcurrent([0, 1, 2, 3], 2, async (value) => {
    started++;
    if (value === 0) throw failure;
    await new Promise((resolve) => { release = resolve; });
    return value;
  });
  const rejection = assert.rejects(result, (error) => error === failure).then(() => { settled = true; });
  await tick();
  assert.equal(started, 2);
  assert.equal(settled, false, "completion waits for the outstanding metadata read");
  release();
  await rejection;
  assert.equal(started, 2);
});

test("metadata concurrency handles empty input and rejects invalid limits", async () => {
  assert.deepEqual(await util.mapConcurrent([], 4, () => assert.fail("unexpected read")), []);
  for (const limit of [0, -1, Infinity, 1.5]) await assert.rejects(util.mapConcurrent([1], limit, () => 1), RangeError);
});

test("source helpers distinguish absent/malformed files from operational read failures", async (t) => {
  if (process.getuid?.() === 0 || process.platform === "win32") { t.skip("POSIX non-root permission check"); return; }
  const root = await mkdtemp(join(tmpdir(), "af-io-"));
  const locked = join(root, "source");
  await mkdir(locked);
  const file = join(locked, "session.jsonl");
  await writeFile(file, '{"type":"synthetic"}\n');
  t.after(async () => { await chmod(locked, 0o700); await rm(root, { recursive: true, force: true }); });
  const missing = join(root, "missing");
  assert.equal(await util.statSafe(missing), null);
  assert.equal(await util.readJson(missing), null);
  assert.deepEqual(await util.listDir(missing), []);
  assert.deepEqual(await util.readHeadRecords(missing), []);
  assert.deepEqual(await util.readTailRecords(missing, 10), []);
  await writeFile(join(root, "malformed.json"), "{");
  assert.equal(await util.readJson(join(root, "malformed.json")), null);
  await chmod(locked, 0);
  for (const read of [() => util.statSafe(file), () => util.listDir(locked), () => util.readJson(file), () => util.readHeadRecords(file), () => util.readTailRecords(file, 21)]) {
    await assert.rejects(read, e => e.code === "EACCES");
  }
});
