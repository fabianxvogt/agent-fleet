/**
 * Shared graph model. Every adapter returns { nodes, edges } using these shapes.
 *
 * Node:
 *   id            globally unique, prefixed by agent ("claude:<uuid>", "omp:<uuid>", ...)
 *   agent         claude | codex | omp | pi | fleet | opencode | <custom>
 *   kind          session | subagent | fleet | worker | process
 *   title, role   human labels; role is e.g. "L1", "worker", "general-purpose"
 *   status        see STATUSES
 *   surface       desktop | cli | app | exec | sdk | in-process
 *   cwd, project, model, pid, startedAt, lastActivityAt (ISO)
 *   agentsviewId  id understood by agentsview's /sessions/<id> route, if any
 *   openUrl       deep link that opens the session in its own app, if any
 *   source        file the data came from
 *   transcript    optional JSONL path when source is registry/desktop metadata
 *   meta          adapter-specific extras (shown raw in the detail panel)
 *
 * Edge:
 *   from, to      node ids
 *   kind          see EDGE_KINDS
 *   inferred      true when derived heuristically (process tree, open files)
 *   label, count, at
 */

export const STATUSES = {
  working: "Actively running a turn",
  waiting: "Alive, turn finished, waiting for the human",
  idle: "Alive but not working and not blocking anyone",
  queued: "Planned, not started yet",
  done: "Finished or process gone",
  failed: "Ended with an error",
  stale: "Claims to run but its process or heartbeat is gone",
};

export const EDGE_KINDS = {
  spawn: "Parent started child",
  message: "Parent sent a message to target",
  report: "Child reported back to parent",
  dependency: "Output of source feeds target",
  process: "OS process ancestry (cross-tool)",
};

export const LIVE_STATUSES = new Set(["working", "waiting", "idle", "queued", "stale"]);

export function node(fields) {
  return {
    kind: "session",
    status: "done",
    title: null,
    role: null,
    surface: null,
    cwd: null,
    project: null,
    model: null,
    pid: null,
    startedAt: null,
    lastActivityAt: null,
    agentsviewId: null,
    openUrl: null,
    source: null,
    meta: {},
    ...fields,
  };
}

export function edge(from, to, kind, extra = {}) {
  return { id: `${kind}:${from}->${to}`, from, to, kind, inferred: false, label: null, count: 1, at: null, ...extra };
}

/** Merge node lists; later fields win but null never overwrites a value. */
export function mergeNodes(lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const n of list) {
      const prev = byId.get(n.id);
      if (!prev) {
        byId.set(n.id, n);
        continue;
      }
      const merged = { ...prev };
      for (const [key, value] of Object.entries(n)) {
        if (value === null || value === undefined) continue;
        merged[key] = key === "meta" ? { ...prev.meta, ...value } : value;
      }
      byId.set(n.id, merged);
    }
  }
  return byId;
}

export function mergeEdges(lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const e of list) {
      const prev = byId.get(e.id);
      if (!prev) byId.set(e.id, e);
      else byId.set(e.id, { ...prev, count: Math.max(prev.count, e.count), at: e.at ?? prev.at, inferred: prev.inferred && e.inferred });
    }
  }
  return byId;
}
