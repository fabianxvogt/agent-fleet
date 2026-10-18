import { join, resolve } from "node:path";
import { edge, node } from "../model.mjs";
import { ageMs, isoOrNull, listDir, mapConcurrent, projectName, readJson, statSafe } from "../util.mjs";

/**
 * pi-agent-fleet DAG runs: <project>/.fleet/<name>-<ts>/{fleet.json, state.json, workers/<id>/*.jsonl}
 *   fleet.json  spec: workers[{id, type, model, depends_on}]
 *   state.json  status, pid + heartbeat_at of the controller, nodes{id: {status, started_at, ended_at, tokens, cost}}
 * Fleets live inside project folders, so we scan configured roots (and cwd of live pi/omp processes).
 */

const HEARTBEAT_MS = 2 * 60_000;
const RESCAN_MS = 60_000;
const METADATA_CONCURRENCY = 16;
const NODE_STATUS = { pending: "queued", running: "working", completed: "done", failed: "failed", skipped: "done", cancelled: "done" };

// These project-local personal-data directories must never be traversed by fleet discovery.
const isPrivatePath = (path) => /\/body-os\/(?:me|people|household)(?:\/|$)/.test(resolve(path));

export function createFleetAdapter() {
  let scan = { at: 0, dirs: null, pending: null };

  async function scanRoots(ctx) {
    const found = new Set();
    let level = ctx.config.fleetRoots.map((dir) => ({ dir, depth: ctx.config.fleetScanDepth }));
    while (level.length) {
      const children = await mapConcurrent(level, METADATA_CONCURRENCY, async ({ dir, depth }) => {
        if (isPrivatePath(dir)) return [];
        const next = [];
        for (const e of await listDir(dir)) {
          if (!e.isDirectory()) continue;
          if (e.name === ".fleet") {
            found.add(join(dir, e.name));
            continue;
          }
          if (depth <= 0 || e.name.startsWith(".") || e.name === "node_modules" || e.name === "target" || e.name === "dist") continue;
          next.push({ dir: join(dir, e.name), depth: depth - 1 });
        }
        return next;
      });
      level = children.flat();
    }
    return [...found].sort();
  }

  /** Root scan is slow (big trees), so it refreshes in the background; live process cwds are checked every tick. */
  async function findFleetDirs(ctx) {
    if (!scan.dirs) {
      scan = { at: ctx.now, dirs: await scanRoots(ctx), pending: null };
    } else if (ctx.now - scan.at > RESCAN_MS && !scan.pending) {
      scan.pending = scanRoots(ctx)
        .then((dirs) => (scan = { at: Date.now(), dirs, pending: null }))
        .catch(() => (scan.pending = null));
    }
    const dirs = new Set(scan.dirs);
    const liveDirs = [...new Set([...ctx.procs.values()]
      .filter((p) => (p.agent === "pi" || p.agent === "omp") && p.cwd && !isPrivatePath(p.cwd))
      .map((p) => join(p.cwd, ".fleet")))];
    const liveStats = await mapConcurrent(liveDirs, METADATA_CONCURRENCY, statSafe);
    for (let i = 0; i < liveDirs.length; i++) if (liveStats[i]?.isDirectory()) dirs.add(liveDirs[i]);
    return [...dirs];
  }

  return {
    id: "fleet",
    label: "Pi fleets",
    async collect(ctx) {
      const out = { nodes: [], edges: [] };
      for (const fleetsDir of await findFleetDirs(ctx)) {
        for (const run of await listDir(fleetsDir)) {
          if (!run.isDirectory()) continue;
          const dir = join(fleetsDir, run.name);
          const stateSt = await statSafe(join(dir, "state.json"));
          if (!stateSt) continue;
          const state = await readJson(join(dir, "state.json"));
          if (!state?.fleet_name) continue;
          const controllerAlive = Boolean(state.pid && ctx.procs.has(state.pid));
          const beating = ageMs(ctx.now, isoOrNull(state.heartbeat_at)) < HEARTBEAT_MS;
          const claimsRunning = state.status === "running";
          if (!claimsRunning && ctx.now - stateSt.mtimeMs > ctx.windowMs) continue;
          if (claimsRunning && !controllerAlive && ctx.now - stateSt.mtimeMs > ctx.windowMs) continue; // long-dead run

          const rawSpec = (await readJson(join(dir, "fleet.json"))) ?? {};
          const spec = { ...rawSpec, workers: Array.isArray(rawSpec.workers) ? rawSpec.workers.filter((w) => w && typeof w.id === "string") : [] };
          const cwd = join(fleetsDir, "..");
          const fleetId = `fleet:${dir}`;
          const fleetStatus = claimsRunning ? (controllerAlive && beating ? "working" : "stale") : NODE_STATUS[state.status] ?? "idle";
          out.nodes.push(
            node({
              id: fleetId,
              agent: "fleet",
              kind: "fleet",
              title: state.fleet_name,
              role: `fleet · iteration ${state.iteration ?? 1}`,
              status: fleetStatus,
              surface: "in-process",
              cwd,
              project: projectName(cwd),
              model: spec.config?.model ?? null,
              pid: controllerAlive ? state.pid : null,
              startedAt: isoOrNull(state.created_at),
              lastActivityAt: isoOrNull(state.heartbeat_at) ?? new Date(stateSt.mtimeMs).toISOString(),
              source: join(dir, "state.json"),
              meta: { costUsd: round(state.cost_usd_estimate), controllerPid: state.pid ?? null, paused: Boolean(state.paused) },
            }),
          );

          const stateNodes = state.nodes && typeof state.nodes === "object" ? state.nodes : {};
          const ids = new Set([...Object.keys(stateNodes), ...spec.workers.map((w) => w.id)]);
          const workersById = new Map();
          for (const w of spec.workers) if (!workersById.has(w.id)) workersById.set(w.id, w);
          const workers = await mapConcurrent([...ids], METADATA_CONCURRENCY, async (wid) => {
            const ws = stateNodes[wid] ?? {};
            const w = workersById.get(wid) ?? {};
            let status = ws.status ? NODE_STATUS[ws.status] ?? "idle" : "queued";
            if (status === "working" && fleetStatus === "stale") status = "stale";
            const nid = `${fleetId}#${wid}`;
            const lastSession = await newestJsonl(join(dir, "workers", wid));
            return {
              node: node({
                id: nid,
                agent: "fleet",
                kind: "worker",
                title: wid,
                role: w.type ?? "worker",
                status,
                surface: "in-process",
                cwd,
                project: projectName(cwd),
                model: w.model ?? spec.config?.model ?? null,
                startedAt: isoOrNull(ws.started_at),
                lastActivityAt: isoOrNull(ws.ended_at) ?? lastSession?.at ?? isoOrNull(ws.started_at),
                source: lastSession?.path ?? null,
                meta: { turns: ws.turns, tokens: ws.tokens, costUsd: round(ws.cost_usd_estimate), note: ws.status_note ?? null },
              }),
              edges: [edge(fleetId, nid, "spawn"), ...(Array.isArray(w.depends_on) ? w.depends_on : []).map((dep) => edge(`${fleetId}#${dep}`, nid, "dependency", { label: "feeds" }))],
            };
          });
          for (const worker of workers) {
            out.nodes.push(worker.node);
            out.edges.push(...worker.edges);
          }
        }
      }
      return out;
    },
  };
}

async function newestJsonl(dir) {
  if (isPrivatePath(dir)) return null;
  let best = null;
  for (const f of await listDir(dir)) {
    if (!f.name.endsWith(".jsonl")) continue;
    const st = await statSafe(join(dir, f.name));
    if (st && (!best || st.mtimeMs > best.mtimeMs)) best = { path: join(dir, f.name), mtimeMs: st.mtimeMs, at: new Date(st.mtimeMs).toISOString() };
  }
  return best;
}

const round = (n) => (typeof n === "number" ? Math.round(n * 100) / 100 : null);
