import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Classify a process as a coding-agent runtime. Returns the agent name or null.
 * Matching is on the executable basename so helper apps (Claude.app, codex-router) are skipped.
 */
export function classifyProcess(comm, args) {
  const exe = basename(comm || "");
  if (exe === "claude") return "claude";
  // exec-server / mcp-server are helpers of a codex host, not sessions of their own
  if (exe === "codex") return /\b(exec-server|mcp-server)\b/.test(args) ? null : "codex";
  if (exe === "omp") return "omp";
  if (exe === "pi") return "pi";
  if (exe === "opencode") return "opencode";
  if (exe === "node" || exe === "bun") {
    if (/@anthropic-ai\/claude-code\/cli/.test(args)) return "claude";
    if (/@openai\/codex\/bin/.test(args)) return "codex";
    if (/oh-my-pi|\/bin\/omp\b/.test(args)) return "omp";
    if (/pi-coding-agent\/dist\/cli|\/bin\/pi\b/.test(args)) return "pi";
    if (/opencode-ai|\/bin\/opencode\b/.test(args)) return "opencode";
  }
  return null;
}

const CANDIDATE_EXES = new Set(["claude", "codex", "omp", "pi", "opencode", "node", "bun"]);

/** Claude's registry uses the C-locale UTC `ps lstart` string as process identity. */
export function processStartToken(value) {
  if (typeof value !== "string") return null;
  const token = value.trim();
  if (!/^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/.test(token)) return null;
  const ms = Date.parse(`${token} UTC`);
  if (!Number.isFinite(ms)) return null;
  // Date.parse normalizes some invalid dates and ignores weekday; require the exact ps spelling.
  const [weekday, day, month, year, time] = new Date(ms).toUTCString().split(" ");
  const canonical = `${weekday.slice(0, -1)} ${month} ${String(Number(day)).padStart(2, " ")} ${time} ${year}`;
  return canonical === token ? token : null;
}

/** Full table of pid/ppid/comm; args are fetched only for executables that may be agents. */
async function psTable(runStage, signal) {
  const opts = { maxBuffer: 64 * 1024 * 1024, timeout: 10_000, signal,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" } };
  const { stdout } = await runStage("table", "ps", ["-axww", "-o", "pid=,ppid=,etime=,comm="], opts);
  const procs = new Map();
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    procs.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), etime: m[3], comm: m[4], args: "", procStart: null, agent: null, cwd: null, openFiles: [] });
  }
  const candidates = [...procs.values()].filter((p) => CANDIDATE_EXES.has(basename(p.comm))).map((p) => p.pid);
  if (candidates.length) {
    let out = "";
    try {
      ({ stdout: out } = await runStage("args", "ps", ["-ww", "-o", "pid=,lstart=,args=", "-p", candidates.join(",")], opts));
    } catch (error) {
      if (error.code !== 1 || error.killed || error.signal) throw error;
      out = error.stdout ?? ""; // a candidate exited in between
    }
    for (const line of out.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(.{24})\s+(.*)$/);
      const p = m && procs.get(Number(m[1]));
      if (p) { p.procStart = processStartToken(m[2]); p.args = m[3]; }
    }
  }
  for (const p of procs.values()) p.agent = classifyProcess(p.comm, p.args);
  return procs;
}

/** One lsof call for all agent processes: working directory plus open session files. */
async function annotateWithLsof(procs, pids, runStage, signal) {
  if (pids.length === 0) return;
  let stdout = "";
  try {
    // -b: never block on unreachable mounts; the timeout keeps a hung lsof from freezing the collector
    ({ stdout } = await runStage("files", "lsof", ["-b", "-nP", "-w", "-p", pids.join(","), "-Fpfn"], { maxBuffer: 64 * 1024 * 1024, timeout: 10_000, signal }));
  } catch (error) {
    if (error.code !== 1 || error.killed || error.signal) throw error;
    stdout = error.stdout ?? ""; // lsof exits 1 when some pid vanished; output is still usable
  }
  let current = null;
  let fd = null;
  for (const line of stdout.split("\n")) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") current = procs.get(Number(value)) ?? null;
    else if (tag === "f") fd = value;
    else if (tag === "n" && current) {
      if (fd === "cwd") current.cwd = value;
      else if (value.endsWith(".jsonl") || value.endsWith("state.json")) current.openFiles.push(value);
    }
  }
}

export async function snapshotProcesses({ run: runCommand = run, signal, now = () => performance.now() } = {}) {
  const timings = { tableMs: 0, argsMs: 0, filesMs: 0 };
  async function runStage(stage, command, argv, options) {
    const started = now();
    try {
      const result = await runCommand(command, argv, options);
      timings[`${stage}Ms`] = Math.max(0, now() - started);
      return result;
    } catch (error) {
      timings[`${stage}Ms`] = Math.max(0, now() - started);
      // Diagnostics contain no arguments or paths and must never replace the original failure.
      try {
        error.processStage = stage;
        error.processTimings = { ...timings };
      } catch { /* A subprocess runner may return an immutable error. */ }
      throw error;
    }
  }
  const procs = await psTable(runStage, signal);
  const agentPids = [...procs.values()].filter((p) => p.agent).map((p) => p.pid);
  // Claude reports its own cwd and session id in ~/.claude/sessions, so lsof (slow per pid) skips it.
  await annotateWithLsof(procs, agentPids.filter((pid) => procs.get(pid).agent !== "claude"), runStage, signal);
  const openFileOwners = new Map(); // path -> pid
  for (const pid of agentPids) for (const f of procs.get(pid).openFiles) openFileOwners.set(f, pid);
  return { procs, agentPids, openFileOwners, timings };
}

/** Ancestor pids, nearest first, stopping at launchd. */
export function ancestors(procs, pid, limit = 40) {
  const out = [];
  let cur = procs.get(pid);
  while (cur && cur.ppid > 1 && out.length < limit) {
    out.push(cur.ppid);
    cur = procs.get(cur.ppid);
  }
  return out;
}
