import assert from "node:assert/strict";
import { test } from "node:test";
import { archiveContent, localContent, safeText } from "../src/session-content.mjs";
import { mergeContent } from "../ui/inspector.js";

const T = "2026-10-16T12:00:00Z";
const codex = (payload) => ({ type: "response_item", timestamp: T, payload });

test("Claude content separates messages, tool results, and private thinking", () => {
  const { entries, activity } = localContent([
    { type: "user", timestamp: T, message: { content: "Please run the tests." } },
    { type: "assistant", timestamp: T, message: { content: [{ type: "thinking", thinking: "hidden reasoning" }, { type: "text", text: "I will check." }, { type: "tool_use", id: "call-1", name: "Bash", input: { command: "npm test" } }] } },
    { type: "user", timestamp: T, message: { content: [{ type: "tool_result", tool_use_id: "call-1", content: "23 tests passed", is_error: false }] } },
    { type: "assistant", timestamp: T, message: { content: [{ type: "text", text: "All tests pass." }], stop_reason: "end_turn" } },
  ], "claude");
  assert.deepEqual(entries.map((e) => e.kind), ["message", "message", "tool", "message"]);
  assert.equal(entries[2].text, "23 tests passed");
  assert.equal(entries[2].status, "completed");
  assert.equal(entries[3].final, true);
  assert.equal(activity.label, "Posted a response");
  assert.ok(!JSON.stringify(entries).includes("hidden reasoning"));
});

test("Codex handles function/custom tools, deduplicates event copies and ignores reasoning", () => {
  const { entries, activity } = localContent([
    codex({ type: "message", role: "user", content: [{ type: "input_text", text: "Build it" }] }),
    { type: "event_msg", timestamp: T, payload: { type: "user_message", message: "Build it" } },
    codex({ type: "reasoning", summary: [{ text: "private reasoning" }] }),
    codex({ type: "message", role: "assistant", channel: "analysis", content: [{ type: "output_text", text: "private analysis" }] }),
    codex({ type: "function_call", name: "exec_command", call_id: "a", arguments: '{"cmd":"npm test"}' }),
    codex({ type: "function_call_output", call_id: "a", output: "Chunk ID: failed\nWall time: 0.1 seconds\nProcess exited with code 1\nFinal output:\nFailed test" }),
    codex({ type: "custom_tool_call", name: "apply_patch", call_id: "b", input: "A safe patch" }),
    codex({ type: "custom_tool_call_output", call_id: "b", output: "Applied" }),
    codex({ type: "message", role: "assistant", phase: "final", content: [{ type: "output_text", text: "Fixed." }] }),
    { type: "event_msg", timestamp: T, payload: { type: "task_complete" } },
  ], "codex");
  assert.equal(entries.length, 4);
  assert.equal(entries[1].status, "failed");
  assert.equal(entries[2].text, "Applied");
  assert.equal(entries[3].final, true);
  assert.equal(activity.label, "Turn finished");
  assert.ok(!JSON.stringify(entries).includes("private reasoning"));
  assert.ok(!JSON.stringify(entries).includes("private analysis"));
});

test("Pi, OMP and fleet logs show only the active branch and text results", () => {
  for (const agent of ["pi", "omp", "fleet"]) {
    const r = localContent([
      { type: "message", id: "a", parentId: null, timestamp: T, message: { role: "user", content: "Start" } },
      { type: "message", id: "abandoned", parentId: "a", timestamp: T, message: { role: "assistant", content: [{ type: "text", text: "Discarded branch" }] } },
      { type: "message", id: "b", parentId: "a", timestamp: T, message: { role: "assistant", content: [{ type: "toolCall", id: "t", name: "write", arguments: { path: "demo.txt" } }] } },
      { type: "message", id: "c", parentId: "b", timestamp: T, message: { role: "toolResult", toolCallId: "t", content: [{ type: "text", text: "Written" }], isError: false } },
    ], agent);
    assert.equal(r.entries.length, 2);
    assert.equal(r.entries[1].text, "Written");
    assert.ok(!JSON.stringify(r).includes("Discarded branch"));
  }
});

test("archive normalization excludes thinking/system and carries tool output", () => {
  const entries = archiveContent([
    { ordinal: 3, role: "assistant", timestamp: T, content: "Done", thinking_text: "not shown", tool_calls: [{ tool_use_id: "x", tool_name: "read", input_json: "{}", result_content: "file content" }] },
    { ordinal: 1, role: "user", timestamp: T, content: "Question" },
    { ordinal: 0, role: "user", is_system: true, content: "hidden instructions" },
  ]);
  assert.equal(entries[0].text, "Question");
  assert.equal(entries[2].text, "file content");
  assert.ok(!JSON.stringify(entries).includes("not shown"));
  assert.ok(!JSON.stringify(entries).includes("hidden instructions"));
});

