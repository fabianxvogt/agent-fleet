import { CARD_H, CARD_W } from "./layout.js";

const OVERSCAN = 100; // Screen pixels; the world-space margin scales with zoom.
const DETAIL_SCALE = 0.45;

function cubicRange(p0, p1, p2, p3) {
  let min = Math.min(p0, p3);
  let max = Math.max(p0, p3);
  // Divide the cubic derivative by three before solving its quadratic.
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const roots = [];
  if (a === 0) {
    if (b !== 0) roots.push(-c / b);
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const d = Math.sqrt(discriminant);
      roots.push((-b - d) / (2 * a), (-b + d) / (2 * a));
    }
  }
  for (const t of roots) {
    if (t <= 0 || t >= 1) continue;
    const s = 1 - t;
    const value = s * s * s * p0 + 3 * s * s * t * p1 + 3 * s * t * t * p2 + t * t * t * p3;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return { min, max };
}

function curve(x0, y0, x1, y1, x2, y2, x3, y3, mid) {
  const x = cubicRange(x0, x1, x2, x3);
  const y = cubicRange(y0, y1, y2, y3);
  return {
    path: `M${x0} ${y0} C${x1} ${y1} ${x2} ${y2} ${x3} ${y3}`,
    mid,
    bounds: { x: x.min, y: y.min, width: x.max - x.min, height: y.max - y.min },
  };
}

// Keep the graph's established routes and badge anchors independent of the DOM.
function edgeGeometry(a, b, isTree) {
  const ax = a.x + CARD_W;
  const ay = a.y + CARD_H / 2;
  const by = b.y + CARD_H / 2;
  if (isTree || b.x > a.x + 10) {
    const bx = b.x;
    const dx = Math.max(30, (bx - ax) / 2);
    return curve(ax, ay, ax + dx, ay, bx - dx, by, bx, by, { x: (ax + bx) / 2, y: (ay + by) / 2 });
  }
  if (Math.abs(b.x - a.x) <= 10) {
    const bulge = 46 + Math.min(120, Math.abs(by - ay) / 4);
    return curve(ax, ay, ax + bulge, ay, ax + bulge, by, ax, by, { x: ax + bulge * 0.75, y: (ay + by) / 2 });
  }
  const sx = a.x;
  const tx = b.x + CARD_W;
  const dx = Math.max(30, (sx - tx) / 2);
  return curve(sx, ay, sx - dx, ay, tx + dx, by, tx, by, { x: (sx + tx) / 2, y: (ay + by) / 2 });
}

function union(a, b) {
  if (!a) return { x: b.x, y: b.y, width: b.width, height: b.height };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x, y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/**
 * Full, zoom-independent geometry. Original nodes, lanes and positions are shared
 * read-only; edge descriptors are copied and enriched with their drawn geometry.
 */
export function createGraphScene(nodes, edges, layout) {
  const ids = new Set(nodes.map((n) => n.id));
  let bounds = null;
  for (const lane of layout.lanes) bounds = union(bounds, lane);
  for (const node of nodes) {
    const p = layout.pos.get(node.id);
    if (p) bounds = union(bounds, { ...p, width: CARD_W, height: CARD_H });
  }
  const relations = [];
  for (const edge of edges) {
    const a = layout.pos.get(edge.from);
    const b = layout.pos.get(edge.to);
    if (!a || !b || !ids.has(edge.from) || !ids.has(edge.to)) continue;
    const isTree = layout.parent.get(edge.to) === edge.from && (edge.kind === "spawn" || edge.kind === "process");
    const geometry = edgeGeometry(a, b, isTree);
    if (edge.count > 1) {
      geometry.bounds = union(geometry.bounds, { x: geometry.mid.x - 13, y: geometry.mid.y - 8, width: 26, height: 16 });
    }
    relations.push({ ...edge, ...geometry, isTree });
    bounds = union(bounds, geometry.bounds);
  }
  return {
    nodes, edges: relations, lanes: layout.lanes, pos: layout.pos,
    bounds: bounds ?? { x: 0, y: 0, width: 0, height: 0 },
  };
}

/** Select drawable geometry without changing the complete scene or its fit bounds. */
export function projectGraphScene(scene, view, viewport, pinnedIds = new Set()) {
  const left = (-view.x - OVERSCAN) / view.k;
  const top = (-view.y - OVERSCAN) / view.k;
  const right = (viewport.width - view.x + OVERSCAN) / view.k;
  const bottom = (viewport.height - view.y + OVERSCAN) / view.k;
  const intersects = (x, y, width, height) => x <= right && x + width >= left && y <= bottom && y + height >= top;
  return {
    nodes: scene.nodes.filter((node) => {
      const p = scene.pos.get(node.id);
      return p && (pinnedIds.has(node.id) || intersects(p.x, p.y, CARD_W, CARD_H));
    }),
    // A relation can cross the view even when both endpoint cards are outside it.
    edges: scene.edges.filter(({ bounds: b }) => intersects(b.x, b.y, b.width, b.height)),
    lanes: scene.lanes.filter((lane) => intersects(lane.x, lane.y, lane.width, lane.height)),
    detail: view.k >= DETAIL_SCALE,
  };
}
