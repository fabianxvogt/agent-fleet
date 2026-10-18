import { join } from "node:path";
import { edge, node } from "../model.mjs";
import { readTurnState } from "../attention.mjs";
import { ageMs, fileCache, isoOrNull, listDir, mapConcurrent, projectName, readHeadRecords, readJson, readTailRecords, statSafe, truncate } from "../util.mjs";

/**
 * Claude Code, CLI and desktop app.
 *  ~/.claude/sessions/<pid>.json                     live registry: pid, sessionId, status busy|idle, entrypoint
 *  ~/Library/Application Support/Claude/claude-code-sessions/<acct>/<org>/local_<id>.json
 *                                                    desktop metadata: title, cliSessionId, spawnedFrom,
 *                                                    sideSessionNotes (child reports), peerReceipts (messages)
 *  ~/.claude/projects/<dir>/<sessionId>.jsonl        transcripts
 *  ~/.claude/projects/<dir>/<sessionId>/subagents/agent-<id>.jsonl + .meta.json
 */

const SUBAGENT_ACTIVE_MS = 90_000;
const READ_CONCURRENCY = 8;
const SURFACES = { "claude-desktop": "desktop", cli: "cli", "sdk-cli": "sdk", "sdk-ts": "sdk", "sdk-py": "sdk" };

const nodeId = (sessionId) => `claude:${sessionId}`;