test("archive/live merge preserves repeat messages, chronology and tool identity", () => {
  const old = archiveContent([
    { ordinal: 4, role: "user", timestamp: T, content: "Again" },
    { ordinal: 5, role: "assistant", timestamp: T, content: "", tool_calls: [{ tool_use_id: "x", tool_name: "Bash", input_json: "npm test", result_content: "passed" }] },
  ]);
  const recent = localContent([
    codex({ type: "message", role: "user", content: [{ type: "input_text", text: "Again" }] }),
    codex({ type: "function_call_output", call_id: "x", output: "passed" }),
    { type: "response_item", timestamp: "2026-10-16T12:05:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Again" }] } },
  ], "codex").entries;
  const merged = mergeContent(old, recent);
  assert.equal(merged.length, 3);
  assert.equal(merged[1].name, "Bash");
  assert.equal(merged[1].input, "npm test");
  const earlier = { ...recent[0], id: "earlier", text: "Before", at: "2026-10-16T11:00:00Z" };
  assert.equal(mergeContent(old, [earlier])[0].text, "Before");
});

test("text limits, credential redaction and non-text outputs are bounded", () => {
  assert.ok(safeText("x".repeat(30000)).length < 17000);
  assert.ok(!safeText('API_KEY="test-sensitive-value"').includes("test-sensitive-value"));
  assert.ok(!safeText('{"API_KEY":"test-sensitive-value"}').includes("test-sensitive-value"));
  assert.ok(!safeText('{"Authorization":"Bearer test-sensitive-value"}').includes("test-sensitive-value"));
  assert.ok(!safeText("Authorization: Bearer sensitive-token").includes("sensitive-token"));
  const { entries } = localContent([codex({ type: "function_call_output", call_id: "image", output: JSON.stringify({ content: [{ type: "image", data: "base64-not-for-display" }] }) })], "codex");
  assert.equal(entries[0].text, "[Non-text output]");
});

test("streamed messages keep stable identities while their text grows", () => {
  const first = localContent([codex({ type: "message", id: "reply", role: "assistant", content: [{ type: "output_text", text: "First" }] })], "codex");
  const next = localContent([codex({ type: "message", id: "reply", role: "assistant", content: [{ type: "output_text", text: "First and second" }] })], "codex");
  assert.equal(mergeContent(first.entries, next.entries).length, 1);
  assert.equal(mergeContent(first.entries, next.entries)[0].text, "First and second");
  const a = archiveContent([{ ordinal: 1, role: "assistant", content: "First" }]);
  const b = archiveContent([{ ordinal: 1, role: "assistant", content: "First and second" }]);
  assert.equal(a[0].id, b[0].id);
});

test("terminal evidence tracks Codex execution and continuations without merging tool entries", () => {
  const run = (sessionId, output = "") => ({ output, session_id: sessionId, wall_time_seconds: 1 });
  const records = [
    codex({ type: "function_call", name: "functions.exec_command", call_id: "exec", arguments: JSON.stringify({ cmd: "npm test", workdir: "/demo/project" }) }),
    codex({ type: "function_call_output", call_id: "exec", output: run(42, "Starting tests") }),
    codex({ type: "function_call", name: "functions.write_stdin", call_id: "poll", arguments: '{"session_id":42,"chars":""}' }),
    codex({ type: "function_call_output", call_id: "poll", output: JSON.stringify(run(42, "12 tests passed")) }),
    codex({ type: "function_call", name: "write_stdin", call_id: "end", arguments: '{"session_id":42}' }),
    codex({ type: "function_call_output", call_id: "end", output: { output: "13 tests passed", exit_code: 0, wall_time_seconds: 0.1 } }),
  ];
  const pending = localContent(records.slice(0, 1), "codex").entries[0];
  assert.deepEqual(pending.terminal, { command: "npm test", cwd: "/demo/project", state: "pending", exitCode: null, sessionId: null });
  const entries = localContent(records, "codex").entries;
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.id), ["tool:exec", "tool:poll", "tool:end"]);
  assert.deepEqual(entries.map((e) => e.terminal.state), ["running", "running", "exited"]);
  for (const entry of entries) {
    assert.equal(entry.terminal.command, "npm test");
    assert.equal(entry.terminal.cwd, "/demo/project");
    assert.equal(entry.terminal.sessionId, "42");
    assert.equal(entry.resultAt, "2026-10-16T12:00:00.000Z");
  }
  assert.equal(entries[2].terminal.exitCode, 0);
  assert.match(entries[1].text, /12 tests passed/);
  assert.equal(localContent(records.slice(0, 3), "codex").entries[1].terminal.state, "pending");
});

