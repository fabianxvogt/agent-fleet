// Pure layout: no DOM access, so it runs in node tests as well as in the browser.

export const CARD_W = 240;
export const CARD_H = 54;
export const GAP_X = 56;
export const ROW_H = 66;
export const LANE_HEAD = 56;
export const LANE_PAD = 18;
export const LANE_GAP = 14;

const LIVE = new Set(["working", "waiting", "idle", "queued", "stale", "failed"]);
const STATUS_RANK = { failed: 0, waiting: 1, working: 2, stale: 3, idle: 4, queued: 5, done: 6 };
const TREE_EDGE_RANK = { spawn: 0, process: 1 };
const RECENT_DONE_MS = 10 * 60_000;

const projectValue = (n) => String(n.project ?? "");

/** Full-snapshot inventory keeps filter alternatives available after selection. */
export function projectOptions(snapshot) {
  const counts = new Map();
  for (const n of snapshot.nodes) {
    const value = projectValue(n);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts].map(([value, count]) => ({ value, label: value || "Unknown project", count }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }) || a.value.localeCompare(b.value));
}

export function matchesFilters(n, { agents = null, query = "", project = null, status = null } = {}) {
  const q = query.trim().toLowerCase();
  return (!agents || agents.has(n.agent)) && (project === null || projectValue(n) === project) && (status === null || n.status === status)
    && (!q || [n.title, n.project, n.role, n.model, n.agent, n.cwd].some((v) => v && String(v).toLowerCase().includes(q)));
}

/** Attention is separate from process liveness: a finished answer can belong to an idle session. */
export function selectAttention(snapshot, { agents = null, query = "", project = null, status = null, now = Date.now() } = {}) {
  const groups = { waiting: [], failed: [], completed: [] };
  for (const n of snapshot.nodes) {
    if (n.kind === "process" || n.meta?.placeholder || !matchesFilters(n, { agents, query, project, status })) continue;
    if (n.status === "failed") groups.failed.push(n);
    else if (n.status === "waiting") groups.waiting.push(n);
    else if (n.status === "done" || n.attention?.kind === "completed") {
      const age = now - Date.parse(n.attention?.at ?? n.lastActivityAt);
      if (Number.isFinite(age) && age >= 0 && age < RECENT_DONE_MS) groups.completed.push(n);
    }
  }
  for (const list of Object.values(groups)) list.sort((a, b) => (b.attention?.at ?? b.lastActivityAt ?? "").localeCompare(a.attention?.at ?? a.lastActivityAt ?? ""));
  return groups;
}

/**
 * Pick what to show.
 *  live: live nodes, their ancestors (to keep trees connected) and children that finished in the last 10 min.
 *  all:  everything in the collector window.
 */
export function selectVisible(snapshot, { scope = "live", agents = null, query = "", project = null, status = null, showParked = false, now = Date.now() } = {}) {
  const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const parentOf = treeParents(snapshot.nodes, snapshot.edges);
  const keep = new Set();
  const parked = new Map(); // project -> hidden parked count
  for (const n of snapshot.nodes) {
    if (!matchesFilters(n, { agents, query, project, status })) continue;
    if (scope === "live" && !showParked && n.meta?.parked && !n.liveView?.available && !["failed", "waiting"].includes(n.status)) {
      parked.set(n.project ?? "unknown", (parked.get(n.project ?? "unknown") ?? 0) + 1);
      continue;
    }
    const recentDone = n.status !== "done" ? false : now - Date.parse(n.lastActivityAt ?? 0) < RECENT_DONE_MS;
    const p = byId.get(parentOf.get(n.id));
    const parentLive = p && LIVE.has(p.status) && (showParked || !p.meta?.parked);
    if (scope === "all" || LIVE.has(n.status) || n.liveView?.available || (recentDone && parentLive)) keep.add(n.id);
  }
  // Restore context only while every ancestor passes the explicit filters.
  for (const id of [...keep]) {
    let cur = parentOf.get(id);
    let guard = 0;
    while (cur && !keep.has(cur) && guard++ < 20) {
      const n = byId.get(cur);
      if (!n || !matchesFilters(n, { agents, query, project, status })) break;
      keep.add(cur);
      if (n.meta?.parked && parked.has(n.project ?? "unknown")) parked.set(n.project ?? "unknown", parked.get(n.project ?? "unknown") - 1);
      cur = parentOf.get(cur);
    }
  }
  const nodes = snapshot.nodes.filter((n) => keep.has(n.id));
  const edges = snapshot.edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  return { nodes, edges, parked: new Map([...parked].filter(([, c]) => c > 0)) };
}

