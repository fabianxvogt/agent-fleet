import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { chromeExecutable } from "../src/browser/chromium.mjs";
import { browserOwner, browserProcesses, discoverBrowsers } from "../src/browser/discovery.mjs";
import { attachBrowser, connectExternal } from "../src/browser/external.mjs";
import { pilotDirectory, pilotManifest, pilotManifests } from "../src/browser/pilot.mjs";
import { createBrowserCatalog, withBrowserPresence } from "../src/browser/presence.mjs";
import { createDashboardServer } from "../src/server.mjs";

async function until(check, timeout = 10_000) {
  for (const end = Date.now() + timeout; Date.now() < end;) { const result = await check(); if (result) return result; await delay(40); }
  assert.fail("Timed out waiting for automatic browser view");
}

test("automatic association uses ancestry or a unique fleet worktree and refuses shared host ambiguity", () => {
  const root = { id: "root", kind: "session", pid: 10 };
  const child = { id: "child", kind: "session", pid: 20 };
  const contexts = [{ root: "/project", node: root }, { root: "/project", node: child }];
  const parents = new Map([[40, 30], [30, 20], [20, 10], [10, 1]]);
  assert.equal(browserOwner(contexts, "/project", 40, parents), child);
  assert.equal(browserOwner(contexts, "/project-other", 40, parents), null);
  assert.equal(browserOwner(contexts, "/project", 90, parents), null);
  assert.equal(browserOwner([...contexts, { root: "/project", node: { ...child, id: "shared-host" } }], "/project", 40, parents), null);
  const worker = { id: "fleet:worker", kind: "worker", agent: "fleet" };
  const fleet = { root: "/project/.fleet/run/worktrees/a", node: worker };
  assert.equal(browserOwner([...contexts, fleet], fleet.root, 90, parents), worker);
  assert.equal(browserOwner([...contexts, fleet, { ...fleet, node: { ...worker, id: "duplicate" } }], fleet.root, 90, parents), null);
});

