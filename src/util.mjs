import { open, readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

export async function statSafe(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

export async function listDir(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readRange(path, start, length) {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

/** First `maxLines` complete JSONL records, reading at most `maxBytes`. */
export async function readHeadRecords(path, maxLines = 4, maxBytes = 512 * 1024) {
  try {
    const text = await readRange(path, 0, maxBytes);
    const lines = text.split("\n");
    if (text.length === maxBytes) lines.pop(); // last line may be cut
    return lines.slice(0, maxLines).map(parseJson).filter(Boolean);
  } catch {
    return [];
  }
}

/** Last complete JSONL records within the final `maxBytes` of the file. */
export async function readTailRecords(path, size, maxBytes = 48 * 1024) {
  try {
    const start = Math.max(0, size - maxBytes);
    const text = await readRange(path, start, Math.min(size, maxBytes));
    const lines = text.split("\n");
    if (start > 0) lines.shift(); // first line may be cut
    return lines.map(parseJson).filter(Boolean);
  } catch {
    return [];
  }
}

/** Cache keyed by path; recomputes only when mtime or size changes. */
export function fileCache() {
  const entries = new Map();
  return {
    async get(path, st, compute) {
      const key = `${st.mtimeMs}:${st.size}`;
      const hit = entries.get(path);
      if (hit && hit.key === key) return hit.value;
      const value = await compute();
      entries.set(path, { key, value });
      return value;
    },
    prune(livePaths) {
      for (const path of entries.keys()) if (!livePaths.has(path)) entries.delete(path);
    },
  };
}

export const isoOrNull = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const date = typeof value === "number" ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export const ageMs = (now, iso) => (iso ? now - Date.parse(iso) : Infinity);

export const shortId = (id) => String(id).replace(/^.*[:/]/, "").slice(0, 8);

/** Project label for a working directory; worktrees map back to their repository. */
export function projectName(cwd) {
  if (!cwd) return "unknown";
  const claudeWorktree = cwd.match(/^(.*)\/\.claude\/worktrees\/[^/]+/);
  if (claudeWorktree) return basename(claudeWorktree[1]);
  const codexWorktree = cwd.match(/\/\.codex\/worktrees\/[^/]+\/(.+)$/);
  if (codexWorktree) return basename(codexWorktree[1]);
  return basename(cwd) || cwd;
}

export const truncate = (text, max = 90) => {
  if (!text) return text;
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export { join };
