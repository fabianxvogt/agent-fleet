import assert from "node:assert/strict";
import { test } from "node:test";
import { collapseCompleted, layout, projectOptions, selectVisible, selectAttention, treeParents } from "../ui/layout.js";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const n = (id, status, extra = {}) => ({ id, agent: "claude", kind: "session", status, project: "p", lastActivityAt: new Date(NOW - 1000).toISOString(), meta: {}, ...extra });
const e = (from, to, kind = "spawn") => ({ id: `${kind}:${from}->${to}`, from, to, kind, count: 1 });

test("an available browser keeps a parked or finished session visible in Live", () => {
  const nodes = [n("parent", "done"), n("view", "done", { title: "Browser owner", meta: { parked: true }, liveView: { available: true } }), n("old", "done")];
  const snap = { nodes, edges: [e("parent", "view")] };
  const visible = selectVisible(snap, { scope: "live", now: NOW });
  assert.deepEqual(visible.nodes.map((n) => n.id), ["parent", "view"]);
  assert.equal(visible.parked.size, 0);
  assert.equal(selectVisible(snap, { scope: "live", query: "missing", now: NOW }).nodes.length, 0);
  nodes[1].liveView = null;
  assert.equal(selectVisible(snap, { scope: "live", now: NOW }).nodes.length, 0);
});

test("treeParents prefers spawn edges over inferred process edges and ignores messages", () => {
  const nodes = [n("a", "working"), n("b", "working"), n("c", "working")];
  const parents = treeParents(nodes, [e("b", "c", "process"), e("a", "c"), e("a", "b", "message")]);
  assert.equal(parents.get("c"), "a");
  assert.equal(parents.has("b"), false);
});

test("treeParents breaks cycles", () => {
  const parents = treeParents([n("a", "done"), n("b", "done")], [e("a", "b"), e("b", "a")]);
  assert.ok(parents.size < 2);
});

test("live scope keeps live nodes, their ancestors and recently finished children", () => {
  const snapshot = {
    nodes: [
      n("root", "done", { lastActivityAt: new Date(NOW - 5 * 3_600_000).toISOString() }),
      n("live", "working"),
      n("old", "done", { lastActivityAt: new Date(NOW - 3_600_000).toISOString() }),
      n("fresh", "done", { lastActivityAt: new Date(NOW - 60_000).toISOString() }),
    ],
    edges: [e("root", "live"), e("live", "fresh"), e("live", "old")],
  };
  const vis = selectVisible(snapshot, { scope: "live", now: NOW });
  assert.deepEqual(vis.nodes.map((x) => x.id).sort(), ["fresh", "live", "root"]);
  assert.equal(selectVisible(snapshot, { scope: "all", now: NOW }).nodes.length, 4);
});

test("parked sessions are hidden in live scope unless they host live work", () => {
  const snapshot = {
    nodes: [n("parked", "idle", { meta: { parked: true } }), n("host", "idle", { meta: { parked: true } }), n("kid", "working")],
    edges: [e("host", "kid")],
  };
  const vis = selectVisible(snapshot, { scope: "live", now: NOW });
  assert.deepEqual(vis.nodes.map((x) => x.id).sort(), ["host", "kid"]);
  assert.equal(vis.parked.get("p"), 1);
  assert.equal(selectVisible(snapshot, { scope: "live", showParked: true, now: NOW }).nodes.length, 3);
});

test("failed and input-requesting sessions remain visible in Live even when marked parked", () => {
  const nodes = [n("failed", "failed", { meta: { parked: true } }), n("waiting", "waiting", { meta: { parked: true } }), n("parked", "idle", { meta: { parked: true } })];
  const visible = selectVisible({ nodes, edges: [] }, { now: NOW });
  assert.deepEqual(visible.nodes.map((node) => node.id), ["failed", "waiting"]);
  assert.equal(visible.parked.get("p"), 1);
});

