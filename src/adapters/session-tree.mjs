import { join } from "node:path";
import { edge, node } from "../model.mjs";
import { readTurnState } from "../attention.mjs";
import { fileCache, isoOrNull, listDir, projectName, readHeadRecords, readTailRecords, statSafe } from "../util.mjs";

/**
 * Shared reader for the pi session format (used by pi and oh-my-pi):
 *   <sessionsRoot>/<project-dir>/<ts>_<id>.jsonl           root session
 *   <sessionsRoot>/<project-dir>/<ts>_<id>/<Name>.jsonl    child (in-process subagent / L1)
 *   <sessionsRoot>/<project-dir>/<ts>_<id>/<Name>/<Sub>.jsonl  grandchild (L2)
 * Records: {type:"title"} (omp only), {type:"session", id, cwd, parentSession}, {type:"model_change"}, ...
 * Hierarchy comes from the directory layout, which is stable even when parentSession is a path.
 */

const WORKING_MS = 60_000;
const SWITCH_MS = 30_000; // a candidate this much newer than the previous pick means the process switched sessions

export function createSessionTreeAdapter({ id, label, agent, sessionsDir, roleForDepth, titleFallback }) {
  const heads = fileCache();
  const tails = fileCache();
  let previous = new Map(); // pid -> path from the last tick, so ties do not flip between sessions

  async function info(path, st, isSubagent = false) {
    const head = await heads.get(path, st, async () => {
      const recs = await readHeadRecords(path, 6, 32 * 1024);
      const session = recs.find((r) => r.type === "session") ?? {};
      const title = recs.find((r) => r.type === "title")?.title || null;
      const model = recs.find((r) => r.type === "model_change");
      return { sessionId: session.id ?? null, cwd: session.cwd ?? null, startedAt: isoOrNull(session.timestamp), title, model: modelName(model) };
    });
    const tail = await tails.get(path, st, async () => {
      const recs = await readTailRecords(path, st.size, 24 * 1024);
      let model = null;
      let title = null;
      for (const r of recs) {
        if (r.type === "model_change") model = modelName(r);
        if (r.type === "title_change" && r.title) title = r.title;
        if (r.type === "session_info" && r.name) title = r.name;
      }
      return { model, title, turn: readTurnState(recs, agent, st.mtimeMs, { humanAudience: !isSubagent }) };
    });
    return { ...head, model: tail.model ?? head.model, title: tail.title ?? head.title, turn: tail.turn };
  }

  /**
   * Which root session each live process is on. pi/omp open session files only briefly while appending
   * (and sometimes open other projects' files), so open files only matter when no session shares the cwd.
   * Among sessions in the process cwd touched since it started, the most recently written one wins: a
   * process that switches sessions (/new, resume) writes to the new file. The previous pick is kept only
   * while no other candidate is clearly newer, which stops ties from flapping without pinning an old session.
   */
  async function assignProcesses(ctx, roots) {
    const assigned = new Map(); // path -> pid
    const procs = [...ctx.procs.values()].filter((p) => p.agent === agent);
    for (const p of procs) {
      const startedMs = ctx.now - etimeMs(p.etime);
      const open = new Set(p.openFiles);
      const sameCwd = [];
      const openOnly = [];
      for (const r of roots) {
        if (assigned.has(r.path) || r.st.mtimeMs < startedMs - 5_000) continue;
        const i = await info(r.path, r.st);
        if (i.cwd && i.cwd === p.cwd) sameCwd.push(r);
        else if (open.has(r.path)) openOnly.push(r);
      }
      const pool = sameCwd.length ? sameCwd : openOnly;
      if (!pool.length) continue;
      const newest = pool.reduce((a, b) => (b.st.mtimeMs > a.st.mtimeMs ? b : a));
      const prev = pool.find((r) => r.path === previous.get(p.pid));
      const pick = prev && newest.st.mtimeMs - prev.st.mtimeMs < SWITCH_MS ? prev : newest;
      assigned.set(pick.path, p.pid);
    }
    previous = new Map([...assigned].map(([path, pid]) => [pid, path]));
    return assigned;
  }

  async function walkChildren(ctx, dir, parentId, depth, rootAlive, out) {
    for (const f of await listDir(dir)) {
      if (!f.isFile() || !f.name.endsWith(".jsonl") || f.name.startsWith(".")) continue;
      const path = join(dir, f.name);
      const st = await statSafe(path);
      if (!st) continue;
      const fresh = ctx.now - st.mtimeMs < WORKING_MS;
      if (!fresh && !rootAlive && ctx.now - st.mtimeMs > ctx.windowMs) continue;
      const i = await info(path, st, true);
      const name = f.name.slice(0, -6);
      const nid = `${agent}:${i.sessionId ?? `${parentId}/${name}`}`;
      out.nodes.push(
        node({
          id: nid,
          agent,
          kind: "subagent",
          title: i.title || name,
          role: roleForDepth(depth),
          status: statusFor(i.turn, rootAlive, fresh),
          attention: i.turn.attention,
          surface: "in-process",
          cwd: i.cwd,
          project: projectName(i.cwd),
          model: i.model,
          startedAt: i.startedAt,
          lastActivityAt: new Date(st.mtimeMs).toISOString(),
          agentsviewId: i.sessionId ? `${agent}:${i.sessionId}` : null,
          source: path,
          meta: { name, depth },
        }),
      );
      out.edges.push(edge(parentId, nid, "spawn", { at: i.startedAt, label: name }));
      const sub = join(dir, name);
      if ((await statSafe(sub))?.isDirectory()) await walkChildren(ctx, sub, nid, depth + 1, rootAlive, out);
    }
  }

  return {
    id,
    label,
    async collect(ctx) {
      const root = sessionsDir(ctx.home);
      const candidates = [];
      for (const proj of await listDir(root)) {
        if (!proj.isDirectory()) continue;
        const projDir = join(root, proj.name);
        for (const f of await listDir(projDir)) {
          if (f.isFile() && f.name.endsWith(".jsonl") && !f.name.startsWith(".")) candidates.push(join(projDir, f.name));
        }
      }
      const roots = (
        await Promise.all(
          candidates.map(async (path) => {
            const childDir = path.slice(0, -6);
            const [st, dirSt] = await Promise.all([statSafe(path), statSafe(childDir)]);
            return st ? { path, childDir, st, dirSt } : null;
          }),
        )
      ).filter(Boolean);
      const live = await assignProcesses(ctx, roots);
      const out = { nodes: [], edges: [] };
      for (const { path, childDir, st, dirSt } of roots) {
        const pid = live.get(path) ?? null;
        const lastMs = Math.max(st.mtimeMs, dirSt?.mtimeMs ?? 0);
        if (!pid && ctx.now - lastMs > ctx.windowMs) continue;
        const i = await info(path, st);
        if (!i.sessionId) continue;
        const nid = `${agent}:${i.sessionId}`;
        const fresh = ctx.now - st.mtimeMs < WORKING_MS;
        out.nodes.push(
          node({
            id: nid,
            agent,
            kind: "session",
            title: i.title || titleFallback(i),
            role: roleForDepth(0),
            status: statusFor(i.turn, Boolean(pid), Boolean(pid) && fresh),
            attention: i.turn.attention,
            surface: "cli",
            cwd: i.cwd,
            project: projectName(i.cwd),
            model: i.model,
            pid,
            startedAt: i.startedAt,
            lastActivityAt: new Date(st.mtimeMs).toISOString(),
            agentsviewId: nid,
            source: path,
            meta: {},
          }),
        );
        if (dirSt?.isDirectory()) await walkChildren(ctx, childDir, nid, 1, Boolean(pid), out);
      }
      const seen = new Set([...roots.map((r) => r.path), ...out.nodes.map((n) => n.source)]);
      heads.prune(seen);
      tails.prune(seen);
      return out;
    },
  };
}

function statusFor(turn, alive, fresh) {
  if (turn.phase === "failed") return "failed";
  if (["question", "approval"].includes(turn.attention?.kind)) return "waiting";
  if (turn.phase !== "completed" && fresh) return "working";
  return alive ? "idle" : "done";
}

/** ps etime "[[dd-]hh:]mm:ss" to milliseconds. */
export function etimeMs(etime = "0:0") {
  const [days, rest] = etime.includes("-") ? etime.split("-") : ["0", etime];
  const parts = rest.split(":").map(Number).reverse();
  return ((Number(days) * 24 + (parts[2] ?? 0)) * 3600 + (parts[1] ?? 0) * 60 + (parts[0] ?? 0)) * 1000;
}

function modelName(rec) {
  if (!rec) return null;
  if (rec.model) return String(rec.model).replace(/^[^/]+\//, "");
  if (rec.modelId) return rec.modelId;
  return null;
}
