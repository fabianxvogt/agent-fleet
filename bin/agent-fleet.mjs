#!/usr/bin/env node
import { loadAdapters } from "../src/adapters/index.mjs";
import { createCollector } from "../src/collector.mjs";
import { loadConfig } from "../src/config.mjs";

const USAGE = `agent-fleet — live dashboard of coding-agent sessions on this machine

Usage:
  agent-fleet serve               run collector + dashboard on http://127.0.0.1:7420
  agent-fleet snapshot [--json]   collect once and print a summary (or the full graph)
  agent-fleet install-service     install and start the macOS LaunchAgent (runs at login)
  agent-fleet uninstall-service   stop and remove the LaunchAgent
  agent-fleet service-status      show LaunchAgent state
  agent-fleet browser help        terminal browser with a live inspector view

Config: ~/.agent-fleet/config.json   Custom adapters: ~/.agent-fleet/adapters/*.mjs`;

const [cmd, ...rest] = process.argv.slice(2);
const config = await loadConfig();

switch (cmd) {
  case "browser": {
    const { browserCli } = await import("../src/browser/cli.mjs");
    try { await browserCli(config, rest); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
    break;
  }
  case "serve": {
    const { serve } = await import("../src/server.mjs");
    await serve(config, await loadAdapters(config));
    break;
  }
  case "snapshot": {
    const collector = createCollector(config, await loadAdapters(config));
    const snap = await collector.collectOnce();
    if (rest.includes("--json")) console.log(JSON.stringify(snap, null, 2));
    else printSummary(snap);
    break;
  }
  case "install-service":
  case "uninstall-service":
  case "service-status": {
    const service = await import("../src/service.mjs");
    await service[{ "install-service": "install", "uninstall-service": "uninstall", "service-status": "status" }[cmd]](config);
    break;
  }
  default:
    console.log(USAGE);
    process.exitCode = cmd && cmd !== "help" && cmd !== "--help" ? 1 : 0;
}

function printSummary(snap) {
  console.log(`collected in ${snap.collectMs} ms · ${snap.nodes.length} nodes · ${snap.edges.length} edges · live ${snap.live}`);
  for (const a of snap.adapters) console.log(`  ${a.id.padEnd(8)} ${String(a.nodes).padStart(4)} nodes ${String(a.ms).padStart(5)} ms${a.error ? `  ERROR ${a.error.split("\n")[0]}` : ""}`);
  console.log("  status:", JSON.stringify(snap.counts));
  const kinds = {};
  for (const e of snap.edges) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  console.log("  edges:", JSON.stringify(kinds));
}
