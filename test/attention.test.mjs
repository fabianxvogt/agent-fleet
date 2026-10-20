import assert from "node:assert/strict";
import { test } from "node:test";
import { readTurnState } from "../src/attention.mjs";

const T = "2026-10-16T11:59:00Z";
const isoT = new Date(T).toISOString();
const codex = (payload) => ({ type: "response_item", timestamp: T, payload });
const event = (type, extra = {}) => ({ type: "event_msg", timestamp: T, payload: { type, ...extra } });
const final = (text, phase = "final") => codex({ type: "message", role: "assistant", phase, content: [{ type: "output_text", text }] });
const question = (id = "q") => codex({ type: "function_call", call_id: id, name: "functions.request_user_input", arguments: "private request content" });
const answer = (id = "q") => codex({ type: "function_call_output", call_id: id, output: "private answer content" });
const noticeOnly = ({ requests, requestsComplete, ...notice }) => notice;

test("direct final human questions are inferred; completion without an ask is explicit", () => {
  for (const text of ["Would you prefer A or B?", "Which option do you prefer?", "Soll ich das veröffentlichen?", "Welche Variante möchtest du?", "- **Would you prefer A or B?**"]) {
    const state = readTurnState([final(text), event("task_complete")], "codex");
    assert.deepEqual(state.attention, { kind: "question", reason: "Question inferred from final reply", at: isoT, evidence: "inferred" });
  }
  assert.deepEqual(readTurnState([final("The changes are ready."), event("task_complete")], "codex"), {
    phase: "completed", attention: { kind: "completed", reason: "Turn finished", at: isoT, evidence: "explicit" },
  });
});

test("quoted, fenced, rhetorical, private and nonfinal questions do not request human input", () => {
  for (const text of [
    "> Would you like A?", '"Would you like A?"', "The prompt asks: Would you like A?",
    "```text\nWould you like A?\n```", "~~~\nWould you like A?\n~~~", "`Would you like A?`",
    "Why would you do that?", "What could possibly go wrong?", "Why bother?", "What is a queue?", "Can you believe it?",
    "Would you like A?\nI chose A and finished the work.",
  ]) assert.equal(readTurnState([final(text)], "codex").attention?.kind, "completed", text);
  for (const phase of ["commentary", "analysis", "reasoning", undefined]) {
    const message = final("Would you prefer A or B?");
    message.payload.phase = phase;
    assert.equal(readTurnState([message], "codex").attention, null, phase);
  }
  assert.equal(readTurnState([final("Would you prefer A?", "commentary"), event("task_complete")], "codex").attention.kind, "completed");
  const state = readTurnState([{ type: "assistant", timestamp: T, message: { stop_reason: "end_turn", content: [{ type: "thinking", thinking: "Would you prefer secret A?" }] } }], "claude");
  assert.equal(state.attention.kind, "completed");
  assert.ok(!JSON.stringify(state).includes("secret"));
});

test("explicit questions remain pending across other activity until their result or a new turn", () => {
  const unrelated = codex({ type: "function_call", call_id: "ls", name: "exec_command" });
  for (const suffix of [[unrelated], [answer("ls")], [final("Independent work is done."), event("task_complete")]]) {
    assert.deepEqual(noticeOnly(readTurnState([question(), ...suffix], "codex").attention), { kind: "question", reason: "Input requested", at: isoT, evidence: "explicit" });
  }
  for (const suffix of [[answer()], [event("task_started")], [event("user_message")], [codex({ type: "message", role: "user", content: [] })]]) {
    assert.deepEqual(readTurnState([question(), ...suffix], "codex"), { phase: "active", attention: null });
  }
  assert.equal(readTurnState([question("a"), question("b"), answer("a")], "codex").attention.kind, "question");
  assert.equal(readTurnState([question("a"), question("b"), answer("a"), answer("b")], "codex").attention, null);
});

test("asynchronous input acknowledgements are not human answers", () => {
  const request = codex({ type: "function_call", call_id: "async-q", name: "functions.request_user_input_async", arguments: "{}" });
  const acknowledgement = codex({ type: "function_call_output", call_id: "async-q", output: "Question displayed; a reply will arrive asynchronously." });
  const work = codex({ type: "function_call", call_id: "work", name: "exec_command" });
  const records = [request, acknowledgement, work, answer("work"), final("I have completed the independent work."), event("task_complete")];
  const pending = readTurnState(records, "codex");
  assert.deepEqual(noticeOnly(pending.attention), { kind: "question", reason: "Input requested", at: isoT, evidence: "explicit" });
  for (const response of [event("user_message", { message: "Choose A" }), codex({ type: "message", role: "user", content: [{ type: "input_text", text: "Choose A" }] })]) {
    assert.deepEqual(readTurnState([...records, response], "codex"), { phase: "active", attention: null });
  }
  assert.deepEqual(readTurnState([...records, event("task_started")], "codex").attention, pending.attention, "an automatic continuation is not a human answer");
  assert.deepEqual(readTurnState([...records, event("task_started"), final("Another independent step is done."), event("task_complete")], "codex").attention, pending.attention);
  assert.equal(readTurnState([...records, event("task_started"), event("user_message", { message: "Choose A" })], "codex").attention, null);
  assert.equal(readTurnState([question(), event("task_started")], "codex").attention, null, "new turns still supersede blocking requests");
  assert.equal(readTurnState([question(), answer()], "codex").attention, null, "a blocking input result is still an answer");
});

