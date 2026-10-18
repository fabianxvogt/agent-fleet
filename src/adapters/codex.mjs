import { join } from "node:path";
import { edge, node } from "../model.mjs";
import { readTurnState } from "../attention.mjs";
import { fileCache, isoOrNull, listDir, mapConcurrent, parseJson, projectName, readHeadRecords, readTailRecords, statSafe } from "../util.mjs";
import { readFile } from "node:fs/promises";

/**
 * OpenAI Codex, CLI and desktop app (ChatGPT.app runs `codex app-server`).
 *  ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
 *      line 1 session_meta: id, cwd, originator, source.subagent.thread_spawn {parent_thread_id, agent_role, agent_nickname}
 *      event_msg task_started / task_complete / turn_aborted mark turn lifecycle
 *  ~/.codex/session_index.jsonl   thread titles (thread_name)
 * A live codex process keeps the rollout files of its loaded threads open; that is our liveness signal.
 */

const WORKING_MS = 3 * 60_000;
const READ_CONCURRENCY = 8;
const SURFACES = { codex_work_desktop: "app", "Codex Desktop": "app", codex_cli_rs: "cli", codex_exec: "exec", codex_vscode: "ide" };

export function createCodexAdapter() {
  const headers = new Map(); // path -> parsed header (immutable)
  const tails = fileCache();
  const titles = { mtimeMs: -1, map: new Map() };

  async function threadTitles(ctx) {
    const path = join(ctx.home, ".codex", "session_index.jsonl");
    const st = await statSafe(path);
    if (!st) return titles.map;
    if (st.mtimeMs !== titles.mtimeMs) {
      const map = new Map();
      for (const line of (await readFile(path, "utf8")).split("\n")) {
        const r = parseJson(line);
        if (r?.id && r.thread_name) map.set(r.id, r.thread_name);
      }
      titles.map = map;
      titles.mtimeMs = st.mtimeMs;
    }
    return titles.map;
  }

  async function candidateFiles(ctx) {
    const root = join(ctx.home, ".codex", "sessions");
    const files = new Set();
    const days = Math.ceil(ctx.windowMs / 86_400_000) + 1;
    const dirs = [];
    for (let i = 0; i <= days; i++) {
      const d = new Date(ctx.now - i * 86_400_000);
      const dir = join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
      dirs.push(dir);
    }
    const entries = await mapConcurrent(dirs, READ_CONCURRENCY, async (dir) => {
      ctx.signal?.throwIfAborted();
      return (await listDir(dir)).filter((f) => f.name.endsWith(".jsonl")).map((f) => join(dir, f.name));
    });
    for (const path of entries.flat()) files.add(path);
    for (const path of ctx.openFileOwners.keys()) if (path.startsWith(root)) files.add(path);
    return [...files];
  }

  async function header(path) {
    if (headers.has(path)) return headers.get(path);
    const [meta, ...rest] = await readHeadRecords(path, 8, 4 * 1024 * 1024);
    if (meta?.type !== "session_meta") return null;
    const p = meta.payload ?? {};
    const spawn = p.source?.subagent?.thread_spawn ?? null;
    const ctxRec = rest.find((r) => r.type === "turn_context");
    const h = {
      id: p.id ?? p.session_id,
      cwd: p.cwd ?? null,
      originator: p.originator ?? null,
      startedAt: isoOrNull(p.timestamp ?? meta.timestamp),
      parentId: spawn?.parent_thread_id ?? p.parent_thread_id ?? null,
      role: spawn?.agent_role ?? p.agent_role ?? null,
      nickname: spawn?.agent_nickname ?? p.agent_nickname ?? null,
      depth: spawn?.depth ?? 0,
      model: ctxRec?.payload?.model ?? null,
      cliVersion: p.cli_version ?? null,
    };
    if (h.id) headers.set(path, h);
    return h;
  }

  async function lifecycle(path, st, isSubagent) {
    return tails.get(path, st, async () => {
      const tail = await readTailRecords(path, st.size, 64 * 1024);
      let model = null;
      for (const r of tail) {
        if (r.type === "turn_context" && r.payload?.model) model = r.payload.model;
      }
      return { ...readTurnState(tail, "codex", st.mtimeMs, { humanAudience: !isSubagent }), model };
    });
  }

  return {
    id: "codex",
    label: "Codex",
    async collect(ctx) {
      const nodes = [];
      const edges = [];
      const [names, files] = await Promise.all([threadTitles(ctx), candidateFiles(ctx)]);
      const sessions = await mapConcurrent(files, READ_CONCURRENCY, async (path) => {
        ctx.signal?.throwIfAborted();
        const st = await statSafe(path);
        if (!st) return null;
        const ownerPid = ctx.openFileOwners.get(path) ?? null;
        if (!ownerPid && ctx.now - st.mtimeMs > ctx.windowMs) return null;
        const h = await header(path);
        if (!h?.id) return null;
        const lc = await lifecycle(path, st, Boolean(h.parentId));
        const fresh = ctx.now - st.mtimeMs < WORKING_MS;
        let status;
        if (lc.phase === "failed") status = "failed";
        else if (["question", "approval"].includes(lc.attention?.kind)) status = "waiting";
        else if (lc.phase === "active" && (ownerPid || fresh)) status = "working";
        else status = ownerPid ? "idle" : "done";
        const owner = ownerPid ? ctx.procs.get(ownerPid) : null;
        const id = `codex:${h.id}`;
        return {
          node: node({
            id,
            agent: "codex",
            kind: h.parentId ? "subagent" : "session",
            title: names.get(h.id) ?? h.nickname ?? `codex ${h.id.slice(-8)}`,
            role: h.role ?? (h.parentId ? "subagent" : null),
            status,
            attention: lc.attention,
            surface: SURFACES[h.originator] ?? h.originator,
            cwd: h.cwd,
            project: projectName(h.cwd),
            model: lc.model ?? h.model,
            pid: ownerPid,
            startedAt: h.startedAt,
            lastActivityAt: new Date(st.mtimeMs).toISOString(),
            agentsviewId: id,
            source: path,
            meta: { nickname: h.nickname, depth: h.depth, cliVersion: h.cliVersion, host: owner ? owner.comm.split("/").slice(-1)[0] : null },
          }),
          edge: h.parentId ? edge(`codex:${h.parentId}`, id, "spawn", { at: h.startedAt, label: h.nickname }) : null,
        };
      });
      for (const session of sessions) {
        if (!session) continue;
        nodes.push(session.node);
        if (session.edge) edges.push(session.edge);
      }
      const seen = new Set(nodes.map((n) => n.source));
      for (const p of headers.keys()) if (!seen.has(p)) headers.delete(p);
      tails.prune(seen);
      return { nodes, edges };
    },
  };
}
