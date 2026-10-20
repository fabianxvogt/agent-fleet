import assert from "node:assert/strict";
import { test } from "node:test";
import { CARD_H, CARD_W, layout } from "../ui/layout.js";
import { createGraphScene, projectGraphScene } from "../ui/graph-scene.js";

const node = (id) => ({ id, status: "working", project: "synthetic" });
const edge = (from, to, extra = {}) => ({ id: `${from}->${to}`, from, to, kind: "message", count: 1, ...extra });
const geometry = (positions, extra = {}) => ({ pos: new Map(Object.entries(positions)), parent: new Map(), lanes: [], ...extra });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test("a 3,000-level scene preserves every semantic node at whole-graph fit", () => {
  const nodes = Array.from({ length: 3000 }, (_, i) => node(`n${i}`));
  const edges = nodes.slice(1).map((n, i) => edge(`n${i}`, n.id, { kind: "spawn" }));
  const scene = createGraphScene(nodes, edges, layout(nodes, edges));
  const viewport = { width: 1200, height: 800 };
  const k = Math.min(viewport.width / scene.bounds.width, viewport.height / scene.bounds.height);
  const projected = projectGraphScene(scene, { x: -scene.bounds.x * k, y: -scene.bounds.y * k, k }, viewport);
  assert.equal(scene.nodes, nodes);
  assert.equal(projected.nodes.length, 3000);
  assert.equal(projected.edges.length, 2999);
  assert.equal(projected.detail, false);

  const center = scene.pos.get("n1500");
  const readable = projectGraphScene(scene, { x: 500 - center.x, y: 350 - center.y, k: 1 }, viewport);
  assert.ok(readable.nodes.some((n) => n.id === "n1500"));
  assert.ok(readable.nodes.length < 10, `${readable.nodes.length} readable cards`);
  assert.ok(readable.edges.length < 12, `${readable.edges.length} readable edges`);
  assert.equal(readable.detail, true);
});

test("full bounds include lanes and cards and stay invariant during projection", () => {
  const lanes = [{ project: "p", x: -50, y: -10, width: 100, height: 40 }];
  const L = geometry({ a: { x: 100, y: 100 } }, { lanes });
  const scene = createGraphScene([node("a")], [], L);
  assert.deepEqual(scene.bounds, { x: -50, y: -10, width: 390, height: 164 });
  assert.equal(scene.lanes, lanes);
  assert.equal(scene.pos, L.pos);
  const bounds = { ...scene.bounds };
  for (const x of [-1e6, 0, 1e6]) {
    projectGraphScene(scene, { x, y: x / 2, k: 0.7 }, { width: 700, height: 500 });
    assert.deepEqual(scene.bounds, bounds);
  }
});

test("same-column relations keep existing curves and exact extrema with count badges", () => {
  const nodes = [node("a"), node("b")];
  const L = geometry({ a: { x: 0, y: 0 }, b: { x: 0, y: 300 } });
  const plain = createGraphScene(nodes, [edge("a", "b")], L).edges[0];
  assert.equal(plain.path, "M240 27 C361 27 361 327 240 327");
  assert.deepEqual(plain.mid, { x: 330.75, y: 177 });
  assert.deepEqual(plain.bounds, { x: 240, y: 27, width: 90.75, height: 300 });
  assert.equal(plain.isTree, false);
  const counted = createGraphScene(nodes, [edge("a", "b", { count: 8, inferred: true })], L);
  assert.deepEqual(counted.edges[0].bounds, { x: 240, y: 27, width: 103.75, height: 300 });
  assert.equal(counted.edges[0].inferred, true);
  assert.deepEqual(counted.bounds, { x: 0, y: 0, width: 343.75, height: 354 });
});

test("a backwards tree curve includes actual cubic overshoot instead of control-point bounds", () => {
  const L = geometry({ a: { x: 200, y: 0 }, b: { x: 0, y: 0 } }, { parent: new Map([["b", "a"]]) });
  const scene = createGraphScene([node("a"), node("b")], [edge("a", "b", { kind: "spawn" })], L);
  const relation = scene.edges[0];
  assert.equal(relation.path, "M440 27 C470 27 -30 27 0 27");
  assert.deepEqual(relation.mid, { x: 220, y: 27 });
  assert.equal(relation.isTree, true);
  // Solve x'(t) = 3(1060t² - 1060t + 30) at its first extremum.
  const t = (1 - Math.sqrt(47 / 53)) / 2;
  const peak = 440 + 90 * t - 1590 * t * t + 1060 * t * t * t;
  near(relation.bounds.x, 440 - peak);
  near(relation.bounds.width, 2 * peak - 440);
  assert.ok(relation.bounds.x < 0);
  assert.ok(relation.bounds.x > -30);
  near(scene.bounds.x, relation.bounds.x);
  near(scene.bounds.width, relation.bounds.width);
});

