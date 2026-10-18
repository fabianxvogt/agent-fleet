import { randomUUID } from "node:crypto";
import { browserSessionAllowed, pilotManifests, pilotRequest, watchPilot } from "./pilot.mjs";
import { discoverBrowsers } from "./discovery.mjs";
import { externalProcess } from "./association.mjs";
import { attachBrowser } from "./external.mjs";

/** Small, verified graph metadata; page content never enters graph snapshots. */
export async function readBrowserPresence(config, nodes) {
  const manifests = await pilotManifests(config);
  const sources = await Promise.all(manifests.map(async (manifest) => {
    if (manifest.state !== "ready") return null;
    const node = nodes.find((n) => n.id === manifest.sessionId);
    if (!node || !await browserSessionAllowed(node)) return null;
    try {
      const status = await pilotRequest(config, node.id, { action: "status" }, { timeoutMs: 1200 });
      if (!["live", "loading"].includes(status?.state)) return null;
      return { id: manifest.runId, sessionId: node.id, mode: status.mode === "attached" ? "attached" : "managed", available: true,
        label: status.title || "Terminal browser", endpoint: manifest.endpoint, targetId: manifest.targetId };
    } catch { return null; }
  }));
  return sources.filter(Boolean);
}

export function withBrowserPresence(snapshot, presence) {
  const sources = Array.isArray(presence) ? presence : presence ? [presence] : [];
  return { ...snapshot, nodes: snapshot.nodes.map((node) => {
    const { liveView: ignored, ...clean } = node;
    const views = sources.filter((s) => s.sessionId === node.id && s.available !== false);
    return views.length ? { ...clean, liveView: { available: true, mode: views[0].mode, count: views.length } } : clean;
  }) };
}

/** Registry for every session; discovery is metadata-only, capture starts on selection. */
export function createBrowserCatalog(config, { discover = discoverBrowsers, managed = readBrowserPresence, attach = attachBrowser, verify = externalProcess } = {}) {
  let sources = [];
  let pending = null;
  let closed = false;
  const viewers = new Set();
  const openings = new Set();
  const disposals = new Set();
  return {
    refresh(nodes) {
      if (closed) return Promise.resolve([]);
      if (pending) return pending;
      pending = (async () => {
        const [explicit, automatic] = await Promise.all([managed(config, nodes), config.autoDiscoverBrowsers === false ? [] : discover(nodes)]);
        if (closed) return [];
        // An explicit observer may already represent one of the discovered pages.
        sources = [...explicit, ...automatic.filter((s) => !explicit.some((e) => e.sessionId === s.sessionId && e.endpoint === s.endpoint && e.targetId === s.targetId))];
        for (const viewer of [...viewers]) {
          const views = sources.filter((s) => s.sessionId === viewer.sessionId);
          viewer.emit("sources", { sources: views.map(({ id, label }) => ({ id, label })), selectedId: viewer.selectedId });
          if (!views.some((s) => s.id === viewer.selectedId)) { viewer.emit("status", { state: "disconnected" }); viewer.stop(); }
        }
        return sources.map(({ sessionId, mode }) => ({ sessionId, mode, available: true }));
      })().finally(() => { pending = null; });
      return pending;
    },
    watch(node, emit, sourceId = null, { signal = null } = {}) {
      if (openings.size >= 8 || signal?.aborted) { emit("status", { state: "disconnected" }); return Promise.resolve(() => {}); }
      const opening = (async () => {
        if (closed) { emit("status", { state: "disconnected" }); return () => {}; }
        if (!await browserSessionAllowed(node)) { emit("status", { state: "restricted" }); return () => {}; }
        if (pending) await pending;
        const views = sources.filter((s) => s.sessionId === node.id);
        const selected = views.find((s) => s.id === sourceId) ?? views[0];
        const current = () => !closed && !signal?.aborted && sources.some((s) => s.id === selected?.id && s.sessionId === node.id);
        emit("sources", { sources: views.map(({ id, label }) => ({ id, label })), selectedId: selected?.id ?? null });
        if (!selected) return watchPilot(config, node, emit, { signal });
        if (!selected.automatic) {
          const dispose = await watchPilot(config, node, emit, { runId: selected.id, signal });
          const viewer = { sessionId: node.id, selectedId: selected.id, emit, stop() { viewers.delete(viewer); dispose(); } };
          if (!current()) { viewer.stop(); emit("status", { state: "disconnected" }); } else viewers.add(viewer);
          return () => viewer.stop();
        }
        let browser;
        try {
          await verify(node, selected.endpoint, selected.process.pid, selected.process.startKey);
          if (!current()) { emit("status", { state: "disconnected" }); return () => {}; }
          browser = await attach(selected);
        } catch { emit("status", { state: "disconnected" }); return () => {}; }
        const runId = randomUUID();
        let stopped = false;
        let viewer;
        let cleanup = null;
        const send = (type, data) => { if (!stopped) emit(type, { ...data, mode: "attached", runId }); };
        const heartbeat = setInterval(() => send("status", browser.status()), 2000);
        const stop = () => {
          if (stopped) return cleanup;
          stopped = true; clearInterval(heartbeat); viewers.delete(viewer);
          signal?.removeEventListener("abort", stop);
          cleanup = browser.close().catch(() => {});
          disposals.add(cleanup);
          void cleanup.finally(() => disposals.delete(cleanup));
          return cleanup;
        };
        viewer = { sessionId: node.id, selectedId: selected.id, emit, stop };
        viewers.add(viewer);
        signal?.addEventListener("abort", stop, { once: true });
        browser.events.on("status", (data) => send("status", data));
        browser.events.on("frame", (data) => send("frame", data));
        browser.events.once("close", () => { send("status", { state: "disconnected" }); stop(); });
        if (!current()) { await stop(); emit("status", { state: "disconnected" }); return stop; }
        send("status", browser.status());
        try { await browser.watch(true); }
        catch { send("status", { state: "disconnected" }); stop(); }
        return stop;
      })();
      openings.add(opening);
      void opening.finally(() => openings.delete(opening)).catch(() => {});
      return opening;
    },
    async close() {
      closed = true;
      for (const viewer of [...viewers]) viewer.stop();
      sources = [];
      await Promise.allSettled([...openings]);
      await Promise.allSettled([...disposals]);
    },
  };
}
