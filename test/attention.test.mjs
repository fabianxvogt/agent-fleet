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
    assert.deepEqual(readTurnState([question(), ...suffix], "codex").attention, { kind: "question", reason: "Input requested", at: isoT, evidence: "explicit" });
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
  assert.deepEqual(pending.attention, { kind: "question", reason: "Input requested", at: isoT, evidence: "explicit" });
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
  assert.deepEqual(readTurnState([request], "codex").attention, { kind: "approval", reason: "Approval requested", at: isoT, evidence: "explicit" });
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
