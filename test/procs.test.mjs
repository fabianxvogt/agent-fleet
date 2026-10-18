import assert from "node:assert/strict";
import { test } from "node:test";
import { snapshotProcesses } from "../src/procs.mjs";

const table = "10 1 00:01 /usr/bin/codex\n11 1 00:01 /usr/bin/claude\n";
const args = "10 codex\n11 claude\n";
const files = "p10\nfcwd\nn/work/fixture\nf7\nn/work/rollout.jsonl\n";
function runner({ argsError, lsofError } = {}) {
  return async (command, argv, options) => {
    assert.equal(options.timeout, 10_000, "every subprocess stays bounded");
    if (command === "ps") {
      if (argv[0] === "-axww") return { stdout: table };
      if (argsError) throw argsError;
      return { stdout: args };
    }
    assert.equal(command, "lsof");
    assert.equal(argv[argv.indexOf("-p") + 1], "10", "Claude metadata does not need lsof");
    if (lsofError) throw lsofError;
    return { stdout: files };
  };
}

test("process snapshot tolerates disappearing pids while retaining partial metadata", async () => {
  const result = await snapshotProcesses({ run: runner({
    argsError: Object.assign(new Error("a pid exited"), { code: 1, stdout: args }),
    lsofError: Object.assign(new Error("a pid exited"), { code: 1, stdout: files }),
  }) });
  assert.equal(result.procs.get(10).cwd, "/work/fixture");
  assert.equal(result.openFileOwners.get("/work/rollout.jsonl"), 10);
  assert.deepEqual(result.agentPids, [10, 11]);
});

test("collector cancellation reaches every process command", async () => {
  const { signal } = new AbortController();
  const run = runner();
  let commands = 0;
  await snapshotProcesses({ signal, run: (command, argv, options) => {
    commands++;
    assert.equal(options.signal, signal);
    return run(command, argv, options);
  } });
  assert.equal(commands, 3);
});

for (const stage of ["argsError", "lsofError"]) {
  test(`process snapshot propagates ${stage} timeout, signal, startup and hard exit failures`, async () => {
    for (const details of [
      { killed: true, signal: "SIGTERM", code: null },
      { killed: true, code: 1 },
      { signal: "SIGKILL", code: null },
      { code: "ENOENT" },
      { code: "ABORT_ERR" },
      { code: 2 },
      { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
    ]) {
      const failure = Object.assign(new Error("snapshot unavailable"), details, { stdout: stage === "argsError" ? args : files });
      await assert.rejects(snapshotProcesses({ run: runner({ [stage]: failure }) }), (error) => error === failure);
    }
  });
}

test("process timings isolate the table, argument and open-file commands", async () => {
  let time = 0;
  const run = runner();
  const result = await snapshotProcesses({ now: () => time, run: (command, argv, options) => {
    time += command === "lsof" ? 23 : argv[0] === "-axww" ? 701 : 41;
    return run(command, argv, options);
  } });
  assert.deepEqual(result.timings, { tableMs: 701, argsMs: 41, filesMs: 23 });
  assert.deepEqual(result.agentPids, [10, 11]);
  assert.equal(result.openFileOwners.get("/work/rollout.jsonl"), 10);
});

test("process timings leave skipped commands at zero", async () => {
  let time = 0;
  let calls = 0;
  const result = await snapshotProcesses({ now: () => time, run: async (command, argv) => {
    calls++;
    assert.equal(command, "ps");
    assert.equal(argv[0], "-axww");
    time += 17;
    return { stdout: "20 1 00:01 /usr/bin/other\n" };
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result.timings, { tableMs: 17, argsMs: 0, filesMs: 0 });
  assert.deepEqual(result.agentPids, []);
});

test("disappearing pids still contribute stage timings without failing the snapshot", async () => {
  let time = 0;
  const exited = Object.assign(new Error("a pid exited"), { code: 1, stdout: args });
  const run = runner({ argsError: exited });
  const result = await snapshotProcesses({ now: () => time, run: (command, argv, options) => {
    time += 5;
    return run(command, argv, options);
  } });
  assert.deepEqual(result.timings, { tableMs: 5, argsMs: 5, filesMs: 5 });
  assert.deepEqual(exited.processTimings, { tableMs: 5, argsMs: 5, filesMs: 0 }, "failure diagnostics stay a partial copy");
  assert.deepEqual(result.agentPids, [10, 11]);
});

test("process failures retain their identity and expose only stage timing metadata", async () => {
  const expected = {
    table: { tableMs: 11, argsMs: 0, filesMs: 0 },
    args: { tableMs: 11, argsMs: 19, filesMs: 0 },
    files: { tableMs: 11, argsMs: 19, filesMs: 31 },
  };
  for (const failureStage of Object.keys(expected)) {
    let time = 0;
    const failure = Object.assign(new Error("snapshot unavailable"), { code: "ABORT_ERR" });
    const run = runner();
    await assert.rejects(snapshotProcesses({ now: () => time, run: (command, argv, options) => {
      const stage = command === "lsof" ? "files" : argv[0] === "-axww" ? "table" : "args";
      time += { table: 11, args: 19, files: 31 }[stage];
      if (stage === failureStage) throw failure;
      return run(command, argv, options);
    } }), (error) => {
      assert.equal(error, failure);
      assert.equal(error.message, "snapshot unavailable");
      assert.equal(error.processStage, failureStage);
      assert.deepEqual(error.processTimings, expected[failureStage]);
      return true;
    });
  }
});

test("timing instrumentation cannot replace a frozen subprocess failure", async () => {
  const failure = Object.freeze(Object.assign(new Error("unavailable"), { code: "ENOENT" }));
  await assert.rejects(snapshotProcesses({ run: () => { throw failure; } }), (error) => error === failure);
});
