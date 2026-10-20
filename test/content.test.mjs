import assert from "node:assert/strict";
import { test } from "node:test";
import { archiveContent, localContent, safeText } from "../src/session-content.mjs";
import { mergeContent } from "../ui/inspector.js";

const T = "2026-10-16T12:00:00Z";
const codex = (payload) => ({ type: "response_item", timestamp: T, payload });

const notification = (status, summary, ids = ["task-example"]) =>
  `<task-notification>\n${ids.map((id) => `<task-id>${id}</task-id>`).join("\n")}\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;
const claudeMessage = (content, role = "user") => ({ type: role, timestamp: T, message: { role, content } });

test("Claude runtime notifications become readable notices without implying confirmed completion", () => {
  const raw = notification("stopped", "4 background shell command tasks didn't finish before the previous session ended. Task ids: task-a, task-b, task-c, task-d.", ["task-a", "task-b", "task-c", "task-d", "__orphan_summary__:shell"])
    .replace("</task-notification>", "<note>No completion record was found. Internal scan markers are not tasks.</note>\n</task-notification>");
  const { entries, activity } = localContent([claudeMessage(raw)], "claude");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "notice");
  assert.equal(entries[0].label, "Background commands stopped");
  assert.equal(entries[0].text, "4 background commands were marked stopped after the previous session ended. Completion was not confirmed.");
  assert.equal(entries[0].noticeStatus, "stopped");
  assert.equal(entries[0].role, undefined);
  assert.equal(entries[0].final, undefined);
  assert.equal(entries[0].artifactCandidates, undefined);
  assert.deepEqual(activity, { kind: "notice", label: entries[0].label, detail: entries[0].text, at: entries[0].at, status: "stopped", noticeStatus: "stopped" });
  assert.doesNotMatch(JSON.stringify({ entries, activity }), /task-[abcd]|orphan_summary|task-notification|<status>|scan marker/i);
});

test("Claude notices preserve recorded status and sanitize summaries, IDs, and credentials", () => {
  for (const [status, label] of [
    ["completed", "Background task completed"], ["failed", "Background task failed"],
    ["stopped", "Background task stopped"], ["running", "Background task running"],
    ["pending", "Background task queued"], ["queued", "Background task queued"],
    ["unrecognized", "Background task update"], ["constructor", "Background task update"], ["__proto__", "Background task update"],
  ]) {
    const raw = notification(status, "Build task-example: ready &amp; available. API_KEY=synthetic-secret Task ids: task-example.");
    const { entries } = localContent([claudeMessage(raw, "assistant")], "claude");
    assert.equal(entries[0].kind, "notice");
    assert.equal(entries[0].label, label);
    assert.match(entries[0].text, /ready & available/);
    assert.doesNotMatch(entries[0].text, /task-example|Task ids|synthetic-secret|<|&amp;/);
    assert.equal(entries[0].artifactCandidates, undefined);
    assert.equal(entries[0].noticeStatus, status === "queued" ? "pending" : ["unrecognized", "constructor", "__proto__"].includes(status) ? "unknown" : status);
  }
});

test("ordinary questions and other agent messages remain conversation, not runtime notices", () => {
  const wrapper = notification("completed", "A background check finished.");
  for (const content of ["Should I stop the background task?", `Can you explain this?\n${wrapper}`, `\`\`\`xml\n${wrapper}\n\`\`\``]) {
    const entry = localContent([claudeMessage(content)], "claude").entries[0];
    assert.equal(entry.kind, "message");
    assert.equal(entry.role, "user");
    assert.equal(entry.text, content);
  }
  assert.equal(localContent([claudeMessage(wrapper)], "pi").entries[0].kind, "message");
  assert.equal(archiveContent([{ ordinal: 2, role: "user", content: wrapper }], "codex")[0].kind, "message");
  assert.equal(archiveContent([{ ordinal: 2, role: "user", content: wrapper }])[0].kind, "message");
});