test("explicit approval events and failed turns cannot be mistaken for completion", () => {
  const request = event("exec_approval_request", { call_id: "approval" });
  assert.deepEqual(noticeOnly(readTurnState([request], "codex").attention), { kind: "approval", reason: "Approval requested", at: isoT, evidence: "explicit" });
  assert.equal(readTurnState([request, event("approval_response", { call_id: "approval" })], "codex").attention, null);
  for (const type of ["error", "turn_aborted"]) {
    assert.deepEqual(readTurnState([question(), event(type), event("task_complete")], "codex"), { phase: "failed", attention: null });
    assert.deepEqual(readTurnState([event(type), event("task_started")], "codex"), { phase: "active", attention: null });
  }
});

test("Claude tool results clear requests without treating unrelated results as user replies", () => {
  const request = { type: "assistant", timestamp: T, message: { content: [{ type: "tool_use", name: "AskUserQuestion", id: "q", input: { text: "private" } }] } };
  const result = (id) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "answer" }] } });
  assert.equal(readTurnState([request, result("other")], "claude").attention.kind, "question");
  assert.equal(readTurnState([request, result("q")], "claude").attention, null);
  assert.equal(readTurnState([request, { type: "user", isMeta: true, message: { content: "Metadata only" } }], "claude").attention.kind, "question");
  assert.equal(readTurnState([request, { type: "user", message: { content: "Proceed" } }], "claude").attention, null);
});

test("Pi/OMP follow the active branch and require explicit completion evidence", () => {
  for (const agent of ["pi", "omp"]) {
    const state = readTurnState([
      { type: "message", id: "u", parentId: null, message: { role: "user", content: "Build it" } },
      { type: "message", id: "old", parentId: "u", message: { role: "assistant", content: [{ type: "toolCall", name: "request_user_input", id: "q" }] } },
      { type: "message", id: "new", parentId: "u", timestamp: T, message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }] } },
    ], agent);
    assert.equal(state.attention.kind, "completed");
    assert.equal(readTurnState([{ type: "message", message: { role: "assistant", content: "Would you choose A?" } }], agent).attention, null);
  }
  assert.deepEqual(readTurnState([], "codex"), { phase: "unknown", attention: null });
});

test("missing event timestamps use stable file time, never the collection clock", () => {
  const records = [{ type: "event_msg", payload: { type: "task_complete" } }];
  assert.equal(readTurnState(records, "codex").attention.at, null);
  assert.equal(readTurnState(records, "codex", Date.parse(T)).attention.at, isoT);
});

test("late Codex copies preserve completion and commentary cannot become a final question", () => {
  const unmarked = final("Would you prefer A?");
  delete unmarked.payload.phase;
  assert.equal(readTurnState([unmarked, event("task_complete"), unmarked], "codex").attention.kind, "question");
  const commentary = final("Would you prefer A?", "commentary");
  assert.equal(readTurnState([commentary, event("agent_message", { message: "Would you prefer A?" }), event("task_complete")], "codex").attention.kind, "completed");
  assert.equal(readTurnState([event("task_complete"), final("Done.")], "codex").phase, "completed");
});

test("subagent prose questions address the parent; explicit human-input tools still request attention", () => {
  const options = { humanAudience: false };
  assert.equal(readTurnState([final("Would you prefer A?")], "codex", null, options).attention.kind, "completed");
  assert.equal(readTurnState([question()], "codex", null, options).attention.kind, "question");
});

