import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCollector, snapshotHealth } from "./collector.mjs";
import { createDetailsService } from "./details.mjs";
import { watchPilot } from "./browser/pilot.mjs";
import { createBrowserCatalog, withBrowserPresence } from "./browser/presence.mjs";

const UI_DIR = fileURLToPath(new URL("../ui/", import.meta.url));
const STATIC = { "/": "index.html", "/app.js": "app.js", "/inspector.js": "inspector.js", "/artifact-view.js": "artifact-view.js", "/browser-view.js": "browser-view.js", "/live-view.js": "live-view.js", "/browser-demo": "browser-demo.html", "/browser-demo.js": "browser-demo.js", "/layout.js": "layout.js", "/graph-scene.js": "graph-scene.js", "/style.css": "style.css", "/favicon.svg": "favicon.svg" };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

export async function serve(config, adapters) {
  const collector = createCollector(config, adapters);
  const details = createDetailsService(config);
  const clients = new Set();
  const browsers = createBrowserCatalog(config);
  let agentsviewUp = false;
  let browserPresence = [];
  let checkingBrowser = false;
  const withExtras = (snap) => ({ ...withBrowserPresence(snap, browserPresence), agentsviewUp });
  const broadcast = (snap) => {
    const payload = `event: snapshot\ndata: ${JSON.stringify(withExtras(snap))}\n\n`;
    for (const res of clients) res.write(payload);
  };

  collector.events.on("snapshot", (snap) => {
    broadcast(snap);
  });
  collector.events.on("error", (error) => console.error("[collector]", error));

  const refreshBrowser = async () => {
    if (checkingBrowser || !collector.latest()) return;
    checkingBrowser = true;
    try {
      const next = await browsers.refresh(collector.latest().nodes);
      if (JSON.stringify(next) !== JSON.stringify(browserPresence)) { browserPresence = next; broadcast(collector.latest()); }
    } finally { checkingBrowser = false; }
  };
  setInterval(() => void refreshBrowser().catch(() => {}), 4000).unref();

  const server = createDashboardServer(collector, details, { clients, withExtras, browserConfig: config, browsers });

  // Keep SSE connections alive through proxies and sleeping laptops.
  setInterval(() => {
    for (const res of clients) res.write(": ping\n\n");
  }, 15_000).unref();

  // agentsview is optional; links are only shown while it answers.
  const probe = async () => {
    try {
      const r = await fetch(new URL("/api/ping", config.agentsviewUrl), { signal: AbortSignal.timeout(1500) });
      agentsviewUp = r.ok;
    } catch {
      agentsviewUp = false;
    }
  };
  await probe();
  setInterval(probe, 30_000).unref();

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  console.log(`agent-fleet listening on http://${config.host}:${config.port}`);
  collector.start();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    collector.stop();
    server.close();
    for (const res of clients) res.end();
    const deadline = setTimeout(() => process.exit(0), 5000);
    await browsers.close();
    clearTimeout(deadline);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return server;
}

function json(res, body, cache = "no-cache") {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": cache });
  res.end(JSON.stringify(body));
}

