import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { browserUrl, displayUrl } from "./chromium.mjs";

const viewable = (url) => { try { browserUrl(url); return true; } catch { return false; } };

export function localEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
      !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Use a loopback HTTP debugging endpoint with a port");
  // Avoid DNS resolution even for localhost.
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url;
}

async function metadata(endpoint, path) {
  const response = await fetch(new URL(path, localEndpoint(endpoint)), { redirect: "error", signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error("Browser debugging endpoint is unavailable");
  let text = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    text += decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(text) > 256 * 1024) { await response.body.cancel().catch(() => {}); throw new Error("Browser metadata is too large"); }
  }
  text += decoder.decode();
  return JSON.parse(text);
}

export async function externalTargets(endpoint) {
  const targets = await metadata(endpoint, "/json/list");
  if (!Array.isArray(targets) || targets.length > 100) throw new Error("Invalid browser targets");
  return targets.filter((t) => t.type === "page" && viewable(t.url) && /^[\w-]{1,128}$/.test(t.id)).map((t) => ({ id: t.id, title: String(t.title ?? "Browser").slice(0,200), url: displayUrl(t.url) }));
}

/** A second CDP connection; closing it never closes the browser or its targets. */
export async function connectExternal(endpoint, { timeoutMs = 5000 } = {}) {
  const base = localEndpoint(endpoint);
  const version = await metadata(base.href, "/json/version");
  const url = new URL(version.webSocketDebuggerUrl);
  if (url.protocol !== "ws:" || url.hostname !== base.hostname || url.port !== base.port ||
      !/^\/devtools\/browser\/[\w-]+$/.test(url.pathname) || url.username || url.password || url.search || url.hash) throw new Error("Invalid browser WebSocket endpoint");
  const socket = new WebSocket(url);
  const events = new EventEmitter();
  const pending = new Map();
  let sequence = 0;
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error("Browser connection closed")); }
    pending.clear(); events.emit("close");
  };
  socket.addEventListener("close", finish);
  socket.addEventListener("error", finish);
  socket.addEventListener("message", ({ data }) => {
    if (closed) return;
    if (typeof data !== "string" || Buffer.byteLength(data) > 4 * 1024 * 1024) { finish(); socket.close(); return; }
    let message;
    try { message = JSON.parse(data); } catch { finish(); socket.close(); return; }
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message || "Browser command failed")); else request.resolve(message.result ?? {});
    } else if (message.method) events.emit("event", message);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("Browser connection timed out")); }, timeoutMs);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Browser connection failed")); }, { once: true });
  });
  return {
    events,
    send(method, params = {}, sessionId) {
      if (closed) return Promise.reject(new Error("Browser connection closed"));
      if (pending.size >= 32) return Promise.reject(new Error("Browser command queue is full"));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("Browser command timed out")); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { socket.send(JSON.stringify({ id, method, params, sessionId })); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    },
    close() { finish(); socket.close(); },
  };
}

const validView = (v) => v && [v.width, v.height, v.scrollX, v.scrollY].every(Number.isFinite) && v.width >= 1 && v.height >= 1 && v.width <= 8192 && v.height <= 8192;