test("terminal evidence accepts runner envelopes without treating stdout phrases as execution state", () => {
  const outputs = [
    "Chunk ID: abcd12\nWall time: 1.0000 seconds\nProcess running with session ID 77\nOriginal token count: 4\nOutput:\nWorking",
    "Chunk ID: aabbcc\nWall time: 0.003 seconds\nProcess exited with code 7\nFinal output:\nFailed",
    "Tests say: Process running with session ID 77",
    "Process exited with code 9\nThis is arbitrary stdout",
    "Chunk ID: aabbcc\nWall time: 0.003 seconds\nProcess exited with code 0\nFinal output:\nProcess running with session ID 99",
    '{"output":"still a printed object","session_id":12}',
    { output: "not validated", session_id: 14, wall_time_seconds: "bad" },
  ];
  const entries = localContent(outputs.flatMap((output, index) => [
    codex({ type: "function_call", name: "exec_command", call_id: `t${index}`, arguments: '{"cmd":"run"}' }),
    codex({ type: "function_call_output", call_id: `t${index}`, output }),
  ]), "codex").entries;
  assert.deepEqual(entries.map((e) => e.terminal.state), ["running", "exited", "unknown", "unknown", "exited", "unknown", "unknown"]);
  assert.equal(entries[0].terminal.sessionId, "77");
  assert.equal(entries[1].terminal.exitCode, 7);
  assert.equal(entries[1].status, "failed");
  assert.equal(entries[4].terminal.sessionId, null);
  assert.equal(entries[4].terminal.exitCode, 0);
  assert.equal(entries[3].status, "completed", "a quoted exit phrase is not proof of failure");
  assert.equal(entries[4].status, "completed", "stdout cannot contradict the runner's exit code");
});

test("Claude and Pi shell results complete synchronous commands and redact terminal fields", () => {
  const claude = localContent([
    { type: "assistant", timestamp: T, message: { content: [{ type: "tool_use", id: "bash", name: "Bash", input: { command: 'API_KEY="test-sensitive-value" printf "<script>safe text</script>"', cwd: "/demo" } }] } },
    { type: "user", timestamp: T, message: { content: [{ type: "tool_result", tool_use_id: "bash", content: "Process running with session ID 999\npassword=output-secret", is_error: true }] } },
  ], "claude").entries[0];
  assert.equal(claude.terminal.state, "exited");
  assert.equal(claude.terminal.exitCode, null);
  assert.equal(claude.terminal.sessionId, null);
  assert.equal(claude.status, "failed");
  assert.match(claude.terminal.command, /<script>safe text<\/script>/);
  assert.ok(!JSON.stringify(claude).includes("test-sensitive-value"));
  assert.ok(!JSON.stringify(claude).includes("output-secret"));
  const pi = localContent([
    { type: "message", timestamp: T, message: { role: "assistant", content: [{ type: "toolCall", id: "p", name: "bash", arguments: { command: "pwd", cwd: "/demo/pi" } }] } },
    { type: "message", timestamp: T, message: { role: "toolResult", toolCallId: "p", content: [{ type: "text", text: "/demo/pi" }] } },
  ], "pi").entries[0];
  assert.deepEqual(pi.terminal, { command: "pwd", cwd: "/demo/pi", state: "exited", exitCode: null, sessionId: null });
});