test("attention separates requests and failures from recent completed answers and terminal sessions", () => {
  const nodes = [
    n("question", "waiting", { attention: { kind: "question", reason: "Input requested" } }),
    n("approval", "waiting", { attention: { kind: "approval", reason: "Approval requested" } }),
    n("failed", "failed", { kind: "worker" }),
    n("answer", "idle", { attention: { kind: "completed", at: new Date(NOW - 2000).toISOString() } }),
    n("terminal", "done", { kind: "subagent" }),
    n("old", "done", { lastActivityAt: new Date(NOW - 600_000).toISOString() }),
    n("future", "done", { lastActivityAt: new Date(NOW + 1000).toISOString() }),
    n("placeholder", "done", { meta: { placeholder: true } }),
    n("process", "done", { kind: "process" }),
    n("idle", "idle"),
  ];
  const groups = selectAttention({ nodes }, { now: NOW });
  assert.deepEqual(groups.waiting.map((node) => node.id), ["question", "approval"]);
  assert.deepEqual(groups.failed.map((node) => node.id), ["failed"]);
  assert.deepEqual(groups.completed.map((node) => node.id), ["terminal", "answer"]);
  assert.equal(selectAttention({ nodes }, { now: NOW + 602_000 }).completed.length, 0);
});

test("attention and graph use the same search and agent filters", () => {
  const nodes = [n("a", "waiting", { title: "Fix collector", agent: "codex" }), n("b", "failed", { title: "Fix browser" }), n("c", "waiting", { title: "Fix collector" })];
  const options = { now: NOW, query: " COLLECTOR ", agents: new Set(["claude"]) };
  assert.deepEqual(selectVisible({ nodes, edges: [] }, options).nodes.map((node) => node.id), ["c"]);
  assert.deepEqual(selectAttention({ nodes }, options).waiting.map((node) => node.id), ["c"]);
  assert.deepEqual(selectAttention({ nodes }, options).failed, []);
});

test("ancestor restoration respects project, status, search and agent filters", () => {
  const filters = [
    { options: { project: "selected" }, parent: { project: "other" } },
    { options: { status: "working" }, parent: { status: "idle" } },
    { options: { query: "match" }, parent: { title: "unrelated" } },
    { options: { agents: new Set(["claude"]) }, parent: { agent: "codex" } },
  ];
  for (const { options, parent } of filters) {
    const nodes = [
      n("parent", "working", { project: "selected", title: "match", meta: { parked: true }, ...parent }),
      n("child", "working", { project: "selected", title: "match" }),
    ];
    const visible = selectVisible({ nodes, edges: [e("parent", "child")] }, { ...options, now: NOW });
    assert.deepEqual(visible.nodes.map((node) => node.id), ["child"]);
    assert.deepEqual(visible.edges, []);
    assert.equal(visible.parked.size, 0);
  }
});

test("a filtered parent stops restoration of otherwise matching distant ancestors", () => {
  const nodes = [
    n("grandparent", "done", { project: "selected" }),
    n("parent", "done", { project: "other" }),
    n("child", "working", { project: "selected" }),
  ];
  const visible = selectVisible({ nodes, edges: [e("grandparent", "parent"), e("parent", "child")] }, { project: "selected", now: NOW });
  assert.deepEqual(visible.nodes.map((node) => node.id), ["child"]);
  assert.deepEqual(visible.edges, []);
});

test("combined filters keep parked counts and Live scope limited to matching sessions", () => {
  const nodes = [
    n("active", "idle", { title: "Fix collector" }),
    n("parked", "idle", { title: "Fix collector", meta: { parked: true } }),
    n("other-project", "idle", { title: "Fix collector", project: "other", meta: { parked: true } }),
    n("other-status", "working", { title: "Fix collector", meta: { parked: true } }),
    n("other-agent", "idle", { title: "Fix collector", agent: "codex", meta: { parked: true } }),
    n("other-query", "idle", { title: "Browser task", meta: { parked: true } }),
  ];
  const snapshot = { nodes, edges: [] };
  const options = { project: "p", status: "idle", query: " COLLECTOR ", agents: new Set(["claude"]), now: NOW };
  const visible = selectVisible(snapshot, options);
  assert.deepEqual(visible.nodes.map((node) => node.id), ["active"]);
  assert.deepEqual([...visible.parked], [["p", 1]]);
  for (const scope of [{ showParked: true }, { scope: "all" }]) {
    const expanded = selectVisible(snapshot, { ...options, ...scope });
    assert.deepEqual(expanded.nodes.map((node) => node.id), ["active", "parked"]);
    assert.equal(expanded.parked.size, 0);
  }
});

