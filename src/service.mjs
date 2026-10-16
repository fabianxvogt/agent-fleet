import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CONFIG_DIR } from "./config.mjs";

const run = promisify(execFile);
const LABEL = "local.agent-fleet";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG = join(CONFIG_DIR, "logs", "agent-fleet.log");
const BIN = fileURLToPath(new URL("../bin/agent-fleet.mjs", import.meta.url));
const domain = () => `gui/${userInfo().uid}`;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

function plist() {
  // ps and lsof live in /bin and /usr/sbin; launchd starts agents with a minimal PATH.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(process.execPath)}</string>
    <string>${esc(BIN)}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>Nice</key><integer>5</integer>
  <key>StandardOutPath</key><string>${esc(LOG)}</string>
  <key>StandardErrorPath</key><string>${esc(LOG)}</string>
</dict>
</plist>
`;
}

async function launchctl(...args) {
  try {
    return (await run("launchctl", args)).stdout;
  } catch (error) {
    return { error: error.stderr?.trim() || String(error) };
  }
}

async function health(config) {
  try {
    const r = await fetch(`http://127.0.0.1:${config.port}/api/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

export async function install(config) {
  await mkdir(join(CONFIG_DIR, "logs"), { recursive: true });
  await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  await writeFile(PLIST, plist());
  await launchctl("bootout", `${domain()}/${LABEL}`); // replace a previous install
  const res = await launchctl("bootstrap", domain(), PLIST);
  if (res?.error) throw new Error(`launchctl bootstrap failed: ${res.error}`);
  for (let i = 0; i < 40; i++) {
    const h = await health(config);
    if (h?.ok) {
      console.log(`agent-fleet service running → http://127.0.0.1:${config.port}  (log: ${LOG})`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`service installed, but the dashboard did not answer yet; check ${LOG}`);
}

export async function uninstall() {
  await launchctl("bootout", `${domain()}/${LABEL}`);
  await rm(PLIST, { force: true });
  console.log("agent-fleet service removed");
}

export async function status(config) {
  const out = await launchctl("print", `${domain()}/${LABEL}`);
  if (typeof out !== "string") {
    console.log("service: not installed");
    return;
  }
  const state = out.match(/^\s*state = (.*)$/m)?.[1] ?? "unknown";
  const pid = out.match(/^\s*pid = (\d+)/m)?.[1] ?? "-";
  const h = await health(config);
  console.log(`service: ${state} (pid ${pid}) · dashboard ${h?.ok ? `ok, last collect ${h.collectMs} ms` : "not answering"} · plist ${PLIST}`);
}