test("questions between separate notification envelopes remain intact in local and archive messages", () => {
  const first = notification("completed", "The first background check finished.");
  const second = notification("failed", "The second background check failed.");
  for (const between of ["Please compare these two task results and explain the difference.", ""]) {
    const content = `${first}\n${between}\n${second}`;
    const local = localContent([claudeMessage(content)], "claude");
    const archived = archiveContent([{ ordinal: 1, role: "user", timestamp: T, content }], "claude");
    for (const entry of [local.entries[0], archived[0]]) {
      assert.equal(entry.kind, "message");
      assert.equal(entry.role, "user");
      assert.equal(entry.text, content);
    }
    assert.equal(local.activity.label, "Received a message");
  }
});

test("archive Claude notices share readable normalization and exclude system or thinking content", () => {
  const raw = notification("failed", "The background build reported an error.");
  const entries = archiveContent([
    { ordinal: 1, role: "user", timestamp: T, content: raw },
    { ordinal: 2, role: "system", content: raw },
    { ordinal: 3, role: "user", is_system: true, content: raw },
    { ordinal: 4, role: "assistant", thinking_text: raw, content: "" },
  ], "claude");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "notice");
  assert.equal(entries[0].id, "archive-notice:1");
  assert.equal(entries[0].label, "Background task failed");
  assert.equal(entries[0].ordinal, 1);
  assert.equal(localContent([claudeMessage(raw, "system"), { type: "assistant", message: { content: [{ type: "thinking", thinking: raw }] } }], "claude").entries.length, 0);
});

test("malformed or hostile full runtime wrappers never expose XML or become artifacts", () => {
  for (const raw of [
    notification("completed", "<script>unsafe()</script>"),
    notification("completed", notification("failed", "Nested wrappers are not a flat runtime notice.")),
    notification("completed", "Done").replace("<status>", "<status>failed</status><status>"),
    notification("completed", "Done").replace("<summary>Done</summary>", ""),
    notification("completed", "Done").replace("</task-notification>", "<!DOCTYPE x SYSTEM 'file:///private/data'></task-notification>"),
    notification("completed", "x".repeat(100_000)),
  ]) {
    const entry = localContent([claudeMessage(raw)], "claude").entries[0];
    assert.equal(entry.kind, "notice");
    assert.equal(entry.noticeStatus, "unknown");
    assert.equal(entry.label, "Background task update");
    assert.equal(entry.text, "A background task update was recorded. No readable summary is available.");
    assert.equal(entry.artifactCandidates, undefined);
  }
  const entry = localContent([claudeMessage(notification("completed", "[Result](output/report.md)"), "assistant")], "claude").entries[0];
  assert.equal(entry.kind, "notice");
  assert.equal(entry.artifactCandidates, undefined);
  assert.equal(localContent([claudeMessage(notification("completed", "x".repeat(2000)))], "claude").entries[0].text.length < 1100, true);
});

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

test("assistant artifact links retain local destinations before transcript truncation", () => {
  const text = [
    "[Plain](/demo/result.txt)",
    "![Plot](images/chart.png)",
    "[With spaces](</demo/My Report.md:12>)",
    String.raw`[Escaped](images/chart\(draft\)\[v2\].png)`,
    "[Encoded](outputs/My%20Report.pdf \"Report title\")",
    "[Nested](outputs/chart(v2).png)",
    "[Section](notes.md#results)",
    "[Duplicate](/demo/result.txt)",
    "x".repeat(17000),
    "[After display truncation](late.txt)",
  ].join("\n");
  const entry = localContent([codex({ type: "message", role: "assistant", content: [{ type: "output_text", text }] })], "codex").entries[0];
  assert.ok(!entry.text.includes("late.txt"));
  assert.deepEqual(entry.artifactCandidates, [
    { path: "/demo/result.txt", kind: "linked" },
    { path: "images/chart.png", kind: "linked" },
    { path: "/demo/My Report.md", kind: "linked" },
    { path: "images/chart(draft)[v2].png", kind: "linked" },
    { path: "outputs/My Report.pdf", kind: "linked" },
    { path: "outputs/chart(v2).png", kind: "linked" },
    { path: "notes.md", kind: "linked" },
    { path: "late.txt", kind: "linked" },
  ]);
  const distinct = localContent(["first.txt", "second.txt"].map((path) => codex({
    type: "message", role: "assistant", content: [{ type: "output_text", text: `${"x".repeat(17000)}\n[File](${path})` }],
  })), "codex").entries;
  assert.equal(distinct.length, 2, "links beyond display truncation must not collapse distinct messages");
  assert.notEqual(distinct[0].id, distinct[1].id);
});

