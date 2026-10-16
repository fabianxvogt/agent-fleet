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
    codex({ type: "function_call_output", call_id: "a", output: "Process exited with code 1\nFailed test" }),
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
