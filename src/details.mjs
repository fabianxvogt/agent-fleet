import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { archiveContent, localContent } from "./session-content.mjs";
import { readTailRecords } from "./util.mjs";

const PAGE_SIZE = 40;
const TAIL_BYTES = 1024 * 1024;
const MAX_RESPONSE = 4 * 1024 * 1024;
const privateContext = (path = "") => /(?:^|[/\\])body-os(?:[/\\]|$)/i.test(path);
const resolvedPrivateContext = async (path) => privateContext(path) || Boolean(path && privateContext(await realpath(path).catch(() => path)));
const inside = (path, root) => { const r = relative(root, path); return r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r); };

export function createDetailsService(config, { fetcher = fetch, now = Date.now } = {}) {
  const cache = new Map();
  const pending = new Map();
  function remember(key, value) {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > 24) cache.delete(cache.keys().next().value);
    return value;
  }

  async function local(n) {
    const path = n.transcript ?? n.source;
    if (!path?.endsWith(".jsonl")) return { state: "unavailable", entries: [], activity: null };
    const roots = {
      claude: join(config.home, ".claude", "projects"), codex: join(config.home, ".codex", "sessions"),
      omp: join(config.home, ".omp", "agent", "sessions"), pi: join(config.home, ".pi", "agent", "sessions"),
      fleet: n.kind === "worker" && n.cwd ? join(n.cwd, ".fleet") : null,
    };
    const root = roots[n.agent];
    if (!root) return { state: "unavailable", entries: [], activity: null };
    try {
      const [file, allowed] = await Promise.all([realpath(path), realpath(root)]);
      if (!inside(file, allowed) || privateContext(file)) return { state: "restricted", entries: [], activity: null };
      const st = await stat(file);
      if (!st.isFile()) return { state: "unavailable", entries: [], activity: null };
      const key = `local:${file}`;
      const hit = cache.get(key);
      if (hit?.size === st.size && hit.mtime === st.mtimeMs) return hit.value;
      const records = await readTailRecords(file, st.size, TAIL_BYTES);
      const content = localContent(records, n.agent);
      const value = { ...content, state: "available", updatedAt: st.mtime.toISOString(), truncated: st.size > TAIL_BYTES || content.truncated };
      remember(key, { size: st.size, mtime: st.mtimeMs, value });
      return value;
    } catch { return { state: "unavailable", entries: [], activity: null }; }
  }

  async function request(base, path, query = {}) {
    const url = new URL(path, base);
    for (const [k, value] of Object.entries(query)) if (value !== null) url.searchParams.set(k, value);
    const response = await fetcher(url, { signal: AbortSignal.timeout(3500), redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error("Archive request failed");
      error.status = response.status;
      throw error;
    }
    // Enforce the limit while receiving, including responses without Content-Length.
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE) throw new Error("Archive response too large");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  async function archive(n, before, revision) {
    if (!n.agentsviewId) return { state: "unavailable", entries: [], hasMore: false };
    let base;
    try {
      base = new URL(config.agentsviewUrl);
      if (base.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) || base.username || base.password) throw new Error();
    } catch { return { state: "unavailable", entries: [], hasMore: false }; }
    const key = `archive:${n.id}:${n.agentsviewId}:${n.cwd}:${before}:${revision}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < 3000) return hit.value;
    try {
      const path = `/api/v1/sessions/${encodeURIComponent(n.agentsviewId)}`;
      const session = await request(base, path);
      // A stale/incorrect adapter ID must not display another session's transcript.
      if (session.id !== n.agentsviewId || await resolvedPrivateContext(session.cwd) || n.cwd && session.cwd && resolve(n.cwd) !== resolve(session.cwd)) {
        return { state: "mismatch", entries: [], hasMore: false };
      }
      const data = await request(base, `${path}/messages`, { limit: PAGE_SIZE, direction: "desc", from: before, expected_revision: revision });
      if (!Array.isArray(data.messages)) throw new Error("Unsupported archive response");
      const rows = data.messages.slice(0, PAGE_SIZE);
      const ordinals = rows.map((m) => m.ordinal).filter((v) => Number.isSafeInteger(v) && v >= 0);
      const oldest = ordinals.length ? Math.min(...ordinals) : 0;
      const value = { state: "available", entries: archiveContent(rows), hasMore: rows.length === PAGE_SIZE && oldest > 0, before: oldest > 0 ? oldest - 1 : null, revision: typeof data.transcript_revision === "string" ? data.transcript_revision : null };
      remember(key, { at: now(), value });
      return value;
    } catch (error) {
      const state = error.status === 404 ? "not-indexed" : error.status === 409 ? "changed" : "offline";
      const value = { state, entries: [], hasMore: false };
      remember(key, { at: now(), value });
      return value;
    }
  }

  return {
    async get(n, { before = null, revision = null } = {}) {
      if (await resolvedPrivateContext(n.cwd) || privateContext(n.source) || privateContext(n.transcript)) {
        return { id: n.id, observedAt: new Date(now()).toISOString(), local: { state: "restricted", entries: [], activity: null }, archive: { state: "restricted", entries: [], hasMore: false } };
      }
      const key = JSON.stringify([n.id, n.source, n.transcript, n.cwd, n.agentsviewId, before, revision]);
      if (pending.has(key)) return pending.get(key);
      if (pending.size >= 8) throw Object.assign(new Error("Inspector busy; retry shortly"), { status: 503 });
      const work = Promise.all([before === null ? local(n) : Promise.resolve(null), archive(n, before, revision)])
        .then(([local, archive]) => ({ id: n.id, observedAt: new Date(now()).toISOString(), local, archive }))
        .finally(() => pending.delete(key));
      pending.set(key, work);
      return work;
    },
  };
}