test("artifact associations exclude code examples, remote links, user text and reasoning", () => {
  const text = [
    "`[Inline](inline.txt)`",
    "`` `[Nested tick](nested.txt)` ``",
    "```md", "[Fence](fence.txt)", "```",
    "~~~~", "![Other fence](fenced.png)", "~~~", "[Still fenced](still.txt)", "~~~~",
    "    [Indented example](indented.txt)",
    "> ```md", "> [Quoted example](quoted.txt)", "> ```",
    String.raw`\[Escaped bracket](escaped.txt)`,
    "[Remote](https://example.test/report.pdf)",
    "[File URL](file:///demo/file.txt)",
    "[Protocol relative](//example.test/file.txt)",
    "[Fragment](#heading)",
    "[Mail](mailto:person@example.test)",
    "[Encoded remote](https%3A%2F%2Fexample.test%2Fsecret.txt)",
    "[Reference][report]", "[report]: reference.txt",
    "/demo/bare.txt",
    "[Actual](actual.txt)",
  ].join("\n");
  const entries = localContent([
    codex({ type: "message", role: "user", content: [{ type: "input_text", text: "[User](user.txt)" }] }),
    codex({ type: "message", role: "assistant", channel: "analysis", content: [{ type: "output_text", text: "[Reasoning](reasoning.txt)" }] }),
    codex({ type: "message", role: "assistant", content: [{ type: "output_text", text }] }),
  ], "codex").entries;
  assert.equal(entries[0].artifactCandidates, undefined);
  assert.deepEqual(entries[1].artifactCandidates, [{ path: "actual.txt", kind: "linked" }]);
});

test("list fences and raw HTML code examples do not create artifact associations", () => {
  for (const example of [
    "1. ```md\n   [Example](example.txt)\n   ```",
    "- ~~~~md\n  [Example](example.txt)\n  ~~~~",
    "> 1. ```md\n>    [Example](example.txt)\n>    ```",
    "   - ```md\n     [Example](example.txt)\n     ```",
    "<pre><code>[Example](example.txt)</code></pre>",
    "Here is <code class=\"sample\">[Example](example.txt)</code>.",
    "<PRE>\n[Example](example.txt)\n</PRE>",
    "<!-- [Example](example.txt) -->",
    "<script>[Example](example.txt)</script>",
    "<textarea>[Example](example.txt)</textarea>",
  ]) {
    const entries = localContent([codex({ type: "message", role: "assistant", content: [{ type: "output_text", text: `${example}\n\n[Actual](actual.txt)` }] })], "codex").entries;
    assert.deepEqual(entries[0].artifactCandidates, [{ path: "actual.txt", kind: "linked" }], example);
  }
});

test("artifact candidates are unique and bounded without accepting malformed paths or link syntax", () => {
  const hostile = [
    "[Huge](" + "x".repeat(4097) + ")",
    "[Control](bad%00.txt)", "[Bad encoding](bad%QZ.txt)",
    "[Encoded scheme](file%3Asecret.txt)",
    "[Secret](<API_KEY=synthetic-secret>)",
    "[Unclosed](<invalid.txt)",
    "[Wrong title](wrong.txt unexpected)",
    "[Unescaped spaces](wrong file.txt)",
    "[Multiline](wrong\nfile.txt)",
    "[Not a link] (space.txt)",
  ].join("\n");
  const entry = localContent([codex({ type: "message", role: "assistant", content: [{ type: "output_text", text: hostile + "\n" + Array.from({ length: 40 }, (_, i) => `[A](file-${i}.txt) [B](file-${i}.txt)`).join("\n") }] })], "codex").entries[0];
  assert.equal(entry.artifactCandidates.length, 32);
  assert.deepEqual(entry.artifactCandidates.map((c) => c.path), Array.from({ length: 32 }, (_, i) => `file-${i}.txt`));
  assert.ok(!JSON.stringify(entry).includes("synthetic-secret"));
});

