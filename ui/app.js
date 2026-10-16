import { CARD_H, CARD_W, LANE_PAD, layout, selectVisible } from "/layout.js";
import { createInspector } from "/inspector.js";

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
const STATUS_LABEL = { working: "Working", waiting: "Waiting for you", idle: "Idle", queued: "Queued", done: "Done", failed: "Failed", stale: "Stale" };
const EDGE_LABEL = { spawn: "started", message: "sent message", report: "reported back", dependency: "feeds", process: "started process" };

const $ = (id) => document.getElementById(id);
const inspector = createInspector($("session-content"));
const state = {
  snap: null,
  scope: "live",
  hiddenAgents: new Set(loadPref("hiddenAgents", [])),
  showParked: loadPref("showParked", false),
  query: "",
  selected: null,
  view: { x: 40, y: 30, k: 1 },
  needsFit: true,
  lastLayout: null,
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
  if (s < 10) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
const clock = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "—");

/* ---------- live connection ---------- */

function connect() {
  const es = new EventSource("/api/events");
  es.addEventListener("snapshot", (ev) => {
    state.snap = JSON.parse(ev.data);
    setPulse(true);
    render();
  });
  es.onerror = () => setPulse(false);
}

function setPulse(on) {
  $("pulse").className = `pulse ${on ? "on" : "off"}`;
  if (!on) $("pulse-text").textContent = "reconnecting…";
}

/* ---------- rendering ---------- */

function render() {
  const snap = state.snap;
  if (!snap) return;
  const agentsPresent = new Set(snap.nodes.map((n) => n.agent));
  const visibleAgents = new Set([...agentsPresent].filter((a) => !state.hiddenAgents.has(a)));
  const vis = selectVisible(snap, { scope: state.scope, agents: visibleAgents, query: state.query, showParked: state.showParked });
  const box = $("canvas").getBoundingClientRect();
  if (state.needsFit) state.sticky = {};
  const L = layout(vis.nodes, vis.edges, { width: box.width - 60, height: box.height - 60 }, state.sticky);
  state.sticky = { order: L.order, cols: L.cols };
  state.lastLayout = { ...L, nodes: vis.nodes, edges: vis.edges };
  if (state.selected && !vis.nodes.some((n) => n.id === state.selected)) {
    // keep the panel on a node that just left the live scope
    if (!snap.nodes.some((n) => n.id === state.selected)) state.selected = null;
  }

  $("viewport").innerHTML = drawGraph(vis.nodes, vis.edges, L, vis.parked);
  // Relation curves and labels can extend outside the lane rectangles.
  state.graphBounds = $("viewport").getBBox();
  $("empty").hidden = vis.nodes.length > 0;
  state.visibleIds = new Set(vis.nodes.map((n) => n.id));
  applySelection();
  renderStats(snap);
  renderWaiting(snap);
  renderAgentFilters(snap, agentsPresent, vis.parked);
  renderSources(snap);
  $("scope-all").textContent = `Last ${snap.windowHours} h`;
  if (state.needsFit && vis.nodes.length) {
    fit();
    state.needsFit = false;
  } else applyView();
  if (state.selected) renderPanel();
}

const cardPos = (L, id) => L.pos.get(id) ?? null;

