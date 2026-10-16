import { createConnection, createServer } from "node:net";
import { chmod, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./chromium.mjs";

export const pilotDirectory = (config) => config.browserDir ?? join(config.home, ".agent-fleet", "browser-pilot");
const socketPath = (dir) => join(dir, "control.sock");
export function validatePilotDirectory(dir) {
  if (Buffer.byteLength(socketPath(dir)) > 100) throw new Error("Browser socket path is too long; configure a shorter browserDir");
}

export async function browserSessionAllowed(node) {
  if (!node?.cwd || !["session", "subagent", "worker"].includes(node.kind)) return false;
  const resolved = await realpath(node.cwd).catch(() => node.cwd);
  return ![node.cwd, resolved].some((path) => /(?:^|[/\\])(?:body-os|Sokra)(?:[/\\]|$)/i.test(path));
}

export async function pilotManifest(config) {
  try {
    const file = join(pilotDirectory(config), "run.json");
    if ((await stat(file)).size > 8192) return null;
    const value = JSON.parse(await readFile(file, "utf8"));
    return typeof value.sessionId === "string" && /^[a-f0-9-]{36}$/.test(value.runId) && Number.isSafeInteger(value.pid) ? value : null;
  } catch { return null; }
}

/** Bounded newline protocol, shared by the local CLI and the read-only viewer. */
export function receive(socket, onMessage) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 3 * 1024 * 1024) { socket.destroy(new Error("Browser message too large")); return; }
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try { onMessage(JSON.parse(line)); } catch { socket.destroy(new Error("Invalid browser message")); return; }
    }
  });
}

export async function pilotRequest(config, sessionId, command) {
  const manifest = await pilotManifest(config);
  if (!manifest || manifest.sessionId !== sessionId) throw new Error("No browser is attached to this session");
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath(pilotDirectory(config)));
    let settled = false;
    const timer = setTimeout(() => socket.destroy(new Error("Browser request timed out")), 20_000);
    socket.on("error", (error) => { settled = true; reject(error); });
    socket.on("close", () => { clearTimeout(timer); if (!settled) reject(new Error("Browser connection closed before replying")); });
    socket.on("connect", () => socket.write(JSON.stringify({ ...command, sessionId, runId: manifest.runId, deadline: Date.now() + 19_000 }) + "\n"));
    receive(socket, (message) => {
      if (message.runId !== manifest.runId || message.sessionId !== sessionId) { socket.destroy(new Error("Browser identity mismatch")); return; }
      settled = true;
      if (message.error) reject(new Error(message.error)); else resolve(message.result);
      socket.end();
    });
  });
}

export async function watchPilot(config, node, emit) {
  if (!await browserSessionAllowed(node)) { emit("status", { state: "restricted" }); return () => {}; }
  const manifest = await pilotManifest(config);
  if (!manifest || manifest.sessionId !== node.id) {
    const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const bin = fileURLToPath(new URL("../../bin/agent-fleet.mjs", import.meta.url));
    emit("status", { state: "unavailable", startCommand: `${quote(process.execPath)} ${quote(bin)} browser start --session ${quote(node.id)}` });
    return () => {};
  }
  const socket = createConnection(socketPath(pilotDirectory(config)));
  let closed = false;
  let connected = false;
  const deadline = setTimeout(() => socket.destroy(new Error("Browser observer timed out")), 5000);
  socket.on("connect", () => socket.write(JSON.stringify({ action: "watch", sessionId: node.id, runId: manifest.runId }) + "\n"));
  socket.on("error", () => { if (!closed) emit("status", { state: "disconnected" }); });
  socket.on("close", () => { clearTimeout(deadline); if (!closed && connected) emit("status", { state: "disconnected" }); });
  receive(socket, (message) => {
    if (closed) return;
    if (message.sessionId !== node.id || message.runId !== manifest.runId) { socket.destroy(new Error("Browser identity mismatch")); return; }
    clearTimeout(deadline); connected = true;
    if (message.type === "status" || message.type === "frame") emit(message.type, { ...message.data, runId: manifest.runId });
  });
  return () => { closed = true; clearTimeout(deadline); socket.destroy(); };
}

