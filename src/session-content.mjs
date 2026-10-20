import { createHash } from "node:crypto";
import { isoOrNull, parseJson } from "./util.mjs";
import { selectSessionBranch } from "./session-branch.mjs";

const MAX_TEXT = 16_000;
const MAX_TERMINAL_SESSIONS = 128;
const MAX_ARTIFACTS = 32;
const MAX_ARTIFACT_PATH = 4096;
const MAX_ARTIFACT_SOURCE = 1024 * 1024;
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

const escaped = (text, at) => {
  let slashes = 0;
  while (at > 0 && text[--at] === "\\") slashes++;
  return slashes % 2 === 1;
};

function artifactPath(value, markdown = false) {
  if (typeof value !== "string" || value.length > MAX_ARTIFACT_PATH * 3) return null;
  let path = value;
  if (markdown) {
    path = path.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
    // Anchors/line selectors belong to the link, not the local filename.
    path = path.split(/[?#]/, 1)[0].replace(/:\d+(?::\d+)?(?:-\d+)?$/, "");
    try { path = decodeURIComponent(path); } catch { return null; }
  }
  if (!path || path !== path.trim() || path.length > MAX_ARTIFACT_PATH ||
      /[\u0000-\u001f\u007f]/.test(path) || /^(?:[a-z][a-z\d+.-]*:|\/\/|[?#])/i.test(path) ||
      safeText(path, MAX_ARTIFACT_PATH) !== path) return null;
  return path;
}

// Association is lexical evidence only. Filesystem policy is applied by the
// artifact service; this parser neither resolves paths nor reads their targets.
function proseWithoutCode(source) {
  const text = source.slice(0, MAX_ARTIFACT_SOURCE);
  let fence = null;
  const lines = text.split("\n").map((line) => {
    // Lists and blockquotes can introduce their own indentation. Be conservative
    // about code containers rather than treating example links as file evidence.
    const marker = /^[ \t]*(?:>[ \t]*|(?:[-+*]|\d{1,9}[.)])[ \t]+)*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return " ".repeat(line.length);
    }
    if (marker && (marker[1][0] !== "`" || !marker[2].includes("`"))) {
      fence = marker[1];
      return " ".repeat(line.length);
    }
    return /^(?: {4}|\t)/.test(line) ? " ".repeat(line.length) : line;
  }).join("\n").replace(/<!--[\s\S]*?(?:-->|$)|<(pre|code|script|style|textarea)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, (code) => code.replace(/[^\n]/g, " "));
  const runs = [...lines.matchAll(/`+/g)].filter((m) => !escaped(lines, m.index));
  const next = new Map(), pairs = new Map();
  for (let i = runs.length - 1; i >= 0; i--) {
    const length = runs[i][0].length;
    if (next.has(length)) pairs.set(i, next.get(length));
    next.set(length, i);
  }
  const parts = [];
  let from = 0;
  for (let i = 0; i < runs.length; i++) {
    if (!pairs.has(i)) continue;
    const end = pairs.get(i), until = runs[end].index + runs[end][0].length;
    parts.push(lines.slice(from, runs[i].index), " ".repeat(until - runs[i].index));
    from = until;
    i = end;
  }
  parts.push(lines.slice(from));
  return parts.join("");
}

function linkDestination(text, start) {
  let i = start;
  while (text[i] === " " || text[i] === "\t") i++;
  const from = i, angle = text[i] === "<";
  if (angle) i++;
  const begin = i;
  let depth = 0, closed = false;
  for (; i < text.length && i - from <= MAX_ARTIFACT_PATH * 3; i++) {
    const c = text[i];
    if (c === "\n" || c === "\r") return null;
    if (c === "\\" && /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(text[i + 1] ?? "")) { i++; continue; }
    if (angle) {
      if (c === "<") return null;
      if (c === ">") { closed = true; break; }
    } else {
      if (/\s/.test(c) || c === ")" && depth === 0) break;
      if (c === "(" && ++depth > 32) return null;
      if (c === ")") depth--;
      if (c === "<" || c === ">") return null;
    }
  }
  if (angle && !closed || depth || i - from > MAX_ARTIFACT_PATH * 3) return null;
  const path = artifactPath(text.slice(begin, i), true);
  if (angle) i++;
  const beforeSpace = i;
  while (text[i] === " " || text[i] === "\t") i++;
  if (text[i] !== ")") {
    if (i === beforeSpace || !['"', "'", "("].includes(text[i])) return null;
    const close = text[i] === "(" ? ")" : text[i];
    const titleStart = i++;
    while (i < text.length && i - titleStart <= MAX_ARTIFACT_PATH && text[i] !== "\n" && !(text[i] === close && !escaped(text, i))) i++;
    if (i - titleStart > MAX_ARTIFACT_PATH) return null;
    if (text[i] !== close) return null;
    for (i++; text[i] === " " || text[i] === "\t"; i++);
  }
  return path && text[i] === ")" ? { path, end: i } : null;
}

function linkedArtifacts(source) {
  const text = proseWithoutCode(source), stack = [], labels = new Map();
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "[" && !escaped(text, i)) stack.push(i);
    if (text[i] === "]" && !escaped(text, i) && stack.length) labels.set(stack.pop(), i);
  }
  const candidates = new Map();
  for (const [start, end] of [...labels].sort((a, b) => a[0] - b[0])) {
    if (end - start > MAX_ARTIFACT_PATH * 2 || escaped(text, start) || text[end + 1] !== "(") continue;
    const destination = linkDestination(text, end + 2);
    if (destination) candidates.set(destination.path, { path: destination.path, kind: "linked" });
    if (candidates.size === MAX_ARTIFACTS) break;
  }
  return [...candidates.values()];
}

function writingTool(name) {
  const leaf = typeof name === "string" ? name.replace(/^(?:functions|tools)\./, "") : "";
  return ["Write", "Edit", "MultiEdit", "write", "edit", "apply_patch"].includes(leaf) ? leaf : null;
}

function writingArtifacts(name, input) {
  const leaf = writingTool(name);
  if (!leaf) return [];
  const args = inputObject(input);
  let paths = [];
  if (["Write", "Edit", "MultiEdit"].includes(leaf)) paths = [args.file_path];
  if (["write", "edit"].includes(leaf)) paths = [args.path];
  if (leaf === "apply_patch") {
    const patch = typeof input === "string" && !Object.keys(args).length ? input : args.patch ?? args.input;
    if (typeof patch !== "string" || patch.length > MAX_ARTIFACT_SOURCE ||
        !/^\*\*\* Begin Patch\r?\n/.test(patch) || !/\r?\n\*\*\* End Patch\s*$/.test(patch)) return [];
    let current = null;
    for (const line of patch.split(/\r?\n/)) {
      const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
      if (header) {
        if (current) paths.push(current);
        current = header[1] === "Delete" ? null : header[2];
      } else if (line.startsWith("*** Move to: ") && current) current = line.slice(13);
    }
    if (current) paths.push(current);
  }
  return [...new Set(paths.map((path) => artifactPath(path)).filter(Boolean))].slice(0, MAX_ARTIFACTS).map((path) => ({ path, kind: "written" }));
}

function noticeText(text) {
  return text.replace(/&(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[\da-f]{1,6});/gi, (entity) => {
    const named = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const code = entity[2].toLowerCase() === "x" ? Number.parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    return code > 31 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : " ";
  });
}

// Claude writes background lifecycle events as user-role text. Accept only the
// whole, flat runtime envelope; quoted examples and surrounding questions remain
// ordinary messages. This is deliberately not an XML evaluator.
function taskNotice(source, at, stableId) {
  const text = source.trim(), open = "<task-notification>", close = "</task-notification>";
  if (!text.startsWith(open) || !text.endsWith(close)) return null;
  let depth = 0;
  for (const tag of text.matchAll(/<\/?task-notification>/g)) {
    depth += tag[0] === open ? 1 : -1;
    // Two quoted examples can surround a real question. Only one outer
    // envelope may cover the entire message; nested malformed content is
    // handled by the generic notice below.
    if (depth === 0 && tag.index !== text.length - close.length) return null;
  }
  let label = "Background task update", detail = "A background task update was recorded. No readable summary is available.", noticeStatus = "unknown";
  if (text.length <= 64_000) {
    const body = text.slice(open.length, -close.length).trim(), fields = new Map();
    const field = /<([a-z][a-z-]{0,40})>([^<]*)<\/\1>\s*/gy;
    let offset = 0, match;
    while ((match = field.exec(body)) && match.index === offset) {
      const values = fields.get(match[1]) ?? [];
      values.push(noticeText(match[2].trim()));
      fields.set(match[1], values);
      offset = field.lastIndex;
    }
    const summaries = fields.get("summary") ?? [], statuses = fields.get("status") ?? [];
    if (offset === body.length && summaries.length === 1 && statuses.length === 1 && summaries[0] &&
        !/[<>]/.test(summaries[0])) {
      const status = statuses[0].toLowerCase(), ids = fields.get("task-id") ?? [];
      const known = { completed: "completed", failed: "failed", stopped: "stopped", running: "running", pending: "pending", queued: "pending" };
      noticeStatus = Object.hasOwn(known, status) ? known[status] : "unknown";
      label = {
        completed: "Background task completed", failed: "Background task failed", stopped: "Background task stopped",
        running: "Background task running", pending: "Background task queued", unknown: "Background task update",
      }[noticeStatus];
      const orphanCount = /^(\d{1,6}) background shell command tasks? (?:didn't|did not) finish before the previous session ended\b/i.exec(summaries[0]);
      if (noticeStatus === "stopped" && orphanCount && Number(orphanCount[1]) > 0 && ids.some((id) => id.startsWith("__orphan_summary"))) {
        const count = Number(orphanCount[1]);
        label = count === 1 ? "Background command stopped" : "Background commands stopped";
        detail = `${count} background command${count === 1 ? " was" : "s were"} marked stopped after the previous session ended. Completion was not confirmed.`;
      } else {
        detail = summaries[0].replace(/\s*\bTask (?:ids?|identifiers?)\s*:[\s\S]*$/i, "")
          .replace(/__orphan_summary[\w:.-]*/g, "");
        for (const id of ids.filter((id) => /^[\w.:/-]{1,160}$/.test(id)).sort((a, b) => b.length - a.length)) {
          detail = detail.replace(new RegExp(`(?<![\\w.-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.-])`, "g"), "");
        }
        detail = safeText(detail.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim(), 1000) || "A background task update was recorded.";
      }
    }
  }
  const time = isoOrNull(at);
  return { id: `notice:${stableId ?? createHash("sha1").update(JSON.stringify([time, noticeStatus, label, detail])).digest("hex")}`, kind: "notice", label, text: detail, at: time, noticeStatus };
}

function message(role, text, at, final = false, stableId = null, agent = null) {
  if (!["user", "assistant"].includes(role) || !text.trim()) return null;
  const notice = agent === "claude" ? taskNotice(text, at, stableId) : null;
  if (notice) return notice;
  const clean = safeText(text);
  const time = isoOrNull(at);
  const artifactCandidates = role === "assistant" ? linkedArtifacts(text) : [];
  const identity = [role, time, clean];
  if (artifactCandidates.length) identity.push(artifactCandidates);
  return { id: `message:${stableId ?? createHash("sha1").update(JSON.stringify(identity)).digest("hex")}`, kind: "message", role, text: clean, at: time, final, ...(artifactCandidates.length ? { artifactCandidates } : {}) };
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

function toolResult(entry, content, at, error, sessions, background = false, artifactCandidates = []) {
  const parsed = typeof content === "string" ? parseJson(content) : content;
  const blocks = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.content) ? parsed.content : null;
  entry.text = safeText(blocks ? textContent(blocks) || "[Non-text output]" : content);
  terminalResult(entry, blocks ? textContent(blocks) : content, sessions, background);
  error = error || parsed?.isError === true || parsed?.is_error === true || parsed?.success === false || entry.terminal?.exitCode != null && entry.terminal.exitCode !== 0;
  entry.status = error ? "failed" : "completed";
  entry.resultAt = isoOrNull(at);
  delete entry.artifactCandidates;
  const patch = writingTool(entry.name) === "apply_patch";
  // Codex's patch failures may be plain text without an error flag. Require its
  // canonical success envelope rather than treating every returned string as a write.
  if (!error && artifactCandidates.length && (!patch || /^Success\. Updated the following files:\r?\n[AMD] /.test(entry.text))) {
    entry.artifactCandidates = artifactCandidates;
  }
}

/** Only user-visible text and tool events; reasoning/thinking and system prompts are excluded. */
export function localContent(records, agent) {
  const entries = [];
  const tools = new Map();
  const terminalSessions = new Map();
  const backgroundCalls = new Set();
  const pendingArtifacts = new Map();
  let activity = null;
  let branch = null;
  const addMessage = (role, text, at, final, stableId) => {
    const m = message(role, text, at, final, stableId, agent);
    if (m) {
      entries.push(m);
      activity = m.kind === "notice"
        ? { kind: "notice", label: m.label, detail: m.text.slice(0, 220), at: m.at, status: m.noticeStatus === "unknown" ? "observed" : m.noticeStatus, noticeStatus: m.noticeStatus }
        : { label: role === "user" ? "Received a message" : "Posted a response", detail: m.text.slice(0, 220), at: m.at, status: "observed" };
    }
  };
  const call = (id, name, input, at, assistant = true) => {
    if (!id) return;
    const t = tool(id, name, input, at, terminalSessions);
    if (inputObject(input).run_in_background === true) backgroundCalls.add(String(id));
    else backgroundCalls.delete(String(id));
    tools.set(String(id), t);
    pendingArtifacts.set(String(id), assistant ? writingArtifacts(name, input) : []);
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
    toolResult(t, content, at, error, terminalSessions, backgroundCalls.has(String(id)), pendingArtifacts.get(String(id)));
    activity = { label: `${t.name} ${t.status === "failed" ? "failed" : "returned"}`, detail: t.text.slice(0, 240), at: t.resultAt ?? t.at, status: t.status };
  };

  ({ records, branch } = selectSessionBranch(records, agent));
  const canonicalCodex = records.some((r) => r.type === "response_item" && r.payload?.type === "message" && !["analysis", "reasoning"].includes(r.payload.channel ?? r.payload.phase));
  for (const r of records) {
    const at = r.timestamp;
    if (agent === "codex") {
      const p = r.payload ?? {};
      if (r.type === "response_item") {
        if (p.type === "message" && !["analysis", "reasoning"].includes(p.channel ?? p.phase)) addMessage(p.role, textContent(p.content), at, p.phase === "final", p.id);
        if (["function_call", "custom_tool_call"].includes(p.type)) call(p.call_id ?? p.id, p.name, p.arguments ?? p.input, at);
        if (["function_call_output", "custom_tool_call_output"].includes(p.type)) result(p.call_id, p.output, at, p.is_error || p.isError);
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
      if (["tool_use", "toolCall"].includes(c.type)) call(c.id, c.name, c.input ?? c.arguments, time, role === "assistant");
      if (c.type === "tool_result") result(c.tool_use_id, c.content, time, c.is_error);
    }
  }
  const unique = [...new Map(entries.map((e) => [e.id, e])).values()];
  return { entries: unique.slice(-120), activity, truncated: unique.length > 120, ...(branch ? { branch } : {}) };
}

export function archiveContent(rows, agent = null) {
  const entries = [];
  const terminalSessions = new Map();
  for (const row of [...rows].sort((a, b) => a.ordinal - b.ordinal)) {
    if (row.is_system || row.role === "system") continue;
    const m = message(row.role, typeof row.content === "string" ? row.content : "", row.timestamp, false, null, agent);
    if (m) entries.push({ ...m, id: `archive-${m.kind}:${row.ordinal}`, ordinal: row.ordinal });
    for (const t of Array.isArray(row.tool_calls) ? row.tool_calls : []) {
      if (!t.tool_use_id) continue;
      const entry = tool(t.tool_use_id, t.tool_name, t.input_json, row.timestamp, terminalSessions);
      if (typeof t.result_content === "string") {
        // Archive rows timestamp the message/call, not the tool result.
        toolResult(entry, t.result_content, null, t.is_error || t.isError, terminalSessions, inputObject(t.input_json).run_in_background === true, row.role === "assistant" ? writingArtifacts(t.tool_name, t.input_json) : []);
      }
      entries.push({ ...entry, ordinal: row.ordinal });
    }
  }
  return entries;
}

