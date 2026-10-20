import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { safeText } from "./session-content.mjs";

const TTL = 30 * 60 * 1000;
const MAX_FILES = 128;
const MAX_SESSIONS = 24;
const MAX_ENTRIES = 400;
const MAX_TEXT = 64 * 1024;
const MAX_BINARY = 8 * 1024 * 1024;
const inside = (file, root) => { const r = relative(root, file); return r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
const privatePath = (file) => /(?:^|[/\\])(?:body-os|sokra)(?:[/\\]|$)/i.test(file);
const credentialPath = (file) => /(?:^|[/\\])(?:\.env(?:[.][^/\\]*)?|\.ssh|\.aws|\.gnupg|\.kube|\.azure|\.git|\.npmrc|\.netrc|\.pypirc|\.credentials(?:\.[^/\\]*)?|credentials(?:\.[^/\\]*)?|secrets?(?:\.[^/\\]*)?|auth\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)(?:[/\\]|$)/i.test(file)
  || /\.(?:pem|key|p12|pfx)$/i.test(file) || /[/\\]\.docker[/\\]config\.json$/i.test(file);
const deniedPath = (file) => privatePath(file) || credentialPath(file);
const identity = (st) => `${st.dev}:${st.ino}:${st.birthtimeNs}`;
const fingerprint = (st) => `${identity(st)}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
const failure = (state, reason) => ({ state, reason });
const fileError = (error) => failure(["ENOENT", "ENOTDIR"].includes(error?.code) ? "missing" : "restricted", "This file is unavailable.");
const TEXT_EXTENSIONS = new Set(".txt .md .markdown .json .jsonl .csv .tsv .log .yaml .yml .toml .ini .cfg .conf .xml .html .htm .svg .css .scss .sass .less .js .mjs .cjs .jsx .ts .tsx .py .rb .go .rs .c .h .cc .cpp .hpp .java .kt .swift .sh .bash .zsh .fish .sql .r .tex .bib .rst .diff .patch .svelte .vue .astro .graphql .gql .gitignore .gitattributes .editorconfig".split(" "));
const DOCUMENT_TYPES = new Map([[".pdf", "application/pdf"], [".doc", "application/msword"], [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"], [".xls", "application/vnd.ms-excel"], [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], [".ppt", "application/vnd.ms-powerpoint"], [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"]]);
const IMAGE_TYPES = new Map([[".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".gif", "image/gif"], [".webp", "image/webp"]]);
function typeOf(file) {
  const ext = extname(file).toLowerCase();
  if (IMAGE_TYPES.has(ext)) return { kind: "image", contentType: IMAGE_TYPES.get(ext) };
  if (DOCUMENT_TYPES.has(ext)) return { kind: "document", contentType: DOCUMENT_TYPES.get(ext) };
  if (TEXT_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(basename(file).toLowerCase()) || /^(?:readme|license|dockerfile|makefile)$/i.test(basename(file))) return { kind: "text", contentType: "text/plain; charset=utf-8" };
  return { kind: "unsupported", contentType: "application/octet-stream" };
}
function imageMatches(body, contentType) {
  if (contentType === "image/png") return body.length >= 24 && body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && body.toString("ascii", 12, 16) === "IHDR";
  if (contentType === "image/jpeg") return body.length >= 4 && body[0] === 255 && body[1] === 216 && body[2] === 255;
  if (contentType === "image/gif") return body.length >= 13 && /^(?:GIF87a|GIF89a)$/.test(body.toString("ascii", 0, 6));
  return contentType === "image/webp" && body.length >= 16 && body.toString("ascii", 0, 4) === "RIFF" && body.toString("ascii", 8, 12) === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(body.toString("ascii", 12, 16));
}

// Resolve one component at a time: an escaping or private symlink target is
// rejected before its existence is inspected. Never crawl workspace contents.
async function checkedPath(file, { boundary = null, deny = privatePath } = {}) {
  let path = resolve(file);
  let links = 0;
  for (;;) {
    if (deny(path) || boundary && !inside(path, boundary)) return failure("restricted", "This path is outside the allowed workspace or is protected.");
    const root = parse(path).root;
    const parts = relative(root, path).split(sep).filter(Boolean);
    let current = root;
    let restart = false;
    let st;
    try {
      for (let i = 0; i < parts.length; i++) {
        current = join(current, parts[i]);
        if (deny(current)) return failure("restricted", "This path is protected.");
        st = await lstat(current, { bigint: true });
        if (st.isSymbolicLink()) {
          if (++links > 40) return failure("restricted", "This path cannot be resolved safely.");
          const target = resolve(dirname(current), await readlink(current));
          if (deny(target) || boundary && !inside(target, boundary)) return failure("restricted", "This path is outside the allowed workspace or is protected.");
          path = resolve(target, ...parts.slice(i + 1));
          restart = true;
          break;
        }
        if (i < parts.length - 1 && !st.isDirectory()) return failure("missing", "This file is unavailable.");
      }
      if (!restart) {
        // realpath also normalizes the on-disk spelling on case-insensitive
        // filesystems. Lexical casing alone must not bypass the home boundary.
        const canonical = await realpath(path);
        if (deny(canonical) || boundary && !inside(canonical, boundary)) return failure("restricted", "This path is outside the allowed workspace or is protected.");
        if (canonical !== path) {
          if (++links > 40) return failure("restricted", "This path cannot be resolved safely.");
          path = canonical;
          continue;
        }
        return { state: "available", path, stat: st ?? await lstat(root, { bigint: true }) };
      }
    } catch (error) { return fileError(error); }
  }
}

/** Read-only, bounded artifact registry. Paths are internal; callers only receive opaque IDs. */
export function createArtifactService(config, { now = Date.now } = {}) {
  const sessions = new Map();
  const homes = [...new Set([config.home, homedir()].filter((p) => typeof p === "string" && isAbsolute(p)).map((p) => resolve(p)))];
  const broadRoot = (root, knownHomes = homes) => root === parse(root).root || knownHomes.some((home) => inside(home, root));
  const sessionKey = (node) => JSON.stringify([node.id, node.agent, node.source ?? null, node.transcript ?? null, node.cwd ?? null, node.agentsviewId ?? null]);
  async function context(node) {
    const literal = sessionKey(node);
    if ([node.cwd, node.source, node.transcript].some((p) => typeof p === "string" && privatePath(p))) return { key: `${literal}:restricted`, state: "restricted" };
    const sources = [];
    const sourceFiles = [];
    for (const source of new Set([node.source, node.transcript].filter((p) => typeof p === "string" && p))) {
      if (!isAbsolute(source)) { sources.push([source, "unavailable"]); continue; }
      const found = await checkedPath(source);
      if (found.state === "restricted") return { key: `${literal}:restricted`, state: "restricted" };
      sources.push(found.state === "available" ? [found.path, identity(found.stat)] : [source, found.state]);
      if (found.state === "available" && found.stat.isFile()) sourceFiles.push({ original: source, path: found.path, dev: String(found.stat.dev), ino: String(found.stat.ino) });
    }
    const key = `${literal}:${JSON.stringify(sources)}`;
    if (typeof node.cwd !== "string" || !isAbsolute(node.cwd) || broadRoot(resolve(node.cwd))) return { key, state: "restricted" };
    const root = await checkedPath(node.cwd);
    const resolvedHomes = await Promise.all(homes.map((home) => checkedPath(home)));
    const canonicalHomes = [...homes, ...resolvedHomes.filter((home) => home.state === "available").map((home) => home.path)];
    if (root.state !== "available" || !root.stat.isDirectory() || broadRoot(root.path, canonicalHomes)) return { key, state: "restricted" };
    return { state: "available", key: `${key}:${root.path}:${identity(root.stat)}`, root: root.path, originalRoot: resolve(node.cwd), sourceFiles };
  }
  function trim(session) {
    const cutoff = now() - TTL;
    while (session.entries.size > MAX_ENTRIES) session.entries.delete(session.entries.keys().next().value);
    for (const [entryKey, entry] of session.entries) {
      if (entry.seen <= cutoff) session.entries.delete(entryKey);
    }
    for (const [path, record] of session.records) {
      record.associations = [...session.entries.values()].flatMap((entry) => entry.refs.filter((ref) => ref.path === path).map((ref) => ({ entryId: entry.id, kind: ref.kind })));
      if (!record.associations.length) session.records.delete(path);
    }
    for (const [id, value] of session.tombstones) if (value.until <= now()) session.tombstones.delete(id);
    while (session.tombstones.size > MAX_FILES) session.tombstones.delete(session.tombstones.keys().next().value);
    while (session.records.size > MAX_FILES) {
      const path = session.records.keys().next().value;
      session.records.delete(path);
      for (const [key, entry] of session.entries) { entry.refs = entry.refs.filter((ref) => ref.path !== path); if (!entry.refs.length) session.entries.delete(key); }
    }
  }
  function touch(id, session) {
    sessions.delete(id);
    sessions.set(id, session);
    while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  }
  function publicRecord(record) {
    const associations = [...new Map(record.associations.map((a) => [JSON.stringify(a), a])).values()];
    return { id: record.id, name: record.name, kind: record.kind, size: record.size, modifiedAt: record.modifiedAt, state: record.state, associations, ...(record.reason ? { reason: record.reason } : {}) };
  }
  function candidatePath(candidate, ctx) {
    if (typeof candidate.path !== "string" || !candidate.path || candidate.path.length > 8192 || /[\0\r\n]/.test(candidate.path)) return null;
    const original = isAbsolute(candidate.path) ? resolve(candidate.path) : resolve(ctx.originalRoot ?? "/", candidate.path);
    if (deniedPath(candidate.path) || deniedPath(original) || !ctx.originalRoot || !ctx.root) return { original, state: "restricted" };
    if (inside(original, ctx.originalRoot)) return { original, path: resolve(ctx.root, relative(ctx.originalRoot, original)), state: ctx.state };
    if (inside(original, ctx.root)) return { original, path: original, state: ctx.state };
    return { original, state: "restricted" };
  }
  async function inspect(candidate, ctx) {
    const name = safeText(basename(candidate.original).replace(/[\x00-\x1f\x7f]/g, "�"), 200);
    const type = typeOf(candidate.original);
    const base = { ...type, name, size: null, modifiedAt: null };
    if (candidate.state !== "available") return { ...base, ...failure("restricted", "This file is outside the allowed workspace or is protected.") };
    const found = await checkedPath(candidate.path, { boundary: ctx.root, deny: deniedPath });
    if (found.state !== "available") return { ...base, ...found };
    if (!found.stat.isFile()) return { ...base, ...failure("unsupported", "Only regular files can be previewed.") };
    const size = Number(found.stat.size);
    const metadata = { ...base, path: found.path, fingerprint: fingerprint(found.stat), size, modifiedAt: new Date(Number(found.stat.mtimeMs)).toISOString() };
    if (type.kind === "unsupported") return { ...metadata, ...failure("unsupported", "This file type is not supported.") };
    if (type.kind !== "text" && size > MAX_BINARY) return { ...metadata, ...failure("oversized", "This file exceeds the 8 MiB limit.") };
    return { ...metadata, state: "available" };
  }
  function getSession(node, ctx) {
    let session = sessions.get(node.id);
    if (!session || session.key !== ctx.key) session = { key: ctx.key, entries: new Map(), records: new Map(), tombstones: new Map(), archiveRevision: undefined, branchHead: undefined };
    touch(node.id, session);
    trim(session);
    return session;
  }
  return {
    async register(node, { local = null, archive = null } = {}) {
      const ctx = await context(node);
      const session = getSession(node, ctx);
      if (local?.state === "restricted" || archive?.state === "restricted") { session.entries.clear(); session.records.clear(); session.tombstones.clear(); return []; }
      if (["pi", "omp", "fleet"].includes(node.agent)) {
        for (const key of session.entries.keys()) if (key.startsWith("archive:")) session.entries.delete(key);
        archive = null;
      }
      if (archive && (["mismatch", "changed"].includes(archive.state) || archive.state === "available" && session.archiveRevision !== undefined && session.archiveRevision !== archive.revision)) {
        for (const key of session.entries.keys()) if (key.startsWith("archive:")) session.entries.delete(key);
      }
      if (archive?.state === "available") session.archiveRevision = archive.revision;
      const revokeLocal = () => { for (const key of session.entries.keys()) if (key.startsWith("local:")) session.entries.delete(key); };
      if (local?.state === "available" && local.sourceIdentity) {
        const expected = ctx.sourceFiles?.find((source) => source.original === (node.transcript ?? node.source));
        const observed = local.sourceIdentity;
        if (!expected || expected.path !== observed.path || expected.dev !== String(observed.dev) || expected.ino !== String(observed.ino)) { revokeLocal(); local = null; }
      }
      if (local?.state === "available") {
        if (["pi", "omp", "fleet"].includes(node.agent)) {
          if (session.localRevision !== local.revision) revokeLocal();
          session.localRevision = local.revision;
        }
        const branch = local.branch;
        if (branch && typeof branch.head === "string" && Array.isArray(branch.ancestry)) {
          if (session.branchHead !== branch.head && !branch.ancestry.includes(session.branchHead)) revokeLocal();
          session.branchHead = branch.head;
        } else if (session.branchHead !== undefined) { revokeLocal(); session.branchHead = undefined; }
      }
      const inspected = new Map();
      for (const [source, value] of [["local", local], ["archive", archive]]) {
        if (value?.state !== "available") continue;
        const incoming = [];
        for (const entry of (value.entries ?? []).slice(-400).reverse()) {
          if (typeof entry.id !== "string" || entry.id.length > 512) continue;
          const refs = [];
          for (const candidate of (entry.artifactCandidates ?? []).slice(0, 32)) {
            if (!["linked", "written"].includes(candidate?.kind)) continue;
            const path = candidatePath(candidate, ctx);
            if (!path || !inspected.has(path.original) && inspected.size >= MAX_FILES) continue;
            refs.push({ path: path.original, kind: candidate.kind });
            if (!inspected.has(path.original)) inspected.set(path.original, await inspect(path, ctx));
            const info = inspected.get(path.original);
            const previous = session.records.get(path.original);
            const signature = JSON.stringify([info.state, info.path, info.fingerprint]);
            let id = previous?.id;
            if (!previous || previous.signature !== signature) {
              if (previous) session.tombstones.set(previous.id, { state: "changed", until: now() + TTL });
              id = randomUUID();
            }
            session.records.delete(path.original);
            session.records.set(path.original, { ...info, id, signature, original: path.original, candidate: path, associations: [] });
          }
          incoming.push({ id: entry.id, refs, seen: now() });
        }
        for (const entry of incoming.reverse()) {
          const entryKey = `${source}:${entry.id}`;
          session.entries.delete(entryKey);
          if (entry.refs.length) session.entries.set(entryKey, entry);
          // Candidate discovery runs newest-first to bound filesystem work;
          // eviction order follows chronological evidence, oldest-first.
          for (const ref of entry.refs) {
            const record = session.records.get(ref.path);
            if (record) { session.records.delete(ref.path); session.records.set(ref.path, record); }
          }
        }
      }
      trim(session);
      const finalContext = await context(node);
      if (sessions.get(node.id) !== session) return [];
      if (finalContext.key !== ctx.key) { sessions.delete(node.id); return []; }
      return [...session.records.values()].map(publicRecord);
    },
    async read(node, id, { download = false } = {}) {
      const ctx = await context(node);
      const session = sessions.get(node.id);
      if (!session || session.key !== ctx.key) { sessions.delete(node.id); return failure("expired", "This file reference has expired. Refresh the session."); }
      touch(node.id, session);
      trim(session);
      const record = [...session.records.values()].find((value) => value.id === id);
      if (!record) return failure(session.tombstones.get(id)?.state ?? "expired", "This file reference has changed or expired. Refresh the session.");
      const metadata = publicRecord(record);
      const info = await inspect(record.candidate, ctx);
      if (info.state !== "available") return { ...metadata, ...failure(info.state, info.reason) };
      if (record.fingerprint !== info.fingerprint || record.path !== info.path) return { ...metadata, ...failure("changed", "This file changed after it was observed. Refresh the session.") };
      if (download && info.size > MAX_BINARY) return { ...metadata, ...failure("oversized", "Downloads are limited to 8 MiB.") };
      if (!download && info.kind === "document") return { ...metadata, ...failure("unsupported", "Download this document to open it.") };
      let handle;
      try {
        handle = await open(info.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || fingerprint(before) !== record.fingerprint) return { ...metadata, ...failure("changed", "This file changed after it was observed.") };
        const guarded = await inspect(record.candidate, ctx);
        if (guarded.state !== "available" || guarded.fingerprint !== record.fingerprint || guarded.path !== info.path) return { ...metadata, ...failure(guarded.state === "restricted" ? "restricted" : "changed", "This file changed after it was observed.") };
        const limit = info.kind === "text" && !download ? MAX_TEXT : MAX_BINARY;
        const body = Buffer.alloc(Math.min(info.size, limit));
        let offset = 0;
        while (offset < body.length) {
          const { bytesRead } = await handle.read(body, offset, body.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        const after = await handle.stat({ bigint: true });
        const final = await inspect(record.candidate, ctx);
        const finalContext = await context(node);
        trim(session);
        if (sessions.get(node.id) !== session || ![...session.records.values()].some((value) => value.id === id)) return { ...metadata, ...failure("expired", "This file reference has expired. Refresh the session.") };
        if (finalContext.key !== ctx.key || fingerprint(after) !== record.fingerprint || final.state !== "available" || final.path !== info.path || final.fingerprint !== record.fingerprint || offset !== body.length) return { ...metadata, ...failure("changed", "This file changed while it was being read.") };
        if (info.kind === "image" && !imageMatches(body, info.contentType)) return { ...metadata, ...failure("unsupported", "The image does not match its declared file type.") };
        if (info.kind === "text") {
          if (body.includes(0)) return { ...metadata, ...failure("unsupported", "This file contains binary data.") };
          const decoded = new TextDecoder().decode(body, { stream: info.size > limit });
          const text = safeText(decoded, limit).replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*$/g, "[redacted private key]");
          const encoded = Buffer.from(text, "utf8");
          let end = Math.min(encoded.length, limit);
          while (end > 0 && end < encoded.length && (encoded[end] & 0xc0) === 0x80) end--;
          const bounded = encoded.subarray(0, end);
          return { ...metadata, state: "available", filename: record.name, contentType: info.contentType, body: download ? bounded : bounded.toString("utf8"), truncated: info.size > limit || encoded.length > limit };
        }
        return { ...metadata, state: "available", filename: record.name, contentType: info.contentType, body };
      } catch (error) { return { ...metadata, ...fileError(error) }; }
      finally { await handle?.close().catch(() => {}); }
    },
    revoke(nodeId) { sessions.delete(nodeId); },
  };
}
