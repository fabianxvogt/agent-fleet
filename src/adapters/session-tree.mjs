import { join } from "node:path";
import { edge, node } from "../model.mjs";
import { readTurnState } from "../attention.mjs";
import { fileCache, isoOrNull, listDir, projectName, readHeadRecords, readTailRecords, statSafe } from "../util.mjs";
import { readRelationObservations, resolveSessionRelations } from "./session-relations.mjs";

/**
 * Shared reader for the pi session format (used by pi and oh-my-pi):
 *   <sessionsRoot>/<project-dir>/<ts>_<id>.jsonl           root session
 *   <sessionsRoot>/<project-dir>/<ts>_<id>/<Name>.jsonl    child (in-process subagent / L1)
 *   <sessionsRoot>/<project-dir>/<ts>_<id>/<Name>/<Sub>.jsonl  grandchild (L2)
 * Records: {type:"title"} (omp only), {type:"session", id, cwd, parentSession}, {type:"model_change"}, ...
 * Directory layout supplies the baseline hierarchy. Verified OMP parentSession
 * paths correct flattened native children; launcher receipts identify managed
 * L1 sessions whose files sit alongside roots.
 */

const WORKING_MS = 60_000;
const SWITCH_MS = 30_000; // a candidate this much newer than the previous pick means the process switched sessions
const fileVersion = (st) => st ? `${st.dev}:${st.ino}:${st.ctimeMs}:${st.mtimeMs}:${st.size}` : null;

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
      const sessionId = typeof session.id === "string" && session.id.length > 0 && session.id.length <= 512
        && !/[\u0000-\u001f]/.test(session.id) ? session.id : null;
      return { sessionId, cwd: session.cwd ?? null, startedAt: isoOrNull(session.timestamp), title, model: modelName(model),
        parentSource: typeof session.parentSession === "string" ? session.parentSession : null };
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
      return { model, title, turn: readTurnState(recs, agent, st.mtimeMs),
        childTurn: readTurnState(recs, agent, st.mtimeMs, { humanAudience: false }),
        observations: agent === "omp" ? readRelationObservations(recs) : [] };
    });
    // A source replacement between the two bounded reads must not join one
    // file's identity to another file's communication evidence.
    const stable = agent !== "omp" || fileVersion(st) === fileVersion(await statSafe(path));
    return { ...head, model: tail.model ?? head.model, title: tail.title ?? head.title,
      turn: isSubagent ? tail.childTurn : tail.turn, childTurn: tail.childTurn,
      observations: stable ? tail.observations : [], parentSource: stable ? head.parentSource : null, stable };
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

  async function walkChildren(ctx, dir, parentId, depth, rootAlive, out, relations, nativeRoot) {
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
      if (agent === "omp" && i.sessionId && i.stable) relations.push({ id: nid, source: path, parentSource: i.parentSource,
        nativeRoot, nativeName: name, observations: i.observations });
      const sub = join(dir, name);
      if ((await statSafe(sub))?.isDirectory()) await walkChildren(ctx, sub, nid, depth + 1, rootAlive, out, relations, nativeRoot);
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
      // Managed L1 sessions live beside roots. A successful launcher receipt
      // with a known source path identifies them before process assignment, so
      // a recently written worker cannot steal its host's process anchor.
      const rootInfo = new Map();
      const rootRelations = [];
      let observedRoots = roots;
      if (agent === "omp") {
        const oldestStart = Math.min(...[...ctx.procs.values()].filter((p) => p.agent === agent).map((p) => ctx.now - etimeMs(p.etime)));
        observedRoots = roots.filter((r) => ctx.now - Math.max(r.st.mtimeMs, r.dirSt?.mtimeMs ?? 0) <= ctx.windowMs
          || r.st.mtimeMs >= oldestStart - 5000);
        const known = new Map(roots.map((r) => [r.path, r]));
        const selected = new Set(observedRoots.map((r) => r.path));
        let referenced = 0;
        for (const root of observedRoots) {
          if (ctx.signal?.aborted) throw new Error("Session collection stopped");
          const i = await info(root.path, root.st);
          rootInfo.set(root.path, i);
          if (!i.sessionId || !i.stable) continue;
          rootRelations.push({ id: `${agent}:${i.sessionId}`, source: root.path,
            parentSource: i.parentSource, nativeRoot: root.path, observations: i.observations });
          // A quiet managed worker may be older than the visible window. Only
          // inspect its already-discovered file when a recent structured receipt
          // references it; never scan all historical transcript tails.
          for (const observation of i.observations) {
            const at = Date.parse(observation.at);
            if (referenced >= 128 || !Number.isFinite(at) || at < ctx.now - ctx.windowMs || at > ctx.now) continue;
            const file = observation.sessionFile ?? (observation.outputFile?.endsWith(".l1-result.txt") ? observation.outputFile.slice(0, -".l1-result.txt".length) : null);
            if (known.has(file) && !selected.has(file)) {
              selected.add(file);
              observedRoots.push(known.get(file));
              referenced++;
            }
          }
        }
      }
      const rootResolution = agent === "omp" ? resolveSessionRelations(rootRelations, ctx) : null;
      const ownership = rootResolution?.ownership ?? new Map();
      const referencedIds = new Set([...ownership.keys(), ...(rootResolution?.edges ?? []).flatMap((e) => [e.from, e.to])]);
      const live = await assignProcesses(ctx, observedRoots.filter((root) => !ownership.has(`${agent}:${rootInfo.get(root.path)?.sessionId}`)));
      const out = { nodes: [], edges: [] };
      const relations = [];
      const rootPaths = new Map(rootRelations.map((r) => [r.id, r.source]));
      const ownerAlive = (id) => {
        const seen = new Set();
        while (id && !seen.has(id)) {
          if (live.has(rootPaths.get(id))) return true;
          seen.add(id);
          id = ownership.get(id);
        }
        return false;
      };
      for (const { path, childDir, st, dirSt } of observedRoots) {
        const pid = live.get(path) ?? null;
        const lastMs = Math.max(st.mtimeMs, dirSt?.mtimeMs ?? 0);
        if (agent !== "omp" && !pid && ctx.now - lastMs > ctx.windowMs) continue;
        const i = rootInfo.get(path) ?? await info(path, st);
        const owned = ownership.has(`${agent}:${i.sessionId}`);
        const rootAlive = Boolean(pid || owned && ownerAlive(`${agent}:${i.sessionId}`));
        if (!rootAlive && ctx.now - lastMs > ctx.windowMs && !referencedIds.has(`${agent}:${i.sessionId}`)) continue;
        if (!i.sessionId) continue;
        const nid = `${agent}:${i.sessionId}`;
        const fresh = ctx.now - st.mtimeMs < WORKING_MS;
        const turn = owned ? i.childTurn : i.turn;
        out.nodes.push(
          node({
            id: nid,
            agent,
            kind: owned ? "subagent" : "session",
            title: i.title || titleFallback(i),
            role: roleForDepth(owned ? 1 : 0),
            status: statusFor(turn, rootAlive, rootAlive && fresh),
            attention: turn.attention,
            surface: owned ? "in-process" : "cli",
            cwd: i.cwd,
            project: projectName(i.cwd),
            model: i.model,
            pid,
            startedAt: i.startedAt,
            lastActivityAt: new Date(st.mtimeMs).toISOString(),
            agentsviewId: nid,
            source: path,
            meta: owned ? { depth: 1 } : {},
          }),
        );
        if (agent === "omp" && i.stable) relations.push({ id: nid, source: path, parentSource: i.parentSource,
          nativeRoot: path, observations: i.observations });
        if (dirSt?.isDirectory()) await walkChildren(ctx, childDir, nid, owned ? 2 : 1, rootAlive, out, relations, path);
      }
      if (agent === "omp") {
        const resolved = resolveSessionRelations(relations, ctx);
        const byId = new Map(out.nodes.map((n) => [n.id, n]));
        out.edges = out.edges.filter((e) => !(e.kind === "spawn" && resolved.nativeParents.has(e.to)));
        for (const [childId, parentId] of resolved.nativeParents) {
          const child = byId.get(childId);
          out.edges.push(edge(parentId, childId, "spawn", { at: child.startedAt, label: "Started worker" }));
        }
        out.edges.push(...resolved.edges);
        const parents = new Map(out.edges.filter((e) => e.kind === "spawn").map((e) => [e.to, e.from]));
        for (const [child, parent] of resolved.ownership) parents.set(child, parent);
        const depths = new Map(out.nodes.filter((n) => n.kind === "session").map((n) => [n.id, 0]));
        for (const n of out.nodes) {
          if (n.kind !== "subagent") continue;
          const chain = [];
          const visited = new Set();
          let current = n.id;
          while (current && !depths.has(current) && !visited.has(current)) {
            chain.push(current);
            visited.add(current);
            current = parents.get(current);
          }
          if (!depths.has(current)) continue;
          let depth = depths.get(current);
          for (const id of chain.reverse()) {
            depths.set(id, ++depth);
            const child = byId.get(id);
            if (child) { child.role = roleForDepth(depth); child.meta = { ...child.meta, depth }; }
          }
        }
      }
      const seen = new Set([...observedRoots.map((r) => r.path), ...out.nodes.map((n) => n.source)]);
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