/** HTTP surface separated from collection so integration tests use synthetic sessions. */
export function createDashboardServer(collector, details, { clients = new Set(), withExtras = (s) => s, browserConfig = null, browsers = null } = {}) {
  const browserViewers = new Set();
  let artifactRequests = 0;
  const health = () => collector.health?.() ?? snapshotHealth(collector.latest());
  const sendHealth = (data) => {
    const payload = `event: health\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      if (res.writableLength > 2 * 1024 * 1024) { res.destroy(); clients.delete(res); }
      else res.write(payload);
    }
  };
  collector.events?.on("health", sendHealth);
  const server = createServer(async (req, res) => {
    // DNS-rebinding guard: only answer requests addressed to loopback names.
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    res.setHeader("content-security-policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
    res.setHeader("x-content-type-options", "nosniff");
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method !== "GET") {
        res.writeHead(405).end();
      } else if (url.pathname.startsWith("/api/sessions/")) {
        res.setHeader("cache-control", "no-store");
        if (req.headers["sec-fetch-site"] === "cross-site" || req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
          res.writeHead(403).end("forbidden");
          return;
        }
        const match = /^\/api\/sessions\/([^/]+)\/(details|browser\/events|artifacts\/([a-f0-9-]{16,64})\/(preview|download))$/.exec(url.pathname);
        if (!match) { res.writeHead(404).end("not found"); return; }
        let id;
        try { id = decodeURIComponent(match[1]); }
        catch { res.writeHead(400).end("invalid session id"); return; }
        const before = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : null;
        const revision = url.searchParams.get("revision");
        if (before !== null && (!Number.isSafeInteger(before) || before < 0 || !/^\d+$/.test(url.searchParams.get("before"))) || revision?.length > 256) {
          res.writeHead(400).end("invalid page"); return;
        }
        if (!collector.latest()) await collector.ready();
        const n = collector.latest()?.nodes.find((n) => n.id === id);
        if (!n) { res.writeHead(404).end("session not found"); return; }
        if (match[3]) {
          if (!details.artifact) { res.writeHead(404).end("not found"); return; }
          if (artifactRequests >= 8) { res.writeHead(503).end("artifact service busy"); return; }
          artifactRequests++;
          try {
            const download = match[4] === "download";
            const file = await details.artifact(n, match[3], { download });
            res.setHeader("content-security-policy", "default-src 'none'; sandbox");
            if (download) {
              if (file.state !== "available" || !Buffer.isBuffer(file.body)) {
                res.writeHead(({ restricted: 403, missing: 404, changed: 409, expired: 410, oversized: 413, unsupported: 415 })[file.state] ?? 503, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ state: file.state ?? "unavailable" }));
                return;
              }
              const name = String(file.filename ?? file.name ?? "download").toWellFormed();
              const fallback = name.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 120) || "download";
              const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
              res.writeHead(200, {
                "content-type": "application/octet-stream",
                "content-disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
                "content-length": file.body.length,
              });
              res.end(file.body);
            } else {
              const value = { state: file.state, kind: file.kind, name: file.name };
              if (file.state === "available") {
                if (file.kind === "text" && typeof file.body === "string") {
                  value.text = file.body;
                  value.truncated = Boolean(file.truncated);
                } else if (file.kind === "image" && Buffer.isBuffer(file.body) && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.contentType)) {
                  value.image = `data:${file.contentType};base64,${file.body.toString("base64")}`;
                }
              }
              json(res, value, "no-store");
            }
          } finally { artifactRequests--; }
          return;
        }
        if (match[2] === "browser/events") {
          if (browserViewers.size >= 8) { res.writeHead(503).end("too many browser viewers"); return; }
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
          browserViewers.add(res);
          res.write("retry: 3000\n\n");
          let closed = false;
          let stop = null;
          const cancellation = new AbortController();
          const emit = (type, data) => {
            if (closed) return;
            if (res.writableLength > 2 * 1024 * 1024) { res.destroy(); return; }
            res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
          };
          req.on("close", () => { closed = true; cancellation.abort(); browserViewers.delete(res); stop?.(); });
          const source = url.searchParams.get("view");
          if (source && !/^[a-f0-9-]{1,64}$/.test(source)) { emit("status", { state: "unavailable" }); res.end(); return; }
          if (browsers) stop = await browsers.watch(n, emit, source, { signal: cancellation.signal });
          else if (browserConfig) stop = await watchPilot(browserConfig, n, emit, { signal: cancellation.signal });
          else emit("status", { state: "unavailable" });
          if (closed) stop?.();
          return;
        }
        json(res, await details.get(n, { before, revision }), "no-store");
      } else if (url.pathname === "/api/snapshot") {
        if (!collector.latest()) await collector.ready();
        const s = collector.latest();
        if (s) json(res, withExtras(s));
        else res.writeHead(503).end("collecting");
      } else if (url.pathname === "/api/health") {
        json(res, health(), "no-store");
      } else if (url.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write("retry: 3000\n\n");
        const s = collector.latest();
        if (s) res.write(`event: snapshot\ndata: ${JSON.stringify(withExtras(s))}\n\n`);
        res.write(`event: health\ndata: ${JSON.stringify(health())}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
      } else if (STATIC[url.pathname]) {
        const file = join(UI_DIR, STATIC[url.pathname]);
        res.writeHead(200, { "content-type": TYPES[extname(file)], "cache-control": "no-cache" });
        res.end(await readFile(file));
      } else {
        res.writeHead(404).end("not found");
      }
    } catch (error) {
      console.error("[http]", error);
      if (!res.headersSent) res.writeHead(error.status === 503 ? 503 : 500);
      res.end("internal error");
    }
  });
  server.once("close", () => collector.events?.off("health", sendHealth));
  return server;
}
