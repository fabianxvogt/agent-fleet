import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCollector } from "./collector.mjs";
import { createDetailsService } from "./details.mjs";
import { watchPilot } from "./browser/pilot.mjs";

const UI_DIR = fileURLToPath(new URL("../ui/", import.meta.url));
const STATIC = { "/": "index.html", "/app.js": "app.js", "/inspector.js": "inspector.js", "/browser-view.js": "browser-view.js", "/browser-demo": "browser-demo.html", "/browser-demo.js": "browser-demo.js", "/layout.js": "layout.js", "/style.css": "style.css", "/favicon.svg": "favicon.svg" };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

export async function serve(config, adapters) {
  const collector = createCollector(config, adapters);
  const details = createDetailsService(config);
  const clients = new Set();
  let agentsviewUp = false;

  collector.events.on("snapshot", (snap) => {
    const payload = `event: snapshot\ndata: ${JSON.stringify(withExtras(snap))}\n\n`;
    for (const res of clients) res.write(payload);
  });
  collector.events.on("error", (error) => console.error("[collector]", error));

  const withExtras = (snap) => ({ ...snap, agentsviewUp });

  const server = createDashboardServer(collector, details, { clients, withExtras, browserConfig: config });

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

  const shutdown = () => {
    collector.stop();
    server.close();
    for (const res of clients) res.end();
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
export function createDashboardServer(collector, details, { clients = new Set(), withExtras = (s) => s, browserConfig = null } = {}) {
  const browserViewers = new Set();
  return createServer(async (req, res) => {
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
        const match = /^\/api\/sessions\/([^/]+)\/(details|browser\/events)$/.exec(url.pathname);
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
        if (match[2] === "browser/events") {
          if (browserViewers.size >= 8) { res.writeHead(503).end("too many browser viewers"); return; }
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
          browserViewers.add(res);
          res.write("retry: 3000\n\n");
          let closed = false;
          let stop = null;
          const emit = (type, data) => {
            if (closed) return;
            if (res.writableLength > 2 * 1024 * 1024) { res.destroy(); return; }
            res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
          };
          req.on("close", () => { closed = true; browserViewers.delete(res); stop?.(); });
          if (browserConfig) stop = await watchPilot(browserConfig, n, emit);
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
        const s = collector.latest();
        json(res, { ok: Boolean(s), generatedAt: s?.generatedAt ?? null, collectMs: s?.collectMs ?? null, adapters: s?.adapters ?? [] });
      } else if (url.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write("retry: 3000\n\n");
        const s = collector.latest();
        if (s) res.write(`event: snapshot\ndata: ${JSON.stringify(withExtras(s))}\n\n`);
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
}
