import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import { connectPipe } from "../src/browser/cdp.mjs";
import { browserCli } from "../src/browser/cli.mjs";
import { browserUrl, chromeExecutable, displayUrl } from "../src/browser/chromium.mjs";
import { browserSessionAllowed, pilotDirectory, pilotManifest, pilotManifests, pilotRequest, receive, validatePilotDirectory, watchPilot } from "../src/browser/pilot.mjs";
import { createDashboardServer } from "../src/server.mjs";

const exec = promisify(execFile);
const listen = async (server) => { await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); return `http://127.0.0.1:${server.address().port}`; };
async function until(check, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(30); }
  assert.fail("Timed out waiting for browser observation");
}

test("browser URLs and session association reject unsupported/private contexts", async (t) => {
  assert.equal(browserUrl("https://example.com"), "https://example.com/");
  assert.equal(browserUrl("about:blank"), "about:blank");
  assert.equal(displayUrl("http://user:secret@localhost/path?token=private#secret"), "http://localhost/path");
  for (const url of ["file:///tmp/x", "data:text/html,x", "javascript:alert(1)", "https://user:pass@example.com"]) assert.throws(() => browserUrl(url));
  const dir = await mkdtemp("/tmp/af-policy-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "body-os"));
  await symlink(join(dir, "body-os"), join(dir, "alias"));
  assert.equal(await browserSessionAllowed({ kind: "session", cwd: dir }), true);
  assert.equal(await browserSessionAllowed({ kind: "session", cwd: join(dir, "alias") }), false);
  assert.equal(await browserSessionAllowed({ kind: "session", cwd: "/Development/Sokra" }), false);
  assert.equal(await browserSessionAllowed({ kind: "process", cwd: dir }), false);
  const overlong = join(dir, "x".repeat(110));
  assert.throws(() => validatePilotDirectory(overlong), /too long/);
  await assert.rejects(browserCli({ browserDir: overlong }, ["start", "--session", "test"]), /too long/);
  await assert.rejects(stat(overlong), { code: "ENOENT" });
});

test("CDP pipe handles fragmented replies and rejects pending calls on close", async () => {
  const child = new EventEmitter();
  child.stdio = [null, null, null, new PassThrough(), new PassThrough()];
  const cdp = connectPipe(child, { timeoutMs: 30 });
  const reply = cdp.send("Test");
  child.stdio[4].write('{"id":1,"res');
  child.stdio[4].write('ult":{"ok":true}}\0');
  assert.deepEqual(await reply, { ok: true });
  await assert.rejects(cdp.send("Never replies"), /timed out/);
  const pending = cdp.send("Closes");
  child.emit("exit");
  await assert.rejects(pending, /closed/);
  await assert.rejects(cdp.send("After close"), /closed/);
});

test("IPC disconnect before a reply fails promptly instead of hanging", async (t) => {
  const dir = await mkdtemp("/tmp/af-ipc-");
  const config = { browserDir: dir };
  await writeFile(join(dir, "run.json"), JSON.stringify({ runId: randomUUID(), sessionId: "test", pid: process.pid }));
  const { createServer: netServer } = await import("node:net");
  const server = netServer((socket) => { socket.resume(); socket.end(); });
  await new Promise((resolve) => server.listen(join(dir, "control.sock"), resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  await assert.rejects(pilotRequest(config, "test", { action: "state" }), /closed before replying/);
});

test("real isolated Chromium: terminal actions, observed clicks, live frames, navigation, cancellation and cleanup", { timeout: 90_000 }, async (t) => {
  try { await chromeExecutable(); } catch { t.skip("Chrome/Chromium is unavailable"); return; }
  const home = await mkdtemp("/tmp/af-browser-");
  const node = { id: "codex:browser-test", kind: "session", agent: "codex", cwd: home };
  const other = { ...node, id: "codex:other" };
  const config = { home, host: "127.0.0.1", browserDir: join(home, "pilot") };
  const browserDir = pilotDirectory(config, node.id);
  let stopWatch = () => {};
  const sockets = new Set();
  const web = createServer((req, res) => {
    const send = () => res.end(`<!doctype html><title>Terminal test</title><button id="button" onclick="this.textContent='Clicked'">Run</button><button id="script" onclick="document.querySelector('#button').click()">Script</button><button id="disabled" disabled>Disabled</button><button id="probe" onclick="this.textContent=typeof window.__agentFleetClick">Probe</button><input id="input"><section id="section">Section</section>`);
    if (req.url === "/slow") setTimeout(send, 700); else send();
  });
  web.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  const webUrl = await listen(web);
  const dashboard = createDashboardServer({ latest: () => ({ nodes: [node, other], edges: [] }) }, { get: async () => ({}) }, { browserConfig: config });
  const dashboardUrl = await listen(dashboard);
  config.port = dashboard.address().port;
  const cli = async (...args) => {
    const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", `import {browserCli} from ${JSON.stringify(new URL("../src/browser/cli.mjs", import.meta.url).href)}; await browserCli(${JSON.stringify(config)},JSON.parse(process.argv[1]));`, JSON.stringify(args)], { env: { ...process.env, CODEX_THREAD_ID: "" }, timeout: 30_000 });
    return JSON.parse(stdout);
  };
  t.after(async () => {
    stopWatch();
    await cli("stop", "--session", node.id).catch(() => {});
    await cli("stop", "--session", other.id).catch(() => {});
    for (const socket of sockets) socket.destroy();
    dashboard.closeAllConnections(); web.closeAllConnections();
    await Promise.all([new Promise((resolve) => dashboard.close(resolve)), new Promise((resolve) => web.close(resolve))]);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  await t.test("CLI attaches only a known allowed session and protects the profile/socket", async () => {
    await assert.rejects(cli("start", "--session", "unknown", "--url", webUrl), /unknown or outside/);
    const result = await cli("start", "--session", node.id, "--url", webUrl);
    assert.equal(result.state, "live");
    assert.equal(result.title, "Terminal test");
    assert.equal((await stat(browserDir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(browserDir, "control.sock"))).mode & 0o777, 0o600);
    assert.equal((await cli("start", "--session", node.id)).existing, true);
    await assert.rejects(pilotRequest(config, other.id, { action: "state" }), /No browser/);
    const parallel = await cli("start", "--session", other.id, "--url", webUrl);
    assert.notEqual(parallel.runId, result.runId);
    assert.equal((await pilotManifests(config)).length, 2);
    assert.equal(await pilotManifest(config), null, "an unspecified stop cannot choose among sessions");
    assert.equal((await pilotRequest(config, node.id, { action: "status" })).state, "live");
    await cli("stop", "--session", other.id);
    assert.equal((await pilotRequest(config, node.id, { action: "status" })).state, "live");
  });
  await t.test("CLI can address a dashboard bound to IPv6 loopback", async () => {
    const ipv6 = createServer((_req, res) => res.end(JSON.stringify({ nodes: [] })));
    await new Promise((resolve, reject) => { ipv6.once("error", reject); ipv6.listen(0, "::1", resolve); });
    try {
      await assert.rejects(browserCli({ ...config, host: "::1", port: ipv6.address().port }, ["start", "--session", "unknown"]), /unknown or outside/);
    } finally { ipv6.closeAllConnections(); await new Promise((resolve) => ipv6.close(resolve)); }
  });
  const observed = [];
  stopWatch = await watchPilot(config, node, (type, data) => observed.push({ type, data }));
  const command = (action, extra = {}) => pilotRequest(config, node.id, { action, ...extra });
  await t.test("viewer receives JPEG frames without owning the controller", async () => {
    const frame = await until(() => observed.find((m) => m.type === "frame")?.data);
    assert.equal(Buffer.from(frame.data, "base64").readUInt16BE(0), 0xffd8);
    assert.equal(frame.width, 1280); assert.equal(frame.height, 800);
    assert.equal((await command("state")).text.includes("Run"), true);
  });
  await t.test("trusted click is observed, script-triggered click cannot forge a marker", async () => {
    const first = await cli("click", "--session", node.id, "--selector", "#button");
    assert.ok(first.click?.id);
    assert.ok((await command("state")).text.includes("Clicked"));
    const second = await command("click", { selector: "#script" });
    assert.equal(second.click.id, first.click.id + 1);
    const state = await command("state");
    assert.equal(state.clicks.length, 2, "programmatic nested click is not marked");
    const aligned = await until(() => observed.find((m) => m.type === "frame" && m.data.at >= second.click.at)?.data);
    assert.equal(aligned.documentId, second.click.documentId);
    assert.equal((await command("click", { selector: "#disabled" })).click, null);
    await command("click", { selector: "#probe" });
    assert.ok((await command("state")).text.includes("undefined"), "page cannot call the observer binding");
    await command("fill", { selector: "#input", text: "safe synthetic text" });
    assert.ok(!(await command("state")).text.includes("safe synthetic text"), "state does not dump input values");
  });
  await t.test("rejected URLs and fragment navigation do not wedge later actions", async () => {
    await assert.rejects(command("open", { url: "file:///tmp/no" }), /failed/);
    assert.equal((await command("state")).state, "live");
    const previous = (await command("state")).documentId;
    await command("open", { url: `${webUrl}/#section` });
    const next = await command("state");
    assert.equal(next.state, "live"); assert.ok(next.documentId > previous); assert.equal(next.clicks.length, 0);
    assert.ok((await command("click", { selector: "#button" })).click);
    await command("open", { url: webUrl });
    assert.equal((await command("state")).clicks.length, 0);
  });
  await t.test("expired/disconnected queued clicks are never executed later", async () => {
    const slow = command("open", { url: `${webUrl}/slow` });
    await delay(60);
    const manifest = await pilotManifest(config);
    const send = (deadline) => {
      const socket = createConnection(join(browserDir, "control.sock"));
      socket.on("error", () => {});
      socket.on("connect", () => socket.write(JSON.stringify({ action: "click", selector: "#button", runId: manifest.runId, sessionId: node.id, deadline }) + "\n"));
      return socket;
    };
    const expired = send(Date.now() + 50);
    const disconnected = send(Date.now() + 19_000);
    receive(expired, () => expired.end());
    await delay(100); disconnected.destroy();
    await slow;
    assert.equal((await command("state")).clicks.length, 0);
    assert.ok((await command("state")).text.includes("Run"));
  });
  await t.test("HTTP view has no control route and enforces origin/session checks", async () => {
    const path = `/api/sessions/${encodeURIComponent(node.id)}/browser/events`;
    assert.equal((await fetch(dashboardUrl + path, { method: "POST" })).status, 405);
    assert.equal((await fetch(dashboardUrl + path, { headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await fetch(`${dashboardUrl}/api/sessions/unknown/browser/events`)).status, 404);
    assert.equal((await fetch(`${dashboardUrl}/api/sessions/${encodeURIComponent(node.id)}/browser/click`)).status, 404);
    const abort = new AbortController();
    const response = await fetch(dashboardUrl + path, { signal: abort.signal });
    assert.equal(response.headers.get("cache-control"), "no-store");
    const reader = response.body.getReader();
    await until(async () => new TextDecoder().decode((await reader.read()).value).includes("event: status"));
    abort.abort();
  });
  await t.test("stop removes the isolated profile and allows a fresh run", async () => {
    stopWatch();
    const old = await pilotManifest(config);
    assert.equal((await cli("stop", "--session", node.id)).stopped, true);
    await assert.rejects(stat(browserDir), { code: "ENOENT" });
    const next = await cli("start", "--session", node.id, "--url", webUrl);
    assert.notEqual(next.runId, old.runId);
    await cli("stop", "--session", node.id);
    await assert.rejects(stat(browserDir), { code: "ENOENT" });
  });
  await t.test("a failed runner can be stopped and its directory recovered", async () => {
    await mkdir(browserDir, { mode: 0o700 });
    const runId = randomUUID();
    await writeFile(join(browserDir, "launch.json"), JSON.stringify({ runId, sessionId: node.id, cwd: home, url: webUrl, executable: "/no-such-chrome" }));
    const child = spawn(process.execPath, [new URL("../bin/browser-runner.mjs", import.meta.url).pathname, browserDir], { stdio: "ignore" });
    await new Promise((resolve) => child.once("exit", resolve));
    assert.equal((await pilotManifest(config)).state, "failed");
    assert.equal((await cli("stop", "--session", node.id)).stale, true);
    await assert.rejects(readFile(join(browserDir, "run.json")), { code: "ENOENT" });
  });
});
