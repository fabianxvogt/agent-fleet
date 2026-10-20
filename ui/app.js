import { CARD_H, CARD_W, LANE_PAD, layout, selectVisible, selectAttention, projectOptions, collapseCompleted } from "/layout.js";
import { createGraphScene, projectGraphScene } from "/graph-scene.js";
import { createInspector } from "/inspector.js";
import { createLiveView } from "/live-view.js";

const AGENTS = {
  claude: { label: "Claude", color: "var(--a-claude)" },
  codex: { label: "Codex", color: "var(--a-codex)" },
  omp: { label: "OhMyPi", color: "var(--a-omp)" },
  pi: { label: "Pi", color: "var(--a-pi)" },
  fleet: { label: "Fleet", color: "var(--a-fleet)" },
  opencode: { label: "OpenCode", color: "var(--a-opencode)" },
};
const agentInfo = (a) => AGENTS[a] ?? { label: a, color: "var(--a-other)" };
// Status and edge kind end up in class names and CSS variables; only known tokens may pass.
const safeStatus = (s) => (Object.hasOwn(STATUS_LABEL, s) ? s : "idle");
const safeKind = (k) => (Object.hasOwn(EDGE_LABEL, k) ? k : "spawn");
const STATUS_LABEL = { working: "Working", waiting: "Needs you", idle: "Idle", queued: "Queued", done: "Done", failed: "Failed", stale: "Stale" };
const EDGE_LABEL = { spawn: "started", message: "sent message", report: "reported back", dependency: "feeds", process: "started process" };

const $ = (id) => document.getElementById(id);
const inspector = createInspector($("session-content"), { browserView: createLiveView($("session-live")) });
const state = {
  snap: null,
  health: null,
  connected: false,
  connectionStarted: false,
  attentionKey: null,
  scope: "live",
  hiddenAgents: new Set(loadPref("hiddenAgents", [])),
  showParked: loadPref("showParked", false),
  query: "",
  project: null,
  status: null,
  display: loadPref("display", "graph") === "list" ? "list" : "graph",
  projectOptionsKey: null,
  collapsedParents: new Set(),
  folded: null,
  selected: null,
  view: { x: 40, y: 30, k: 1 },
  needsFit: true,
  lastLayout: null,
  scene: null,
  projection: null,
  staleNodes: new Set(),
  sticky: {}, // lane order + column count, reset on fit / filter / resize
};

