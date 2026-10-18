import { isoOrNull } from "./util.mjs";

const INPUT_TOOLS = new Set(["askuserquestion", "request_user_input", "request_user_input_async"]);
const APPROVAL_EVENTS = new Set(["approval_request", "exec_approval_request", "apply_patch_approval_request"]);
const REASONS = {
  question: "Input requested",
  approval: "Approval requested",
  completed: "Turn finished",
};

function attention(kind, at, evidence = "explicit") {
  return { kind, reason: evidence === "inferred" ? "Question inferred from final reply" : REASONS[kind], at: isoOrNull(at), evidence };
}

function textContent(content) {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((c) => ["text", "input_text", "output_text"].includes(c?.type)).map((c) => typeof c.text === "string" ? c.text : "").join("\n") : "";
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

function activeBranch(records, agent) {
  if (!["pi", "omp"].includes(agent) || !records.some((r) => Object.hasOwn(r, "parentId"))) return records;
  const byId = new Map(records.filter((r) => r.id).map((r) => [r.id, r]));
  const keep = new Set();
  let r = records.findLast((r) => r.id);
  while (r && !keep.has(r.id)) { keep.add(r.id); r = byId.get(r.parentId); }
  return records.filter((r) => keep.has(r.id));
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
  const call = (id, name, at) => {
    activate();
    const toolName = typeof name === "string" ? name.split(/[.:/]/).at(-1).toLowerCase() : "";
    if (INPUT_TOOLS.has(toolName)) pending.set(id ?? name, { notice: attention("question", at), async: toolName === "request_user_input_async" });
  };
  const result = (id) => {
    activate();
    // An asynchronous input tool returns an acknowledgement immediately. The
    // human's answer arrives as a user event, not as this tool's output.
    if (!pending.get(id)?.async) pending.delete(id);
  };
  const assistant = (content, at, final, eligible = true) => {
    // A response copy can be appended just after task_complete. Until a new
    // turn/activity event appears, it still belongs to that completed turn.
    const finished = final || phase === "completed" && eligible;
    activate();
    if (eligible) candidate = { text: textContent(content), at };
    if (finished) finish(at);
  };

  for (const r of activeBranch(records, agent)) {
    const at = r.timestamp ?? r.message?.timestamp ?? fallbackAt;
    if (agent === "codex") {
      const p = r.payload ?? {};
      if (r.type === "event_msg") {
        if (p.type === "task_started") activate("turn");
        else if (p.type === "user_message") activate("user");
        else if (["error", "turn_aborted"].includes(p.type)) fail();
        else if (p.type === "task_complete") {
          // Some versions put the visible final reply only on the lifecycle event.
          if (typeof p.last_agent_message === "string") candidate = { text: p.last_agent_message, at };
          if (phase !== "failed") finish(at);
        } else if (p.type === "agent_message") {
          if (!canonicalReplies.has(p.message) && !["analysis", "reasoning"].includes(p.channel ?? p.phase)) assistant(p.message ?? "", at, p.phase === "final" || p.channel === "final", p.phase !== "commentary" && p.channel !== "commentary");
        } else if (APPROVAL_EVENTS.has(p.type)) {
          activate();
          pending.set(p.call_id ?? p.id ?? p.type, { notice: attention("approval", at), async: false });
        } else if (p.type === "approval_response") result(p.call_id ?? p.id);
      } else if (r.type === "response_item") {
        if (p.type === "message" && p.role === "user") activate("user");
        if (p.type === "message" && p.role === "assistant" && !["analysis", "reasoning"].includes(p.channel ?? p.phase)) assistant(p.content, at, p.phase === "final" || p.channel === "final", p.phase !== "commentary" && p.channel !== "commentary");
        if (["function_call", "custom_tool_call"].includes(p.type)) call(p.call_id ?? p.id, p.name, at);
        if (["function_call_output", "custom_tool_call_output"].includes(p.type)) result(p.call_id ?? p.id);
      }
      continue;
    }

    if (r.isMeta || r.isCompactSummary) continue;
    if (r.type === "result" && r.is_error === true) { fail(); continue; }
    const m = r.message;
    if (!m || !["user", "assistant", "message"].includes(r.type)) continue;
    const role = m.role ?? r.type;
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (role === "toolResult") { result(m.toolCallId); continue; }
    if (role === "user") {
      const results = blocks.filter((c) => c?.type === "tool_result");
      if (results.length) results.forEach((c) => result(c.tool_use_id));
      else activate("user");
      continue;
    }
    if (role !== "assistant") continue;
    const stop = m.stop_reason ?? m.stopReason;
    if (r.isApiErrorMessage || ["error", "aborted"].includes(stop)) { fail(); continue; }
    const calls = blocks.filter((c) => ["tool_use", "toolCall"].includes(c?.type));
    assistant(m.content, at, !calls.length && ["end_turn", "stop"].includes(stop));
    calls.forEach((c) => call(c.id, c.name, at));
  }
  return { phase, attention: phase === "failed" ? null : [...pending.values()].at(-1)?.notice ?? notice };
}