function drawGraph(nodes, edges, L, parked) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let out = "";
  for (const lane of L.lanes) {
    const hidden = parked.get(lane.project);
    const meta = [lane.working ? `${lane.working} working` : null, lane.waiting ? `${lane.waiting} waiting` : null, `${lane.size} shown`, hidden ? `+${hidden} parked` : null].filter(Boolean).join(" · ");
    out += `<g class="lane"><rect class="lane-bg" x="${lane.x}" y="${lane.y}" width="${lane.width}" height="${lane.height}" rx="12"/>`;
    out += `<text class="lane-title" x="${lane.x + LANE_PAD}" y="${lane.y + 24}">${esc(lane.project)}</text>`;
    out += `<text class="lane-meta" x="${lane.x + lane.width - LANE_PAD}" y="${lane.y + 24}" text-anchor="end">${esc(meta)}</text></g>`;
  }

  let edgeSvg = "";
  for (const e of edges) {
    const a = cardPos(L, e.from);
    const b = cardPos(L, e.to);
    if (!a || !b) continue;
    const isTree = L.parent.get(e.to) === e.from && (e.kind === "spawn" || e.kind === "process");
    const child = byId.get(e.to);
    const flow = isTree && child?.status === "working";
    const d = edgePath(a, b, isTree);
    const marker = ["message", "report", "dependency"].includes(e.kind) ? ` marker-end="url(#arrow-${safeKind(e.kind)})"` : "";
    edgeSvg += `<path class="edge e-${safeKind(e.kind)}${flow ? " flow" : ""}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" d="${d.path}"${marker}><title>${esc(EDGE_LABEL[e.kind] ?? e.kind)}${e.inferred ? " (inferred)" : ""}${e.count > 1 ? ` ×${e.count}` : ""}</title></path>`;
    if (e.count > 1) edgeSvg += `<g class="edge-badge" data-from="${esc(e.from)}" data-to="${esc(e.to)}"><rect x="${d.mid.x - 13}" y="${d.mid.y - 8}" width="26" height="16" rx="8"/><text x="${d.mid.x}" y="${d.mid.y + 3.5}" text-anchor="middle">×${e.count}</text></g>`;
  }

  let nodeSvg = "";
  for (const n of nodes) {
    const p = cardPos(L, n.id);
    if (!p) continue;
    nodeSvg += drawNode(n, p);
  }
  return out + edgeSvg + nodeSvg;
}

function edgePath(a, b, isTree) {
  const ax = a.x + CARD_W;
  const ay = a.y + CARD_H / 2;
  if (isTree || b.x > a.x + 10) {
    const bx = b.x;
    const by = b.y + CARD_H / 2;
    const dx = Math.max(30, (bx - ax) / 2);
    return { path: `M${ax} ${ay} C${ax + dx} ${ay} ${bx - dx} ${by} ${bx} ${by}`, mid: { x: (ax + bx) / 2, y: (ay + by) / 2 } };
  }
  if (Math.abs(b.x - a.x) <= 10) {
    // same column: loop out to the right
    const by = b.y + CARD_H / 2;
    const bulge = 46 + Math.min(120, Math.abs(by - ay) / 4);
    return { path: `M${ax} ${ay} C${ax + bulge} ${ay} ${ax + bulge} ${by} ${ax} ${by}`, mid: { x: ax + bulge * 0.75, y: (ay + by) / 2 } };
  }
  // target is left of source: leave from the left edge of the source into the right edge of the target
  const sx = a.x;
  const tx = b.x + CARD_W;
  const by = b.y + CARD_H / 2;
  const dx = Math.max(30, (sx - tx) / 2);
  return { path: `M${sx} ${ay} C${sx - dx} ${ay} ${tx + dx} ${by} ${tx} ${by}`, mid: { x: (sx + tx) / 2, y: (ay + by) / 2 } };
}

