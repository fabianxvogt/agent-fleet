import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { archiveContent, localContent } from "./session-content.mjs";
import { readTailRecords } from "./util.mjs";
import { createArtifactService } from "./artifacts.mjs";

const PAGE_SIZE = 40;
const TAIL_BYTES = 1024 * 1024;
const MAX_RESPONSE = 4 * 1024 * 1024;
const privateContext = (path = "") => /(?:^|[/\\])body-os(?:[/\\]|$)/i.test(path);
const resolvedPrivateContext = async (path) => privateContext(path) || Boolean(path && privateContext(await realpath(path).catch(() => path)));
const inside = (path, root) => { const r = relative(root, path); return r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
const fileVersion = (st) => `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
const isBranchScoped = (n) => ["omp", "pi", "fleet"].includes(n.agent);

export function createDetailsService(config, { fetcher = fetch, now = Date.now } = {}) {
  const artifacts = createArtifactService(config, { now });
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
      const key = `local:${n.agent}:${file}`;
      const hit = cache.get(key);
      if (hit?.version === fileVersion(st)) return hit.value;
      const records = await readTailRecords(file, st.size, TAIL_BYTES);
      const [after, resolved] = await Promise.all([stat(file), realpath(path)]);
      if (resolved !== file || fileVersion(after) !== fileVersion(st)) return { state: "unavailable", entries: [], activity: null };
      const content = localContent(records, n.agent);
      const sourceIdentity = { path: file, dev: String(st.dev), ino: String(st.ino) };
      const previous = hit?.value;
      const sameSource = previous?.sourceIdentity?.path === file && previous.sourceIdentity.dev === sourceIdentity.dev && previous.sourceIdentity.ino === sourceIdentity.ino;
      const branchIds = new Set(content.branch?.ancestry ?? []);
      const fingerprints = new Map(records.filter((record) => branchIds.has(record.id)).map((record) =>
        [record.id, createHash("sha256").update(JSON.stringify(record)).digest("hex")]));
      // A bounded tail can prove a straight append only when it still contains
      // the previously selected head. Missing ancestry must revoke retained UI
      // evidence, just as a fork, explicit clear, or source replacement does.
      const oldHeadIndex = content.branch?.ancestry?.indexOf(previous?.branch?.head) ?? -1;
      const ancestorSuffix = oldHeadIndex >= 0 ? content.branch.ancestry.slice(oldHeadIndex) : [];
      const sameAncestors = oldHeadIndex >= 0 && ancestorSuffix.every((id, index) => id === previous.branch.ancestry[index]) &&
        (st.size > TAIL_BYTES || ancestorSuffix.length === previous.branch.ancestry.length);
      const unchangedRecords = hit?.fingerprints && [...hit.fingerprints].every(([id, fingerprint]) => !fingerprints.has(id) || fingerprints.get(id) === fingerprint);
      const continuous = sameSource && st.size > hit.size && sameAncestors && unchangedRecords;
      const revision = isBranchScoped(n) ? continuous ? previous.revision : randomUUID() : undefined;
      const value = { ...content, state: "available", updatedAt: st.mtime.toISOString(), truncated: st.size > TAIL_BYTES || content.truncated,
        sourceIdentity, ...(revision ? { revision } : {}) };
      remember(key, { version: fileVersion(st), size: st.size, fingerprints, value });
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
      const value = { state: "available", entries: archiveContent(rows, n.agent), hasMore: rows.length === PAGE_SIZE && oldest > 0, before: oldest > 0 ? oldest - 1 : null, revision: typeof data.transcript_revision === "string" ? data.transcript_revision : null };
      remember(key, { at: now(), value });
      return value;
    } catch (error) {
      const state = error.status === 404 ? "not-indexed" : error.status === 409 ? "changed" : "offline";
      const value = { state, entries: [], hasMore: false };
      remember(key, { at: now(), value });
      return value;
    }
  }

  const publicContent = (content) => {
    if (!content) return content;
    const { sourceIdentity, branch, ...visible } = content;
    return { ...visible, entries: (content.entries ?? []).map(({ artifactCandidates, ...entry }) => entry) };
  };
  const service = {
    async get(n, { before = null, revision = null } = {}) {
      const branchScoped = isBranchScoped(n);
      if (await resolvedPrivateContext(n.cwd) || privateContext(n.source) || privateContext(n.transcript)) {
        artifacts.revoke(n.id);
        return { id: n.id, branchScoped, observedAt: new Date(now()).toISOString(), local: { state: "restricted", entries: [], activity: null }, archive: { state: "restricted", entries: [], hasMore: false }, artifacts: [], artifactState: "available" };
      }
      const key = JSON.stringify([n.id, n.source, n.transcript, n.cwd, n.agentsviewId, before, revision]);
      if (pending.has(key)) return pending.get(key);
      if (pending.size >= 8) throw Object.assign(new Error("Inspector busy; retry shortly"), { status: 503 });
      const work = Promise.all([before === null || branchScoped ? local(n) : Promise.resolve(null), archive(n, before, revision)])
        .then(async ([local, archive]) => {
          let files = [], artifactState = "available";
          try { files = await artifacts.register(n, { local, archive }); }
          catch { artifacts.revoke(n.id); artifactState = "unavailable"; }
          return { id: n.id, branchScoped, observedAt: new Date(now()).toISOString(), local: publicContent(local), archive: publicContent(archive), artifacts: files, artifactState };
        })
        .finally(() => pending.delete(key));
      pending.set(key, work);
      return work;
    },
    async artifact(n, id, options = {}) {
      // Refresh identity/revision revocations before serving retained evidence.
      await service.get(n);
      return artifacts.read(n, id, options);
    },
  };
  return service;
}
