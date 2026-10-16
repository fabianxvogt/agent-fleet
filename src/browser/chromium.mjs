import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { connectPipe } from "./cdp.mjs";

export const VIEWPORT = { width: 1280, height: 800 };
const WORLD = "agent-fleet-observer";
const BINDING = "__agentFleetClick";
const OBSERVER = `if (window === window.top && !globalThis.__agentFleetObserved) {
  globalThis.__agentFleetObserved = true;
  document.addEventListener('click', event => {
    if (!event.isTrusted) return;
    ${BINDING}(JSON.stringify({x:event.clientX,y:event.clientY,width:innerWidth,height:innerHeight,at:Date.now(),trusted:true}));
  }, {capture:true,passive:true});
}`;

export function browserUrl(value) {
  if (value === "about:blank") return value;
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Use an HTTP(S) URL without embedded credentials");
  return url.href;
}

export async function chromeExecutable(explicit = process.env.AGENT_FLEET_CHROME) {
  const paths = explicit ? [explicit] : process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
    : ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"];
  for (const path of paths) { try { await access(path); return path; } catch {} }
  throw new Error("Chrome/Chromium is unavailable. Set AGENT_FLEET_CHROME to its executable.");
}

export async function launchBrowser({ profile, executable, url = "about:blank" }) {
  browserUrl(url);
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const child = spawn(await chromeExecutable(executable), [
    "--headless=new", "--remote-debugging-pipe", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-component-update", "--disable-sync", "--hide-scrollbars", "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const cdp = connectPipe(child);
  const events = new EventEmitter();
  let session;
  let frameId;
  let contextId;
  let documentId = 0;
  let documentStartedAt = 0;
  let ready = false;
  let currentUrl = "about:blank";
  let title = "Browser";
  let subscribers = 0;
  let casting = false;
  let castQueue = Promise.resolve();
  let lastFrame = null;
  let clickSequence = 0;
  let clicks = [];
  let capture = null;
  let stopped = false;
  const acknowledgements = new Set();
  const page = (method, params = {}) => cdp.send(method, params, session);
  const status = () => ({ state: stopped ? "stopped" : ready ? "live" : "loading", documentId, title, url: displayUrl(currentUrl), viewport: VIEWPORT, clicks: clicks.filter((c) => Date.now() - c.at < 6000), lastFrameAt: lastFrame?.at ?? null });
  const publishStatus = () => events.emit("status", status());
  const frame = (data, at = Date.now(), expectedDocument = documentId) => {
    if (!ready || stopped || expectedDocument !== documentId || at < documentStartedAt || lastFrame?.at > at || typeof data !== "string" || data.length > 2 * 1024 * 1024) return;
    lastFrame = { data, at, documentId, width: VIEWPORT.width, height: VIEWPORT.height };
    events.emit("frame", lastFrame);
  };
  const screenshot = () => {
    if (capture || !ready || !subscribers) return capture;
    const expectedDocument = documentId;
    const capturedAt = Date.now();
    capture = page("Page.captureScreenshot", { format: "jpeg", quality: 60, captureBeyondViewport: false })
      .then((result) => frame(result.data, capturedAt, expectedDocument))
      .catch(() => {}).finally(() => { capture = null; });
    return capture;
  };
  const reset = (url) => {
    currentUrl = url;
    documentId++;
    documentStartedAt = Date.now();
    clicks = []; lastFrame = null; contextId = null; ready = false;
    publishStatus();
  };
  cdp.events.on("close", () => { stopped = true; for (const timer of acknowledgements) clearTimeout(timer); publishStatus(); events.emit("close"); });
  cdp.events.on("event", ({ method, params = {}, sessionId }) => {
    if (sessionId !== session) return;
    if (method === "Page.frameNavigated" && !params.frame.parentId) { frameId = params.frame.id; reset(params.frame.url); }
    if (method === "Runtime.executionContextCreated" && params.context.name === WORLD && params.context.auxData?.frameId === frameId) contextId = params.context.id;
    if (method === "Runtime.executionContextsCleared") contextId = null;
    if (method === "Page.domContentEventFired") { ready = true; publishStatus(); void screenshot(); }
    if (method === "Page.navigatedWithinDocument" && params.frameId === frameId) {
      currentUrl = params.url; documentId++; documentStartedAt = Date.now();
      clicks = []; lastFrame = null; ready = true;
      publishStatus(); void screenshot();
    }
    if (method === "Runtime.bindingCalled" && params.name === BINDING && params.executionContextId === contextId) {
      let click;
      try { if (params.payload.length > 1000) return; click = JSON.parse(params.payload); } catch { return; }
      if (!click.trusted || ![click.x, click.y, click.at].every(Number.isFinite) || click.x < 0 || click.y < 0 || click.x >= VIEWPORT.width || click.y >= VIEWPORT.height) return;
      if (click.width !== VIEWPORT.width || click.height !== VIEWPORT.height) return;
      clicks = [...clicks.filter((c) => Date.now() - c.at < 6000), { id: ++clickSequence, x: click.x, y: click.y, at: click.at, documentId }].slice(-6);
      publishStatus(); void screenshot();
    }
    if (method === "Page.screencastFrame") {
      frame(params.data, params.metadata?.timestamp ? params.metadata.timestamp * 1000 : Date.now());
      const timer = setTimeout(() => { acknowledgements.delete(timer); void page("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {}); }, 250);
      acknowledgements.add(timer);
    }
  });

  async function waitReady() {
    const deadline = Date.now() + 15_000;
    while (!stopped && Date.now() < deadline) {
      if (ready && contextId) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Browser page did not become ready");
  }
  async function evaluate(expression) {
    await waitReady();
    const result = await page("Runtime.evaluate", { expression, contextId, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error("Browser operation failed: element missing or unavailable");
    return result.result?.value;
  }
  async function navigate(nextUrl) {
    const validatedUrl = browserUrl(nextUrl);
    const previousReady = ready;
    const previousDocument = documentId;
    ready = false;
    let result;
    try {
      result = await page("Page.navigate", { url: validatedUrl });
      if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
      if (!result.loaderId && documentId === previousDocument) ready = previousReady;
    } catch (error) {
      if (documentId === previousDocument) ready = previousReady;
      publishStatus(); throw error;
    }
    await waitReady();
    title = await evaluate("document.title");
    publishStatus(); await screenshot();
    return status();
  }
  try {
    await cdp.send("Browser.getVersion");
    await cdp.send("Browser.setDownloadBehavior", { behavior: "deny" });
    const target = await cdp.send("Target.createTarget", { url: "about:blank" });
    session = (await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
    await page("Page.enable");
    frameId = (await page("Page.getFrameTree")).frameTree.frame.id;
    await page("Runtime.enable");
    await page("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
    await page("Runtime.addBinding", { name: BINDING, executionContextName: WORLD });
    await page("Page.addScriptToEvaluateOnNewDocument", { source: OBSERVER, worldName: WORLD, runImmediately: true });
    // Re-navigate even about:blank so all observer and readiness events agree.
    await navigate(url);
  } catch (error) { child.kill(); cdp.close(); throw error; }

  return {
    events, status,
    async watch(enable) {
      subscribers = Math.max(0, subscribers + (enable ? 1 : -1));
      castQueue = castQueue.catch(() => {}).then(async () => {
        if (Boolean(subscribers) === casting || stopped) return;
        casting = Boolean(subscribers);
        await page(casting ? "Page.startScreencast" : "Page.stopScreencast", casting ? { format: "jpeg", quality: 60, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height } : {});
        if (casting) await screenshot();
      });
      return castQueue;
    },
    lastFrame: () => lastFrame,
    async command(command) {
      if (command.action === "open") return navigate(command.url);
      if (command.action === "state") return { ...status(), text: String(await evaluate("document.body?.innerText ?? ''")).slice(0, 12000) };
      if (command.action === "click") {
        const previousClick = clickSequence;
        if (typeof command.selector !== "string" || command.selector.length > 1000) throw new Error("A CSS selector is required");
        const point = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(command.selector)}); if (!el) throw Error(); el.scrollIntoView({block:'center',inline:'center'}); const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
        if (!point || point.x < 0 || point.y < 0 || point.x >= VIEWPORT.width || point.y >= VIEWPORT.height) throw new Error("Element is outside the browser viewport");
        await page("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
        await page("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
        await screenshot();
        return { dispatched: true, ...point, click: clicks.find((c) => c.id > previousClick) ?? null };
      }
      if (command.action === "fill") {
        if (typeof command.selector !== "string" || command.selector.length > 1000 || typeof command.text !== "string" || command.text.length > 16000) throw new Error("A selector and text are required");
        await evaluate(`(() => { const el=document.querySelector(${JSON.stringify(command.selector)}); if (!el || !['INPUT','TEXTAREA'].includes(el.tagName)) throw Error(); el.focus(); el.select(); })()`);
        await page("Input.insertText", { text: command.text });
        await screenshot(); return { filled: true };
      }
      if (command.action === "scroll") {
        const dy = Number(command.dy);
        if (!Number.isFinite(dy) || Math.abs(dy) > 10000) throw new Error("Scroll distance must be between -10000 and 10000");
        await page("Input.dispatchMouseEvent", { type: "mouseWheel", x: 640, y: 400, deltaX: 0, deltaY: dy });
        clicks = []; publishStatus(); await screenshot(); return { scrolled: true };
      }
      throw new Error("Unknown browser action");
    },
    async close() {
      subscribers = 0;
      await cdp.send("Browser.close").catch(() => {});
      if (child.exitCode === null) child.kill();
      if (child.exitCode === null) await new Promise((resolve) => { const timer = setTimeout(resolve, 3000); child.once("exit", () => { clearTimeout(timer); resolve(); }); });
      cdp.close();
    },
  };
}

export function displayUrl(value) {
  try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.href; } catch { return "Browser"; }
}