function drawNode(n, p) {
  const agent = agentInfo(n.agent);
  const role = n.role ? clip(n.role, 18) : null;
  const sub = [AGENTS[n.agent] ? agent.label : n.agent, n.surface && n.surface !== "in-process" ? n.surface : null, shortModel(n.model)].filter(Boolean).join(" · ");
  const roleW = role ? Math.round(role.length * 6.1 + 12) : 0;
  const titleMax = Math.floor((CARD_W - 46 - (role ? roleW + 6 : 0)) / 6.9);
  const cls = ["node", `s-${safeStatus(n.status)}`, n.meta?.placeholder ? "placeholder" : ""].join(" ");
  return `<g class="${cls}" data-id="${esc(n.id)}" transform="translate(${p.x} ${p.y})">
    <title>${esc(n.title)}\n${esc(STATUS_LABEL[n.status] ?? n.status)}${n.cwd ? `\n${esc(n.cwd)}` : ""}</title>
    <rect class="card" width="${CARD_W}" height="${CARD_H}" rx="9"/>
    <rect class="stripe" x="7" y="10" width="3.5" height="${CARD_H - 20}" fill="${agent.color}"/>
    <text class="title" x="19" y="22">${esc(clip(n.title, titleMax))}</text>
    ${role ? `<rect class="role" x="${CARD_W - 30 - roleW}" y="10" width="${roleW}" height="16" rx="5"/><text class="role-text" x="${CARD_W - 30 - roleW / 2}" y="21.5" text-anchor="middle">${esc(role)}</text>` : ""}
    <text class="sub" x="19" y="40">${esc(clip(sub, 30))}</text>
    <text class="ago" x="${CARD_W - 12}" y="40" text-anchor="end" data-ts="${esc(n.lastActivityAt ?? "")}">${esc(ago(n.lastActivityAt))}</text>
    ${n.status === "working" ? `<circle class="halo" cx="${CARD_W - 15}" cy="18" r="4.5"/>` : ""}
    <circle class="status-dot" cx="${CARD_W - 15}" cy="18" r="4.5" fill="var(--s-${safeStatus(n.status)})"/>
  </g>`;
}