/** Each node gets at most one tree parent: spawn edges beat inferred process edges. */
export function treeParents(nodes, edges) {
  const ids = new Set(nodes.map((n) => n.id));
  const best = new Map();
  for (const e of edges) {
    if (!(e.kind in TREE_EDGE_RANK) || !ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
    const prev = best.get(e.to);
    if (!prev || TREE_EDGE_RANK[e.kind] < TREE_EDGE_RANK[prev.kind]) best.set(e.to, e);
  }
  const parent = new Map([...best].map(([to, e]) => [to, e.from]));
  // break cycles defensively: only cut a node that is itself on the cycle
  for (const id of [...parent.keys()]) {
    const seen = new Set([id]);
    let cur = parent.get(id);
    while (cur) {
      if (cur === id) {
        parent.delete(id);
        break;
      }
      if (seen.has(cur)) break; // leads into a cycle elsewhere; that cycle's own member gets cut
      seen.add(cur);
      cur = parent.get(cur);
    }
  }
  return parent;
}

const confidentlyFinished = (node) => node.kind !== "process" && !node.meta?.placeholder && !node.meta?.dataStale && !node.liveView?.available
  && !["question", "approval"].includes(node.attention?.kind)
  && (node.status === "done" || (node.status === "idle" && node.attention?.kind === "completed"));

/** Summarize a forest from its leaves without recursion, including very deep agent trees. */
function completionForest(nodes, parents, isFinished) {
  const children = new Map();
  for (const [child, parent] of parents) {
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(child);
  }
  const facts = new Map(nodes.map((node) => [node.id, { finished: isFinished(node), size: 1 }]));
  const remaining = new Map([...children].map(([id, ids]) => [id, ids.length]));
  const queue = nodes.filter((node) => !children.has(node.id)).map((node) => node.id);
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    const parent = parents.get(id);
    if (parent === undefined) continue;
    const own = facts.get(id);
    const ancestor = facts.get(parent);
    ancestor.finished &&= own.finished;
    ancestor.size += own.size;
    remaining.set(parent, remaining.get(parent) - 1);
    if (remaining.get(parent) === 0) queue.push(parent);
  }
  return { children, facts };
}

/**
 * Hide confidently finished child branches, retaining their parent as the control.
 * Check the full snapshot as well as the filtered tree: filtering out an active
 * descendant or its preferred parent must never make that work look completed.
 */
export function collapseCompleted(snapshot, visible, collapsedParents = new Set()) {
  const fullParents = treeParents(snapshot.nodes, snapshot.edges);
  const full = completionForest(snapshot.nodes, fullParents, confidentlyFinished);
  const parents = treeParents(visible.nodes, visible.edges);
  const { children, facts } = completionForest(visible.nodes, parents, (node) => confidentlyFinished(node) && full.facts.get(node.id)?.finished === true);
  const eligibleBranches = new Set();
  const controls = new Map();
  for (const [parent, ids] of children) {
    let eligibleCount = 0;
    for (const id of ids) {
      if (!facts.get(id).finished) continue;
      eligibleBranches.add(id);
      eligibleCount += facts.get(id).size;
    }
    if (eligibleCount > 0) controls.set(parent, { eligibleCount, hiddenCount: 0 });
  }

  // Each hidden node records all folded ancestors, including controls that are
  // themselves hidden, so selecting it can reopen the complete path in one step.
  const hiddenBy = new Map();
  const pending = visible.nodes.filter((node) => !parents.has(node.id)).map((node) => ({ id: node.id, ancestors: [] }));
  for (let index = 0; index < pending.length; index++) {
    const { id, ancestors } = pending[index];
    if (ancestors.length) hiddenBy.set(id, ancestors);
    const control = controls.get(id);
    const folded = collapsedParents.has(id) && control;
    // Only exposed controls own a hidden count; nested folds do not double-count.
    if (folded && !ancestors.length) control.hiddenCount = control.eligibleCount;
    for (const child of children.get(id) ?? []) {
      pending.push({ id: child, ancestors: folded && eligibleBranches.has(child) ? [...ancestors, id] : ancestors });
    }
  }
  const nodes = visible.nodes.filter((node) => !hiddenBy.has(node.id));
  const ids = new Set(nodes.map((node) => node.id));
  const edges = visible.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  return { nodes, edges, controls, hiddenBy };
}