test("notification request identities are opaque, stable and separate from fallback observation times", () => {
  const missingTime = question("runtime-call");
  delete missingTime.timestamp;
  const first = readTurnState([missingTime], "codex", Date.parse(T)).attention;
  const later = readTurnState([missingTime], "codex", Date.parse(T) + 4000).attention;
  assert.notEqual(first.at, later.at);
  assert.deepEqual(first.requests, later.requests);
  assert.equal(first.requests[0].at, null, "file mtime does not establish the request event time");
  assert.match(first.requests[0].requestId, /^[a-f0-9]{64}$/);
  const timed = readTurnState([question("runtime-call")], "codex").attention.requests[0];
  assert.equal(timed.requestId, first.requests[0].requestId);
  assert.equal(timed.at, isoT);
  assert.notEqual(timed.requestId, readTurnState([question("other-call")], "codex").attention.requests[0].requestId);
  assert.notEqual(timed.requestId, readTurnState([event("approval_request", { call_id: "runtime-call" })], "codex").attention.requests[0].requestId);
  const claude = { type: "assistant", timestamp: T, message: { content: [{ type: "tool_use", name: "AskUserQuestion", id: "runtime-call" }] } };
  assert.notEqual(timed.requestId, readTurnState([claude], "claude").attention.requests[0].requestId);
  assert.doesNotMatch(JSON.stringify(first.requests), /runtime-call|private|mtime/);
});

test("all concurrent explicit requests remain visible as metadata while the outer notice stays latest", () => {
  const records = [question("older"), event("approval_request", { call_id: "newer" })];
  const both = readTurnState(records, "codex").attention;
  assert.equal(both.kind, "approval");
  assert.equal(both.requestsComplete, true);
  assert.deepEqual(both.requests.map((r) => r.kind), ["question", "approval"]);
  const older = readTurnState([...records, event("approval_response", { call_id: "newer" })], "codex").attention;
  assert.equal(older.kind, "question");
  assert.deepEqual(older.requests, [both.requests[0]], "an old concurrent request keeps its identity when it resurfaces");
  assert.equal(readTurnState([...records, event("user_message")], "codex").attention, null);
  assert.equal(readTurnState([final("Would you prefer A?")], "codex").attention.requests, undefined);
  assert.equal(readTurnState([final("Done.")], "codex").attention.requests, undefined);
});

test("missing or malformed runtime IDs remain UI attention without notification identity", () => {
  for (const callId of [null, undefined, "", " ", " x", "x\n", "x\u0000", 7, {}, "x".repeat(513)]) {
    const record = question();
    record.payload.call_id = callId;
    const state = readTurnState([record], "codex").attention;
    assert.equal(state.kind, "question");
    assert.equal(state.evidence, "explicit");
    assert.deepEqual(state.requests, []);
    assert.equal(state.requestsComplete, true);
  }
  assert.deepEqual(readTurnState([event("approval_request")], "codex").attention.requests, []);
});

test("request timestamps reject coercible malformed values while accepting runtime Unix milliseconds", () => {
  for (const timestamp of [null, undefined, "", "1", "bad", {}, false, "2026-02-31T12:00:00Z", -1, 1.5]) {
    const record = question();
    record.timestamp = timestamp;
    assert.equal(readTurnState([record], "codex", Date.parse(T)).attention.requests[0].at, null);
  }
  assert.equal(readTurnState([{ ...question(), timestamp: Date.parse(T) }], "codex").attention.requests[0].at, isoT);
});

test("async acknowledgement keeps notification identity; tool failures, user replies and branch clears revoke it", () => {
  const ask = codex({ type: "function_call", call_id: "async", name: "functions.request_user_input_async" });
  const initial = readTurnState([ask], "codex").attention;
  assert.deepEqual(readTurnState([ask, answer("async"), event("task_started")], "codex").attention.requests, initial.requests);
  assert.equal(readTurnState([ask, codex({ type: "function_call_output", call_id: "async", is_error: true })], "codex").attention, null);
  assert.equal(readTurnState([ask, event("error")], "codex").attention, null);
  const root = { type: "message", id: "root", parentId: null, message: { role: "user", content: "Start" } };
  const call = { type: "message", id: "ask", parentId: "root", timestamp: T, message: { role: "assistant", content: [{ type: "toolCall", id: "q", name: "request_user_input" }] } };
  assert.equal(readTurnState([root, call], "omp").attention.requests.length, 1);
  assert.equal(readTurnState([root, call, { type: "model_usage", id: "clear", parentId: "ask", activeLeafId: null }], "omp").attention, null);
  assert.equal(readTurnState([root, call, { type: "message", id: "fork", parentId: "root", message: { role: "assistant", content: "New branch" } }], "omp").attention, null);
});

test("pending metadata overflow is explicit and resolving requests restores a complete set", () => {
  const records = Array.from({ length: 1025 }, (_, i) => question(`q-${i}`));
  const overflowing = readTurnState(records, "codex").attention;
  assert.equal(overflowing.requests.length, 1024);
  assert.equal(overflowing.requestsComplete, false);
  const resolved = readTurnState([...records, answer("q-1024")], "codex").attention;
  assert.equal(resolved.requests.length, 1024);
  assert.equal(resolved.requestsComplete, true);
  assert.equal(readTurnState([...records, event("user_message")], "codex").attention, null);
});