function applySelection() {
  const vp = $("viewport");
  const sel = state.selected;
  vp.querySelectorAll(".node").forEach((g) => g.classList.remove("selected", "related", "dim"));
  vp.querySelectorAll(".edge, .edge-badge").forEach((e) => e.classList.remove("dim", "hl"));
  if (!sel || !state.visibleIds?.has(sel)) return; // selected node is not drawn: do not dim the whole graph
  const related = new Set([sel]);
  vp.querySelectorAll(".edge, .edge-badge").forEach((e) => {
    const touches = e.dataset.from === sel || e.dataset.to === sel;
    if (touches) {
      related.add(e.dataset.from);
      related.add(e.dataset.to);
    }
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
  const c = snap.counts;
  const sessionsLive = snap.nodes.filter((n) => n.kind === "session" && ["working", "waiting", "idle"].includes(n.status)).length;
  const items = [
    ["working", c.working ?? 0, "Working"],
    ["waiting", c.waiting ?? 0, "Waiting"],
    ["idle", sessionsLive, "Live sessions"],
  ];
  if (c.stale) items.push(["stale", c.stale, "Stale"]);
  $("stats").innerHTML = items.map(([s, n, label]) => `<span class="stat"><i style="background:var(--s-${s})"></i><b>${n}</b>${label}</span>`).join("");
  $("pulse-text").textContent = `live · ${snap.collectMs} ms`;
}

function renderWaiting(snap) {
  const list = snap.nodes.filter((n) => n.status === "waiting" && !state.hiddenAgents.has(n.agent)).sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
  $("waiting-count").textContent = list.length;
  $("waiting").innerHTML = list.length
    ? list.map((n) => `<li data-id="${esc(n.id)}" style="--agent:${agentInfo(n.agent).color}"><div class="w-title">${esc(n.title)}</div><div class="w-sub"><span>${esc(n.project ?? "")} · ${esc(agentInfo(n.agent).label)}</span><span data-ts="${esc(n.lastActivityAt ?? "")}">${esc(ago(n.lastActivityAt))}</span></div></li>`).join("")
    : `<li class="w-none">Nothing is waiting on you.</li>`;
}

function renderAgentFilters(snap, present, parked) {
  const counts = {};
  for (const n of snap.nodes) if (["working", "waiting", "idle", "stale", "queued"].includes(n.status)) counts[n.agent] = (counts[n.agent] ?? 0) + 1;
  const order = [...new Set([...Object.keys(AGENTS), ...present])].filter((a) => present.has(a) || AGENTS[a]);
  $("agent-filters").innerHTML = order
    .map((a) => `<label><input type="checkbox" data-agent="${esc(a)}" ${state.hiddenAgents.has(a) ? "" : "checked"} ${present.has(a) ? "" : "disabled"}/><span class="swatch" style="background:${agentInfo(a).color}"></span>${esc(agentInfo(a).label)}<span class="n">${present.has(a) ? `${counts[a] ?? 0} live` : "none"}</span></label>`)
    .join("") +
    `<label class="parked-toggle"><input type="checkbox" data-parked ${state.showParked ? "checked" : ""}/>Show parked sessions<span class="n">${state.showParked ? "" : [...parked.values()].reduce((a, b) => a + b, 0) + " hidden"}</span></label>`;
}

function renderSources(snap) {
  const av = snap.agentsviewUp ? "agentsview: connected" : "agentsview: offline";
  $("sources").innerHTML =
    `<h2>Sources</h2>` +
    snap.adapters.map((a) => `<div class="${a.error ? "err" : ""}" title="${esc(a.error ?? "")}"><span>${esc(a.label)}</span><span>${a.error ? "error" : `${a.nodes} · ${a.ms} ms`}</span></div>`).join("") +
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
      <span class="chip status"><i style="background:var(--s-${safeStatus(n.status)})"></i>${esc(STATUS_LABEL[n.status] ?? n.status)}</span>
      ${n.role ? `<span class="chip">${esc(n.role)}</span>` : ""}
      <span class="chip">${esc(n.kind)}</span>
    </div>`;
  inspector.select(n.id, STATUS_LABEL[n.status] ?? n.status);
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
}

function fit() {
  const bounds = state.graphBounds;
  const limits = viewLimits();
  if (!limits) return;
  const k = limits.minScale;
  state.view = { k, x: (limits.width - bounds.width * k) / 2 - bounds.x * k, y: (limits.height - bounds.height * k) / 2 - bounds.y * k };
  applyView();
}

function zoomAt(factor, cx, cy) {
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

function select(id, { center = false } = {}) {
  state.selected = id;
  applySelection();
  renderPanel();
  if (!id) {
    applyView();
    return;
  }
  // opening the panel narrows the canvas; bring the node back if it ended up hidden
  const g = [...$("viewport").querySelectorAll(".node")].find((el) => el.dataset.id === id);
  const box = $("canvas").getBoundingClientRect();
  const r = g?.getBoundingClientRect();
  const offscreen = r && (r.right > box.right || r.left < box.left || r.bottom > box.bottom || r.top < box.top);
  if (center || offscreen) centerOn(id);
  else applyView();
}

/* ---------- events ---------- */

function wire() {
  const canvas = $("canvas");
  let drag = null;
  canvas.addEventListener("pointerdown", (ev) => {
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
    const g = ev.target.closest(".node");
    if (g) select(g.dataset.id);
  });
  $("zoom-in").onclick = () => zoomAt(1.2, canvas.clientWidth / 2, canvas.clientHeight / 2);
  $("zoom-out").onclick = () => zoomAt(1 / 1.2, canvas.clientWidth / 2, canvas.clientHeight / 2);
  $("zoom-fit").onclick = () => {
    state.needsFit = true;
    render();
  };
  $("panel-close").onclick = () => select(null);

  document.querySelectorAll(".segmented button").forEach((b) => {
    b.onclick = () => {
      state.scope = b.dataset.scope;
      document.querySelectorAll(".segmented button").forEach((x) => x.classList.toggle("on", x === b));
      state.needsFit = true;
      render();
    };
  });
  $("search").addEventListener("input", (ev) => {
    state.query = ev.target.value;
    state.needsFit = true;
    render();
  });
  $("agent-filters").addEventListener("change", (ev) => {
    if ("parked" in ev.target.dataset) {
      state.showParked = ev.target.checked;
      savePref("showParked", state.showParked);
      state.needsFit = true;
      render();
      return;
    }
    const a = ev.target.dataset.agent;
    if (!a) return;
    if (ev.target.checked) state.hiddenAgents.delete(a);
    else state.hiddenAgents.add(a);
    savePref("hiddenAgents", [...state.hiddenAgents]);
    state.needsFit = true;
    render();
  });
  $("waiting").addEventListener("click", (ev) => {
    const li = ev.target.closest("li[data-id]");
    if (li) select(li.dataset.id, { center: true });
  });
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
    if (ev.target.matches("input")) {
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
  }, 1000);
}

wire();
connect();
