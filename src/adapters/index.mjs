import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClaudeAdapter } from "./claude.mjs";
import { createCodexAdapter } from "./codex.mjs";
import { createFleetAdapter } from "./fleet.mjs";
import { createOmpAdapter } from "./omp.mjs";
import { createPiAdapter } from "./pi.mjs";

/**
 * Adapter contract (see docs/ADAPTERS.md):
 *   export default function create() { return { id, label, async collect(ctx) { return { nodes, edges } } } }
 * Built-ins below; extra adapters are loaded from config.adapterDir (default ~/.agent-fleet/adapters/*.mjs).
 */
export const BUILTIN_ADAPTERS = [createClaudeAdapter, createCodexAdapter, createOmpAdapter, createPiAdapter, createFleetAdapter];

export async function loadAdapters(config) {
  const adapters = BUILTIN_ADAPTERS.map((create) => create());
  let files = [];
  try {
    files = (await readdir(config.adapterDir)).filter((f) => f.endsWith(".mjs")).sort();
  } catch {
    // no custom adapters
  }
  for (const f of files) {
    const mod = await import(pathToFileURL(join(config.adapterDir, f)).href);
    const create = mod.default ?? mod.createAdapter;
    if (typeof create !== "function") throw new Error(`${f}: adapter module must export a default factory`);
    adapters.push(create());
  }
  const disabled = new Set(config.disabledAdapters);
  return adapters.filter((a) => !disabled.has(a.id));
}
