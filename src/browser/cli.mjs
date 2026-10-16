import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserUrl, chromeExecutable } from "./chromium.mjs";
import { browserSessionAllowed, pilotDirectory, pilotManifest, pilotRequest, validatePilotDirectory } from "./pilot.mjs";

export const BROWSER_HELP = `agent-fleet browser — managed terminal browser with a read-only live view

  browser start --session <node-id> [--url <http-url>]
  browser open --session <node-id> --url <http-url>
  browser click --session <node-id> --selector <css-selector>
  browser fill --session <node-id> --selector <css-selector> --text <text>
  browser scroll --session <node-id> --dy <pixels>
  browser state --session <node-id>
  browser stop [--session <node-id>]

Select that session in Agent Fleet and open Live. One managed browser at a time.
It uses an isolated temporary profile; stopping removes that profile.
For Codex, CODEX_THREAD_ID can supply the session when --session is omitted.`;

export async function browserCli(config, args) {
  const [action, ...rest] = args;
  if (!action || action === "help" || action === "--help") { console.log(BROWSER_HELP); return; }
  if (!["start", "open", "click", "fill", "scroll", "state", "stop"].includes(action)) throw new Error(BROWSER_HELP);
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!/^--(?:session|url|selector|text|dy)$/.test(rest[i]) || rest[i + 1] === undefined) throw new Error(BROWSER_HELP);
    options[rest[i].slice(2)] = rest[i + 1];
  }
  let sessionId = options.session ?? (process.env.CODEX_THREAD_ID ? `codex:${process.env.CODEX_THREAD_ID}` : null);
  const dir = pilotDirectory(config);
  const current = await pilotManifest(config);
  if (action === "stop" && !sessionId) sessionId = current?.sessionId;
  if (!sessionId || sessionId.length > 1000) throw new Error("Pass --session with the session's Agent Fleet node ID");
  if (action !== "start") {
    try {
      const result = await pilotRequest(config, sessionId, { action, ...options, sessionId });
      if (action === "stop") {
        let stopped = false;
        for (let i = 0; i < 100; i++) {
          const manifest = await pilotManifest(config);
          if (manifest && manifest.runId !== current?.runId) { stopped = true; break; }
          try { await stat(dir); } catch (error) { if (error.code === "ENOENT") { stopped = true; break; } throw error; }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!stopped) throw new Error("Browser is still stopping; retry after its runner exits");
      }
      console.log(JSON.stringify(result, null, 2));
    }
    catch (error) {
      if (action !== "stop" || !current || current.sessionId !== sessionId) throw error;
      try { process.kill(current.pid, 0); } catch (check) {
        if (check.code === "ESRCH") { await rm(dir, { recursive: true, force: true }); console.log(JSON.stringify({ stopped: true, stale: true })); return; }
      }
      throw error;
    }
    return;
  }
  const url = browserUrl(options.url ?? "about:blank");
  validatePilotDirectory(dir);
  const executable = await chromeExecutable();
  const host = config.host === "::1" ? "[::1]" : config.host;
  const response = await fetch(`http://${host}:${config.port}/api/snapshot`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("Agent Fleet must be running before starting a browser");
  const snapshot = await response.json();
  const node = snapshot.nodes?.find((n) => n.id === sessionId);
  if (!node || !await browserSessionAllowed(node)) throw new Error("The session is unknown or outside the browser pilot's allowed context");
  if (current) {
    if (current.sessionId !== sessionId) throw new Error("The browser pilot is already attached to another session; stop it first");
    console.log(JSON.stringify({ sessionId, existing: true, ...await pilotRequest(config, sessionId, { action: "status" }) }, null, 2));
    return;
  }
  await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
  try { await mkdir(dir, { mode: 0o700 }); }
  catch { throw new Error("A browser run is starting or left a stale directory. Use browser stop after its runner exits."); }
  const runId = randomUUID();
  let child;
  let spawnError;
  try {
    await writeFile(join(dir, "launch.json"), JSON.stringify({ runId, sessionId, cwd: node.cwd, url, executable }), { mode: 0o600 });
    const log = await open(join(dir, "runner.log"), "a", 0o600);
    try {
      child = spawn(process.execPath, [fileURLToPath(new URL("../../bin/browser-runner.mjs", import.meta.url)), dir], { detached: true, stdio: ["ignore", log.fd, log.fd] });
      child.on("error", (error) => { spawnError = error; });
      child.unref();
    } finally { await log.close(); }
    for (let i = 0; i < 80; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const manifest = await pilotManifest(config);
      if (manifest?.runId === runId && manifest.state === "ready") {
        console.log(JSON.stringify({ sessionId, runId, ...await pilotRequest(config, sessionId, { action: "status" }) }, null, 2));
        return;
      }
      if (manifest?.runId === runId && manifest.state === "failed") break;
      if (spawnError || child.exitCode !== null || child.signalCode !== null) break;
    }
    throw new Error("Browser did not start. Check the private browser-pilot/runner.log file.");
  } catch (error) {
    child?.kill();
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => { const timer = setTimeout(resolve, 5000); child.once("exit", () => { clearTimeout(timer); resolve(); }); });
    }
    // A failed runner still needs a manifest so `browser stop` can recover it.
    if (!child?.pid) await rm(dir, { recursive: true, force: true });
    else if (!await pilotManifest(config)) await writeFile(join(dir, "run.json"), JSON.stringify({ sessionId, runId, pid: child.pid, state: "failed" }), { mode: 0o600 });
    throw error;
  }
}