test("project options inventory the full snapshot and normalize unknown project values", () => {
  const nodes = [
    n("z", "working", { project: "Zebra" }),
    n("a", "done", { project: "alpha", meta: { parked: true } }),
    n("a2", "waiting", { project: "alpha" }),
    n("missing", "working", { project: undefined }),
    n("null", "working", { project: null }),
    n("empty", "working", { project: "" }),
    n("number", "working", { project: 7 }),
  ];
  const snapshot = { nodes, edges: [] };
  assert.deepEqual(projectOptions(snapshot), [
    { value: "7", label: "7", count: 1 },
    { value: "alpha", label: "alpha", count: 2 },
    { value: "", label: "Unknown project", count: 3 },
    { value: "Zebra", label: "Zebra", count: 1 },
  ]);
  assert.deepEqual(projectOptions({ nodes: [] }), []);
  assert.deepEqual(selectVisible(snapshot, { project: "", now: NOW }).nodes.map((node) => node.id), ["missing", "null", "empty"]);
  assert.deepEqual(selectVisible(snapshot, { project: "7", now: NOW }).nodes.map((node) => node.id), ["number"]);
  assert.equal(projectOptions(snapshot).length, 4);
});

test("status filters preserve lifecycle independently of freshness and completed attention", () => {
  const nodes = [
    n("cached", "working", { meta: { dataStale: true } }),
    n("stale", "stale"),
    n("answer", "idle", { attention: { kind: "completed", at: new Date(NOW - 1000).toISOString() } }),
    n("terminal", "done"),
  ];
  const snapshot = { nodes, edges: [] };
  for (const [status, id] of [["working", "cached"], ["stale", "stale"], ["idle", "answer"], ["done", "terminal"]]) {
    assert.deepEqual(selectVisible(snapshot, { scope: "all", status, now: NOW }).nodes.map((node) => node.id), [id]);
  }
  assert.deepEqual(selectAttention(snapshot, { status: "idle", now: NOW }).completed.map((node) => node.id), ["answer"]);
  assert.deepEqual(selectAttention(snapshot, { status: "done", now: NOW }).completed.map((node) => node.id), ["terminal"]);
});

test("attention combines project and status with existing filters without depending on scope", () => {
  const nodes = [
    n("request", "waiting", { project: "selected", title: "Fix collector", meta: { parked: true } }),
    n("failure", "failed", { project: "selected", title: "Fix collector" }),
    n("other-project", "waiting", { project: "other", title: "Fix collector" }),
    n("other-agent", "waiting", { project: "selected", title: "Fix collector", agent: "codex" }),
    n("other-query", "waiting", { project: "selected", title: "Browser task" }),
  ];
  const snapshot = { nodes, edges: [] };
  const options = { project: "selected", status: "waiting", query: "collector", agents: new Set(["claude"]), now: NOW };
  assert.deepEqual(selectVisible(snapshot, options).nodes.map((node) => node.id), ["request"]);
  for (const scope of ["live", "all"]) {
    const attention = selectAttention(snapshot, { ...options, scope });
    assert.deepEqual(attention.waiting.map((node) => node.id), ["request"]);
    assert.deepEqual(attention.failed, []);
    assert.deepEqual(attention.completed, []);
  }
});

test("layout places children right of parents and packs lanes without overlap", () => {
  const nodes = [n("a", "working", { project: "one" }), n("b", "working", { project: "one" }), n("c", "waiting", { project: "two" }), n("d", "idle", { project: "three" })];
  const L = layout(nodes, [e("a", "b")], { width: 2000, height: 600 });
  assert.ok(L.pos.get("b").x > L.pos.get("a").x);
  const rects = L.lanes;
  for (const r1 of rects) {
    for (const r2 of rects) {
      if (r1 === r2) continue;
      const overlap = r1.x < r2.x + r2.width && r2.x < r1.x + r1.width && r1.y < r2.y + r2.height && r2.y < r1.y + r1.height;
      assert.equal(overlap, false, `${r1.project} overlaps ${r2.project}`);
    }
  }
  const sticky = layout(nodes, [e("a", "b")], { width: 300, height: 300 }, { order: ["three", "two", "one"], cols: L.cols });
  assert.deepEqual(sticky.order, ["three", "two", "one"]);
  assert.equal(sticky.cols, L.cols);
});

test("cycle breaking only cuts nodes on the cycle", () => {
  // tail -> a -> b -> a : tail keeps its parent
  const nodes = [n("a", "done"), n("b", "done"), n("tail", "done")];
  const parents = treeParents(nodes, [e("a", "tail"), e("b", "a"), e("a", "b")]);
  assert.equal(parents.get("tail"), "a");
});