test("successful Claude and Pi write/edit fields add evidence without parsing arbitrary tool prose", () => {
  for (const [agent, calls] of [
    ["claude", [["Write", { file_path: "/demo/new.txt" }], ["Edit", { file_path: "/demo/existing.txt" }], ["MultiEdit", { file_path: "/demo/multiple.txt" }]]],
    ["pi", [["write", { path: "report.md" }], ["edit", { path: "changed.md" }]]],
    ["omp", [["write", { path: "report.md" }], ["edit", { path: "changed.md" }]]],
  ]) {
    const records = calls.flatMap(([name, input], i) => [
      { type: "message", timestamp: T, message: { role: "assistant", content: [{ type: "toolCall", id: `${i}`, name, arguments: input }] } },
      { type: "message", timestamp: T, message: { role: "toolResult", toolCallId: `${i}`, content: [{ type: "text", text: "Written. [Not evidence](elsewhere.txt)" }], isError: false } },
    ]);
    assert.equal(localContent(records.slice(0, 1), agent).entries[0].artifactCandidates, undefined);
    const entries = localContent(records, agent).entries;
    assert.deepEqual(entries.map((e) => e.artifactCandidates), calls.map(([, input]) => [{ path: input.file_path ?? input.path, kind: "written" }]));
  }
  const ignored = [
    ["Read", { file_path: "read.txt" }, false],
    ["read", { path: "read.txt" }, false],
    ["Bash", { command: "printf '[Shell](shell.txt)'", path: "shell.txt" }, false],
    ["not_write", { path: "unknown.txt" }, false],
    ["mcp__unknown__write", { path: "unknown-namespace.txt" }, false],
    ["write", { file_path: "wrong-field.txt" }, false],
    ["Write", { file_path: "failed.txt" }, true],
  ].flatMap(([name, input, isError], i) => [
    { type: "message", timestamp: T, message: { role: "assistant", content: [{ type: "toolCall", id: `${i}`, name, arguments: input }] } },
    { type: "message", timestamp: T, message: { role: "toolResult", toolCallId: `${i}`, content: [{ type: "text", text: "[Output](output.txt)" }], isError } },
  ]);
  assert.ok(localContent(ignored, "pi").entries.every((e) => !e.artifactCandidates));
  const userTool = localContent([
    { type: "message", message: { role: "user", content: [{ type: "toolCall", id: "fake", name: "write", arguments: { path: "user-tool.txt" } }] } },
    { type: "message", message: { role: "toolResult", toolCallId: "fake", content: "Written" } },
  ], "pi");
  assert.ok(userTool.entries.every((e) => !e.artifactCandidates));
});

test("Codex apply_patch evidence requires a confirmed success and excludes deletions", () => {
  const patch = [
    "*** Begin Patch", "*** Add File: created.txt", "+new",
    "*** Update File: old.txt", "*** Move to: moved.txt", "@@", "-old", "+new",
    "*** Update File: changed.txt", "@@", "-old", "+new",
    "*** Delete File: deleted.txt", "*** End Patch",
  ].join("\n");
  const call = (id, input = patch) => codex({ type: "custom_tool_call", call_id: id, name: "functions.apply_patch", input });
  const result = (id, output, flags = {}) => codex({ type: "custom_tool_call_output", call_id: id, output, ...flags });
  const entries = localContent([
    call("success"), result("success", "Success. Updated the following files:\nA created.txt\nM moved.txt\nM changed.txt\nD deleted.txt"),
    call("failure"), result("failure", "apply_patch verification failed: File not found"),
    call("error-flag"), result("error-flag", "Success. Updated the following files:\nA created.txt", { is_error: true }),
    call("structured-error", { patch }), result("structured-error", { isError: true, content: [{ type: "text", text: "Success. Updated the following files:\nA created.txt" }] }),
    call("unconfirmed"), result("unconfirmed", "I wrote the file."),
    call("invalid-patch", "*** Add File: not-a-valid-patch.txt"), result("invalid-patch", "Success. Updated the following files:\nA not-a-valid-patch.txt"),
  ], "codex").entries;
  assert.deepEqual(entries[0].artifactCandidates, ["created.txt", "moved.txt", "changed.txt"].map((path) => ({ path, kind: "written" })));
  assert.ok(entries.slice(1).every((e) => !e.artifactCandidates));
});

