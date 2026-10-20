import { createHash } from "node:crypto";
import { isoOrNull, parseJson } from "./util.mjs";

const MAX_TEXT = 16_000;
const MAX_TERMINAL_SESSIONS = 128;
const SECRET_FIELD = String.raw`\b(?:[\w]*[_-])?(?:api[_-]?key|(?:access|auth|refresh)[_-]?token|secret(?:[_-](?:access[_-])?key)?|password)`;
const ESCAPED_SECRET = new RegExp(String.raw`(${SECRET_FIELD}\\?["']?\s*[:=]\s*\\(["']))(?:\\\\\\["']|\\\\|(?!\\\2)[\s\S])*(?:\\\2|$)`, "gi");
const QUOTED_SECRET = new RegExp(String.raw`(${SECRET_FIELD}["']?\s*[:=]\s*(["']))(?:\\[\s\S]|(?!\2)[^\\])*(?:\2|$)`, "gi");
const UNQUOTED_SECRET = new RegExp(String.raw`(${SECRET_FIELD}(?:\\?["'])?\s*[:=]\s*)(?!(?:\\?["']|\s))[^\s"',}]+`, "gi");

export function safeText(value, max = MAX_TEXT) {
  let text = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
  text = text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[redacted private key]")
    .replace(/\b(?:sk-(?:proj-)?[\w-]{20,}|gh[pousr]_[\w]{20,}|github_pat_[\w]{20,})\b/g, "[redacted token]")
    .replace(/(\bauthorization["']?\s*[:=]\s*["']?(?:bearer|basic)\s+)[^\s"',}]+/gi, "$1[redacted]")
    .replace(ESCAPED_SECRET, "$1[redacted]\\$2")
    .replace(QUOTED_SECRET, "$1[redacted]$2")
    .replace(UNQUOTED_SECRET, "$1[redacted]");
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

function shellTool(name) {
  const leaf = typeof name === "string" ? name.split(/\.|__|\/|:/).at(-1) : "";
  return ["Bash", "bash", "exec_command", "shell_command", "write_stdin"].includes(leaf) ? leaf : null;
}

function inputObject(input) {
  const value = typeof input === "string" ? parseJson(input) : input;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sessionId(value) {
  const text = typeof value === "string" ? value : Number.isSafeInteger(value) ? String(value) : "";
  return /^[\w.:-]{1,160}$/.test(text) && safeText(text) === text ? text : null;
}

function terminalCall(name, input, sessions) {
  const kind = shellTool(name);
  if (!kind) return null;
  const args = inputObject(input);
  const id = kind === "write_stdin" ? sessionId(args.session_id) : null;
  const origin = id ? sessions.get(id) : null;
  const command = kind === "write_stdin" ? origin?.command : kind === "exec_command" ? args.cmd : args.command;
  const cwd = kind === "write_stdin" ? origin?.cwd : ["Bash", "bash"].includes(kind) ? args.cwd : args.workdir;
  return {
    command: typeof command === "string" ? safeText(command, 8000) : null,
    cwd: typeof cwd === "string" ? safeText(cwd, 2000) : null,
    state: "pending",
    exitCode: null,
    sessionId: id,
  };
}

// Only runner metadata is execution evidence. The output body may quote these
// same phrases (or be entirely hostile), so never scan it for process state.
function runnerResult(content) {
  const parsed = typeof content === "string" ? parseJson(content) : content;
  if (parsed && !Array.isArray(parsed) && typeof parsed.output === "string" &&
      Number.isFinite(parsed.wall_time_seconds) && parsed.wall_time_seconds >= 0) {
    const exitCode = Number.isSafeInteger(parsed.exit_code) ? parsed.exit_code : null;
    const id = sessionId(parsed.session_id);
    if (exitCode !== null || id !== null) return { state: exitCode !== null ? "exited" : "running", exitCode, sessionId: id };
  }
  if (typeof content !== "string") return null;
  const wrapper = /^Chunk ID: [\w-]+\r?\nWall time: \d+(?:\.\d+)? seconds\r?\nProcess (?:exited with code (-?\d+)|running with session ID ([\w.:-]+))\r?\n(?:Original token count: \d+\r?\n)?(?:Final output|Output):(?:\r?\n|$)/.exec(content);
  if (!wrapper) return null;
  const exitCode = wrapper[1] !== undefined ? Number(wrapper[1]) : null;
  const id = sessionId(wrapper[2]);
  if (exitCode !== null && !Number.isSafeInteger(exitCode) || exitCode === null && id === null) return null;
  return { state: exitCode !== null ? "exited" : "running", exitCode, sessionId: id };
}

function terminalResult(entry, content, sessions, background) {
  if (!entry.terminal) return;
  const kind = shellTool(entry.name);
  // Bash returns stdout directly, unlike the exec runner's metadata envelope.
  // A background request's return does not prove that its command has finished.
  const synchronous = ["Bash", "bash"].includes(kind);
  const evidence = synchronous ? null : runnerResult(content);
  const state = synchronous && !background ? "exited" : "unknown";
  entry.terminal = {
    ...entry.terminal,
    state: evidence?.state ?? state,
    exitCode: evidence?.exitCode ?? null,
    sessionId: evidence?.sessionId ?? entry.terminal.sessionId,
  };
  if (entry.terminal.sessionId) {
    sessions.delete(entry.terminal.sessionId);
    sessions.set(entry.terminal.sessionId, { command: entry.terminal.command, cwd: entry.terminal.cwd });
    if (sessions.size > MAX_TERMINAL_SESSIONS) sessions.delete(sessions.keys().next().value);
  }
}

function tool(id, name, input, at, sessions) {
  const terminal = terminalCall(name, input, sessions);
  return { id: `tool:${id}`, kind: "tool", name: safeText(name || "Tool", 160), input: safeText(input, 8000), text: null, at: isoOrNull(at), status: "observed", ...(terminal ? { terminal } : {}) };
}

function toolResult(entry, content, at, error, sessions, background = false) {
  const parsed = typeof content === "string" ? parseJson(content) : content;
  const blocks = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.content) ? parsed.content : null;
  entry.text = safeText(blocks ? textContent(blocks) || "[Non-text output]" : content);
  terminalResult(entry, blocks ? textContent(blocks) : content, sessions, background);
  error = error || parsed?.isError === true || entry.terminal?.exitCode != null && entry.terminal.exitCode !== 0;
  entry.status = error ? "failed" : "completed";
  entry.resultAt = isoOrNull(at);
}

/** Only user-visible text and tool events; reasoning/thinking and system prompts are excluded. */
export function localContent(records, agent) {
  const entries = [];
  const tools = new Map();
  const terminalSessions = new Map();
  const backgroundCalls = new Set();
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
    const t = tool(id, name, input, at, terminalSessions);
    if (inputObject(input).run_in_background === true) backgroundCalls.add(String(id));
    else backgroundCalls.delete(String(id));
    tools.set(String(id), t);
    entries.push(t);
    activity = { label: `Called ${t.name}`, detail: t.input.slice(0, 240), at: t.at, status: "observed" };
  };
  const result = (id, content, at, error = false) => {
    if (!id) return;
    let t = tools.get(String(id));
    if (!t) {
      t = tool(id, "Tool result", null, at, terminalSessions);
      tools.set(String(id), t);
      entries.push(t);
    }
    toolResult(t, content, at, error, terminalSessions, backgroundCalls.has(String(id)));
    activity = { label: `${t.name} ${t.status === "failed" ? "failed" : "returned"}`, detail: t.text.slice(0, 240), at: t.resultAt ?? t.at, status: t.status };
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
  const terminalSessions = new Map();
  for (const row of [...rows].sort((a, b) => a.ordinal - b.ordinal)) {
    if (row.is_system || row.role === "system") continue;
    const m = message(row.role, typeof row.content === "string" ? row.content : "", row.timestamp);
    if (m) entries.push({ ...m, id: `archive-message:${row.ordinal}`, ordinal: row.ordinal });
    for (const t of Array.isArray(row.tool_calls) ? row.tool_calls : []) {
      if (!t.tool_use_id) continue;
      const entry = tool(t.tool_use_id, t.tool_name, t.input_json, row.timestamp, terminalSessions);
      if (typeof t.result_content === "string") {
        // Archive rows timestamp the message/call, not the tool result.
        toolResult(entry, t.result_content, null, false, terminalSessions, inputObject(t.input_json).run_in_background === true);
      }
      entries.push({ ...entry, ordinal: row.ordinal });
    }
  }
  return entries;
}