export async function attachBrowser({ endpoint, targetId }) {
  if (!/^[\w-]{1,128}$/.test(targetId)) throw new Error("An explicit page target ID is required");
  const cdp = await connectExternal(endpoint);
  const events = new EventEmitter();
  const key = randomUUID().replaceAll("-", "");
  const world = `agent-fleet-${key}`;
  const binding = `__agentFleet${key}`;
  const script = `(() => {
    if (window !== window.top || globalThis.__fleetCleanup || !(['http:','https:'].includes(location.protocol) || location.href==='about:blank')) return;
    const metrics = () => ({width:innerWidth,height:innerHeight,scrollX,scrollY,at:Date.now()});
    const click = e => { if (e.isTrusted) globalThis.${binding}?.(JSON.stringify({...metrics(),type:'click',x:e.clientX,y:e.clientY})); };
    const viewport = () => globalThis.${binding}?.(JSON.stringify({...metrics(),type:'viewport'}));
    document.addEventListener('click',click,{capture:true,passive:true});
    window.addEventListener('resize',viewport,{passive:true});
    window.addEventListener('scroll',viewport,{passive:true});
    globalThis.__fleetCleanup = () => {document.removeEventListener('click',click,true);window.removeEventListener('resize',viewport);window.removeEventListener('scroll',viewport);delete globalThis.__fleetCleanup;};
  })()`;
  let session, frameId, contextId, scriptId;
  let documentId = 1, generation = 0, clickSequence = 0;
  let stopped = false, closing = false, subscribers = 0, timer = null, capture = null;
  let view = null, clicks = [], lastFrame = null, ready = false, blocked = false, title = "Browser", url = "about:blank";
  const page = (method, params = {}) => cdp.send(method, params, session);
  const status = () => ({ state: stopped ? "stopped" : blocked ? "blocked" : ready ? "live" : "loading", mode: "attached", documentId, title: blocked ? "Unsupported browser page" : title, url: blocked ? "Unsupported page URL" : displayUrl(url), viewport: view && { width: view.width, height: view.height }, clicks: clicks.filter((c) => Date.now() - c.at < 6000), lastFrameAt: lastFrame?.at ?? null, targetId });
  const publish = () => events.emit("status", status());
  const invalidate = () => { documentId++; generation++; clicks = []; lastFrame = null; publish(); };
  const updateView = (next) => {
    if (!validView(next)) return false;
    if (view && ["width", "height", "scrollX", "scrollY"].some((k) => view[k] !== next[k])) invalidate();
    view = { width: next.width, height: next.height, scrollX: next.scrollX, scrollY: next.scrollY };
    return true;
  };
  const evaluate = async (expression) => {
    if (!contextId || stopped || blocked) throw new Error("Browser context is unavailable");
    const result = await page("Runtime.evaluate", { expression, contextId, returnByValue: true });
    if (result.exceptionDetails) throw new Error("Browser observation failed");
    return result.result?.value;
  };
  async function observe() {
    if (!subscribers || stopped || blocked || capture) return capture;
    capture = (async () => {
      const expected = generation;
      if (!contextId) return;
      const metrics = await evaluate("({width:innerWidth,height:innerHeight,scrollX,scrollY,title:String(document.title).slice(0,200),url:location.href.slice(0,8192),ready:document.readyState!=='loading'})");
      if (expected !== generation || stopped || blocked) return;
      if (!updateView(metrics)) throw new Error("Browser viewport exceeds the view limit");
      if (!viewable(metrics.url)) { blocked = true; ready = false; invalidate(); return; }
      title = String(metrics.title).slice(0,200); url = metrics.url; ready = metrics.ready;
      publish();
      if (!ready) return;
      const document = documentId, capturedAt = Date.now();
      // A clip/scale can temporarily override emulation owned by another CDP client.
      const { data } = await page("Page.captureScreenshot", { format: "jpeg", quality: 60, captureBeyondViewport: false });
      if (stopped || blocked || !subscribers || document !== documentId) return;
      if (typeof data !== "string" || data.length > 2 * 1024 * 1024) throw new Error("Browser frame exceeds the view limit");
      lastFrame = { data, at: capturedAt, documentId, width: view.width, height: view.height };
      events.emit("frame", lastFrame);
    })().catch(() => { if (!stopped) { ready = false; invalidate(); } }).finally(() => { capture = null; });
    return capture;
  }
  cdp.events.on("event", ({ method, params = {}, sessionId }) => {
    if (method === "Target.detachedFromTarget" && params.sessionId === session) { cdp.close(); return; }
    if (sessionId !== session) return;
    if (method === "Page.frameNavigated" && !params.frame.parentId) { frameId = params.frame.id; contextId = null; ready = false; url = params.frame.url; blocked = !viewable(url); view = null; invalidate(); }
    if (method === "Runtime.executionContextCreated" && params.context.name === world && params.context.auxData?.frameId === frameId) contextId = params.context.id;
    if (method === "Runtime.executionContextsCleared") { contextId = null; ready = false; invalidate(); }
    if (method === "Page.navigatedWithinDocument" && params.frameId === frameId) { url = params.url; blocked = !viewable(url); invalidate(); }
    if (method === "Runtime.bindingCalled" && !blocked && params.name === binding && params.executionContextId === contextId) {
      let event;
      try { if (params.payload.length > 1500) return; event = JSON.parse(params.payload); } catch { return; }
      if (!validView(event) || !Number.isFinite(event.at) || Math.abs(Date.now() - event.at) > 6000) return;
      updateView(event);
      if (event.type === "click" && [event.x,event.y].every(Number.isFinite) && event.x >= 0 && event.y >= 0 && event.x < view.width && event.y < view.height) {
        clicks = [...clicks.filter((c) => Date.now() - c.at < 6000), { id: ++clickSequence, documentId, x: event.x, y: event.y, at: event.at }].slice(-6);
        publish(); void observe();
      }
    }
  });
  cdp.events.on("close", () => { stopped = true; clearInterval(timer); lastFrame = null; clicks = []; publish(); events.emit("close"); });
  try {
    const info = (await cdp.send("Target.getTargetInfo", { targetId })).targetInfo;
    if (info.type !== "page") throw new Error("Only page targets can be observed");
    if (!viewable(info.url)) throw new Error("Only HTTP(S) pages and about:blank can be observed");
    title = info.title; url = info.url;
    session = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    await page("Page.enable"); frameId = (await page("Page.getFrameTree")).frameTree.frame.id;
    await page("Runtime.enable");
    await page("Runtime.addBinding", { name: binding, executionContextName: world });
    scriptId = (await page("Page.addScriptToEvaluateOnNewDocument", { source: script, worldName: world, runImmediately: true })).identifier;
    if (!contextId) {
      contextId = (await page("Page.createIsolatedWorld", { frameId, worldName: world })).executionContextId;
      await evaluate(script);
    }
    const metrics = await evaluate("({width:innerWidth,height:innerHeight,scrollX,scrollY,ready:document.readyState!=='loading'})");
    updateView(metrics); ready = metrics.ready;
  } catch (error) { await close(); throw error; }
  async function close() {
    if (closing) return;
    closing = true; clearInterval(timer); subscribers = 0;
    await evaluate("globalThis.__fleetCleanup?.()").catch(() => {});
    if (scriptId) await page("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId }).catch(() => {});
    if (session) {
      await page("Runtime.removeBinding", { name: binding }).catch(() => {});
      await cdp.send("Target.detachFromTarget", { sessionId: session }).catch(() => {});
    }
    cdp.close();
  }
  return {
    events, status, lastFrame: () => lastFrame,
    async watch(enable) {
      subscribers = Math.max(0, subscribers + (enable ? 1 : -1));
      if (subscribers && !timer) { timer = setInterval(() => void observe(), 400); await observe(); }
      if (!subscribers) { clearInterval(timer); timer = null; }
    },
    async command(command) {
      if (command.action !== "state") throw new Error("Attached browser is read-only; use its owning agent");
      return { ...status(), text: await evaluate("String(document.body?.innerText ?? '').slice(0,12000)") };
    },
    close,
  };
}
