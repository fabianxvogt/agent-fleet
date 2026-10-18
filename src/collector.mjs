import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { link } from "./linker.mjs";
import { EDGE_KINDS, LIVE_STATUSES, STATUSES, mergeEdges, mergeNodes } from "./model.mjs";
import { snapshotProcesses } from "./procs.mjs";

/** Process observations have one cadence; adapters publish independently without overlapping reads. */
export function createCollector(config, adapters, { snapshotProcesses: readProcesses = snapshotProcesses, now = Date.now } = {}) {
  const events = new EventEmitter();
  const intervalMs = config.intervalMs ?? 4000;
  const retainMs = config.retainStaleMs ?? 120_000;
  const staleAfterMs = Math.max(3 * intervalMs, 10_000);
  const sourceState = () => ({ pending: null, active: null, cancel: null, data: null, lastSuccessAt: null, observedAt: null, error: null, ms: 0, cycleMs: 0, epoch: -1 });
  const sources = new Map(adapters.map(a => [a.id, sourceState()]));
  const processes = sourceState();
  let latest = null, timer = null, publication = null, firstTick = null, readyResolve = null;
  let round = null, collection = null, collectionError = null;
  let live = false, stopped = false, failureEpoch = 0;

  // Keep the raw promise registered after timeout: ignoring cancellation must never
  // cause overlapping reads or allow a late result to overwrite newer observations.
  async function bounded(state, read, timeoutMs, label) {
    if (state.pending) throw new Error(`${label} is still running after its timeout`);
    const controller = new AbortController();
    const job = Promise.resolve().then(() => read(controller.signal));
    state.pending = job;
    const clear = () => { if (state.pending === job) state.pending = null; };
    job.then(clear, clear);
    let timeout;
    try {
      return await Promise.race([job, new Promise((_, reject) => {
        state.cancel = () => { reject(new Error(`${label} stopped`)); controller.abort(); };
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs} ms`));
          controller.abort();
        }, timeoutMs);
      })]);
    } finally { clearTimeout(timeout); state.cancel = null; }
  }

  function sourceResult(adapter, at) {
    const state = sources.get(adapter.id);
    const age = state.observedAt ? at - Date.parse(state.observedAt) : Infinity;
    const error = processes.error ? `Process observation unavailable: ${processes.error}` : state.error;
    const stale = Boolean(error || state.epoch !== failureEpoch || age > staleAfterMs);
    const retained = stale && state.data !== null && age <= retainMs;
    const data = !stale || retained ? state.data : null;
    return {
      adapter, nodes: (data?.nodes ?? []).map(n => ({ ...n, meta: {
        ...n.meta, dataSource: adapter.id, ...(stale ? { dataStale: true, dataObservedAt: state.observedAt } : {}),
      } })), edges: data?.edges ?? [],
      lastSuccessAt: state.lastSuccessAt, observedAt: state.observedAt,
      stale, retained, error, ms: state.ms, cycleMs: state.cycleMs, updating: Boolean(state.active),
    };
  }

  function buildSnapshot() {
    const at = now();
    const results = adapters.map(a => sourceResult(a, at));
    const nodes = mergeNodes(results.map(r => r.nodes));
    const edges = mergeEdges(results.map(r => r.edges));
    const processAge = processes.observedAt ? at - Date.parse(processes.observedAt) : Infinity;
    const procs = processAge <= retainMs ? processes.data?.procs ?? new Map() : new Map();
    link(nodes, edges, procs);
    if (processes.error || processAge > staleAfterMs) for (const n of nodes.values()) {
      n.meta = { ...n.meta, dataStale: true, dataObservedAt: n.meta?.dataObservedAt ?? processes.observedAt };
    }
    for (const e of edges.values()) {
      if (!nodes.has(e.from) || !nodes.has(e.to) || !(e.kind in EDGE_KINDS)) edges.delete(e.id);
    }
    for (const n of nodes.values()) if (!(n.status in STATUSES)) n.status = "idle";
    const parkMs = config.parkAfterMinutes * 60_000;
    for (const n of nodes.values()) {
      const realRequest = ["question", "approval"].includes(n.attention?.kind);
      if ((n.status === "idle" && n.kind !== "process" || n.status === "waiting" && !realRequest) && !n.meta?.dataStale && at - Date.parse(n.lastActivityAt ?? 0) > parkMs) {
        n.status = "idle";
        n.meta = { ...n.meta, parked: true };
      }
    }
    const nodeList = [...nodes.values()].sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
    const counts = {};
    for (const n of nodeList) counts[n.status] = (counts[n.status] ?? 0) + 1;
    const snapshot = {
      generatedAt: new Date(at).toISOString(),
      collectMs: Math.max(processes.ms, ...results.map(r => r.cycleMs)),
      processMs: processes.ms, processError: processes.error, processObservedAt: processes.observedAt,
      processTimings: processes.timings ?? null, processStage: processes.stage ?? null,
      intervalMs, windowHours: config.windowHours, agentsviewUrl: config.agentsviewUrl,
      adapters: results.map(r => ({ id: r.adapter.id, label: r.adapter.label, nodes: r.nodes.length, ms: r.ms,
        error: r.error, lastSuccessAt: r.lastSuccessAt, observedAt: r.observedAt,
        stale: r.stale, retained: r.retained, updating: r.updating })),
      counts, live: nodeList.filter(n => LIVE_STATUSES.has(n.status)).length,
      nodes: nodeList, edges: [...edges.values()],
    };
    snapshot.hash = hashOf(snapshot);
    return snapshot;
  }

  function publish() {
    if (!live || stopped) return;
    try {
      const next = buildSnapshot();
      collectionError = null;
      const changed = !latest || next.hash !== latest.hash;
      latest = next;
      if (changed) events.emit("snapshot", latest);
      events.emit("health", snapshotHealth(latest, { now: now(), collectionError }));
      readyResolve?.(); readyResolve = null;
    } catch (error) {
      collectionError = String(error?.message ?? error);
      if (events.listenerCount("error")) events.emit("error", error);
      events.emit("health", snapshotHealth(latest, { now: now(), collectionError }));
      readyResolve?.(); readyResolve = null;
    }
  }

  function requestPublish() {
    if (!live || stopped || publication) return;
    // Coalesce completions in the same event-loop turn; health-only changes do
    // not emit graph snapshots or disturb selection/scroll position.
    publication = setImmediate(() => { publication = null; publish(); });
  }

  function startSource(adapter, ctx, epoch, roundStarted) {
    const state = sources.get(adapter.id);
    if (state.active) return state.active;
    const started = now();
    state.active = (async () => {
      try {
        const data = await bounded(state, signal => adapter.collect({ ...ctx, signal }), config.adapterTimeoutMs ?? 8000, adapter.label);
        if (stopped) return;
        if (epoch !== failureEpoch) throw new Error("Process observation changed during source collection; retrying");
        if (!data || data.nodes != null && !Array.isArray(data.nodes) || data.edges != null && !Array.isArray(data.edges)) throw new Error("Invalid adapter result");
        state.data = { nodes: data.nodes ?? [], edges: data.edges ?? [] };
        state.lastSuccessAt = new Date(now()).toISOString();
        state.observedAt = ctx.processObservedAt;
        state.epoch = epoch;
        state.error = null;
      } catch (error) {
        if (!stopped) state.error = String(error?.message ?? error);
      } finally {
        if (!stopped) { state.ms = now() - started; state.cycleMs = now() - roundStarted; }
        state.active = null;
        requestPublish();
      }
    })();
    return state.active;
  }

  async function runRound() {
    if (round) return round;
    round = (async () => {
      const started = now();
      try {
        const data = await bounded(processes, signal => readProcesses({ signal }), config.processTimeoutMs ?? 10_000, "Process collection");
        if (stopped) return [];
        processes.data = data;
        processes.lastSuccessAt = new Date(now()).toISOString();
        processes.observedAt = new Date(started).toISOString();
        processes.error = null;
        processes.timings = data.timings ?? null;
        processes.stage = null;
      } catch (error) {
        if (stopped) return [];
        processes.error = String(error?.message ?? error);
        processes.timings = error.processTimings ?? null;
        processes.stage = error.processStage ?? null;
        failureEpoch++;
      }
      processes.ms = now() - started;
      const jobs = [];
      if (!processes.error) {
        const { procs, openFileOwners } = processes.data;
        const ctx = { now: now(), home: config.home, windowMs: config.windowHours * 3_600_000,
          procs, openFileOwners, config, processObservedAt: processes.observedAt };
        for (const adapter of adapters) jobs.push(startSource(adapter, ctx, failureEpoch, started));
      }
      // Refresh aging/expiry even if every source is still pending. On startup,
      // the first completed source supplies the first usable snapshot.
      if (latest || processes.error || !adapters.length) requestPublish();
      return jobs;
    })();
    try { return await round; }
    finally { round = null; }
  }

  async function collectOnce() {
    if (collection) return collection;
    collection = (async () => {
      const jobs = await runRound();
      await Promise.all(jobs);
      return buildSnapshot();
    })();
    try { return await collection; }
    finally { collection = null; }
  }

  async function tick() {
    if (!live || stopped) return;
    const started = now();
    try { await runRound(); }
    catch (error) {
      collectionError = String(error?.message ?? error);
      if (events.listenerCount("error")) events.emit("error", error);
    } finally {
      if (!stopped && live) timer = setTimeout(tick, Math.max(0, intervalMs - (now() - started)));
    }
  }

  return {
    events, collectOnce, latest: () => latest,
    health: () => snapshotHealth(latest, { now: now(), collectionError }),
    ready: () => firstTick ?? Promise.resolve(),
    start() {
      if (firstTick) return firstTick;
      live = true;
      firstTick = new Promise(resolve => { readyResolve = resolve; });
      void tick();
      return firstTick;
    },
    stop() {
      stopped = true; live = false;
      clearTimeout(timer); clearImmediate(publication); publication = null;
      for (const state of [processes, ...sources.values()]) state.cancel?.();
      readyResolve?.(); readyResolve = null;
    },
  };
}

/** Transport liveness is not data freshness: a healthy connection can carry old data. */
export function snapshotHealth(snapshot, { now = Date.now(), collectionError = null } = {}) {
  const intervalMs = snapshot?.intervalMs ?? 4000;
  const staleAfterMs = Math.max(3 * intervalMs, 10_000);
  const generated = Date.parse(snapshot?.generatedAt);
  const ageMs = Number.isFinite(generated) ? Math.max(0, now - generated) : null;
  const processStale = snapshot?.processObservedAt != null && now - Date.parse(snapshot.processObservedAt) > staleAfterMs;
  const stale = ageMs === null || ageMs > staleAfterMs || processStale;
  const adapters = (snapshot?.adapters ?? []).map(a => {
    const observed = Date.parse(a.observedAt ?? a.lastSuccessAt);
    return { ...a, stale: Boolean(a.stale || a.error || !Number.isFinite(observed) || now - observed > staleAfterMs) };
  });
  const processError = snapshot?.processError ?? null;
  const degraded = Boolean(collectionError || processError || processStale || adapters.some(a => a.stale || a.error));
  return { ready: Boolean(snapshot), ok: Boolean(snapshot) && !stale && !degraded, stale, degraded, ageMs, staleAfterMs, generatedAt: snapshot?.generatedAt ?? null, collectMs: snapshot?.collectMs ?? null, processMs: snapshot?.processMs ?? null, intervalMs, processError, processObservedAt: snapshot?.processObservedAt ?? null, processTimings: snapshot?.processTimings ?? null, processStage: snapshot?.processStage ?? null, collectionError, adapters };
}

/** Hash of the graph content, ignoring timing fields that change every tick. */
function hashOf(s) {
  const h = createHash("sha1");
  h.update(JSON.stringify(s.adapters.map((a) => [a.id, a.nodes, Boolean(a.error)])));
  h.update(JSON.stringify(Boolean(s.processError)));
  h.update(JSON.stringify(s.nodes));
  h.update(JSON.stringify(s.edges));
  return h.digest("hex").slice(0, 16);
}
