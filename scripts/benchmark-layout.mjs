#!/usr/bin/env node
// Synthetic only: no session files or running agents are read.
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import * as current from "../ui/layout.js";

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--baseline" || !/^[\w./-]+$/.test(args[1]) || args[1].startsWith("-"))) {
  console.error("Usage: node scripts/benchmark-layout.mjs [--baseline <git-ref>]");
  process.exit(1);
}
const versions = [["current", current]];
if (args.length) {
  // Historical layout.js is a self-contained module; do not modify the checkout.
  const source = execFileSync("git", ["show", `${args[1]}:ui/layout.js`], { cwd: new URL("../", import.meta.url), encoding: "utf8", maxBuffer: 1024 * 1024 });
  versions.unshift([args[1], await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)]);
}

const now = Date.parse("2026-10-20T12:00:00Z");
function fixture(count, shape, finished = false) {
  return {
    nodes: Array.from({ length: count }, (_, i) => ({
      id: `synthetic:${i}`, project: "Synthetic benchmark", agent: "codex", kind: "session",
      status: finished ? "done" : "working", lastActivityAt: new Date(now).toISOString(),
    })),
    edges: Array.from({ length: count - 1 }, (_, i) => ({
      from: `synthetic:${shape === "chain" ? i : Math.floor(i / 4)}`, to: `synthetic:${i + 1}`, kind: "spawn",
    })),
  };
}
function measure(work) {
  const start = performance.now();
  try {
    work();
    return { ms: +(performance.now() - start).toFixed(2) };
  }
  catch (error) { return { error: error.message }; }
}

const cases = [
  ["balanced-1000", fixture(1000, "balanced"), new Set()],
  ["balanced-3000", fixture(3000, "balanced"), new Set()],
  ["chain-3000", fixture(3000, "chain"), new Set()],
  ["folded-chain-3000", fixture(3000, "chain", true), new Set(Array.from({ length: 3000 }, (_, i) => `synthetic:${i}`))],
];
console.log(JSON.stringify({ node: process.version, samples: 3, viewport: { width: 1440, height: 900 }, note: "Pure computation only; browser painting and I/O are excluded." }));
for (const [name, snapshot, collapsed] of cases) {
  // Interleave versions to reduce bias from warm-up and changing host load.
  for (let sample = 0; sample < 3; sample++) for (const [version, module] of sample % 2 ? [...versions].reverse() : versions) {
    const selection = measure(() => module.selectVisible(snapshot, { scope: "all", now }));
    const projection = measure(() => module.collapseCompleted(snapshot, snapshot, collapsed));
    const layout = measure(() => module.layout(snapshot.nodes, snapshot.edges, { width: 1440, height: 900 }));
    console.log(JSON.stringify({ version, fixture: name, sample: sample + 1, selection, projection, layout }));
  }
}
