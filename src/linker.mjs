import { edge, node } from "./model.mjs";
import { ancestors } from "./procs.mjs";
import { projectName } from "./util.mjs";
import { etimeMs } from "./adapters/session-tree.mjs";

// Rounded to the minute so the value is stable between ticks (etime itself changes every second).
const startedAtMinute = (etime) => new Date(Math.floor((Date.now() - etimeMs(etime)) / 60_000) * 60_000).toISOString();

/**
 * Cross-tool relationships the adapters cannot see on their own.
 *  1. Agent processes without any session node become `process` nodes, so nothing running is invisible.
 *  2. Process ancestry: an agent process whose ancestor is another agent's session was started by it
 *     (e.g. Claude runs `codex exec` or `omp` through its shell). Edge kind `process`, inferred.
 *  3. In-process ownership: a fleet controller shares its pid with the pi/omp session hosting it.
 * A pid hosting several sessions (codex app-server) is not a unique anchor and is skipped for (2).
 */
export function link(nodes, edges, procs) {
  const sessionsByPid = new Map();
  for (const n of nodes.values()) {
    if (!n.pid || n.kind !== "session") continue;
    if (!sessionsByPid.has(n.pid)) sessionsByPid.set(n.pid, []);
    sessionsByPid.get(n.pid).push(n.id);
  }
  const anchors = new Map([...sessionsByPid].filter(([, ids]) => ids.length === 1).map(([pid, ids]) => [pid, ids[0]]));
  const pidsWithNodes = new Set([...nodes.values()].map((n) => n.pid).filter(Boolean));

  for (const p of procs.values()) {
    if (!p.agent || pidsWithNodes.has(p.pid)) continue;
    const id = `process:${p.pid}`;
    anchors.set(p.pid, id);
    nodes.set(
      id,
      node({
        id,
        agent: p.agent,
        kind: "process",
        title: `${p.agent} process ${p.pid}`,
        status: "idle",
        surface: "process",
        cwd: p.cwd,
        project: projectName(p.cwd),
        pid: p.pid,
        startedAt: startedAtMinute(p.etime),
        meta: { args: p.args.slice(0, 240), note: "Running agent process without a recognised session file" },
      }),
    );
  }

  for (const p of procs.values()) {
    const self = p.agent ? anchors.get(p.pid) : null;
    if (!self) continue;
    for (const apid of ancestors(procs, p.pid)) {
      const parent = anchors.get(apid);
      if (parent && parent !== self) {
        const e = edge(parent, self, "process", { inferred: true, label: "started process" });
        if (!edges.has(e.id)) edges.set(e.id, e);
        break;
      }
    }
  }

  for (const n of nodes.values()) {
    if (n.kind !== "fleet" || !n.pid) continue;
    const owner = anchors.get(n.pid);
    if (owner && owner !== n.id) {
      const e = edge(owner, n.id, "spawn", { inferred: true, label: "hosts fleet" });
      edges.set(e.id, e);
    }
  }

  // Edges may reference parents outside the time window; add a placeholder so the tree stays connected.
  for (const e of [...edges.values()]) {
    for (const id of [e.from, e.to]) {
      if (nodes.has(id)) continue;
      const agent = id.split(":")[0];
      const agentsviewId = agent === "claude" ? id.slice("claude:".length) : ["codex", "omp", "pi"].includes(agent) ? id : null;
      nodes.set(id, node({ id, agent, title: `${agent} ${id.slice(-8)}`, status: "done", agentsviewId, meta: { placeholder: true } }));
    }
  }
}
