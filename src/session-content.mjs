import { createHash } from "node:crypto";
import { isoOrNull, parseJson } from "./util.mjs";

const MAX_TEXT = 16_000;

export function safeText(value, max = MAX_TEXT) {
  let text = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
  text = text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[redacted private key]")
    .replace(/\b(?:sk-(?:proj-)?[\w-]{20,}|gh[pousr]_[\w]{20,}|github_pat_[\w]{20,})\b/g, "[redacted token]")
    .replace(/(\bauthorization["']?\s*[:=]\s*["']?(?:bearer|basic)\s+)[^\s"',}]+/gi, "$1[redacted]")
    .replace(/(\b(?:[\w]*[_-])?(?:api[_-]?key|(?:access|auth|refresh)[_-]?token|secret(?:[_-](?:access[_-])?key)?|password)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[redacted]");
  return text.length > max ? `${text.slice(0, max)}\n… [output shortened]` : text;
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => ["text", "input_text", "output_text"].includes(c.type)).map((c) => c.text ?? "").join("\n");
}

function message(role, text, at, final = false, stableId = null) {
  if (!["user", "assistant"].includes(role) || !text.trim()) return null;
  const clean = safeText(text);
  const time = isoOrNull(at);
  return { id: `message:${stableId ?? createHash("sha1").update(JSON.stringify([role, time, clean])).digest("hex")}`, kind: "message", role, text: clean, at: time, final };
}

function tool(id, name, input, at) {
  return { id: `tool:${id}`, kind: "tool", name: safeText(name || "Tool", 160), input: safeText(input, 8000), text: null, at: isoOrNull(at), status: "observed" };
}

/** Only user-visible text and tool events; reasoning/thinking and system prompts are excluded. */
export function localContent(records, agent) {
  const entries = [];
  const tools = new Map();
  let activity = null;
  const addMessage = (role, text, at, final, stableId) => {
    const m = message(role, text, at, final, stableId);
    if (m) {
      entries.push(m);
      activity = { label: role === "user" ? "Received a message" : "Posted a response", detail: m.text.slice(0, 220), at: m.at, status: "observed" };
    }
  };
  const call = (id, name, input, at) => {
    if (!id) return;
    const t = tool(id, name, input, at);
    tools.set(String(id), t);
    entries.push(t);
    activity = { label: `Called ${t.name}`, detail: t.input.slice(0, 240), at: t.at, status: "observed" };
  };
  const result = (id, content, at, error = false) => {
    if (!id) return;
    let t = tools.get(String(id));
    if (!t) {
      t = tool(id, "Tool result", null, at);
      tools.set(String(id), t);
      entries.push(t);
    }
    const parsed = typeof content === "string" ? parseJson(content) : content;
    const blocks = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.content) ? parsed.content : null;
    t.text = safeText(blocks ? textContent(blocks) || "[Non-text output]" : content);
    error = error || parsed?.isError === true || /Process exited with code [1-9]\d*/.test(t.text);
    t.status = error ? "failed" : "completed";
    t.resultAt = isoOrNull(at);
    activity = { label: `${t.name} ${error ? "failed" : "returned"}`, detail: t.text.slice(0, 240), at: t.resultAt ?? t.at, status: t.status };
  };

  // Pi/OMP session files can contain multiple branches. Follow the last record's
  // parent chain where available rather than replaying abandoned branches.
  if (["pi", "omp", "fleet"].includes(agent) && records.some((r) => Object.hasOwn(r, "parentId"))) {
    const byId = new Map(records.filter((r) => r.id).map((r) => [r.id, r]));
    const keep = new Set();
    let r = records.findLast((r) => r.id);
    while (r && !keep.has(r.id)) { keep.add(r.id); r = byId.get(r.parentId); }
    records = records.filter((r) => keep.has(r.id));
  }
  const canonicalCodex = records.some((r) => r.type === "response_item" && r.payload?.type === "message" && !["analysis", "reasoning"].includes(r.payload.channel ?? r.payload.phase));
  for (const r of records) {
    const at = r.timestamp;
    if (agent === "codex") {
      const p = r.payload ?? {};
      if (r.type === "response_item") {
        if (p.type === "message" && !["analysis", "reasoning"].includes(p.channel ?? p.phase)) addMessage(p.role, textContent(p.content), at, p.phase === "final", p.id);
        if (["function_call", "custom_tool_call"].includes(p.type)) call(p.call_id ?? p.id, p.name, p.arguments ?? p.input, at);
        if (["function_call_output", "custom_tool_call_output"].includes(p.type)) result(p.call_id, p.output, at);
      } else if (r.type === "event_msg") {
        if (!canonicalCodex && p.type === "user_message") addMessage("user", p.message ?? "", at, false);
        if (!canonicalCodex && p.type === "agent_message") addMessage("assistant", p.message ?? "", at, p.phase === "final");
        const labels = { task_started: "Turn started", task_complete: "Turn finished", turn_aborted: "Turn stopped", error: "Session reported an error" };
        if (labels[p.type]) activity = { label: labels[p.type], detail: "", at: isoOrNull(at), status: p.type === "error" ? "failed" : "observed" };
      }
      continue;
    }
    const m = r.message;
    if (!m || r.type !== "message" && !["user", "assistant"].includes(r.type)) continue;
    const role = m.role ?? r.type;
    const time = at ?? m.timestamp;
    if (role === "toolResult") {
      result(m.toolCallId, m.content, time, m.isError);
      continue;
    }
    addMessage(role, textContent(m.content), time, role === "assistant" && ["end_turn", "stop"].includes(m.stop_reason ?? m.stopReason), r.uuid ?? r.id ?? m.id);
    for (const c of Array.isArray(m.content) ? m.content : []) {
      if (["tool_use", "toolCall"].includes(c.type)) call(c.id, c.name, c.input ?? c.arguments, time);
      if (c.type === "tool_result") result(c.tool_use_id, c.content, time, c.is_error);
    }
  }
  const unique = [...new Map(entries.map((e) => [e.id, e])).values()];
  return { entries: unique.slice(-120), activity, truncated: unique.length > 120 };
}

export function archiveContent(rows) {
  const entries = [];
  for (const row of [...rows].sort((a, b) => a.ordinal - b.ordinal)) {
    if (row.is_system || row.role === "system") continue;
    const m = message(row.role, typeof row.content === "string" ? row.content : "", row.timestamp);
    if (m) entries.push({ ...m, id: `archive-message:${row.ordinal}`, ordinal: row.ordinal });
    for (const t of Array.isArray(row.tool_calls) ? row.tool_calls : []) {
      if (!t.tool_use_id) continue;
      const entry = tool(t.tool_use_id, t.tool_name, t.input_json, row.timestamp);
      if (typeof t.result_content === "string") {
        entry.text = safeText(t.result_content);
        entry.status = "completed";
      }
      entries.push({ ...entry, ordinal: row.ordinal });
    }
  }
  return entries;
}

