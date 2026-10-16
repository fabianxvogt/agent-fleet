import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { link } from "./linker.mjs";
import { EDGE_KINDS, LIVE_STATUSES, STATUSES, mergeEdges, mergeNodes } from "./model.mjs";
import { snapshotProcesses } from "./procs.mjs";

/** Runs every adapter on an interval and emits "snapshot" whenever the graph changes. */
export function createCollector(config, adapters) {
  const events = new EventEmitter();
  let latest = null;
  let timer = null;
  let running = false;
  let firstTick = null;

  async function collectOnce() {
    const started = Date.now();
    const { procs, openFileOwners } = await snapshotProcesses();
    const ctx = { now: Date.now(), home: config.home, windowMs: config.windowHours * 3_600_000, procs, openFileOwners, config };
    const results = await Promise.all(
      adapters.map(async (a) => {
        const t0 = Date.now();
        try {
          const r = await a.collect(ctx);
          return { adapter: a, nodes: r.nodes ?? [], edges: r.edges ?? [], ms: Date.now() - t0, error: null };
        } catch (error) {
          return { adapter: a, nodes: [], edges: [], ms: Date.now() - t0, error: String(error?.stack ?? error) };
        }
      }),
    );
    const nodes = mergeNodes(results.map((r) => r.nodes));
    const edges = mergeEdges(results.map((r) => r.edges));
    link(nodes, edges, procs);
    for (const e of edges.values()) {
      if (!nodes.has(e.from) || !nodes.has(e.to) || !(e.kind in EDGE_KINDS)) edges.delete(e.id);
    }
    // Statuses come from files on disk (e.g. a cloned repo's .fleet/state.json): never pass unknown values on.
    for (const n of nodes.values()) if (!(n.status in STATUSES)) n.status = "idle";
    // A session that has waited for hours is parked, not urgent: keep "waiting" for what needs attention now.
    const parkMs = config.parkAfterMinutes * 60_000;
    for (const n of nodes.values()) {
      if (n.status === "waiting" && ctx.now - Date.parse(n.lastActivityAt ?? 0) > parkMs) {
        n.status = "idle";
        n.meta = { ...n.meta, parked: true };
      }
    }

    const nodeList = [...nodes.values()].sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
    const counts = {};
    for (const n of nodeList) counts[n.status] = (counts[n.status] ?? 0) + 1;
    const snapshot = {
      generatedAt: new Date().toISOString(),
      collectMs: Date.now() - started,
      windowHours: config.windowHours,
      agentsviewUrl: config.agentsviewUrl,
      adapters: results.map((r) => ({ id: r.adapter.id, label: r.adapter.label, nodes: r.nodes.length, ms: r.ms, error: r.error })),
      counts,
      live: nodeList.filter((n) => LIVE_STATUSES.has(n.status)).length,
      nodes: nodeList,
      edges: [...edges.values()],
    };
    snapshot.hash = hashOf(snapshot);
    return snapshot;
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const next = await collectOnce();
      if (!latest || next.hash !== latest.hash) {
        latest = next;
        events.emit("snapshot", latest);
      } else {
        latest = { ...latest, generatedAt: next.generatedAt, collectMs: next.collectMs };
      }
    } catch (error) {
      events.emit("error", error);
    } finally {
      running = false;
    }
  }

  return {
    events,
    collectOnce,
    latest: () => latest,
    /** Resolves once the first collection finished; requests share it instead of starting their own. */
    ready: () => firstTick ?? Promise.resolve(),
    async start() {
      firstTick = tick();
      await firstTick;
      timer = setInterval(tick, config.intervalMs);
    },
    stop() {
      clearInterval(timer);
    },
  };
}

/** Hash of the graph content, ignoring timing fields that change every tick. */
function hashOf(s) {
  const h = createHash("sha1");
  h.update(JSON.stringify(s.adapters.map((a) => [a.id, a.nodes, Boolean(a.error)])));
  h.update(JSON.stringify(s.nodes));
  h.update(JSON.stringify(s.edges));
  return h.digest("hex").slice(0, 16);
}