test("completed folds hide only whole finished branches and keep their parent", () => {
  const nodes = [
    n("root", "working"), n("done", "done"),
    n("answer", "idle", { attention: { kind: "completed" } }), n("grandchild", "done"),
    ...["idle", "working", "waiting", "failed", "stale", "queued"].map((status) => n(status, status)),
  ];
  const edges = [...nodes.slice(1).filter((node) => node.id !== "grandchild").map((node) => e("root", node.id)), e("answer", "grandchild"), e("done", "working", "message")];
  const snapshot = { nodes, edges };
  const expanded = collapseCompleted(snapshot, snapshot);
  assert.deepEqual(expanded.controls.get("root"), { eligibleCount: 3, hiddenCount: 0 });
  assert.equal(expanded.nodes.length, nodes.length);
  const folded = collapseCompleted(snapshot, snapshot, new Set(["root"]));
  assert.deepEqual(folded.nodes.map((node) => node.id), ["root", "idle", "working", "waiting", "failed", "stale", "queued"]);
  assert.deepEqual(folded.controls.get("root"), { eligibleCount: 3, hiddenCount: 3 });
  assert.deepEqual([...folded.hiddenBy.keys()].sort(), ["answer", "done", "grandchild"]);
  assert.ok(folded.edges.every((edge) => edge.from === "root" && !["done", "answer", "grandchild"].includes(edge.to)));
});

test("freshness, questions, LIVE access and placeholder nodes prevent completed folds", () => {
  const protectedNodes = [
    n("cached", "done", { meta: { dataStale: true } }),
    n("question", "done", { attention: { kind: "question" } }),
    n("approval", "done", { attention: { kind: "approval" } }),
    n("browser", "done", { liveView: { available: true } }),
    n("process", "done", { kind: "process" }),
    n("placeholder", "done", { meta: { placeholder: true } }),
  ];
  const nodes = [n("root", "working"), ...protectedNodes.flatMap((node) => [n(`${node.id}-branch`, "done"), node])];
  const edges = protectedNodes.flatMap((node) => [e("root", `${node.id}-branch`), e(`${node.id}-branch`, node.id)]);
  const snapshot = { nodes, edges };
  const folded = collapseCompleted(snapshot, snapshot, new Set(nodes.map((node) => node.id)));
  assert.deepEqual(folded.nodes, nodes);
  assert.equal(folded.controls.size, 0);
  assert.equal(folded.hiddenBy.size, 0);
});

test("filtered-out unfinished descendants still prevent their full branch from collapsing", () => {
  const snapshot = {
    nodes: [n("root", "working"), n("branch", "done"), n("hidden-work", "working", { project: "other" })],
    edges: [e("root", "branch"), e("branch", "hidden-work")],
  };
  const visible = selectVisible(snapshot, { scope: "all", project: "p" });
  assert.deepEqual(visible.nodes.map((node) => node.id), ["root", "branch"]);
  const folded = collapseCompleted(snapshot, visible, new Set(["root"]));
  assert.deepEqual(folded.nodes, visible.nodes);
  assert.equal(folded.controls.size, 0);
});

test("a changed effective parent cannot hide active work or its filtered-out descendants", () => {
  for (const movedStatus of ["working", "done"]) {
    const snapshot = {
      nodes: [n("root", "working"), n("branch", "done"), n("preferred", "working", { project: "other" }), n("moved", movedStatus), n("hidden-failure", "failed", { project: "other" })],
      edges: [e("root", "branch"), e("preferred", "moved"), e("branch", "moved", "process"), e("moved", "hidden-failure")],
    };
    const visible = selectVisible(snapshot, { scope: "all", project: "p" });
    assert.equal(treeParents(snapshot.nodes, snapshot.edges).get("moved"), "preferred");
    assert.equal(treeParents(visible.nodes, visible.edges).get("moved"), "branch");
    const folded = collapseCompleted(snapshot, visible, new Set(["root", "branch"]));
    assert.deepEqual(folded.nodes, visible.nodes);
    assert.equal(folded.controls.size, 0);
  }
});