test("Pi/OMP abandoned branches never contribute artifact associations", () => {
  for (const agent of ["pi", "omp", "fleet"]) {
    const entries = localContent([
      { type: "message", id: "start", parentId: null, timestamp: T, message: { role: "user", content: "Write a report" } },
      { type: "message", id: "old", parentId: "start", timestamp: T, message: { role: "assistant", content: [{ type: "text", text: "[Abandoned](old.txt)" }, { type: "toolCall", id: "old-tool", name: "write", arguments: { path: "abandoned.txt" } }] } },
      { type: "message", id: "old-result", parentId: "old", timestamp: T, message: { role: "toolResult", toolCallId: "old-tool", content: "Written" } },
      { type: "message", id: "current", parentId: "start", timestamp: T, message: { role: "assistant", content: "[Current](current.txt)" } },
    ], agent).entries;
    assert.deepEqual(entries.flatMap((e) => e.artifactCandidates ?? []), [{ path: "current.txt", kind: "linked" }]);
  }
});

test("Pi/OMP branch metadata distinguishes a straight append from a fork and a read gap", () => {
  const record = (id, parentId) => ({ type: "message", id, parentId, timestamp: T, message: { role: "assistant", content: `[File](${id}.txt)` } });
  const records = [record("start", null), record("one", "start"), record("two", "one")];
  for (const agent of ["pi", "omp", "fleet"]) {
    const initial = localContent(records, agent);
    assert.deepEqual(initial.branch, { head: "two", ancestry: ["two", "one", "start"] });
    const append = localContent([...records, record("three", "two")], agent);
    assert.ok(append.branch.ancestry.includes(initial.branch.head));
    const fork = localContent([...records, record("fork", "start")], agent);
    assert.deepEqual(fork.branch, { head: "fork", ancestry: ["fork", "start"] });
    assert.ok(!fork.branch.ancestry.includes(initial.branch.head));
    const gap = localContent([record("new", "unavailable-parent")], agent);
    assert.deepEqual(gap.branch, { head: "new", ancestry: ["new"] });
    assert.ok(!gap.branch.ancestry.includes(initial.branch.head));
    const chain = Array.from({ length: 130 }, (_, i) => record(`n${i}`, i ? `n${i - 1}` : null));
    const tail = localContent(chain, agent);
    assert.equal(tail.entries.length, 120);
    assert.equal(tail.branch.ancestry.length, 130, "branch continuity is independent of displayed entry limits");
  }
  assert.equal(localContent(records, "claude").branch, undefined);
  assert.equal(localContent([{ type: "message", id: "flat", message: { role: "assistant", content: "No parents" } }], "pi").branch, undefined);
});

test("archive artifact associations follow the same normalization and explicit failure rules", () => {
  const entries = archiveContent([
    { ordinal: 0, role: "system", content: "[System](system.txt)" },
    { ordinal: 1, role: "user", content: "[User](user.txt)", tool_calls: [{ tool_use_id: "user-tool", tool_name: "write", input_json: '{"path":"user-tool.txt"}', result_content: "Written" }] },
    { ordinal: 2, role: "assistant", content: "![Image](plot.png) `[Example](example.txt)`", thinking_text: "[Private](private.txt)", tool_calls: [
      { tool_use_id: "ok", tool_name: "write", input_json: '{"path":"archive.txt"}', result_content: "Written" },
      { tool_use_id: "failed", tool_name: "write", input_json: '{"path":"failed.txt"}', result_content: '{"isError":true,"content":[{"type":"text","text":"failure"}]}' },
      { tool_use_id: "flag", tool_name: "Write", input_json: '{"file_path":"failed-flag.txt"}', result_content: "failed", is_error: true },
      { tool_use_id: "pending", tool_name: "Write", input_json: '{"file_path":"pending.txt"}' },
    ] },
  ]);
  assert.deepEqual(entries.flatMap((e) => e.artifactCandidates ?? []), [
    { path: "plot.png", kind: "linked" }, { path: "archive.txt", kind: "written" },
  ]);
});