function loadPref(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(`agent-fleet:${key}`)) ?? fallback;
  } catch {
    return fallback;
  }
}
function savePref(key, value) {
  try {
    localStorage.setItem(`agent-fleet:${key}`, JSON.stringify(value));
  } catch {
    // storage unavailable; preference lives for this tab only
  }
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clip = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const shortModel = (m) => (m ? String(m).replace(/^claude-/, "").replace(/^openai-codex\//, "") : null);

function ago(iso, now = Date.now()) {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return "";
  if (s < 10) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
const clock = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "—");
const updateAge = (iso, now) => ago(iso, now) === "now" ? "updated just now" : `updated ${ago(iso, now)} ago`;

/* ---------- live connection ---------- */

function connect() {
  const es = new EventSource("/api/events");
  es.addEventListener("snapshot", (ev) => {
    state.snap = JSON.parse(ev.data);
    state.health = { ...state.snap, degraded: state.snap.adapters?.some((a) => a.error || a.stale) };
    state.connected = true;
    state.connectionStarted = true;
    render();
  });
  es.addEventListener("health", (ev) => {
    state.health = JSON.parse(ev.data);
    state.connected = true;
    state.connectionStarted = true;
    renderHealth();
  });
  es.onopen = () => { state.connected = true; renderHealth(); };
  es.onerror = () => {
    state.connected = false;
    state.connectionStarted = true;
    renderHealth();
  };
}

function renderHealth(now = Date.now()) {
  const health = state.health;
  const stamp = Date.parse(health?.generatedAt);
  const threshold = Math.max((health?.intervalMs ?? 4000) * 3, 10_000);
  const age = Number.isFinite(stamp) ? Math.max(0, now - stamp) : null;
  const processStale = health?.processObservedAt != null && now - Date.parse(health.processObservedAt) > threshold;
  const staleSources = new Set((health?.adapters ?? []).filter((a) => {
    const observed = Date.parse(a.observedAt ?? a.lastSuccessAt);
    return a.error || a.stale || !Number.isFinite(observed) || now - observed > threshold;
  }).map(a => a.id));
  const stale = health?.stale || age === null || age > threshold || processStale;
  const degraded = health?.degraded || health?.processError || staleSources.size;
  const slow = health?.collectMs > (health?.intervalMs ?? 4000);
  const updated = age === null ? "no update yet" : updateAge(health.generatedAt, now);
  let label, mode;
  if (!state.connected) {
    mode = state.connectionStarted ? "off" : "";
    label = state.connectionStarted ? `Disconnected · ${updated}` : "Connecting…";
  } else if (stale) {
    mode = "warn";
    label = `Delayed · ${updated}`;
  } else if (degraded) {
    mode = "warn";
    label = `Source unavailable · ${updated}`;
  } else {
    mode = slow ? "warn" : "on";
    label = `${slow ? "Slow update" : "Current"} · ${updated}`;
  }
  $("pulse").className = `pulse ${mode}`;
  $("pulse").title = `${!state.connected ? "Reconnecting automatically. " : ""}Last collection: ${health?.collectMs ?? "—"} ms. Expected every ${Math.round((health?.intervalMs ?? 4000) / 1000)} s.`;
  $("pulse-text").textContent = label;
  const dataState = !state.connected || stale ? "stale" : "current";
  $("canvas").dataset.freshness = dataState;
  $("data-notice").hidden = dataState === "current";
  $("data-notice").textContent = state.snap ? "Showing last known activity. Waiting for a fresh update." : "Waiting for session data…";
  state.staleNodes = new Set((state.snap?.nodes ?? []).filter(n => n.meta?.dataStale || staleSources.has(n.meta?.dataSource ?? n.agent)).map(n => n.id));
  decorateFreshness();
  $("panel-data-notice").hidden = dataState === "current" && !state.staleNodes.has(state.selected);
  renderSources(health, now, threshold);
}

function decorateFreshness() {
  for (const el of $("canvas").querySelectorAll(".node, .session-row")) el.classList.toggle("data-stale", state.staleNodes.has(el.dataset.id));
  for (const el of $("viewport").querySelectorAll(".edge")) el.classList.toggle("data-stale", state.staleNodes.has(el.dataset.from) || state.staleNodes.has(el.dataset.to));
}

/* ---------- rendering ---------- */

function filterOptions() {
  return {
    scope: state.scope, query: state.query, project: state.project, status: state.status,
    showParked: state.showParked,
    agents: new Set((state.snap?.nodes ?? []).map((n) => n.agent).filter((a) => !state.hiddenAgents.has(a))),
  };
}

function hasFilters() {
  return Boolean(state.query.trim() || state.project !== null || state.status !== null || state.hiddenAgents.size);
}

function renderFilters(vis, folded) {
  const options = projectOptions(state.snap);
  // Keep an explicit selection even if its final session disappears during refresh.
  if (state.project !== null && !options.some((p) => p.value === state.project)) {
    options.push({ value: state.project, label: state.project || "Unknown project", count: 0 });
  }
  const key = JSON.stringify(options);
  if (key !== state.projectOptionsKey) {
    $("project-filter").innerHTML = '<option value="all">All projects</option>' + options.map((p) => `<option value="project:${esc(p.value)}">${esc(p.label)} (${p.count})</option>`).join("");
    state.projectOptionsKey = key;
  }
  $("project-filter").value = state.project === null ? "all" : `project:${state.project}`;
  $("status-filter").value = state.status ?? "all";
  $("reset-filters").hidden = !hasFilters();
  const scope = state.scope === "live" ? "Live" : `Last ${state.snap.windowHours} h`;
  const hidden = folded?.hiddenIds.size ?? 0;
  const count = hidden ? `${vis.nodes.length} matches · ${folded.nodes.length} shown · ${hidden} folded` : `${vis.nodes.length} shown`;
  $("filter-summary").textContent = `${count} · ${scope}${state.project !== null ? ` · ${state.project || "Unknown project"}` : ""}${state.status ? ` · ${STATUS_LABEL[state.status]}` : ""}`;
  $("graph-fold-controls").hidden = state.display !== "graph";
  $("collapse-finished").disabled = !folded || ![...folded.controls].some(([id]) => !state.collapsedParents.has(id));
  $("expand-finished").disabled = state.collapsedParents.size === 0;
  $("empty-title").textContent = hasFilters() ? "No matching sessions" : state.scope === "live" ? "No live agent sessions" : "No sessions in this time window";
  $("empty-description").textContent = hasFilters()
    ? `Change or reset the filters${state.scope === "live" ? ", or check the longer time window" : ""}.`
    : "Start Claude, Codex, OhMyPi or Pi to see its sessions here.";
  for (const view of ["graph", "list"]) {
    $(`view-${view}`).classList.toggle("on", state.display === view);
    $(`view-${view}`).setAttribute("aria-pressed", String(state.display === view));
  }
  $("graph").hidden = state.display !== "graph";
  // SVGElement does not implement HTMLElement.hidden in WebKit.
  $("graph").classList.toggle("view-hidden", state.display !== "graph");
  $("graph").setAttribute("aria-hidden", String(state.display !== "graph"));
  $("graph-zoom").hidden = state.display !== "graph";
  $("session-list").hidden = state.display !== "list";
  $("list-order").hidden = state.display !== "list";
  $("canvas").dataset.view = state.display;
}

function render() {
  const snap = state.snap;
  if (!snap) return;
  const agentsPresent = new Set(snap.nodes.map((n) => n.agent));
  const vis = selectVisible(snap, filterOptions());
  const knownIds = new Set(snap.nodes.map((n) => n.id));
  for (const id of state.collapsedParents) if (!knownIds.has(id)) state.collapsedParents.delete(id);
  let folded = state.display === "graph" ? collapseCompleted(snap, vis, state.collapsedParents) : null;
  // Keep a selected session visible if a refresh completes a previously active branch.
  if (folded?.hiddenIds.has(state.selected)) {
    for (const id of folded.revealPath(state.selected)) state.collapsedParents.delete(id);
    folded = collapseCompleted(snap, vis, state.collapsedParents);
  }
  state.folded = folded;
  renderFilters(vis, folded);
  if (state.selected && !vis.nodes.some((n) => n.id === state.selected)) {
    // keep the panel on a node that just left the live scope
    if (!snap.nodes.some((n) => n.id === state.selected)) state.selected = null;
  }

  if (state.display === "graph") {
    if ($("session-rows").innerHTML) $("session-rows").innerHTML = "";
    const box = $("canvas").getBoundingClientRect();
    if (state.needsFit) state.sticky = {};
    const L = layout(folded.nodes, folded.edges, { width: box.width - 60, height: box.height - 60 }, state.sticky);
    state.sticky = { order: L.order, cols: L.cols };
    state.lastLayout = { ...L, nodes: folded.nodes, edges: folded.edges };
    state.scene = createGraphScene(folded.nodes, folded.edges, L);
    state.graphBounds = state.scene.bounds;
    state.parked = vis.parked;
    state.projection = null;
  } else {
    if ($("viewport").innerHTML) $("viewport").innerHTML = "";
    state.scene = null;
    state.projection = null;
    renderList(vis.nodes);
  }
  $("empty").hidden = vis.nodes.length > 0;
  state.visibleIds = new Set((state.display === "graph" ? folded.nodes : vis.nodes).map((n) => n.id));
  applySelection();
  renderStats({ ...snap, nodes: vis.nodes });
  renderAttention(snap);
  renderAgentFilters(snap, agentsPresent, vis.parked);
  renderHealth();
  $("scope-all").textContent = `Last ${snap.windowHours} h`;
  if (state.display === "graph" && state.needsFit && vis.nodes.length) {
    fit();
    state.needsFit = false;
  } else if (state.display === "graph") applyView();
  if (state.selected || !$("panel").hidden) renderPanel();
}

function renderList(nodes) {
  const focused = document.activeElement?.closest?.("#session-rows button");
  const focusedId = focused?.closest("[data-id]")?.dataset.id;
  const focusedLive = focused?.hasAttribute("data-live-view");
  const scroll = $("session-list").scrollTop;
  const rows = [...nodes].sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "") || a.id.localeCompare(b.id));
  $("session-rows").innerHTML = rows.map((n) => {
    const agent = agentInfo(n.agent);
    const note = n.meta?.dataStale ? "Last known" : n.attention?.evidence === "inferred" && n.status === "waiting" ? "Inferred question" : n.attention?.kind === "completed" ? "Reply finished" : n.meta?.parked ? "Parked" : "";
    const subtitle = [agent.label, n.project || "Unknown project", n.role].filter(Boolean).join(" · ");
    return `<tr class="session-row${n.meta?.dataStale ? " data-stale" : ""}" data-id="${esc(n.id)}">
      <td><button type="button" class="session-name" aria-pressed="false" title="${esc(n.title)}">${esc(n.title)}</button><span class="session-sub" title="${esc(subtitle)}"><i class="swatch" style="background:${agent.color}"></i>${esc(subtitle)}</span>${n.liveView?.available ? `<button type="button" class="session-live" data-live-view aria-label="Open live browser for ${esc(n.title)}">LIVE ↗</button>` : ""}</td>
      <td><span class="session-status" style="--status:var(--s-${n.meta?.dataStale ? "stale" : safeStatus(n.status)})"><i></i>${esc(STATUS_LABEL[n.status] ?? n.status)}</span>${note ? `<span class="session-note">${esc(note)}</span>` : ""}</td>
      <td class="session-age" title="${esc(clock(n.lastActivityAt))}"><span data-ts="${esc(n.lastActivityAt ?? "")}">${esc(ago(n.lastActivityAt)) || "—"}</span></td>
    </tr>`;
  }).join("");
  $("session-list").scrollTop = scroll;
  if (focusedId) {
    const row = [...$("session-rows").querySelectorAll("[data-id]")].find((r) => r.dataset.id === focusedId);
    row?.querySelector(focusedLive ? "[data-live-view]" : ".session-name")?.focus({ preventScroll: true });
  }
}

const cardPos = (L, id) => L.pos.get(id) ?? null;

function graphFocus() {
  const active = document.activeElement;
  const node = active?.closest?.(".node");
  if (!node) return null;
  return { id: node.dataset.id, kind: active.closest("[data-collapse]") ? "fold" : active.closest("[data-live-view]") ? "live" : "node" };
}

function drawProjection() {
  if (!state.scene) return;
  const focus = graphFocus();
  const box = $("canvas").getBoundingClientRect();
  const projection = projectGraphScene(state.scene, state.view, box, new Set(focus ? [focus.id] : []));
  const previous = state.projection;
  const focusedId = projection.detail ? null : focus?.id;
  const same = (a, b) => a.length === b.length && a.every((item, i) => item === b[i]);
  if (previous && previous.detail === projection.detail && previous.focusedId === focusedId
    && same(previous.nodes, projection.nodes) && same(previous.edges, projection.edges) && same(previous.lanes, projection.lanes)) return;
  state.projection = { ...projection, focusedId };
  $("viewport").innerHTML = drawGraph(projection, state.scene, state.parked, state.folded.controls, focus?.id);
  applySelection();
  decorateFreshness();
  if (focus) {
    const node = [...$("viewport").querySelectorAll(".node")].find((el) => el.dataset.id === focus.id);
    const target = focus.kind === "fold" ? node?.querySelector("[data-collapse]") : focus.kind === "live" ? node?.querySelector("[data-live-view]") : node;
    (target ?? node)?.focus({ preventScroll: true });
  }
}

function drawGraph(projection, scene, parked, controls, focusedId) {
  const { nodes, edges, lanes, detail } = projection;
  const byId = new Map(scene.nodes.map((n) => [n.id, n]));
  let out = "";
  for (const [index, lane] of lanes.entries()) {
    const hidden = parked.get(lane.project);
    const meta = [lane.failed ? `${lane.failed} failed` : null, lane.working ? `${lane.working} working` : null, lane.waiting ? `${lane.waiting} need you` : null, `${lane.size} shown`, hidden ? `+${hidden} parked` : null].filter(Boolean).join(" · ");
    out += `<g class="lane"><rect class="lane-bg" x="${lane.x}" y="${lane.y}" width="${lane.width}" height="${lane.height}" rx="12"/>`;
    if (detail) {
      out += `<clipPath id="lane-heading-${index}"><rect x="${lane.x + LANE_PAD}" y="${lane.y}" width="${Math.max(0, lane.width - 2 * LANE_PAD)}" height="52"/></clipPath><g clip-path="url(#lane-heading-${index})">`;
      out += `<text class="lane-title" x="${lane.x + LANE_PAD}" y="${lane.y + 24}">${esc(lane.project)}</text>`;
      out += `<text class="lane-meta" x="${lane.x + LANE_PAD}" y="${lane.y + 42}"><title>${esc(meta)}</title>${esc(clip(meta, Math.floor((lane.width - 2 * LANE_PAD) / 6)))}</text></g>`;
    }
    out += "</g>";
  }

  let edgeSvg = "";
  for (const e of edges) {
    const child = byId.get(e.to);
    const flow = detail && e.isTree && child?.status === "working" && !child.meta?.dataStale;
    const stale = state.staleNodes.has(e.from) || state.staleNodes.has(e.to);
    const marker = ["message", "report", "dependency"].includes(e.kind) ? ` marker-end="url(#arrow-${safeKind(e.kind)})"` : "";
    edgeSvg += `<path class="edge e-${safeKind(e.kind)}${flow ? " flow" : ""}${stale ? " data-stale" : ""}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" d="${e.path}"${marker}><title>${esc(EDGE_LABEL[e.kind] ?? e.kind)}${e.inferred ? " (inferred)" : ""}${e.count > 1 ? ` ×${e.count}` : ""}</title></path>`;
    if (detail && e.count > 1) edgeSvg += `<g class="edge-badge" data-from="${esc(e.from)}" data-to="${esc(e.to)}"><rect x="${e.mid.x - 13}" y="${e.mid.y - 8}" width="26" height="16" rx="8"/><text x="${e.mid.x}" y="${e.mid.y + 3.5}" text-anchor="middle">×${e.count}</text></g>`;
  }

  let nodeSvg = "";
  for (const n of nodes) {
    const p = scene.pos.get(n.id);
    if (!p) continue;
    nodeSvg += drawNode(n, p, controls.get(n.id), detail || n.id === focusedId);
  }
  return out + edgeSvg + nodeSvg;
}

function drawNode(n, p, fold, detail) {
  const agent = agentInfo(n.agent);
  const role = n.role ? clip(n.role, 18) : null;
  const sub = n.meta?.dataStale ? `Last known: ${STATUS_LABEL[n.status] ?? n.status}` : [AGENTS[n.agent] ? agent.label : n.agent, n.surface && n.surface !== "in-process" ? n.surface : null, shortModel(n.model)].filter(Boolean).join(" · ");
  const roleW = role ? Math.round(role.length * 6.1 + 12) : 0;
  const titleMax = Math.floor((CARD_W - 46 - (role ? roleW + 6 : 0)) / 6.9);
  const stale = n.meta?.dataStale || state.staleNodes.has(n.id);
  const cls = ["node", `s-${safeStatus(n.status)}`, stale ? "data-stale" : "", n.meta?.placeholder ? "placeholder" : "", n.liveView?.available ? "has-live" : "", detail ? "" : "compact"].join(" ");
  const folded = Boolean(fold?.hiddenCount);
  const foldLabel = fold ? `${folded ? "Show" : "Hide"} ${fold.eligibleCount} finished sessions under ${n.title}` : "";
  const opening = `<g class="${cls}" data-id="${esc(n.id)}" transform="translate(${p.x} ${p.y})" role="button" tabindex="0" aria-label="${esc(n.title)} · ${esc(STATUS_LABEL[n.status] ?? n.status)}" aria-pressed="false" style="--node-status:var(--s-${safeStatus(n.status)})">
    <title>${esc(n.title)}\n${esc(agent.label)} · ${n.meta?.dataStale ? "Last known: " : ""}${esc(STATUS_LABEL[n.status] ?? n.status)}${n.attention?.reason ? ` · ${esc(n.attention.reason)}${n.attention.evidence === "inferred" ? " (inferred)" : ""}` : ""}${n.cwd ? `\n${esc(n.cwd)}` : ""}</title>`;
  if (!detail) return `${opening}<rect class="card" width="${CARD_W}" height="${CARD_H}" rx="9"/><rect class="stripe" x="7" y="10" width="3.5" height="${CARD_H - 20}" fill="${agent.color}"/></g>`;
  return `${opening}
    <rect class="card" width="${CARD_W}" height="${CARD_H}" rx="9"/>
    <rect class="stripe" x="7" y="10" width="3.5" height="${CARD_H - 20}" fill="${agent.color}"/>
    <text class="title" x="19" y="22">${esc(clip(n.title, titleMax))}</text>
    ${role ? `<rect class="role" x="${CARD_W - 30 - roleW}" y="10" width="${roleW}" height="16" rx="5"/><text class="role-text" x="${CARD_W - 30 - roleW / 2}" y="21.5" text-anchor="middle">${esc(role)}</text>` : ""}
    ${fold ? `<g class="collapse-toggle${folded ? " collapsed" : ""}" data-collapse="${esc(n.id)}" role="button" tabindex="0" aria-expanded="${!folded}" aria-label="${esc(foldLabel)}" transform="translate(17 30)"><title>${esc(foldLabel)}</title><rect width="121" height="19" rx="5"/><text x="8" y="13">${folded ? "+" : "−"} ${fold.eligibleCount} finished</text></g>` : `<text class="sub" x="19" y="40">${esc(clip(sub, n.liveView?.available ? 23 : 30))}</text>`}
    ${n.liveView?.available ? `<g class="live-badge" data-live-view role="button" tabindex="0" aria-label="Open live browser for ${esc(n.title)}" transform="translate(${CARD_W - 64} 30)"><title>Live browser available · open Live view</title><rect width="54" height="17" rx="5"/><circle cx="9" cy="8.5" r="2.5"/><text x="31" y="12" text-anchor="middle">LIVE</text></g>` : `<text class="ago" x="${CARD_W - 12}" y="40" text-anchor="end" data-ts="${esc(n.lastActivityAt ?? "")}">${esc(ago(n.lastActivityAt))}</text>`}
    ${n.status === "working" && !n.meta?.dataStale ? `<circle class="halo" cx="${CARD_W - 15}" cy="18" r="4.5"/>` : ""}
    <circle class="status-dot" cx="${CARD_W - 15}" cy="18" r="4.5" fill="var(--s-${n.meta?.dataStale ? "stale" : safeStatus(n.status)})"/>
  </g>`;
}

function applySelection() {
  const vp = $("viewport");
  const sel = state.selected;
  $("session-rows").querySelectorAll("[data-id]").forEach((row) => {
    row.classList.toggle("selected", row.dataset.id === sel);
    row.querySelector(".session-name")?.setAttribute("aria-pressed", String(row.dataset.id === sel));
  });
  vp.querySelectorAll(".node").forEach((g) => {
    g.classList.remove("selected", "related", "dim");
    g.setAttribute("aria-pressed", String(g.dataset.id === sel));
  });
  vp.querySelectorAll(".edge, .edge-badge").forEach((e) => e.classList.remove("dim", "hl"));
  if (!sel || !state.visibleIds?.has(sel)) return; // selected node is not drawn: do not dim the whole graph
  const related = new Set([sel]);
  for (const edge of state.scene?.edges ?? []) {
    if (edge.from === sel || edge.to === sel) {
      related.add(edge.from);
      related.add(edge.to);
    }
  }
  vp.querySelectorAll(".edge, .edge-badge").forEach((e) => {
    const touches = e.dataset.from === sel || e.dataset.to === sel;
    e.classList.add(touches ? "hl" : "dim");
  });
  vp.querySelectorAll(".node").forEach((g) => {
    const id = g.dataset.id;
    if (id === sel) g.classList.add("selected");
    else if (related.has(id)) g.classList.add("related");
    else g.classList.add("dim");
  });
}

function renderStats(snap) {
  const c = {};
  for (const n of snap.nodes) if (!n.meta?.dataStale) c[n.status] = (c[n.status] ?? 0) + 1;
  const sessionsLive = snap.nodes.filter((n) => !n.meta?.dataStale && n.kind === "session" && ["working", "waiting", "idle"].includes(n.status)).length;
  const cached = snap.nodes.filter((n) => n.meta?.dataStale).length;
  const items = [
    ["failed", snap.nodes.filter((n) => n.status === "failed").length, "Failed"],
    ["waiting", snap.nodes.filter((n) => n.status === "waiting").length, "Needs you"],
    ["working", c.working ?? 0, "Working"],
    ["idle", sessionsLive, "Live sessions"],
  ];
  if (c.stale) items.push(["stale", c.stale, "Stale"]);
  if (cached) items.push(["stale", cached, "Last known"]);
  $("stats").innerHTML = items.map(([s, n, label]) => `<span class="stat"><i style="background:var(--s-${s})"></i><b>${n}</b>${label}</span>`).join("");
}

function renderAttention(snap, now = Date.now()) {
  const groups = selectAttention(snap, { ...filterOptions(), now });
  const key = JSON.stringify(groups);
  if (key === state.attentionKey) return; // Preserve keyboard focus while only ages change.
  state.attentionKey = key;
  const empty = { waiting: "No input requested.", failed: "No failures.", completed: "No answers finished in the last 10 min." };
  for (const [kind, list] of Object.entries(groups)) {
    $(`${kind}-count`).textContent = list.length;
    $(kind).innerHTML = list.length ? list.map((n) => {
      const at = n.attention?.at ?? n.lastActivityAt;
      const reason = n.attention?.reason ?? (kind === "failed" ? "Session failed" : kind === "completed" ? "Session finished" : "Input requested");
      return `<li><button type="button" class="attention-item ${kind}${n.meta?.dataStale ? " data-stale" : ""}" data-id="${esc(n.id)}" style="--agent:${agentInfo(n.agent).color}"><span class="w-title">${esc(n.title)}</span><span class="w-reason">${n.meta?.dataStale ? "Last known · " : ""}${esc(reason)}${n.attention?.evidence === "inferred" ? " · inferred" : ""}</span><span class="w-sub"><span>${esc(n.project ?? "")} · ${esc(agentInfo(n.agent).label)}</span><span data-ts="${esc(at ?? "")}">${esc(ago(at, now))}</span></span></button></li>`;
    }).join("") : `<li class="w-none">${empty[kind]}</li>`;
  }
  $("attention-toggle").textContent = `Attention ${groups.waiting.length + groups.failed.length}`;
}

function renderAgentFilters(snap, present, parked) {
  const counts = {};
  const available = selectVisible(snap, { ...filterOptions(), agents: present });
  for (const n of available.nodes) counts[n.agent] = (counts[n.agent] ?? 0) + 1;
  const order = [...new Set([...Object.keys(AGENTS), ...present])].filter((a) => present.has(a) || AGENTS[a]);
  $("agent-filters").innerHTML = order
    .map((a) => `<label><input type="checkbox" data-agent="${esc(a)}" ${state.hiddenAgents.has(a) ? "" : "checked"} ${present.has(a) ? "" : "disabled"}/><span class="swatch" style="background:${agentInfo(a).color}"></span>${esc(agentInfo(a).label)}<span class="n">${present.has(a) ? `${counts[a] ?? 0} match` : "none"}</span></label>`)
    .join("") +
    `<label class="parked-toggle"><input type="checkbox" data-parked ${state.showParked ? "checked" : ""}/>Show parked sessions<span class="n">${state.showParked ? "" : [...parked.values()].reduce((a, b) => a + b, 0) + " hidden"}</span></label>`;
}

function renderSources(health, now, threshold) {
  const av = state.snap?.agentsviewUp ? "agentsview: connected" : "agentsview: offline";
  $("sources").innerHTML =
    `<h2>Sources</h2>` +
    (health?.adapters ?? []).map((a) => {
      const observedAt = a.observedAt ?? a.lastSuccessAt;
      const age = now - Date.parse(observedAt);
      const stale = a.stale || !Number.isFinite(age) || age > threshold;
      const ageLabel = observedAt ? updateAge(observedAt, now) : "no successful update";
      const label = a.updating && !a.lastSuccessAt && !a.error ? "collecting" : a.error ? `${a.retained ? "cached · " : ""}unavailable` : stale ? "delayed" : `${a.nodes} items`;
      return `<div class="source ${a.error ? "err" : stale ? "source-stale" : ""}" title="${esc(a.error ?? `Collection: ${a.ms} ms`)}"><span>${esc(a.label)}<small>${esc(ageLabel)}</small></span><span>${label}</span></div>`;
    }).join("") +
    (health?.processError ? `<div class="err" title="${esc(health.processError)}"><span>Process discovery</span><span>unavailable</span></div>` : "") +
    `<div style="margin-top:6px"><span>${av}</span></div>`;
}

/* ---------- detail panel ---------- */

function renderPanel() {
  const snap = state.snap;
  const n = snap?.nodes.find((x) => x.id === state.selected);
  if (!n) {
    $("panel").hidden = true;
    inspector.select(null);
    return;
  }
  $("panel").hidden = false;
  const agent = agentInfo(n.agent);
  const actions = [];
  if (n.agentsviewId) {
    actions.push(
      snap.agentsviewUp
        ? `<a href="${esc(new URL(`/sessions/${encodeURIComponent(n.agentsviewId)}`, snap.agentsviewUrl).href)}" target="_blank" rel="noopener">Open transcript in agentsview ↗</a>`
        : `<div class="hint">Transcript links appear once agentsview runs on ${esc(snap.agentsviewUrl)} (<code>agentsview serve</code>).</div>`,
    );
  }
  if (n.openUrl) actions.push(`<a href="${esc(n.openUrl)}">Open in Claude app ↗</a>`);
  const resume = resumeCommand(n);
  if (resume) actions.push(`<button data-copy="${esc(resume)}">Copy resume command</button>`);
  if (n.cwd) actions.push(`<button data-copy="${esc(n.cwd)}">Copy working directory</button>`);

  const facts = [
    ["Project", esc(n.project)],
    ["Directory", n.cwd ? `<code>${esc(n.cwd)}</code>` : null],
    ["Model", esc(n.model)],
    ["Surface", esc(n.surface)],
    ["Process", n.pid ? `pid ${n.pid}` : null],
    ["Started", n.startedAt ? `${clock(n.startedAt)} · ${ago(n.startedAt)} ago` : null],
    ["Last activity", n.lastActivityAt ? `${clock(n.lastActivityAt)} · <span data-ts="${esc(n.lastActivityAt)}">${ago(n.lastActivityAt)}</span> ago` : null],
    ...Object.entries(n.meta ?? {}).filter(([k, v]) => v !== null && v !== undefined && v !== "" && k !== "placeholder").map(([k, v]) => [k, `<code>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</code>`]),
    ["Id", `<code>${esc(n.id)}</code>`],
    ["Source", n.source ? `<code>${esc(n.source)}</code>` : null],
  ].filter(([, v]) => v);

  const byId = new Map(snap.nodes.map((x) => [x.id, x]));
  const rels = [];
  for (const e of snap.edges) {
    if (e.from !== n.id && e.to !== n.id) continue;
    const outgoing = e.from === n.id;
    const other = byId.get(outgoing ? e.to : e.from);
    if (!other) continue;
    rels.push({ e, outgoing, other, label: relLabel(e.kind, outgoing) });
  }
  rels.sort((a, b) => (b.e.at ?? "").localeCompare(a.e.at ?? ""));

  $("panel-overview").innerHTML = `
    <h3>${esc(n.title)}</h3>
    <div class="chips">
      <span class="chip agent" style="background:${agent.color}">${esc(agent.label)}</span>
      <span class="chip status"><i style="background:var(--s-${n.meta?.dataStale ? "stale" : safeStatus(n.status)})"></i>${n.meta?.dataStale ? "Last known: " : ""}${esc(STATUS_LABEL[n.status] ?? n.status)}</span>
      ${n.role ? `<span class="chip">${esc(n.role)}</span>` : ""}
      <span class="chip">${esc(n.kind)}</span>
    </div>
    ${n.attention?.reason ? `<p class="attention-note">${esc(n.attention.reason)}${n.attention.evidence === "inferred" ? " · inferred from session activity" : ""}</p>` : ""}
    ${n.meta?.dataStale ? `<p class="attention-note stale-note">This source is unavailable. Activity shown is from its last successful update.</p>` : ""}`;
  inspector.select(n.id, `${n.meta?.dataStale ? "Last known: " : ""}${STATUS_LABEL[n.status] ?? n.status}`, { title: n.title, status: n.status, lastActivityAt: n.lastActivityAt, stale: Boolean(n.meta?.dataStale) });
  $("panel-body").innerHTML = `
    ${actions.length ? `<div class="actions">${actions.join("")}</div>` : ""}
    <dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>
    <h4>Relations (${rels.length})</h4>
    ${
      rels.length
        ? `<ul class="rel">${rels
            .map(
              (r) => `<li data-id="${esc(r.other.id)}"><span class="k" style="color:var(--e-${r.e.kind === "spawn" ? "report" : safeKind(r.e.kind)})">${esc(r.label)}${r.e.count > 1 ? ` ×${r.e.count}` : ""}${r.e.inferred ? " · inferred" : ""}</span>
                <span class="t">${esc(r.other.title)}</span>
                ${r.e.label && r.e.kind === "report" ? `<span class="note">${esc(r.e.label)}</span>` : ""}
                ${r.e.at ? `<span class="note">${esc(clock(r.e.at))}</span>` : ""}</li>`,
            )
            .join("")}</ul>`
        : `<p class="hint" style="color:var(--faint)">No known relations.</p>`
    }`;
}

function relLabel(kind, outgoing) {
  const map = {
    spawn: ["Started", "Started by"],
    message: ["Sent messages to", "Messages from"],
    report: ["Reported to", "Reports from"],
    dependency: ["Feeds", "Fed by"],
    process: ["Started process", "Process started by"],
  };
  return (map[kind] ?? [kind, kind])[outgoing ? 0 : 1];
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function resumeCommand(n) {
  if (n.kind !== "session" || !n.cwd) return null;
  const cd = `cd ${shq(n.cwd)} && `;
  if (n.agent === "claude" && n.agentsviewId && n.surface !== "desktop") return `${cd}claude --resume ${shq(n.agentsviewId)}`;
  if (n.agent === "codex") return `${cd}codex resume ${shq(n.id.replace(/^codex:/, ""))}`;
  return null;
}

/* ---------- pan / zoom ---------- */

// The overview is the furthest zoom-out. At larger scales, each axis stops
// at the graph edge; an axis that already fits stays centered.
function viewLimits() {
  const bounds = state.graphBounds;
  const box = $("canvas").getBoundingClientRect();
  if (!bounds?.width || !bounds.height || box.width <= 0 || box.height <= 0) return null;
  const pad = Math.min(30, box.width / 4, box.height / 4);
  const minScale = Math.min(1.05, (box.width - pad * 2) / bounds.width, (box.height - pad * 2) / bounds.height);
  return { width: box.width, height: box.height, pad, minScale, maxScale: 2.2 };
}

function applyView() {
  if (state.display !== "graph") return;
  const limits = viewLimits();
  if (limits) {
    const bounds = state.graphBounds;
    const k = Math.max(limits.minScale, Math.min(limits.maxScale, state.view.k));
    const bound = (value, origin, extent, available) => {
      const span = extent * k;
      if (span <= available - limits.pad * 2) return (available - span) / 2 - origin * k;
      return Math.max(available - limits.pad - (origin + extent) * k, Math.min(limits.pad - origin * k, value));
    };
    state.view = {
      k,
      x: bound(state.view.x, bounds.x, bounds.width, limits.width),
      y: bound(state.view.y, bounds.y, bounds.height, limits.height),
    };
  }
  $("zoom-out").disabled = !limits || state.view.k <= limits.minScale + 1e-9;
  $("zoom-in").disabled = !limits || state.view.k >= limits.maxScale - 1e-9;
  const { x, y, k } = state.view;
  $("viewport").setAttribute("transform", `translate(${x} ${y}) scale(${k})`);
  drawProjection();
}

function fit() {
  if (state.display !== "graph") return;
  const bounds = state.graphBounds;
  const limits = viewLimits();
  if (!limits) return;
  const k = limits.minScale;
  state.view = { k, x: (limits.width - bounds.width * k) / 2 - bounds.x * k, y: (limits.height - bounds.height * k) / 2 - bounds.y * k };
  applyView();
}

function zoomAt(factor, cx, cy) {
  if (state.display !== "graph") return;
  const limits = viewLimits();
  if (!limits) return;
  const v = state.view;
  const k = Math.max(limits.minScale, Math.min(limits.maxScale, v.k * factor));
  const f = k / v.k;
  state.view = { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
  applyView();
}

function centerOn(id) {
  const L = state.lastLayout;
  const p = L && cardPos(L, id);
  if (!p) return;
  const box = $("canvas").getBoundingClientRect();
  const k = Math.max(state.view.k, 0.8);
  state.view = { k, x: box.width / 2 - (p.x + CARD_W / 2) * k, y: box.height / 2 - (p.y + CARD_H / 2) * k };
  applyView();
}

function select(id, { center = false, live = false } = {}) {
  state.selected = id;
  if (state.display === "graph" && state.folded?.hiddenIds.has(id)) {
    for (const parent of state.folded.revealPath(id)) state.collapsedParents.delete(parent);
    state.needsFit = true;
    render();
  } else {
    applySelection();
    renderPanel();
  }
  if (live && id) inspector.showTab("live");
  if (state.display === "list") {
    if (center && id) [...$("session-rows").querySelectorAll("[data-id]")].find((r) => r.dataset.id === id)?.scrollIntoView({ block: "nearest" });
    return;
  }
  if (!id) {
    applyView();
    return;
  }
  // opening the panel narrows the canvas; bring the node back if it ended up hidden
  const p = state.scene?.pos.get(id);
  const box = $("canvas").getBoundingClientRect();
  const v = state.view;
  const offscreen = p && (v.x + (p.x + CARD_W) * v.k > box.width || v.x + p.x * v.k < 0 || v.y + (p.y + CARD_H) * v.k > box.height || v.y + p.y * v.k < 0);
  if (center || offscreen || v.k < 0.45) centerOn(id);
  else applyView();
}

/* ---------- events ---------- */

function changeCollapse(parents) {
  if (!state.snap) return;
  state.collapsedParents = parents;
  const projected = collapseCompleted(state.snap, selectVisible(state.snap, filterOptions()), parents);
  if (projected.hiddenIds.has(state.selected)) {
    const drawn = new Set(projected.nodes.map((n) => n.id));
    state.selected = projected.revealPath(state.selected).find((id) => drawn.has(id)) ?? null;
  }
  state.needsFit = true;
  render();
}

function toggleCollapse(id) {
  if (!state.folded?.controls.has(id)) return;
  const next = new Set(state.collapsedParents);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  changeCollapse(next);
}

function filtersChanged() {
  state.needsFit = true;
  $("session-list").scrollTop = 0;
  render();
  if (state.selected && !state.visibleIds?.has(state.selected)) select(null);
}

function setDisplay(display) {
  const previous = state.display;
  state.display = display;
  savePref("display", display);
  state.needsFit = true;
  render();
  if (previous !== "graph" && display === "graph" && state.selected) centerOn(state.selected);
}

function wire() {
  const canvas = $("canvas");
  let drag = null;
  canvas.addEventListener("pointerdown", (ev) => {
    if (state.display !== "graph") return;
    if (ev.target.closest(".node") || ev.target.closest(".zoom")) return;
    drag = { x: ev.clientX, y: ev.clientY, vx: state.view.x, vy: state.view.y, moved: false };
    canvas.setPointerCapture(ev.pointerId);
    canvas.classList.add("dragging");
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    state.view = { ...state.view, x: drag.vx + dx, y: drag.vy + dy };
    applyView();
  });
  canvas.addEventListener("pointerup", (ev) => {
    if (drag && !drag.moved && !ev.target.closest(".node")) select(null);
    drag = null;
    canvas.classList.remove("dragging");
  });
  canvas.addEventListener(
    "wheel",
    (ev) => {
      if (state.display !== "graph") return;
      ev.preventDefault();
      const box = canvas.getBoundingClientRect();
      if (ev.ctrlKey || ev.metaKey) zoomAt(Math.exp(-ev.deltaY * 0.01), ev.clientX - box.left, ev.clientY - box.top);
      else {
        state.view = { ...state.view, x: state.view.x - ev.deltaX, y: state.view.y - ev.deltaY };
        applyView();
      }
    },
    { passive: false },
  );
  $("viewport").addEventListener("click", (ev) => {
    const fold = ev.target.closest("[data-collapse]");
    if (fold) { toggleCollapse(fold.dataset.collapse); return; }
    const g = ev.target.closest(".node");
    if (g) select(g.dataset.id, { live: Boolean(ev.target.closest("[data-live-view]")) });
  });
  $("viewport").addEventListener("keydown", (ev) => {
    if (!["Enter", " "].includes(ev.key)) return;
    const fold = ev.target.closest("[data-collapse]");
    if (fold) { ev.preventDefault(); toggleCollapse(fold.dataset.collapse); return; }
    const node = ev.target.closest(".node");
    if (node) { ev.preventDefault(); select(node.dataset.id, { live: Boolean(ev.target.closest("[data-live-view]")) }); }
  });
  // Focus is pinned by the next view update. Replacing SVG on focusin can remove
  // the pointer's target between mousedown (focus) and its eventual click.
  $("zoom-in").onclick = () => zoomAt(1.2, canvas.clientWidth / 2, canvas.clientHeight / 2);
  $("zoom-out").onclick = () => zoomAt(1 / 1.2, canvas.clientWidth / 2, canvas.clientHeight / 2);
  $("zoom-fit").onclick = () => {
    state.needsFit = true;
    render();
  };
  $("panel-close").onclick = () => select(null);
  $("view-graph").onclick = () => setDisplay("graph");
  $("view-list").onclick = () => setDisplay("list");
  $("collapse-finished").onclick = () => changeCollapse(new Set([...state.collapsedParents, ...(state.folded?.controls.keys() ?? [])]));
  $("expand-finished").onclick = () => changeCollapse(new Set());
  $("session-rows").addEventListener("click", (ev) => {
    const row = ev.target.closest("[data-id]");
    if (row) select(row.dataset.id, { live: Boolean(ev.target.closest("[data-live-view]")) });
  });
  $("project-filter").addEventListener("change", (ev) => {
    state.project = ev.target.value === "all" ? null : ev.target.value.slice("project:".length);
    filtersChanged();
  });
  $("status-filter").addEventListener("change", (ev) => {
    state.status = Object.hasOwn(STATUS_LABEL, ev.target.value) ? ev.target.value : null;
    filtersChanged();
  });
  $("reset-filters").onclick = () => {
    state.project = null;
    state.status = null;
    state.query = "";
    state.hiddenAgents.clear();
    savePref("hiddenAgents", []);
    $("search").value = "";
    filtersChanged();
  };

  document.querySelectorAll("[data-scope]").forEach((b) => {
    b.onclick = () => {
      state.scope = b.dataset.scope;
      document.querySelectorAll("[data-scope]").forEach((x) => {
        x.classList.toggle("on", x === b);
        x.setAttribute("aria-selected", String(x === b));
      });
      filtersChanged();
    };
  });
  $("search").addEventListener("input", (ev) => {
    state.query = ev.target.value;
    filtersChanged();
  });
  $("agent-filters").addEventListener("change", (ev) => {
    if ("parked" in ev.target.dataset) {
      state.showParked = ev.target.checked;
      savePref("showParked", state.showParked);
      filtersChanged();
      return;
    }
    const a = ev.target.dataset.agent;
    if (!a) return;
    if (ev.target.checked) state.hiddenAgents.delete(a);
    else state.hiddenAgents.add(a);
    savePref("hiddenAgents", [...state.hiddenAgents]);
    filtersChanged();
  });
  for (const kind of ["waiting", "failed", "completed"]) $(kind).addEventListener("click", (ev) => {
    const button = ev.target.closest("button[data-id]");
    if (button) {
      select(button.dataset.id, { center: true });
      $("rail").classList.remove("open");
      $("attention-toggle").setAttribute("aria-expanded", "false");
    }
  });
  $("attention-toggle").onclick = () => {
    const open = $("attention-toggle").getAttribute("aria-expanded") !== "true";
    $("attention-toggle").setAttribute("aria-expanded", String(open));
    $("rail").classList.toggle("open", open);
  };
  $("panel").addEventListener("click", async (ev) => {
    const copy = ev.target.closest("[data-copy]");
    if (copy) {
      try {
        await navigator.clipboard.writeText(copy.dataset.copy);
        const label = copy.textContent;
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = label), 1200);
      } catch {
        // clipboard blocked; leave the button unchanged
      }
      return;
    }
    const li = ev.target.closest("li[data-id]");
    if (li) select(li.dataset.id, { center: true });
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.target.matches("input, select, textarea, button")) {
      if (ev.key === "Escape") ev.target.blur();
      return;
    }
    if (ev.key === "Escape") select(null);
    if (ev.key === "/") {
      ev.preventDefault();
      $("search").focus();
    }
    if (ev.key === "f") {
      state.needsFit = true;
      render();
    }
  });
  // Includes panel open/close and app-pane resizing, which do not resize window.
  new ResizeObserver(() => applyView()).observe(canvas);

  // relative timestamps tick without a re-render
  setInterval(() => {
    const now = Date.now();
    document.querySelectorAll("[data-ts]").forEach((el) => {
      if (el.dataset.ts) el.textContent = ago(el.dataset.ts, now);
    });
    renderHealth(now);
    if (state.snap) renderAttention(state.snap, now);
  }, 1000);
}

wire();
connect();