export async function runPilot(dir) {
  process.umask(0o077);
  validatePilotDirectory(dir);
  const launch = JSON.parse(await readFile(join(dir, "launch.json"), "utf8"));
  await rm(join(dir, "launch.json"));
  const identity = { runId: launch.runId, sessionId: launch.sessionId };
  const manifest = { ...identity, cwd: launch.cwd, createdAt: new Date().toISOString(), pid: process.pid };
  await writeFile(join(dir, "run.json"), JSON.stringify({ ...manifest, state: "starting" }), { mode: 0o600 });
  let cancelled = false;
  process.once("SIGTERM", () => { cancelled = true; });
  let browser;
  try { browser = await launchBrowser({ profile: join(dir, "profile"), url: launch.url, executable: launch.executable }); }
  catch (error) { await writeFile(join(dir, "run.json"), JSON.stringify({ ...manifest, state: "failed" })); throw error; }
  if (cancelled) { await browser.close(); await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); return; }
  const watchers = new Set();
  const sockets = new Set();
  let queue = Promise.resolve();
  let queued = 0;
  let stopping = false;
  const write = (socket, value) => {
    if (socket.destroyed) return;
    if (socket.writableLength > 2 * 1024 * 1024) { socket.destroy(); return; }
    socket.write(JSON.stringify({ ...identity, ...value }) + "\n");
  };
  const broadcast = (type, data) => { for (const socket of watchers) write(socket, { type, data }); };
  browser.events.on("status", (data) => broadcast("status", data));
  browser.events.on("frame", (data) => broadcast("frame", data));
  const server = createServer((socket) => {
    if (sockets.size >= 12) { socket.destroy(); return; }
    sockets.add(socket);
    const deadline = setTimeout(() => socket.destroy(), 5000);
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(deadline); sockets.delete(socket);
      if (watchers.delete(socket)) void browser.watch(false).catch(() => {});
    });
    let received = false;
    receive(socket, (command) => {
      clearTimeout(deadline);
      if (received) { socket.destroy(); return; }
      received = true;
      if (command.sessionId !== identity.sessionId || command.runId !== identity.runId) { socket.destroy(); return; }
      if (command.action === "watch") {
        watchers.add(socket);
        write(socket, { type: "status", data: browser.status() });
        if (browser.lastFrame()) write(socket, { type: "frame", data: browser.lastFrame() });
        void browser.watch(true).catch(() => write(socket, { type: "status", data: { state: "disconnected" } }));
      } else if (command.action === "status") write(socket, { result: browser.status() });
      else if (command.action === "stop") { write(socket, { result: { stopped: true } }); setImmediate(() => void stop()); }
      else if (queued >= 16) write(socket, { error: "Browser action queue is full" });
      else {
        queued++;
        const deadline = Math.min(Number(command.deadline) || Date.now() + 19_000, Date.now() + 19_000);
        queue = queue.then(() => {
          if (stopping || socket.destroyed || Date.now() >= deadline) throw new Error("Browser request expired");
          return browser.command(command);
        }).then((result) => write(socket, { result }), () => write(socket, { error: "Browser action failed; check the URL or selector" })).finally(() => queued--);
      }
    });
  });
  async function stop() {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    broadcast("status", { state: "stopped" });
    server.close(); for (const socket of sockets) socket.end();
    await browser.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
    for (const socket of sockets) socket.destroy();
  }
  const heartbeat = setInterval(() => broadcast("status", browser.status()), 2000);
  browser.events.once("close", () => void stop());
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath(dir), resolve); });
    await chmod(socketPath(dir), 0o600);
    await writeFile(join(dir, "run.json"), JSON.stringify({ ...manifest, state: "ready" }), { mode: 0o600 });
  } catch (error) { await stop(); throw error; }
}
