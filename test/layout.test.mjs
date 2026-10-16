import assert from "node:assert/strict";
import { test } from "node:test";
import { layout, selectVisible, treeParents } from "../ui/layout.js";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const n = (id, status, extra = {}) => ({ id, agent: "claude", kind: "session", status, project: "p", lastActivityAt: new Date(NOW - 1000).toISOString(), meta: {}, ...extra });
const e = (from, to, kind = "spawn") => ({ id: `${kind}:${from}->${to}`, from, to, kind, count: 1 });

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