const activity = (n) => Date.parse(n.lastActivityAt ?? 0) || 0;
const byPriority = (a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || activity(b) - activity(a);

/**
 * Swimlane per project of the tree root; tidy tree inside each lane (depth on x).
 * Lanes are packed masonry-style into as many columns as fit the viewport best (`viewport` = {width, height}).
 */
export function layout(nodes, edges, viewport = { width: 1600, height: 900 }, sticky = {}) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parent = treeParents(nodes, edges);
  const children = new Map();
  for (const [child, p] of parent) {
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(byId.get(child));
  }
  for (const list of children.values()) list.sort(byPriority);

  const roots = nodes.filter((n) => !parent.has(n.id));
  const laneMap = new Map();
  for (const r of roots) {
    const key = r.project ?? "unknown";
    if (!laneMap.has(key)) laneMap.set(key, []);
    laneMap.get(key).push(r);
  }

  const subtreeStats = new Map();
  const stats = (n) => {
    if (subtreeStats.has(n.id)) return subtreeStats.get(n.id);
    const s = { working: n.status === "working" && !n.meta?.dataStale ? 1 : 0, waiting: n.status === "waiting" ? 1 : 0, failed: n.status === "failed" ? 1 : 0, last: activity(n), size: 1 };
    for (const c of children.get(n.id) ?? []) {
      const cs = stats(c);
      s.working += cs.working;
      s.waiting += cs.waiting;
      s.failed += cs.failed;
      s.last = Math.max(s.last, cs.last);
      s.size += cs.size;
    }
    subtreeStats.set(n.id, s);
    return s;
  };

  const lanes = [...laneMap].map(([project, rs]) => {
    rs.sort((a, b) => stats(b).working - stats(a).working || byPriority(a, b));
    const agg = rs.reduce((acc, r) => {
      const s = stats(r);
      return { working: acc.working + s.working, waiting: acc.waiting + s.waiting, failed: acc.failed + s.failed, last: Math.max(acc.last, s.last), size: acc.size + s.size };
    }, { working: 0, waiting: 0, failed: 0, last: 0, size: 0 });
    return { project, roots: rs, ...agg };
  });
  lanes.sort((a, b) => b.failed - a.failed || b.waiting - a.waiting || (b.working > 0) - (a.working > 0) || b.last - a.last);
  // Sticky order: lanes keep the rank they had on the previous render so the picture does not jump on updates.
  if (sticky.order?.length) {
    const rank = new Map(sticky.order.map((p, i) => [p, i]));
    const fresh = lanes.filter((l) => !rank.has(l.project));
    lanes.splice(0, lanes.length, ...lanes.filter((l) => rank.has(l.project)).sort((a, b) => rank.get(a.project) - rank.get(b.project)), ...fresh);
  }

  // 1. lay out every lane in local coordinates
  const local = new Map(); // id -> {x, y} relative to lane origin
  for (const lane of lanes) {
    let row = 0;
    let depthMax = 0;
    const place = (n, depth) => {
      depthMax = Math.max(depthMax, depth);
      const kids = children.get(n.id) ?? [];
      let cy;
      if (kids.length === 0) cy = row++;
      else {
        const ys = kids.map((k) => place(k, depth + 1));
        cy = (ys[0] + ys[ys.length - 1]) / 2;
      }
      local.set(n.id, { lane, x: LANE_PAD + depth * (CARD_W + GAP_X), y: LANE_HEAD + LANE_PAD + cy * ROW_H });
      return cy;
    };
    for (const r of lane.roots) place(r, 0);
    lane.w = LANE_PAD * 2 + (depthMax + 1) * (CARD_W + GAP_X) - GAP_X;
    lane.h = LANE_HEAD + LANE_PAD * 2 + Math.max(1, row) * ROW_H - (ROW_H - CARD_H);
  }

  // 2. masonry: try column counts, keep the packing that shows the most at the largest scale.
  //    Each column is as wide as its widest lane, so one deep tree does not widen every column.
  const colRange = sticky.cols ? [Math.min(sticky.cols, Math.max(1, lanes.length))] : Array.from({ length: Math.max(1, lanes.length) }, (_, i) => i + 1);
  let best = null;
  for (const cols of colRange) {
    const heights = new Array(cols).fill(0);
    const widths = new Array(cols).fill(0);
    const assigned = lanes.map((lane) => {
      const c = heights.indexOf(Math.min(...heights));
      const at = { lane, c, y: heights[c] };
      heights[c] += lane.h + LANE_GAP;
      widths[c] = Math.max(widths[c], lane.w);
      return at;
    });
    const xs = widths.reduce((acc, w, i) => (acc.push(i === 0 ? 0 : acc[i - 1] + widths[i - 1] + LANE_GAP), acc), []);
    const placed = assigned.map((a) => ({ lane: a.lane, x: xs[a.c], y: a.y, width: widths[a.c] }));
    const width = widths.reduce((s, w) => s + w, 0) + LANE_GAP * (cols - 1);
    const height = Math.max(...heights) - LANE_GAP;
    const scale = Math.min(1, viewport.width / width, viewport.height / height);
    if (!best || scale > best.scale + 0.01) best = { placed, width, height, scale, cols };
    if (width > viewport.width * 1.6) break;
  }

  const pos = new Map();
  const laneRects = [];
  for (const { lane, x, y, width } of best?.placed ?? []) {
    laneRects.push({ project: lane.project, x, y, width, height: lane.h, working: lane.working, waiting: lane.waiting, failed: lane.failed, size: lane.size });
    lane.origin = { x, y };
  }
  for (const [id, p] of local) pos.set(id, { x: p.lane.origin.x + p.x, y: p.lane.origin.y + p.y });
  return { pos, lanes: laneRects, width: best?.width ?? 0, height: Math.max(0, best?.height ?? 0), parent, cols: best?.cols ?? 1, order: lanes.map((l) => l.project) };
}