test("left-going relations and short forward links retain their existing paths and midpoints", () => {
  const L = geometry({ a: { x: 500, y: 100 }, b: { x: 0, y: 300 }, c: { x: 520, y: 300 } });
  const scene = createGraphScene([node("a"), node("b"), node("c")], [edge("a", "b"), edge("a", "c")], L);
  assert.equal(scene.edges[0].path, "M500 127 C370 127 370 327 240 327");
  assert.deepEqual(scene.edges[0].mid, { x: 370, y: 227 });
  assert.equal(scene.edges[1].path, "M740 127 C770 127 490 327 520 327");
  assert.deepEqual(scene.edges[1].mid, { x: 630, y: 227 });
});

test("horizontal count badges contribute their full height to relation visibility", () => {
  const L = geometry({ a: { x: -1000, y: 80 }, b: { x: 1000, y: 80 } });
  const scene = createGraphScene([node("a"), node("b")], [edge("a", "b", { count: 2 })], L);
  assert.equal(scene.edges[0].bounds.y, 99);
  assert.equal(scene.edges[0].bounds.height, 16);
  // The curve is below this viewport plus overscan; its badge reaches inside.
  assert.equal(projectGraphScene(scene, { x: 0, y: 0, k: 2 }, { width: 200, height: 96 }).edges.length, 0);
  assert.equal(projectGraphScene(scene, { x: 0, y: 0, k: 1 }, { width: 200, height: 1 }).edges.length, 1);
});

test("relations crossing the viewport survive even when both endpoint cards are offscreen", () => {
  const L = geometry({ a: { x: -1000, y: 0 }, b: { x: 1000, y: 0 } });
  const scene = createGraphScene([node("a"), node("b")], [edge("a", "b")], L);
  const projected = projectGraphScene(scene, { x: 0, y: 0, k: 1 }, { width: 100, height: 100 });
  assert.deepEqual(projected.nodes, []);
  assert.equal(projected.edges.length, 1);
  assert.equal(projected.edges[0], scene.edges[0]);
});

test("missing endpoints or positions do not create ghost relations", () => {
  const L = geometry({ a: { x: 0, y: 0 }, ghost: { x: 300, y: 0 } });
  const scene = createGraphScene([node("a"), node("b")], [edge("a", "missing"), edge("ghost", "a"), edge("a", "b")], L);
  assert.deepEqual(scene.edges, []);
  assert.deepEqual(scene.bounds, { x: 0, y: 0, width: CARD_W, height: CARD_H });
  assert.deepEqual(projectGraphScene(scene, { x: 0, y: 0, k: 1 }, { width: 100, height: 100 }).nodes.map((n) => n.id), ["a"]);
});

test("projection retains pinned offscreen cards and applies 100 screen pixels of overscan", () => {
  const nodes = [node("visible"), node("border"), node("outside"), node("focused")];
  const scene = createGraphScene(nodes, [], geometry({
    visible: { x: 0, y: 0 }, border: { x: 150, y: 0 },
    outside: { x: 151, y: 0 }, focused: { x: 10000, y: 0 },
  }));
  const projected = projectGraphScene(scene, { x: 0, y: 0, k: 2 }, { width: 200, height: 100 }, new Set(["focused", "missing"]));
  assert.deepEqual(projected.nodes.map((n) => n.id), ["visible", "border", "focused"]);
});

test("projection culls offscreen lanes without changing their full scene inventory", () => {
  const lanes = [
    { project: "near", x: 0, y: 0, width: 300, height: 200 },
    { project: "far", x: 10000, y: 0, width: 300, height: 200 },
  ];
  const scene = createGraphScene([], [], geometry({}, { lanes }));
  const projected = projectGraphScene(scene, { x: 0, y: 0, k: 1 }, { width: 800, height: 600 });
  assert.deepEqual(projected.lanes, [lanes[0]]);
  assert.equal(scene.lanes.length, 2);
  assert.equal(scene.bounds.width, 10300);
});

test("detail threshold is inclusive and projection leaves source geometry untouched", () => {
  const nodes = Object.freeze([Object.freeze(node("a")), Object.freeze(node("b"))]);
  const edges = Object.freeze([Object.freeze(edge("a", "b", { count: 2 }))]);
  const L = geometry({ a: Object.freeze({ x: 0, y: 0 }), b: Object.freeze({ x: 300, y: 0 }) });
  Object.freeze(L.lanes);
  const scene = createGraphScene(nodes, edges, Object.freeze(L));
  for (const [k, detail] of [[0.449999, false], [0.45, true], [1, true]]) {
    assert.equal(projectGraphScene(scene, { x: 0, y: 0, k }, { width: 1000, height: 1000 }).detail, detail);
  }
  assert.equal("bounds" in edges[0], false);
  assert.equal("path" in edges[0], false);
  assert.equal(L.pos.get("a").x, 0);
  assert.deepEqual(createGraphScene([], [], geometry({})).bounds, { x: 0, y: 0, width: 0, height: 0 });
});