const asyncQuestion = (id, questions = [{}]) => codex({
  type: "function_call", call_id: id, name: "functions.request_user_input_async",
  arguments: JSON.stringify({ questions }),
});
const asyncReply = (items) => `<send_user_message_question_reply>\n${JSON.stringify(items.map(([id, index]) => ({
  questionItemId: JSON.stringify(["request_user_input_async", id, index]), question: "PRIVATE QUESTION", answer: "PRIVATE ANSWER",
})))}\n</send_user_message_question_reply>`;

test("targeted asynchronous replies clear only their call, preserving concurrent requests", () => {
  const records = [asyncQuestion("a"), asyncQuestion("b"), event("approval_request", { call_id: "approval" })];
  const initial = readTurnState(records, "codex").attention;
  const reply = asyncReply([["a", 0]]);
  for (const response of [
    event("user_message", { message: reply }),
    codex({ type: "message", role: "user", content: [{ type: "input_text", text: reply }] }),
  ]) {
    const remaining = readTurnState([...records, response], "codex").attention;
    assert.deepEqual(remaining.requests, initial.requests.slice(1));
    assert.equal(remaining.kind, "approval");
    assert.doesNotMatch(JSON.stringify(remaining), /PRIVATE/);
  }
  const copies = [event("user_message", { message: reply }), codex({ type: "message", role: "user", content: reply })];
  assert.deepEqual(readTurnState([...records, ...copies], "codex").attention.requests, initial.requests.slice(1), "event/canonical copies are idempotent");
});

test("partial asynchronous answers require all observed question indices before resolving the call", () => {
  const records = [asyncQuestion("a", [{}, {}]), asyncQuestion("b")];
  const initial = readTurnState(records, "codex").attention.requests;
  const first = event("user_message", { message: asyncReply([["a", 0]]) });
  assert.deepEqual(readTurnState([...records, first, first], "codex").attention.requests, initial);
  const remaining = readTurnState([...records, first, event("user_message", { message: asyncReply([["a", 1]]) })], "codex").attention.requests;
  assert.deepEqual(remaining, initial.slice(1));
  assert.equal(readTurnState([...records, event("user_message", { message: asyncReply([["a", 0], ["a", 1], ["b", 0]]) })], "codex").attention, null);
});

test("unknown or malformed targeted answers do not resolve unrelated or incompletely observed requests", () => {
  const records = [asyncQuestion("a", undefined), asyncQuestion("b")];
  records[0].payload.arguments = "{}";
  const initial = readTurnState(records, "codex").attention.requests;
  for (const message of [
    asyncReply([["a", 0]]), asyncReply([["missing", 0]]), asyncReply([["b", -1]]), asyncReply([["b", 1]]),
    "<send_user_message_question_reply>invalid</send_user_message_question_reply>",
    `<send_user_message_question_reply>${" ".repeat(65_537)}</send_user_message_question_reply>`,
    '<send_user_message_question_reply>[{"questionItemId":"invalid"}]</send_user_message_question_reply>',
    `<send_user_message_question_reply>${JSON.stringify([{ questionItemId: JSON.stringify(["request_user_input_async", "b", 0]) }])}</send_user_message_question_reply>`,
  ]) assert.deepEqual(readTurnState([...records, event("user_message", { message })], "codex").attention.requests, initial);
  assert.equal(readTurnState([...records, event("user_message", { message: "Proceed with the work." })], "codex").attention, null);
});

test("structured asynchronous errors revoke only the failed request without interpreting prose", () => {
  const records = [asyncQuestion("a"), asyncQuestion("b")];
  const initial = readTurnState(records, "codex").attention.requests;
  for (const envelope of [{ isError: true }, { is_error: true }, { success: false }]) {
    for (const output of [envelope, JSON.stringify(envelope)]) {
      const failed = codex({ type: "function_call_output", call_id: "b", output });
      assert.deepEqual(readTurnState([...records, failed], "codex").attention.requests, initial.slice(0, 1));
    }
  }
  for (const output of [
    "The previous step failed.", "```json\n{\"isError\":true}\n```", "{bad", '{"nested":{"isError":true}}',
    { success: true }, { isError: false }, JSON.stringify({ isError: true, padding: "x".repeat(65_537) }),
  ]) assert.deepEqual(readTurnState([...records, codex({ type: "function_call_output", call_id: "b", output })], "codex").attention.requests, initial);
});
