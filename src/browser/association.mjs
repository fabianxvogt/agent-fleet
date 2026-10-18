import { execFile } from "node:child_process";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { localEndpoint } from "./external.mjs";
import { browserSessionAllowed } from "./pilot.mjs";

const exec = promisify(execFile);
const inside = (root, path) => { const rel = relative(root, path); return rel === "" || rel !== ".." && !rel.startsWith("../") && !rel.startsWith("/"); };
const regularProfile = (path) => /(?:Application Support\/(?:Google\/Chrome|Chromium)|\.config\/(?:google-chrome|chromium))(?:\/|$)/i.test(path);

export async function browserContext(node) {
  if (!await browserSessionAllowed(node)) throw new Error("This session cannot supply a browser view");
  let root = await realpath(node.cwd);
  if (node.agent === "fleet" && node.kind === "worker") {
    const source = node.source?.match(/^(.*)\/workers\/([^/]+)\/[^/]+$/);
    if (!source) throw new Error("Fleet worker browser association is unavailable");
    root = await realpath(join(source[1], "worktrees", source[2]));
    if (!inside(await realpath(node.cwd), root)) throw new Error("Fleet browser context is outside its project");
  }
  if (!await browserSessionAllowed({ kind: "session", cwd: root })) throw new Error("Browser context is restricted");
  return root;
}

export async function verifiedProfile(rawProfile, cwd, explicit = null) {
  const directory = await realpath(resolve(cwd, rawProfile));
  if (!await browserSessionAllowed({ kind: "session", cwd: directory }) || regularProfile(directory)) throw new Error("Browser profile is restricted");
  let lastUsed = "Default";
  const statePath = join(directory, "Local State");
  const stateExists = await lstat(statePath).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (stateExists) {
    const stateFile = await realpath(statePath);
    if (!inside(directory, stateFile) || !await browserSessionAllowed({ kind: "session", cwd: stateFile }) || (await stat(stateFile)).size > 1024 * 1024) throw new Error("Browser profile metadata is restricted");
    lastUsed = JSON.parse(await readFile(stateFile, "utf8")).profile?.last_used ?? "Default";
  }
  const name = explicit ?? lastUsed;
  if (typeof name !== "string" || !/^[\w -]{1,128}$/.test(name)) throw new Error("Browser profile directory is ambiguous");
  const effective = await realpath(join(directory, name));
  if (!inside(directory, effective) || !await browserSessionAllowed({ kind: "session", cwd: effective }) || regularProfile(effective)) throw new Error("Browser profile alias escapes its dedicated directory");
  return { directory, effective };
}

/** Explicit session + process association; never probe an arbitrary browser port. */
export async function externalProcess(node, endpoint, rawPid, expectedStart = null) {
  if (!await browserSessionAllowed(node)) throw new Error("This session cannot supply a browser view");
  const pid = Number(rawPid), port = localEndpoint(endpoint).port;
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error("Pass the existing browser process PID");
  const { stdout: processText } = await exec("ps", ["-p", String(pid), "-o", "lstart=", "-o", "args="], { timeout: 2000, maxBuffer: 64 * 1024 });
  const match = processText.trim().match(/^(.{24})\s+(.+)$/);
  if (!match || expectedStart && match[1] !== expectedStart) throw new Error("Browser process changed");
  const args = match[2];
  // ps flattens argv. Reject duplicate/embedded flags rather than guessing which Chrome used.
  if ([...args.matchAll(/--user-data-dir(?:=|\s+)/g)].length !== 1 || [...args.matchAll(/--remote-debugging-port(?:=|\s+)/g)].length !== 1 || /--profile-directory(?:=|\s+)(?:["']?(?:\/|\.\.))/.test(args)) throw new Error("Browser process has ambiguous profile/debugging flags");
  const hasProfile = args.includes("--profile-directory");
  const profileName = args.match(/(?:^|\s)--profile-directory=([\w-]{1,128})(?=\s+--|\s*$)/)?.[1];
  if (hasProfile && (!profileName || [...args.matchAll(/--profile-directory/g)].length !== 1)) throw new Error("Browser process has ambiguous profile-directory flags");
  const debug = args.match(/--remote-debugging-port(?:=|\s+)(\d+)(?:\s|$)/)?.[1];
  const profile = args.match(/--user-data-dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (!/chrome|chromium/i.test(args.split(" --")[0]) || /--type=/.test(args) || !debug || debug !== "0" && debug !== port || !profile) throw new Error("This is not a dedicated Chromium debugging process");
  const { stdout: cwdText } = await exec("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: 2000, maxBuffer: 16 * 1024 });
  const cwd = await realpath(cwdText.split("\n").find((l) => l.startsWith("n"))?.slice(1) ?? "");
  if (!await browserSessionAllowed({ kind: "session", cwd })) throw new Error("Browser context is restricted");
  const verified = await verifiedProfile(profile[1] ?? profile[2] ?? profile[3], cwd, profileName);
  const root = await browserContext(node);
  if (!inside(root, cwd)) throw new Error("Browser process does not belong to this session's working context");
  const { stdout: listeners } = await exec("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP:" + port, "-sTCP:LISTEN", "-Fn"], { timeout: 2000, maxBuffer: 16 * 1024 });
  const addresses = listeners.split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1));
  if (!addresses.length || addresses.some((a) => !["127.0.0.1:" + port, "[::1]:" + port].includes(a))) throw new Error("Browser debugging must listen only on loopback and belong to this PID");
  return { pid, startKey: match[1], cwd, profile: verified.directory, effectiveProfile: verified.effective };
}