test("terminal evidence uses exact known input fields and handles orphan continuations safely", () => {
  const entries = localContent([
    codex({ type: "function_call", name: "mcp__runner__shell_command", call_id: "shell", arguments: '{"command":"pwd","workdir":"/demo"}' }),
    codex({ type: "function_call", name: "functions.exec", call_id: "orchestration", arguments: 'await tools.exec_command({cmd:"pwd"})' }),
    codex({ type: "function_call", name: "not_exec_command", call_id: "unknown", arguments: '{"cmd":"pwd"}' }),
    codex({ type: "function_call", name: "Bash", call_id: "raw", arguments: "pwd" }),
    codex({ type: "function_call", name: "write_stdin", call_id: "orphan", arguments: '{"session_id":37,"command":"do not invent","cwd":"/wrong"}' }),
    codex({ type: "function_call_output", call_id: "orphan", output: { output: "finished", exit_code: 2, wall_time_seconds: 0 } }),
    codex({ type: "function_call_output", call_id: "without-call", output: { output: "finished", session_id: 31, wall_time_seconds: 1 } }),
  ], "codex").entries;
  assert.deepEqual(entries[0].terminal, { command: "pwd", cwd: "/demo", state: "pending", exitCode: null, sessionId: null });
  assert.equal(entries[1].terminal, undefined);
  assert.equal(entries[2].terminal, undefined);
  assert.equal(entries[3].terminal.command, null);
  assert.deepEqual(entries[4].terminal, { command: null, cwd: null, state: "exited", exitCode: 2, sessionId: "37" });
  assert.equal(entries[4].status, "failed");
  assert.equal(entries[5].terminal, undefined);
});

test("archive terminal evidence preserves unavailable result times and only knows explicit completion", () => {
  const entries = archiveContent([
    { ordinal: 1, role: "assistant", tool_calls: [{ tool_use_id: "a", tool_name: "Bash", input_json: '{"command":"pwd"}', result_content: "done" }] },
    { ordinal: 2, role: "assistant", timestamp: T, tool_calls: [{ tool_use_id: "b", tool_name: "exec_command", input_json: '{"cmd":"run"}', result_content: "Chunk ID: abc\nWall time: 0.1 seconds\nProcess exited with code 4\nFinal output:\nFailure" }] },
    { ordinal: 3, role: "assistant", tool_calls: [{ tool_use_id: "c", tool_name: "exec_command", input_json: '{"cmd":"pending"}' }] },
  ]);
  assert.equal(entries[0].at, null);
  assert.equal(entries[0].resultAt, null);
  assert.equal(entries[0].terminal.state, "exited");
  assert.equal(entries[1].resultAt, null);
  assert.equal(entries[1].terminal.exitCode, 4);
  assert.equal(entries[1].status, "failed");
  assert.equal(entries[2].terminal.state, "pending");
  assert.ok(!entries[2].resultAt);
});

test("terminal evidence remains bounded and background Bash returns do not imply command completion", () => {
  const records = [];
  for (let id = 1; id <= 129; id++) {
    records.push(
      codex({ type: "function_call", name: "exec_command", call_id: `c${id}`, arguments: JSON.stringify({ cmd: `command ${id}` }) }),
      codex({ type: "function_call_output", call_id: `c${id}`, output: { output: "", session_id: id, wall_time_seconds: 1 } }),
    );
  }
  records.push(codex({ type: "function_call", name: "write_stdin", call_id: "old", arguments: '{"session_id":1}' }));
  records.push(codex({ type: "function_call", name: "write_stdin", call_id: "recent", arguments: '{"session_id":129}' }));
  const entries = localContent(records, "codex").entries;
  assert.equal(entries.length, 120);
  assert.equal(entries.at(-2).terminal.command, null);
  assert.equal(entries.at(-1).terminal.command, "command 129");
  const background = localContent([
    codex({ type: "function_call", name: "Bash", call_id: "background", arguments: JSON.stringify({ command: "x".repeat(9000), run_in_background: true }) }),
    codex({ type: "function_call_output", call_id: "background", output: "Background task started" }),
  ], "codex").entries[0];
  assert.equal(background.terminal.state, "unknown");
  assert.ok(background.terminal.command.length < 8100);
});

test("terminal credential redaction handles quoted values and JSON-escaped shell commands", () => {
  for (const input of [
    'PASSWORD="synthetic secret with spaces"',
    'PASSWORD="synthetic secret with spaces',
    "PASSWORD='synthetic secret with spaces'",
    String.raw`PASSWORD=\"synthetic secret with spaces`,
    'PASSWORD="synthetic \\"secret with spaces"',
    JSON.stringify({ command: 'API_KEY="synthetic secret with spaces" run-tests' }),
    JSON.stringify({ command: 'API_KEY="synthetic \\"secret with spaces" run-tests' }),
    JSON.stringify({ command: "PASSWORD='synthetic secret with spaces' run-tests" }),
  ]) {
    const redacted = safeText(input);
    assert.ok(!redacted.includes("synthetic"));
    assert.ok(!redacted.includes("with spaces"));
    assert.match(redacted, /\[redacted\]/);
  }
  const command = 'API_KEY="synthetic secret" run-tests';
  assert.equal(JSON.parse(safeText({ command })).command, 'API_KEY="[redacted]" run-tests');
});