export function createClaudeAdapter() {
  const desktopCache = fileCache();
  const headCache = fileCache();
  const metaCache = fileCache();
  const childTails = fileCache();

  async function readRegistry(ctx) {
    const dir = join(ctx.home, ".claude", "sessions");
    const entries = (await listDir(dir)).filter((entry) => entry.name.endsWith(".json"));
    const records = await mapConcurrent(entries, READ_CONCURRENCY, async (entry) => {
      ctx.signal?.throwIfAborted();
      const data = await readJson(join(dir, entry.name));
      if (!data?.sessionId || !data.pid) return null;
      const proc = ctx.procs.get(data.pid);
      if (!proc || proc.agent !== "claude") return null; // stale registry file of a dead process
      return { ...data, file: join(dir, entry.name) };
    });
    return records.filter(Boolean);
  }

  async function readDesktop(ctx) {
    const root = join(ctx.home, "Library", "Application Support", "Claude", "claude-code-sessions");
    const accounts = (await listDir(root)).filter((acct) => acct.isDirectory());
    const orgs = (await mapConcurrent(accounts, READ_CONCURRENCY, async (acct) => {
      ctx.signal?.throwIfAborted();
      return (await listDir(join(root, acct.name))).filter((org) => org.isDirectory()).map((org) => join(root, acct.name, org.name));
    })).flat();
    const files = (await mapConcurrent(orgs, READ_CONCURRENCY, async (dir) => {
      ctx.signal?.throwIfAborted();
      return (await listDir(dir)).filter((f) => f.name.startsWith("local_") && f.name.endsWith(".json")).map((f) => join(dir, f.name));
    })).flat();
    const live = new Set(files);
    desktopCache.prune(live);
    const records = await mapConcurrent(files, READ_CONCURRENCY, async (file) => {
      ctx.signal?.throwIfAborted();
      const st = await statSafe(file);
      if (!st) return null;
      const d = await desktopCache.get(file, st, async () => {
        const raw = await readJson(file);
        if (!raw) return null;
        // keep only the small fields we need; desktop files carry large prompt snapshots
        return {
          localId: raw.sessionId,
          cliSessionId: raw.cliSessionId,
          title: raw.title,
          cwd: raw.cwd,
          model: raw.model,
          effort: raw.effort,
          permissionMode: raw.permissionMode,
          isArchived: Boolean(raw.isArchived),
          createdAt: isoOrNull(raw.createdAt),
          lastActivityAt: isoOrNull(raw.lastActivityAt),
          spawnedFrom: raw.spawnedFrom ? { localId: raw.spawnedFrom.sessionId, name: raw.spawnedFrom.name } : null,
          reports: (raw.sideSessionNotes ?? []).map((n) => ({ from: n.sessionId, title: n.title, at: isoOrNull(n.at), summary: truncate(n.report, 160) })),
          messages: (raw.peerReceipts ?? []).map((r) => ({ to: r.targetSessionId, at: isoOrNull(r.sentAt), delivery: r.delivery, read: Boolean(r.readAt) })),
          file,
        };
      });
      return d;
    });
    return records.filter(Boolean);
  }

  /** Index of transcript files: sessionId -> { path, dirPath }. */
  async function indexTranscripts(ctx) {
    const root = join(ctx.home, ".claude", "projects");
    const dirs = (await listDir(root)).filter((dir) => dir.isDirectory());
    const entries = await mapConcurrent(dirs, READ_CONCURRENCY, async (dir) => {
      ctx.signal?.throwIfAborted();
      const dirPath = join(root, dir.name);
      return (await listDir(dirPath)).filter((f) => f.name.endsWith(".jsonl")).map((f) => [f.name.slice(0, -6), { path: join(dirPath, f.name), dirPath }]);
    });
    return new Map(entries.flat());
  }

  const completeHeads = new Map(); // path -> head records; a transcript's first records never change

  async function headOf(path, st) {
    if (completeHeads.has(path)) return completeHeads.get(path);
    const head = await readHeadRecords(path, 30, 256 * 1024);
    if (head.length >= 30 || st.size > 256 * 1024) completeHeads.set(path, head);
    return head;
  }

  async function transcriptInfo(path, st) {
    if (!st) return null;
    return headCache.get(path, st, async () => {
      const head = await headOf(path, st);
      const first = head.find((r) => r.cwd) ?? {};
      const tail = await readTailRecords(path, st.size, 32 * 1024);
      // titles can be appended later (ai-title, custom-title), so look at head and tail
      const titleRec = [...head, ...tail].reverse().find((r) => r.type === "custom-title" || r.type === "ai-title" || r.type === "summary");
      const lastTs = [...tail].reverse().find((r) => r.timestamp)?.timestamp;
      const model = [...tail].reverse().find((r) => r.message?.model)?.message?.model;
      return {
        st,
        cwd: first.cwd ?? null,
        entrypoint: first.entrypoint ?? null,
        startedAt: isoOrNull(head.find((r) => r.timestamp)?.timestamp),
        lastActivityAt: isoOrNull(lastTs) ?? new Date(st.mtimeMs).toISOString(),
        title: titleRec?.customTitle ?? titleRec?.aiTitle ?? titleRec?.summary ?? null,
        model: model ?? null,
        turn: readTurnState(tail, "claude", st.mtimeMs),
      };
    });
  }

  async function subagents(ctx, sessionId, transcript, parentStatus) {
    const dir = join(transcript.dirPath, sessionId, "subagents");
    const out = { nodes: [], edges: [] };
    for (const f of await listDir(dir)) {
      ctx.signal?.throwIfAborted();
      if (!f.name.endsWith(".jsonl")) continue;
      const path = join(dir, f.name);
      const st = await statSafe(path);
      if (!st || ctx.now - st.mtimeMs > ctx.windowMs) continue;
      const agentId = f.name.slice(0, -6);
      const metaPath = join(dir, `${agentId}.meta.json`);
      const metaSt = await statSafe(metaPath);
      const meta = metaSt ? await metaCache.get(metaPath, metaSt, () => readJson(metaPath)) : null;
      const turn = await childTails.get(path, st, async () => readTurnState(await readTailRecords(path, st.size, 32 * 1024), "claude", st.mtimeMs, { humanAudience: false }));
      const active = ctx.now - st.mtimeMs < SUBAGENT_ACTIVE_MS && parentStatus !== "done";
      const asks = ["question", "approval"].includes(turn.attention?.kind);
      const status = turn.phase === "failed" ? "failed" : asks ? "waiting" : turn.phase === "completed" ? "done" : active ? "working" : "done";
      const id = `claude-sub:${sessionId}:${agentId}`;
      out.nodes.push(
        node({
          id,
          agent: "claude",
          kind: "subagent",
          title: meta?.description ?? agentId,
          role: meta?.agentType ?? "subagent",
          status,
          attention: turn.attention,
          surface: "in-process",
          cwd: transcript.cwd,
          project: projectName(transcript.cwd),
          model: meta?.model ?? null,
          lastActivityAt: new Date(st.mtimeMs).toISOString(),
          startedAt: new Date(st.birthtimeMs || st.ctimeMs).toISOString(),
          agentsviewId: agentId,
          source: path,
          meta: { spawnDepth: meta?.spawnDepth ?? 1, background: meta?.requestShape === "background" },
        }),
      );
      out.edges.push(edge(nodeId(sessionId), id, "spawn", { at: new Date(st.birthtimeMs || st.ctimeMs).toISOString() }));
    }
    return out;
  }

  return {
    id: "claude",
    label: "Claude Code",
    async collect(ctx) {
      const [registry, desktop, transcripts] = await Promise.all([readRegistry(ctx), readDesktop(ctx), indexTranscripts(ctx)]);
      const nodes = [];
      const edges = [];
      const byLocal = new Map(desktop.map((d) => [d.localId, d]));
      const liveBySession = new Map(registry.map((r) => [r.sessionId, r]));
      const desktopBySession = new Map(desktop.filter((d) => d.cliSessionId).map((d) => [d.cliSessionId, d]));

      // Which sessions to show: everything alive, plus anything touched inside the window.
      const ids = new Set(liveBySession.keys());
      for (const d of desktop) {
        if (d.cliSessionId && !d.isArchived && ageMs(ctx.now, d.lastActivityAt) < ctx.windowMs) ids.add(d.cliSessionId);
      }
      const observed = await mapConcurrent([...transcripts], READ_CONCURRENCY, async ([sid, t]) => {
        ctx.signal?.throwIfAborted();
        return [sid, await statSafe(t.path)];
      });
      const transcriptStats = new Map(observed);
      for (const [sid, st] of observed) if (st && ctx.now - st.mtimeMs < ctx.windowMs) ids.add(sid);

      // Each session reads its own children sequentially, so nested fan-out stays bounded.
      const sessions = await mapConcurrent([...ids], READ_CONCURRENCY, async (sid) => {
        ctx.signal?.throwIfAborted();
        const nodes = [];
        const edges = [];
        const live = liveBySession.get(sid);
        const d = desktopBySession.get(sid);
        const t = transcripts.get(sid);
        const info = t ? await transcriptInfo(t.path, transcriptStats.get(sid)) : null;
        const cwd = live?.cwd ?? d?.cwd ?? info?.cwd ?? null;
        const turn = info?.turn;
        const asks = ["question", "approval"].includes(turn?.attention?.kind);
        const status = turn?.phase === "failed" ? "failed" : asks ? "waiting" : live ? (live.status === "busy" ? "working" : "idle") : "done";
        const entry = live?.entrypoint ?? info?.entrypoint ?? (d ? "claude-desktop" : null);
        nodes.push(
          node({
            id: nodeId(sid),
            agent: "claude",
            kind: "session",
            title: d?.title ?? live?.name ?? info?.title ?? `claude ${sid.slice(0, 8)}`,
            status,
            attention: status === "working" ? null : turn?.attention ?? null,
            surface: SURFACES[entry] ?? entry,
            cwd,
            project: projectName(cwd),
            model: d?.model ?? info?.model ?? null,
            pid: live?.pid ?? null,
            startedAt: isoOrNull(live?.startedAt) ?? d?.createdAt ?? info?.startedAt ?? null,
            lastActivityAt: [isoOrNull(live?.statusUpdatedAt), d?.lastActivityAt, info?.lastActivityAt].filter(Boolean).sort().pop() ?? null,
            agentsviewId: sid,
            openUrl: d ? `claude://claude.ai/epitaxy/${d.localId}` : null,
            source: d?.file ?? live?.file ?? t?.path ?? null,
            transcript: t?.path ?? null,
            meta: { effort: d?.effort, permissionMode: d?.permissionMode, desktopId: d?.localId, kind: live?.kind },
          }),
        );

        if (d?.spawnedFrom) {
          const parent = byLocal.get(d.spawnedFrom.localId);
          if (parent?.cliSessionId) edges.push(edge(nodeId(parent.cliSessionId), nodeId(sid), "spawn", { label: d.spawnedFrom.name, at: d.createdAt }));
        }
        if (d) {
          for (const [target, list] of groupBy(d.messages, (m) => m.to)) {
            const td = byLocal.get(target);
            if (td?.cliSessionId) edges.push(edge(nodeId(sid), nodeId(td.cliSessionId), "message", { count: list.length, at: list.map((m) => m.at).sort().pop() }));
          }
          for (const [from, list] of groupBy(d.reports, (r) => r.from)) {
            const fd = byLocal.get(from);
            if (fd?.cliSessionId) edges.push(edge(nodeId(fd.cliSessionId), nodeId(sid), "report", { count: list.length, at: list.map((r) => r.at).sort().pop(), label: list.at(-1)?.summary }));
          }
        }
        if (t) {
          const sub = await subagents(ctx, sid, { ...t, cwd }, status);
          nodes.push(...sub.nodes);
          edges.push(...sub.edges);
        }
        return { nodes, edges };
      });
      for (const session of sessions) {
        nodes.push(...session.nodes);
        edges.push(...session.edges);
      }

      const seen = new Set([...nodes.map((n) => n.source), ...[...ids].map((sid) => transcripts.get(sid)?.path)].filter(Boolean));
      headCache.prune(seen);
      childTails.prune(new Set(nodes.filter((n) => n.kind === "subagent").map((n) => n.source)));
      metaCache.prune(new Set(nodes.filter((n) => n.kind === "subagent").map((n) => n.source.replace(/\.jsonl$/, ".meta.json"))));
      for (const p of completeHeads.keys()) if (!seen.has(p)) completeHeads.delete(p);

      // Parents referenced by edges but outside the window still need a node to hang on.
      const present = new Set(nodes.map((n) => n.id));
      for (const e of edges) {
        for (const id of [e.from, e.to]) {
          if (present.has(id)) continue;
          const sid = id.slice("claude:".length);
          const d = desktopBySession.get(sid);
          nodes.push(node({ id, agent: "claude", title: d?.title ?? `claude ${sid.slice(0, 8)}`, status: "done", surface: "desktop", cwd: d?.cwd, project: projectName(d?.cwd), lastActivityAt: d?.lastActivityAt, agentsviewId: sid, openUrl: d ? `claude://claude.ai/epitaxy/${d.localId}` : null }));
          present.add(id);
        }
      }
      return { nodes, edges };
    },
  };
}

function groupBy(list, key) {
  const map = new Map();
  for (const item of list ?? []) {
    const k = key(item);
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}