test("per-session registry coexists with a legacy run and cannot choose an unspecified session", async (t) => {
  const home = await mkdtemp("/tmp/af-registry-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = { home, browserDir: join(home, "legacy") };
  const legacy = pilotDirectory(config), second = pilotDirectory(config, "pi:second");
  const manifest = (id) => ({ sessionId: id, runId: randomUUID(), pid: process.pid, state: "ready" });
  for (const [dir, id] of [[legacy, "pi:legacy"], [second, "pi:second"]]) {
    await mkdir(dir, { recursive: true }); await writeFile(join(dir, "run.json"), JSON.stringify(manifest(id)));
  }
  assert.equal((await pilotManifests(config)).length, 2);
  assert.equal(await pilotManifest(config), null);
  assert.equal((await pilotManifest(config, "pi:legacy")).directory, legacy);
  assert.equal((await pilotManifest(config, "pi:second")).directory, second);
  await rm(second, { recursive: true });
  assert.equal((await pilotManifest(config)).sessionId, "pi:legacy");
});

test("catalog metadata refresh never starts capture, and removal/closing releases only its own observer", async () => {
  const node = { id: "pi:test", kind: "session", cwd: "/tmp" };
  let discovered = [{ id: "aa", sessionId: node.id, automatic: true, mode: "attached", process: { pid: 123, startKey: "test" } }];
  let attached = 0, closed = 0;
  const browser = { events: new EventEmitter(), status: () => ({ state: "live", documentId: 1 }), watch: async () => {}, close: async () => { closed++; } };
  const catalog = createBrowserCatalog({}, { managed: async () => [], discover: async () => discovered, verify: async () => {}, attach: async () => { attached++; return browser; } });
  const presence = await catalog.refresh([node]); assert.equal(attached, 0);
  assert.equal(withBrowserPresence({ nodes: [node] }, presence).nodes[0].liveView.count, 1);
  const events = [];
  const stop = await catalog.watch(node, (type, data) => events.push({ type, data }));
  assert.equal(attached, 1);
  discovered = []; await catalog.refresh([node]);
  assert.equal(events.at(-1).data.state, "disconnected"); assert.equal(closed, 1);
  stop(); catalog.close(); assert.equal(closed, 1);
});

test("a source removed during attachment never starts late capture", async () => {
  const node = { id: "pi:test", kind: "session", cwd: "/tmp" };
  let discovered = [{ id: "aa", sessionId: node.id, automatic: true, process: { pid: 123 } }];
  let resolveAttach, watching = 0, closed = 0;
  const browser = { events: new EventEmitter(), status: () => ({ state: "live" }), watch: async () => { watching++; }, close: async () => { closed++; } };
  const catalog = createBrowserCatalog({}, { managed: async () => [], discover: async () => discovered, verify: async () => {}, attach: () => new Promise((resolve) => { resolveAttach = resolve; }) });
  await catalog.refresh([node]);
  const opening = catalog.watch(node, () => {});
  await until(() => resolveAttach);
  discovered = []; await catalog.refresh([node]);
  resolveAttach(browser); const stop = await opening;
  assert.equal(watching, 0); assert.equal(closed, 1);
  stop(); catalog.close(); assert.equal(closed, 1);
});

test("catalog shutdown awaits observer cleanup, including a pending attachment", async () => {
  const node = { id: "pi:test", kind: "session", cwd: "/tmp" };
  const source = { id: "aa", sessionId: node.id, automatic: true, process: { pid: 123 } };
  let resolveAttach, resolveClose, watching = 0;
  const browser = { events: new EventEmitter(), status: () => ({ state: "live" }), watch: async () => { watching++; }, close: () => new Promise((resolve) => { resolveClose = resolve; }) };
  const catalog = createBrowserCatalog({}, { managed: async () => [], discover: async () => [source], verify: async () => {}, attach: () => new Promise((resolve) => { resolveAttach = resolve; }) });
  await catalog.refresh([node]);
  const opening = catalog.watch(node, () => {}); await until(() => resolveAttach);
  let finished = false; const closing = catalog.close().then(() => { finished = true; });
  resolveAttach(browser); await until(() => resolveClose);
  assert.equal(finished, false); assert.equal(watching, 0);
  resolveClose(); await opening; await closing; assert.equal(finished, true);
});

test("HTTP client cancellation during attachment prevents late capture", async (t) => {
  const node = { id: "pi:test", kind: "session", cwd: "/tmp" };
  let resolveAttach, signal, opening, watching = 0, closed = 0;
  const browser = { events: new EventEmitter(), status: () => ({ state: "live" }), watch: async () => { watching++; }, close: async () => { closed++; } };
  const catalog = createBrowserCatalog({}, { managed: async () => [], discover: async () => [{ id: "aa", sessionId: node.id, automatic: true, process: { pid: 123 } }], verify: async () => {}, attach: () => new Promise((resolve) => { resolveAttach = resolve; }) });
  await catalog.refresh([node]);
  const server = createDashboardServer({ latest: () => ({ nodes: [node] }) }, {}, { browsers: { watch(...args) { signal = args[3].signal; opening = catalog.watch(...args); return opening; } } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await catalog.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/${encodeURIComponent(node.id)}/browser/events`, { signal: controller.signal });
  await response.body.getReader().read(); await until(() => resolveAttach);
  controller.abort(); await until(() => signal.aborted);
  resolveAttach(browser); await opening;
  assert.equal(watching, 0); assert.equal(closed, 1);
});

test("automatic discovery: two existing browsers, multiple pages and concurrent session streams", { timeout: 90_000 }, async (t) => {
  let executable;
  try { executable = await chromeExecutable(); } catch { t.skip("Chrome is unavailable"); return; }
  const home = await mkdtemp("/tmp/af-discovery-");
  const nodes = ["a", "b"].map((name) => ({ id: "pi:auto-" + name, kind: "session", agent: "pi", cwd: join(home, name), pid: process.pid, status: "working" }));
  for (const node of nodes) await mkdir(node.cwd);
  const web = createServer((req, res) => res.end(`<!doctype html><title>Browser ${req.url}</title><button id="button" onclick="this.textContent='Owner clicked'">Run</button>`));
  await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${web.address().port}`;
  const children = [], owners = [], stops = [];
  let catalog, dashboard;
  t.after(async () => {
    for (const stop of stops) stop(); catalog?.close();
    for (const owner of owners) owner.close();
    for (const child of children) child.kill();
    await Promise.all(children.map(async (child) => { if (child.exitCode === null) await new Promise((resolve) => { const timer = setTimeout(resolve, 3000); child.once("exit", () => { clearTimeout(timer); resolve(); }); }); }));
    web.closeAllConnections(); await new Promise((resolve) => web.close(resolve));
    if (dashboard) { dashboard.closeAllConnections(); await new Promise((resolve) => dashboard.close(resolve)); }
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  for (const [index, node] of nodes.entries()) {
    const profile = join(home, "profile-" + index); await mkdir(profile);
    children.push(spawn(executable, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", url + "/" + index], { cwd: node.cwd, stdio: "ignore" }));
    const port = await until(async () => { try { return (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; } catch { return null; } });
    owners.push(await until(() => connectExternal(`http://127.0.0.1:${port}`).catch(() => null)));
  }
  const inventory = async () => {
    const result = await browserProcesses();
    return { ...result, browsers: result.browsers.filter((b) => children.some((c) => c.pid === b.pid)) };
  };
  const discover = (current) => discoverBrowsers(current, { inventory });
  const config = { home, autoDiscoverBrowsers: true };
  let attachments = 0;
  catalog = createBrowserCatalog(config, { discover, attach: async (source) => { attachments++; return attachBrowser(source); } });
  let presence = await catalog.refresh(nodes);
  assert.equal(presence.length, 2); assert.equal(attachments, 0);
  assert.equal(withBrowserPresence({ nodes }, presence).nodes.every((n) => n.liveView?.available), true);
  const streams = [[], []];
  for (let i = 0; i < nodes.length; i++) stops.push(await catalog.watch(nodes[i], (type, data) => streams[i].push({ type, data })));
  for (const stream of streams) assert.ok(await until(() => stream.find((m) => m.type === "frame")));
  assert.notEqual(streams[0].find((m) => m.type === "frame").data.runId, streams[1].find((m) => m.type === "frame").data.runId);
  for (let i = 0; i < 2; i++) assert.equal(streams[i].findLast((m) => m.type === "status").data.title, "Browser /" + i);

  const extra = await owners[0].send("Target.createTarget", { url: url + "/extra" });
  await until(async () => (await owners[0].send("Target.getTargetInfo", { targetId: extra.targetId })).targetInfo.title === "Browser /extra");
  presence = await catalog.refresh(nodes);
  const graph = withBrowserPresence({ nodes }, presence);
  assert.equal(graph.nodes[0].liveView.count, 2); assert.equal(graph.nodes[1].liveView.count, 1);
  const choices = streams[0].findLast((m) => m.type === "sources").data.sources;
  assert.equal(choices.length, 2);
  stops[0]();
  const second = [];
  const choice = choices.find((s) => s.label === "Browser /extra"); assert.ok(choice);
  stops.push(await catalog.watch(nodes[0], (type, data) => second.push({ type, data }), choice.id));
  assert.ok(await until(() => second.find((m) => m.type === "frame")));
  const session = (await owners[0].send("Target.attachToTarget", { targetId: extra.targetId, flatten: true })).sessionId;
  const page = (method, params = {}) => owners[0].send(method, params, session);
  const point = (await page("Runtime.evaluate", { expression: "JSON.stringify((()=>{const r=document.querySelector('#button').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})())", returnByValue: true })).result.value;
  const { x, y } = JSON.parse(point);
  await page("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await page("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  const click = await until(() => second.findLast((m) => m.type === "status")?.data.clicks?.at(-1));
  assert.ok(await until(() => second.findLast((m) => m.type === "frame" && m.data.at >= click.at)));
  assert.equal(streams[1].findLast((m) => m.type === "status").data.clicks.length, 0);
  await owners[0].send("Target.closeTarget", { targetId: extra.targetId });
  await until(() => second.some((m) => m.type === "status" && m.data.state === "disconnected"));
  presence = await catalog.refresh(nodes);
  assert.equal(withBrowserPresence({ nodes }, presence).nodes[0].liveView.count, 1);
  assert.ok((await owners[1].send("Browser.getVersion")).product.includes("Chrome"));
  assert.deepEqual(await discover([...nodes, { ...nodes[0], id: "pi:ambiguous" }]).then((s) => s.map((v) => v.sessionId)), [nodes[1].id]);

  dashboard = createDashboardServer({ latest: () => ({ nodes, edges: [] }) }, {}, { browsers: catalog });
  await new Promise((resolve) => dashboard.listen(0, "127.0.0.1", resolve));
  const abort = new AbortController();
  const response = await fetch(`http://127.0.0.1:${dashboard.address().port}/api/sessions/${encodeURIComponent(nodes[1].id)}/browser/events`, { signal: abort.signal });
  const reader = response.body.getReader();
  let events = "";
  await until(async () => { events += new TextDecoder().decode((await reader.read()).value); return events.includes("event: frame"); });
  assert.ok(events.includes("event: sources")); abort.abort();
});