test("nested folds count each hidden node once and record every ancestor needed to reveal it", () => {
  const snapshot = {
    nodes: [n("root", "working"), n("a", "done"), n("b", "done"), n("c", "done")],
    edges: [e("root", "a"), e("a", "b"), e("b", "c")],
  };
  const collapsed = new Set(["root", "a", "b"]);
  const folded = collapseCompleted(snapshot, snapshot, collapsed);
  assert.deepEqual(folded.nodes.map((node) => node.id), ["root"]);
  assert.deepEqual([...folded.controls], [
    ["root", { eligibleCount: 3, hiddenCount: 3 }],
    ["a", { eligibleCount: 2, hiddenCount: 0 }],
    ["b", { eligibleCount: 1, hiddenCount: 0 }],
  ]);
  assert.equal([...folded.controls.values()].reduce((sum, control) => sum + control.hiddenCount, 0), folded.hiddenBy.size);
  assert.deepEqual(folded.hiddenBy.get("a"), ["root"]);
  assert.deepEqual(folded.hiddenBy.get("c"), ["root", "a", "b"]);
  for (const id of folded.hiddenBy.get("c")) collapsed.delete(id);
  const revealed = collapseCompleted(snapshot, snapshot, collapsed);
  assert.deepEqual(revealed.nodes, snapshot.nodes);
  assert.equal(revealed.hiddenBy.size, 0);
  const partiallyExpanded = collapseCompleted(snapshot, snapshot, new Set(["a", "b"]));
  assert.deepEqual(partiallyExpanded.nodes.map((node) => node.id), ["root", "a"]);
  assert.deepEqual(partiallyExpanded.controls.get("a"), { eligibleCount: 2, hiddenCount: 2 });
});

test("fold preferences do not conceal resumed, failed, waiting, stale or newly LIVE descendants", () => {
  const completed = n("child", "idle", { attention: { kind: "completed" } });
  const original = { nodes: [n("root", "working"), n("branch", "done"), completed], edges: [e("root", "branch"), e("branch", "child")] };
  const collapsed = new Set(["root", "branch"]);
  assert.equal(collapseCompleted(original, original, collapsed).hiddenBy.size, 2);
  const transitions = [
    { status: "working" }, { status: "failed" }, { status: "waiting", attention: { kind: "question" } },
    { status: "queued" }, { status: "stale" }, { status: "idle", attention: null },
    { meta: { dataStale: true } }, { liveView: { available: true } },
  ];
  for (const change of transitions) {
    const snapshot = { ...original, nodes: [...original.nodes.slice(0, 2), { ...completed, ...change }] };
    const folded = collapseCompleted(snapshot, snapshot, collapsed);
    assert.deepEqual(folded.nodes, snapshot.nodes);
    assert.equal(folded.hiddenBy.size, 0);
  }
});

test("fold counts include only matching visible descendants and leave unrelated roots intact", () => {
  const snapshot = {
    nodes: [n("root", "working"), n("a", "done"), n("b", "done"), n("filtered", "done", { project: "other" }), n("other-root", "done")],
    edges: [e("root", "a"), e("a", "b"), e("a", "filtered")],
  };
  const visible = selectVisible(snapshot, { scope: "all", project: "p" });
  const folded = collapseCompleted(snapshot, visible, new Set(["root", "other-root", "missing"]));
  assert.deepEqual(folded.nodes.map((node) => node.id), ["root", "other-root"]);
  assert.deepEqual(folded.controls.get("root"), { eligibleCount: 2, hiddenCount: 2 });
  assert.equal(folded.hiddenBy.size, 2);
  assert.equal(folded.controls.has("other-root"), false);
});

test("fold projection tolerates cycles and dangling edges without mutating its inputs", () => {
  const nodes = [n("a", "done"), n("b", "done"), n("tail", "done")];
  const edges = [e("a", "tail"), e("b", "a"), e("a", "b"), e("a", "a"), e("missing", "tail")];
  const snapshot = structuredClone({ nodes, edges });
  const collapsed = new Set(nodes.map((node) => node.id));
  for (const node of nodes) { Object.freeze(node.meta); Object.freeze(node); }
  edges.forEach(Object.freeze);
  const visible = Object.freeze({ nodes: Object.freeze(nodes), edges: Object.freeze(edges) });
  const folded = collapseCompleted(snapshot, visible, collapsed);
  assert.equal(folded.nodes.length, 1);
  assert.equal(folded.hiddenBy.size, 2);
  assert.deepEqual(snapshot, { nodes, edges });
  assert.deepEqual([...collapsed], ["a", "b", "tail"]);
  assert.ok(folded.edges.every((edge) => folded.nodes.some((node) => node.id === edge.from) && folded.nodes.some((node) => node.id === edge.to)));
  assert.deepEqual(collapseCompleted({ nodes: [], edges: [] }, { nodes: [], edges: [] }), { nodes: [], edges: [], controls: new Map(), hiddenBy: new Map() });
});
