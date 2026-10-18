import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { chromeExecutable } from "../src/browser/chromium.mjs";
import { attachBrowser, connectExternal, externalTargets, localEndpoint } from "../src/browser/external.mjs";
import { externalProcess, verifiedProfile } from "../src/browser/association.mjs";
import { pilotDirectory, pilotManifest, pilotRequest, watchPilot } from "../src/browser/pilot.mjs";
import { readBrowserPresence, withBrowserPresence } from "../src/browser/presence.mjs";
import { createDashboardServer } from "../src/server.mjs";

const exec = promisify(execFile);
const listen = async (s) => { await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve)); return `http://127.0.0.1:${s.address().port}`; };
async function until(check, timeout = 8000) {
  for (const end = Date.now() + timeout; Date.now() < end;) { const value = await check(); if (value) return value; await delay(40); }
  assert.fail("Timed out waiting for external browser");
}

test("external endpoints are explicit loopback origins, with no credentials or redirects", async (t) => {
  assert.equal(localEndpoint("http://localhost:9222").href, "http://127.0.0.1:9222/");
  for (const value of ["http://example.com:9222", "http://127.0.0.1", "http://user:pass@127.0.0.1:9222", "http://127.0.0.1:9222/other", "http://127.0.0.1:9222/?secret=x", "ws://127.0.0.1:9222"]) assert.throws(() => localEndpoint(value));
  const server = createServer((req, res) => {
    if (req.url === "/json/list") res.writeHead(302, { location: "https://example.com" }).end();
    else res.end(JSON.stringify({ webSocketDebuggerUrl: "ws://example.com:9222/devtools/browser/123" }));
  });
  const endpoint = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  await assert.rejects(externalTargets(endpoint));
  await assert.rejects(connectExternal(endpoint), /Invalid browser WebSocket/);
});

