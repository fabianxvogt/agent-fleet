import { homedir } from "node:os";
import { join } from "node:path";
import { readJson } from "./util.mjs";

export const CONFIG_DIR = join(homedir(), ".agent-fleet");

export const DEFAULTS = {
  host: "127.0.0.1", // never bind beyond loopback; the dashboard shows session titles and paths
  port: 7420,
  intervalMs: 4000,
  adapterTimeoutMs: 8000,
  processTimeoutMs: 10_000,
  retainStaleMs: 120_000,
  windowHours: 12, // ended sessions stay visible this long
  parkAfterMinutes: 120, // quiet sessions are parked; explicit unresolved requests stay visible
  fleetRoots: [join(homedir(), "Development")],
  fleetScanDepth: 3,
  agentsviewUrl: "http://127.0.0.1:8080",
  adapterDir: join(CONFIG_DIR, "adapters"),
  disabledAdapters: [],
  autoDiscoverBrowsers: true,
};

export async function loadConfig(overrides = {}) {
  const file = (await readJson(join(CONFIG_DIR, "config.json"))) ?? {};
  const env = process.env.AGENT_FLEET_PORT ? { port: Number(process.env.AGENT_FLEET_PORT) } : {};
  const config = { ...DEFAULTS, ...file, ...env, ...overrides, home: overrides.home ?? homedir() };
  if (!["127.0.0.1", "::1", "localhost"].includes(config.host)) throw new Error(`refusing to bind non-loopback host ${config.host}`);
  return config;
}
