// Pure layout: no DOM access, so it runs in node tests as well as in the browser.

export const CARD_W = 240;
export const CARD_H = 54;
export const GAP_X = 56;
export const ROW_H = 66;
export const LANE_HEAD = 38;
export const LANE_PAD = 18;
export const LANE_GAP = 14;

const LIVE = new Set(["working", "waiting", "idle", "queued", "stale"]);
const STATUS_RANK = { working: 0, waiting: 1, stale: 2, idle: 3, queued: 4, failed: 5, done: 6 };
const TREE_EDGE_RANK = { spawn: 0, process: 1 };
const RECENT_DONE_MS = 10 * 60_000;

/**
 * Pick what to show.
 *  live: live nodes, their ancestors (to keep trees connected) and children that finished in the last 10 min.
 *  all:  everything in the collector window.
 */
export function selectVisible(snapshot, { scope = "live", agents = null, query = "", showParked = false, now = Date.now() } = {}) {
  const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const parentOf = treeParents(snapshot.nodes, snapshot.edges);
  const keep = new Set();
  const q = query.trim().toLowerCase();
  const matches = (n) => !q || [n.title, n.project, n.role, n.model, n.agent, n.cwd].some((v) => v && String(v).toLowerCase().includes(q));
  const agentOk = (n) => !agents || agents.has(n.agent);

  const parked = new Map(); // project -> hidden parked count
  for (const n of snapshot.nodes) {
    if (!agentOk(n) || !matches(n)) continue;
    if (scope === "live" && !showParked && n.meta?.parked) {
      parked.set(n.project ?? "unknown", (parked.get(n.project ?? "unknown") ?? 0) + 1);
      continue;
    }
    const recentDone = n.status !== "done" ? false : now - Date.parse(n.lastActivityAt ?? 0) < RECENT_DONE_MS;
    const p = byId.get(parentOf.get(n.id));
    const parentLive = p && LIVE.has(p.status) && (showParked || !p.meta?.parked);
    if (scope === "all" || LIVE.has(n.status) || (recentDone && parentLive)) keep.add(n.id);
  }
  // pull in ancestors so a live child never floats without its parent (even a parked one)
  for (const id of [...keep]) {
    let cur = parentOf.get(id);
    let guard = 0;
    while (cur && !keep.has(cur) && guard++ < 20) {
      const n = byId.get(cur);
      if (n) {
        keep.add(cur);
        if (n.meta?.parked && parked.has(n.project ?? "unknown")) parked.set(n.project ?? "unknown", parked.get(n.project ?? "unknown") - 1);
      }
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
    const s = { working: n.status === "working" ? 1 : 0, waiting: n.status === "waiting" ? 1 : 0, last: activity(n), size: 1 };
    for (const c of children.get(n.id) ?? []) {
      const cs = stats(c);
      s.working += cs.working;
      s.waiting += cs.waiting;
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
      return { working: acc.working + s.working, waiting: acc.waiting + s.waiting, last: Math.max(acc.last, s.last), size: acc.size + s.size };
    }, { working: 0, waiting: 0, last: 0, size: 0 });
    return { project, roots: rs, ...agg };
  });
  lanes.sort((a, b) => (b.working > 0) - (a.working > 0) || b.waiting - a.waiting || b.last - a.last);
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
    laneRects.push({ project: lane.project, x, y, width, height: lane.h, working: lane.working, waiting: lane.waiting, size: lane.size });
    lane.origin = { x, y };
  }
  for (const [id, p] of local) pos.set(id, { x: p.lane.origin.x + p.x, y: p.lane.origin.y + p.y });
  return { pos, lanes: laneRects, width: best?.width ?? 0, height: Math.max(0, best?.height ?? 0), parent, cols: best?.cols ?? 1, order: lanes.map((l) => l.project) };
}
