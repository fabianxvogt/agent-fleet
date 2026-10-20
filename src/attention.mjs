import { createHash } from "node:crypto";
import { isoOrNull } from "./util.mjs";
import { selectSessionBranch } from "./session-branch.mjs";

const INPUT_TOOLS = new Set(["askuserquestion", "request_user_input", "request_user_input_async"]);
const APPROVAL_EVENTS = new Set(["approval_request", "exec_approval_request", "apply_patch_approval_request"]);
const MAX_PENDING_REQUESTS = 1024;
const MAX_STRUCTURED_BYTES = 65_536;
const REASONS = {
  question: "Input requested",
  approval: "Approval requested",
  completed: "Turn finished",
};

function attention(kind, at, evidence = "explicit") {
  return { kind, reason: evidence === "inferred" ? "Question inferred from final reply" : REASONS[kind], at: isoOrNull(at), evidence };
}

function requestIdentity(agent, kind, id) {
  if (typeof id !== "string" || !id.length || id.length > 512 || id.trim() !== id || /[\u0000-\u001f\u007f]/u.test(id)) return null;
  return createHash("sha256").update(JSON.stringify([agent, kind, id])).digest("hex");
}

function requestTimestamp(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? isoOrNull(value) : null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const normalized = isoOrNull(value);
  return normalized?.slice(0, 19) === value.slice(0, 19) ? normalized : null;
}

function textContent(content) {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((c) => ["text", "input_text", "output_text"].includes(c?.type)).map((c) => typeof c.text === "string" ? c.text : "").join("\n") : "";
}