test("effective profile aliases and relative profiles are checked before browser access", async (t) => {
  const dir = await mkdtemp("/tmp/af-profile-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profile = join(dir, "profile"); await mkdir(join(profile, "Default"), { recursive: true });
  assert.ok((await verifiedProfile("profile", dir)).effective.endsWith("/profile/Default"));
  await rm(join(profile, "Default"), { recursive: true });
  const elsewhere = join(dir, "other"); await mkdir(elsewhere);
  await symlink(elsewhere, join(profile, "Default"));
  await assert.rejects(verifiedProfile(profile, dir), /alias escapes/);
  await writeFile(join(profile, "Local State"), JSON.stringify({ profile: { last_used: "../other" } }));
  await assert.rejects(verifiedProfile(profile, dir), /ambiguous/);
  await rm(join(profile, "Local State"));
  await symlink(join(elsewhere, "Local State"), join(profile, "Local State"));
  await writeFile(join(elsewhere, "Local State"), '{}');
  await assert.rejects(verifiedProfile(profile, dir), /metadata is restricted/);
});

test("real existing Chromium: observer coexists with its owner and detach leaves it alive", { timeout: 90_000 }, async (t) => {
  let executable;
  try { executable = await chromeExecutable(); } catch { t.skip("Chrome is unavailable"); return; }
  const home = await mkdtemp("/tmp/af-external-");
  const profile = join(home, "profile"); await mkdir(profile);
  const config = { home, host: "127.0.0.1", browserDir: join(home, "observer") };
  const node = { id: "pi:existing-browser", kind: "session", agent: "pi", cwd: home, status: "done" };
  const web = createServer((req, res) => res.end(req.url === "/large" ? '<!doctype html><title>Large page</title>' + 'x'.repeat(5 * 1024 * 1024) : '<!doctype html><title>Existing browser</title><button id="button" onclick="this.textContent=\'Clicked by owner\'">Run</button><div style="height:1800px;background:linear-gradient(red,blue)">Tall page</div>'));
  const webUrl = await listen(web);
  const chrome = spawn(executable, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", webUrl], { cwd: home, stdio: "ignore" });
  let owner, stopWatch = () => {};
  const dashboard = createDashboardServer({ latest: () => ({ nodes: [node], edges: [] }) }, { get: async () => ({}) }, { browserConfig: config });
  await listen(dashboard); config.port = dashboard.address().port;
  const cli = async (...args) => {
    const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", `import {browserCli} from ${JSON.stringify(new URL("../src/browser/cli.mjs", import.meta.url).href)}; await browserCli(${JSON.stringify(config)},JSON.parse(process.argv[1]));`, JSON.stringify(args)], { env: { ...process.env, CODEX_THREAD_ID: "" }, timeout: 30_000 });
    return JSON.parse(stdout);
  };
  t.after(async () => {
    stopWatch(); await cli("stop", "--session", node.id).catch(() => {});
    owner?.close(); chrome.kill();
    if (chrome.exitCode === null) await new Promise((resolve) => { const timer = setTimeout(resolve, 3000); chrome.once("exit", () => { clearTimeout(timer); resolve(); }); });
    web.closeAllConnections(); dashboard.closeAllConnections();
    await Promise.all([new Promise((r) => web.close(r)), new Promise((r) => dashboard.close(r))]);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const port = await until(async () => { try { return (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; } catch { return null; } });
  const endpoint = `http://127.0.0.1:${port}`;
  owner = await connectExternal(endpoint);
  const target = await until(async () => (await externalTargets(endpoint)).find((p) => p.title === "Existing browser"));
  const ownerSession = (await owner.send("Target.attachToTarget", { targetId: target.id, flatten: true })).sessionId;
  const page = (method, params = {}) => owner.send(method, params, ownerSession);
  const evaluate = async (expression) => (await page("Runtime.evaluate", { expression, returnByValue: true })).result.value;
  await page("Page.enable");
  await page("Emulation.setDeviceMetricsOverride", { width: 1024, height: 640, deviceScaleFactor: 2, mobile: false });
  const before = await evaluate("({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,url:location.href})");
  let ownerFrames = 0;
  owner.events.on("event", (message) => {
    if (message.sessionId === ownerSession && message.method === "Page.screencastFrame") { ownerFrames++; void page("Page.screencastFrameAck", { sessionId: message.params.sessionId }).catch(() => {}); }
  });
  await page("Page.startScreencast", { format: "jpeg", quality: 40 });

  await t.test("association checks cwd, process start identity and loopback port ownership", async () => {
    const association = await externalProcess(node, endpoint, chrome.pid);
    assert.equal(association.pid, chrome.pid); assert.ok(association.startKey);
    await assert.rejects(externalProcess(node, endpoint, chrome.pid, "wrong start"), /changed/);
    const unrelated = join(home, "other"); await mkdir(unrelated);
    await assert.rejects(externalProcess({ ...node, cwd: unrelated }, endpoint, chrome.pid), /working context/);
    await assert.rejects(externalProcess(node, "http://127.0.0.1:1", chrome.pid));
    const ambiguous = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", "--", "--user-data-dir=/tmp/allowed", "--user-data-dir=/tmp/body-os", "--remote-debugging-port=" + port], { cwd: home, stdio: "ignore" });
    try { await assert.rejects(externalProcess(node, endpoint, ambiguous.pid), /ambiguous/); }
    finally { ambiguous.kill(); }
  });
  await t.test("CLI attaches an exact existing target, preserving viewport and navigation", async () => {
    const listed = await cli("targets", "--session", node.id, "--endpoint", endpoint, "--browser-pid", String(chrome.pid));
    assert.ok(listed.targets.some((p) => p.id === target.id));
    await assert.rejects(cli("attach", "--session", node.id, "--endpoint", endpoint, "--browser-pid", String(chrome.pid), "--target", "missing"), /existing page target/);
    const attached = await cli("attach", "--session", node.id, "--endpoint", endpoint, "--browser-pid", String(chrome.pid), "--target", target.id);
    assert.equal(attached.mode, "attached"); assert.equal(attached.targetId, target.id);
    assert.deepEqual(await evaluate("({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,url:location.href})"), before);
    assert.equal((await pilotManifest(config)).mode, "attached");
    await assert.rejects(stat(join(config.browserDir, "profile")), { code: "ENOENT" });
  });
  const observed = [];
  stopWatch = await watchPilot(config, node, (type, data) => observed.push({ type, data }));
  const command = (action, extra = {}) => pilotRequest(config, node.id, { action, ...extra });
  await t.test("frames retain the real viewport while the owner's screencast continues", async () => {
    const frame = await until(() => observed.find((m) => m.type === "frame")?.data);
    assert.equal(frame.width, 1024); assert.equal(frame.height, 640);
    assert.equal(Buffer.from(frame.data,"base64").readUInt16BE(0), 0xffd8);
    assert.ok(ownerFrames > 0);
    assert.deepEqual(await evaluate("({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,url:location.href})"), before);
  });
  await t.test("owner's trusted input produces a marker; observer cannot navigate or click", async () => {
    await assert.rejects(command("open", { url: "about:blank" }), /failed/);
    await assert.rejects(command("click", { selector: "#button" }), /failed/);
    const point = await evaluate("(() => {const r=document.querySelector('#button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
    await page("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    await page("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
    const clicked = await until(async () => (await command("state")).clicks.at(-1));
    assert.ok((await command("state")).text.includes("Clicked by owner"));
    await until(() => observed.find((m) => m.type === "frame" && m.data.at >= clicked.at && m.data.documentId === clicked.documentId));
    await evaluate("document.querySelector('#button').click()");
    assert.equal((await command("state")).clicks.length, 1);
    assert.equal(await evaluate("Object.keys(window).filter(k=>k.startsWith('__agentFleet')).length"), 0);
  });
  await t.test("owner's scroll, resize and navigation invalidate old frames and markers", async () => {
    const first = (await command("state")).documentId;
    await page("Input.dispatchMouseEvent", { type: "mouseWheel", x: 500, y: 400, deltaX: 0, deltaY: 300 });
    await until(async () => (await command("state")).documentId > first);
    assert.equal((await command("state")).clicks.length, 0);
    await page("Emulation.setDeviceMetricsOverride", { width: 800, height: 900, deviceScaleFactor: 1, mobile: false });
    await until(() => observed.find((m) => m.type === "frame" && m.data.width === 800 && m.data.height === 900));
    const previous = (await command("state")).documentId;
    await page("Page.navigate", { url: webUrl + "/second" });
    await until(() => observed.find((m) => m.type === "frame" && m.data.documentId > previous));
    assert.equal((await command("state")).clicks.length, 0);
    assert.ok((await command("state")).text.includes("Run"));
  });
  await t.test("unsupported file navigation hides content and resumes only on an allowed page", async () => {
    const file = join(home, "blocked.html"); await writeFile(file, '<!doctype html><title>Do not capture</title>FILE MUST STAY HIDDEN');
    await page("Page.navigate", { url: new URL(`file://${file}`).href });
    await until(() => observed.findLast((m) => m.type === "status")?.data.state === "blocked");
    assert.deepEqual(await readBrowserPresence(config, [node]), []);
    await assert.rejects(command("state"), /failed/);
    assert.equal((await externalTargets(endpoint)).some((p) => p.id === target.id), false);
    await assert.rejects(attachBrowser({ endpoint, targetId: target.id }), /HTTP/);
    const count = observed.filter((m) => m.type === "frame").length;
    await delay(500);
    assert.equal(observed.filter((m) => m.type === "frame").length, count);
    await page("Page.navigate", { url: webUrl });
    await until(() => observed.filter((m) => m.type === "frame").length > count);
  });
  await t.test("capture limits invalidate a previously live image and recover after resize", async () => {
    const old = await command("state");
    await page("Emulation.setDeviceMetricsOverride", { width: 9000, height: 600, deviceScaleFactor: 1, mobile: false });
    const loading = await until(async () => { const value = await command("state"); return value.state === "loading" && value.documentId > old.documentId ? value : null; });
    assert.equal(loading.lastFrameAt, null); assert.equal(loading.clicks.length, 0);
    await page("Emulation.setDeviceMetricsOverride", { width: 800, height: 900, deviceScaleFactor: 1, mobile: false });
    await until(() => observed.findLast((m) => m.type === "frame")?.data.documentId >= loading.documentId);
    assert.equal((await command("state")).state, "live");
  });
  await t.test("page text is truncated inside the browser before transport", async () => {
    await page("Page.navigate", { url: webUrl + "/large" });
    await until(async () => await evaluate("document.readyState") === "complete");
    assert.equal((await command("state")).text.length, 12000);
    await evaluate("document.title='t'.repeat(5*1024*1024);true");
    await until(() => observed.findLast((m) => m.type === "status")?.data.title.length === 200);
    assert.equal((await command("state")).mode, "attached");
    await page("Page.navigate", { url: webUrl });
    await until(async () => await evaluate("document.readyState") === "complete");
  });
  await t.test("verified presence marks only its own graph node and expires on disconnect", async () => {
    const presence = await readBrowserPresence(config, [node]);
    assert.equal(presence[0].sessionId, node.id); assert.equal(presence[0].mode, "attached");
    const snapshot = withBrowserPresence({ nodes: [node, { ...node, id: "other", liveView: { available: true } }] }, presence);
    assert.equal(snapshot.nodes[0].liveView.available, true); assert.equal(snapshot.nodes[1].liveView, undefined);
    assert.deepEqual(await readBrowserPresence(config, []), []);
    assert.deepEqual(await readBrowserPresence(config, [{ ...node, cwd: join(home, "body-os") }]), []);
  });
  await t.test("detach removes the observer and leaves the existing browser controllable", async () => {
    stopWatch();
    const result = await cli("detach", "--session", node.id);
    assert.equal(result.detached, true); assert.equal(result.browserContinues, true);
    assert.equal(chrome.exitCode, null);
    assert.ok((await owner.send("Browser.getVersion")).product.includes("Chrome"));
    assert.equal(await evaluate("document.title"), "Existing browser");
    await assert.rejects(stat(pilotDirectory(config, node.id)), { code: "ENOENT" });
    assert.deepEqual(await readBrowserPresence(config, [node]), []);
    const observer = await attachBrowser({ endpoint, targetId: target.id });
    let closed = false;
    observer.events.once("close", () => { closed = true; });
    await owner.send("Target.closeTarget", { targetId: target.id });
    await until(() => closed);
    assert.equal(observer.status().state, "stopped");
    await observer.close();
    assert.ok((await owner.send("Browser.getVersion")).product.includes("Chrome"));
  });
});
