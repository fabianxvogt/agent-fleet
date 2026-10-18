import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import { browserContext, externalProcess } from "./association.mjs";
import { externalTargets } from "./external.mjs";

const exec = promisify(execFile);
const chromiumNames = new Set(["Google Chrome", "Google Chrome for Testing", "Chromium", "chrome", "chromium", "headless_shell", "chrome-headless-shell"]);
const inside = (root, path) => path === root || path.startsWith(root + "/");

/** No args are read for unrelated executables. No arbitrary ports are probed. */
export async function browserProcesses() {
  const { stdout } = await exec("ps", ["-axww", "-o", "pid=,ppid=,comm="], { timeout: 2000, maxBuffer: 8 * 1024 * 1024 });
  const parents = new Map(), candidates = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    parents.set(Number(m[1]), Number(m[2]));
    if (chromiumNames.has(basename(m[3]))) candidates.push(m[1]);
  }
  if (!candidates.length) return { parents, browsers: [] };
  let text;
  try { ({ stdout: text } = await exec("ps", ["-ww", "-p", candidates.join(","), "-o", "pid=,lstart=,args="], { timeout: 2000, maxBuffer: 2 * 1024 * 1024 })); }
  catch (error) { text = error.stdout ?? ""; }
  const browsers = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.{24})\s+(.+)$/);
    if (!m || /--type=/.test(m[3]) || !/--user-data-dir(?:=|\s+)/.test(m[3])) continue;
    const port = m[3].match(/--remote-debugging-port(?:=|\s+)(\d+)(?:\s|$)/)?.[1];
    if (port !== undefined) browsers.push({ pid: Number(m[1]), startKey: m[2], port: Number(port) });
  }
  return { parents, browsers };
}

/** A shared cwd alone is insufficient evidence for an ordinary session. */
export function browserOwner(contexts, cwd, pid, parents) {
  let matches = contexts.filter((c) => inside(c.root, cwd));
  if (!matches.length) return null;
  const length = Math.max(...matches.map((c) => c.root.length));
  matches = matches.filter((c) => c.root.length === length);
  if (matches.length === 1 && matches[0].node.agent === "fleet" && matches[0].node.kind === "worker") return matches[0].node;
  const visited = new Set();
  for (let current = parents.get(pid); current > 1 && !visited.has(current); current = parents.get(current)) {
    visited.add(current);
    const owners = matches.filter((c) => c.node.pid === current);
    if (owners.length) return owners.length === 1 ? owners[0].node : null;
    if (visited.size >= 64) break;
  }
  return null;
}

export async function discoverBrowsers(nodes, { inventory = browserProcesses, verify = externalProcess, targets = externalTargets } = {}) {
  const contexts = (await Promise.all(nodes.map(async (node) => {
    try { return { node, root: await browserContext(node) }; } catch { return null; }
  }))).filter(Boolean);
  if (!contexts.length) return [];
  const { parents, browsers } = await inventory();
  const results = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, browsers.length) }, async () => {
    while (cursor < browsers.length) {
      const candidate = browsers[cursor++];
      try {
        const { stdout } = await exec("lsof", ["-a", "-p", String(candidate.pid), "-d", "cwd", "-Fn"], { timeout: 2000, maxBuffer: 16 * 1024 });
        const rawCwd = stdout.split("\n").find((l) => l.startsWith("n"))?.slice(1);
        if (!rawCwd) continue;
        const cwd = await realpath(rawCwd);
        const node = browserOwner(contexts, cwd, candidate.pid, parents);
        if (!node) continue;
        // Resolve port 0 from this process's actual listener, never from a guessed port/profile file.
        const { stdout: listeners } = await exec("lsof", ["-nP", "-a", "-p", String(candidate.pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], { timeout: 2000, maxBuffer: 16 * 1024 });
        const addresses = listeners.split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1));
        if (!addresses.length || addresses.some((a) => !/^(?:127\.0\.0\.1|\[::1\]):\d+$/.test(a))) continue;
        const ports = [...new Set(addresses.map((a) => Number(a.slice(a.lastIndexOf(":") + 1))))];
        const port = candidate.port || (ports.length === 1 ? ports[0] : null);
        if (!port || !ports.includes(port)) continue;
        const host = addresses.includes(`127.0.0.1:${port}`) ? "127.0.0.1" : "[::1]";
        const endpoint = `http://${host}:${port}`;
        const process = await verify(node, endpoint, candidate.pid, candidate.startKey);
        for (const target of await targets(endpoint)) {
          const key = createHash("sha256").update(`${node.id}\0${candidate.pid}\0${candidate.startKey}\0${target.id}`).digest("hex").slice(0, 24);
          results.push({ id: key, sessionId: node.id, mode: "attached", automatic: true, endpoint, targetId: target.id, process, label: target.title || target.url || "Agent browser" });
        }
      } catch { /* A browser can disappear or fail validation between any two observations. */ }
    }
  }));
  return results.sort((a, b) => a.id.localeCompare(b.id));
}