function structured(value) {
  if (typeof value !== "string") return value;
  if (Buffer.byteLength(value, "utf8") > MAX_STRUCTURED_BYTES) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function structuredFailure(output) {
  const value = structured(output);
  return value?.isError === true || value?.is_error === true || value?.success === false;
}

/** Only infer a direct human request in a final, unquoted prose question. */
function asksHuman(text) {
  const prose = text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, "").replace(/`[^`]*`/g, "");
  const last = (prose.trim().split(/\n/).at(-1)?.trim() ?? "").replace(/^(?:[-*+]|\d+\.)\s+/, "").replace(/[*_]/g, "");
  if (!last.endsWith("?") || /^(?:>|["'“„‘]|#{1,6}\s)/.test(last)) return false;
  if (/^(?:can|could|would) you (?:believe|imagine)\b/i.test(last)) return false;
  // Requiring direct address/permission wording avoids generic/rhetorical questions
  // such as "Why bother?". This remains a heuristic, never explicit evidence.
  return /(?:^|[.!]\s+)(?:(?:would|could|can|will|do) you\b|(?:which|what|where|when|how)\b[^?]{0,100}\b(?:do|would|will|can) you\b|(?:shall|should|may|can) I\b|(?:soll|darf|kann) ich\b|(?:möchtest|willst|kannst|könntest|würdest|bevorzugst) du\b|(?:welche[rsnm]?|was|wo|wann|wie)\b[^?]{0,100}\b(?:möchtest|willst|bevorzugst|brauchst) du\b|(?:möchten|können|könnten|würden|bevorzugen) Sie\b)/iu.test(last);
}

/**
 * Reduce a bounded transcript tail to metadata only. No content or private
 * reasoning leaves this function. Missing evidence remains unknown.
 */
export function readTurnState(records, agent, fallbackAt = null, { humanAudience = true } = {}) {
  let phase = "unknown";
  let notice = null;
  let candidate = null;
  const pending = new Map();
  // Canonical response items carry channel/finality; their event copies may omit
  // those flags. In particular, a commentary copy must not become a final ask.
  const canonicalReplies = new Set(agent === "codex" ? records.filter((r) => r.type === "response_item" && r.payload?.type === "message" && r.payload.role === "assistant" && !["analysis", "reasoning"].includes(r.payload.channel ?? r.payload.phase)).map((r) => textContent(r.payload.content)) : []);
  const activate = (cause = null) => {
    phase = "active";
    notice = null;
    candidate = null;
    if (cause === "user") pending.clear();
    // New turns supersede blocking calls, but can be automatic continuations.
    // An asynchronous ask survives until observed user input or a failure.
    else if (cause === "turn") for (const [id, request] of pending) if (!request.async) pending.delete(id);
  };
  const finish = (at) => {
    phase = "completed";
    notice = humanAudience && candidate && asksHuman(candidate.text)
      ? attention("question", candidate.at ?? at, "inferred")
      : attention("completed", at);
  };
  const fail = () => { phase = "failed"; notice = null; candidate = null; pending.clear(); };
  const request = (id, key, kind, at, async = false, requestAt = null, args = null) => {
    const requestId = requestIdentity(agent, kind, id);
    const observed = attention(kind, at);
    const questions = async ? structured(args)?.questions : null;
    const questionCount = Array.isArray(questions) && questions.length > 0 && questions.length <= MAX_PENDING_REQUESTS &&
      questions.every((q) => q && typeof q === "object" && !Array.isArray(q)) ? questions.length : null;
    pending.set(key, { notice: observed, async, questionCount, answered: new Set(),
      request: requestId ? { requestId, kind, at: requestTimestamp(requestAt) } : null });
  };
  const call = (id, name, at, requestAt, args) => {
    activate();
    const toolName = typeof name === "string" ? name.split(/[.:/]/).at(-1).toLowerCase() : "";
    if (INPUT_TOOLS.has(toolName)) request(id, id ?? name, "question", at, toolName === "request_user_input_async", requestAt, args);
  };
  const result = (id, failed = false, output = null) => {
    activate();
    // An asynchronous input tool returns an acknowledgement immediately. The
    // human's answer arrives as a user event, not as this tool's output.
    if (failed || !pending.get(id)?.async || structuredFailure(output)) pending.delete(id);
  };
  const user = (content) => {
    const text = textContent(content).trim();
    const open = "<send_user_message_question_reply>", close = "</send_user_message_question_reply>";
    if (!text.startsWith(open) || !text.endsWith(close)) { activate("user"); return; }
    activate();
    const replies = structured(text.slice(open.length, -close.length));
    // Recognized but incomplete envelopes cannot prove any request resolved.
    if (!Array.isArray(replies) || replies.length > MAX_PENDING_REQUESTS) return;
    for (const reply of replies) {
      if (typeof reply?.answer !== "string") continue;
      const identity = typeof reply?.questionItemId === "string" ? structured(reply.questionItemId) : null;
      if (!Array.isArray(identity) || identity.length !== 3 || identity[0] !== "request_user_input_async" ||
        typeof identity[1] !== "string" || !Number.isSafeInteger(identity[2]) || identity[2] < 0) continue;
      const entry = pending.get(identity[1]);
      if (!entry?.async || entry.questionCount === null || identity[2] >= entry.questionCount) continue;
      entry.answered.add(identity[2]);
      if (entry.answered.size === entry.questionCount) pending.delete(identity[1]);
    }
  };
  const assistant = (content, at, final, eligible = true) => {
    // A response copy can be appended just after task_complete. Until a new
    // turn/activity event appears, it still belongs to that completed turn.
    const finished = final || phase === "completed" && eligible;
    activate();
    if (eligible) candidate = { text: textContent(content), at };
    if (finished) finish(at);
  };

  for (const r of selectSessionBranch(records, agent).records) {
    const requestAt = r.timestamp ?? r.message?.timestamp ?? null;
    const at = requestAt ?? fallbackAt;
    if (agent === "codex") {
      const p = r.payload ?? {};
      if (r.type === "event_msg") {
        if (p.type === "task_started") activate("turn");
        else if (p.type === "user_message") user(p.message);
        else if (["error", "turn_aborted"].includes(p.type)) fail();
        else if (p.type === "task_complete") {
          // Some versions put the visible final reply only on the lifecycle event.
          if (typeof p.last_agent_message === "string") candidate = { text: p.last_agent_message, at };
          if (phase !== "failed") finish(at);
        } else if (p.type === "agent_message") {
          if (!canonicalReplies.has(p.message) && !["analysis", "reasoning"].includes(p.channel ?? p.phase)) assistant(p.message ?? "", at, p.phase === "final" || p.channel === "final", p.phase !== "commentary" && p.channel !== "commentary");
        } else if (APPROVAL_EVENTS.has(p.type)) {
          activate();
          request(p.call_id ?? p.id, p.call_id ?? p.id ?? p.type, "approval", at, false, requestAt);
        } else if (p.type === "approval_response") result(p.call_id ?? p.id);
      } else if (r.type === "response_item") {
        if (p.type === "message" && p.role === "user") user(p.content);
        if (p.type === "message" && p.role === "assistant" && !["analysis", "reasoning"].includes(p.channel ?? p.phase)) assistant(p.content, at, p.phase === "final" || p.channel === "final", p.phase !== "commentary" && p.channel !== "commentary");
        if (["function_call", "custom_tool_call"].includes(p.type)) call(p.call_id ?? p.id, p.name, at, requestAt, p.arguments ?? p.input);
        if (["function_call_output", "custom_tool_call_output"].includes(p.type)) result(p.call_id ?? p.id, p.is_error === true || p.isError === true, p.output);
      }
      continue;
    }

    if (r.isMeta || r.isCompactSummary) continue;
    if (r.type === "result" && r.is_error === true) { fail(); continue; }
    const m = r.message;
    if (!m || !["user", "assistant", "message"].includes(r.type)) continue;
    const role = m.role ?? r.type;
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (role === "toolResult") { result(m.toolCallId, m.isError === true, m.content); continue; }
    if (role === "user") {
      const results = blocks.filter((c) => c?.type === "tool_result");
      if (results.length) results.forEach((c) => result(c.tool_use_id, c.is_error === true, c.content));
      else activate("user");
      continue;
    }
    if (role !== "assistant") continue;
    const stop = m.stop_reason ?? m.stopReason;
    if (r.isApiErrorMessage || ["error", "aborted"].includes(stop)) { fail(); continue; }
    const calls = blocks.filter((c) => ["tool_use", "toolCall"].includes(c?.type));
    assistant(m.content, at, !calls.length && ["end_turn", "stop"].includes(stop));
    calls.forEach((c) => call(c.id, c.name, at, requestAt, c.arguments ?? c.input));
  }
  const observed = phase === "failed" ? null : [...pending.values()].at(-1)?.notice ?? notice;
  const requests = [...pending.values()].flatMap((entry) => entry.request ? [entry.request] : []);
  return { phase, attention: observed && pending.size
    ? { ...observed, requests: requests.slice(0, MAX_PENDING_REQUESTS), requestsComplete: requests.length <= MAX_PENDING_REQUESTS }
    : observed };
}
