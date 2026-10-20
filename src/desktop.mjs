import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { install as installService } from "./service.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const bundleId = "local.agent-fleet.desktop";
const label = "local.agent-fleet.app";
const domain = () => `gui/${userInfo().uid}`;
const appPath = () => join(homedir(), "Applications", "Agent Fleet.app");
const shortcut = () => join(homedir(), "Desktop", "Agent Fleet.app");
const agentPath = () => join(homedir(), "Library", "LaunchAgents", label + ".plist");
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
const plist = (body) => `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${body}</dict></plist>`;
const exists = async (path) => Boolean(await lstat(path).catch((e) => { if (e.code === "ENOENT") return null; throw e; }));

async function verifyApp(path) {
  const { stdout } = await exec("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(path, "Contents", "Info.plist")]);
  if (stdout.trim() !== bundleId) throw new Error("An unrelated application already uses the Agent Fleet app path");
}

export async function installApp(config) {
  if (process.platform !== "darwin") throw new Error("The desktop app installer requires macOS and the Xcode Swift tools");
  const destination = appPath();
  if (await exists(destination)) await verifyApp(destination);
  if (await exists(shortcut()) && (!((await lstat(shortcut())).isSymbolicLink()) || await readlink(shortcut()) !== destination)) throw new Error("An unrelated Desktop item already uses the Agent Fleet name");
  await mkdir(join(homedir(), "Applications"), { recursive: true });
  const build = await mkdtemp(join(homedir(), "Applications", ".agent-fleet-build-"));
  const bundle = join(build, "Agent Fleet.app"), contents = join(bundle, "Contents");
  let backup = false;
  try {
    await mkdir(join(contents, "MacOS"), { recursive: true });
    await mkdir(join(contents, "Resources"), { recursive: true });
    const host = config.host === "::1" ? "[::1]" : config.host;
    const url = `http://${host}:${config.port}/`;
    await writeFile(join(contents, "Info.plist"), plist(`
      <key>CFBundleIdentifier</key><string>${bundleId}</string>
      <key>CFBundleName</key><string>Agent Fleet</string><key>CFBundleDisplayName</key><string>Agent Fleet</string>
      <key>CFBundleExecutable</key><string>AgentFleet</string><key>CFBundlePackageType</key><string>APPL</string>
      <key>CFBundleShortVersionString</key><string>0.10.0</string><key>CFBundleVersion</key><string>11</string>
      <key>CFBundleIconFile</key><string>AgentFleet</string><key>NSHighResolutionCapable</key><true/>
      <key>LSMinimumSystemVersion</key><string>13.0</string><key>NSPrincipalClass</key><string>NSApplication</string>
      <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
      <key>AgentFleetURL</key><string>${escape(url)}</string>
      <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>`));
    console.log("Building the Agent Fleet Mac app…");
    await exec("xcrun", ["swiftc", "-swift-version", "5", "-O", "-framework", "AppKit", "-framework", "WebKit", "-module-cache-path", join(build, "modules"), join(root, "desktop", "AgentFleet.swift"), "-o", join(contents, "MacOS", "AgentFleet")], { timeout: 180_000, maxBuffer: 1024 * 1024 });
    const icons = join(build, "AgentFleet.iconset");
    await exec("xcrun", ["swift", "-module-cache-path", join(build, "modules"), join(root, "desktop", "Icon.swift"), icons], { timeout: 120_000, maxBuffer: 1024 * 1024 });
    await exec("iconutil", ["-c", "icns", icons, "-o", join(contents, "Resources", "AgentFleet.icns")]);
    await exec("plutil", ["-lint", join(contents, "Info.plist")]);
    await exec("codesign", ["--force", "--sign", "-", "--identifier", bundleId, bundle]);
    await exec("codesign", ["--verify", "--deep", "--strict", bundle]);
    if (await exists(destination)) { await rename(destination, join(build, "previous.app")); backup = true; }
    try { await rename(bundle, destination); }
    catch (error) { if (backup) { await rename(join(build, "previous.app"), destination); backup = false; } throw error; }
    if (!await exists(shortcut())) { await mkdir(join(homedir(), "Desktop"), { recursive: true }); await symlink(destination, shortcut()); }
    const serviceFile = join(homedir(), "Library", "LaunchAgents", "local.agent-fleet.plist");
    if (!await exists(serviceFile)) await installService(config);
    await exec("launchctl", ["enable", `${domain()}/local.agent-fleet`]);
    await exec("launchctl", ["kickstart", `${domain()}/local.agent-fleet`]).catch(async () => { await exec("launchctl", ["bootstrap", domain(), serviceFile]); });
    await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    await writeFile(agentPath(), plist(`
      <key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/usr/bin/open</string><string>${escape(destination)}</string></array>
      <key>RunAtLoad</key><true/><key>LimitLoadToSessionType</key><string>Aqua</string><key>ThrottleInterval</key><integer>30</integer>`));
    await exec("plutil", ["-lint", agentPath()]);
    await exec("launchctl", ["bootout", `${domain()}/${label}`]).catch(() => {});
    await exec("launchctl", ["enable", `${domain()}/${label}`]);
    await exec("launchctl", ["bootstrap", domain(), agentPath()]);
    console.log(`App installed: ${destination}\nDesktop shortcut: ${shortcut()}\nThe background service and app window start at login. Quitting the app leaves the service running.`);
  } finally { await rm(build, { recursive: true, force: true }); }
}

export async function uninstallApp() {
  const destination = appPath();
  if (await exists(destination)) await verifyApp(destination);
  const executable = join(destination, "Contents", "MacOS", "AgentFleet");
  const { stdout: processes } = await exec("ps", ["-axo", "args="], { maxBuffer: 8 * 1024 * 1024 });
  if (processes.split("\n").some((line) => line.trim() === executable || line.trim().startsWith(executable + " "))) throw new Error("Quit Agent Fleet with Command-Q before uninstalling its app");
  await exec("launchctl", ["bootout", `${domain()}/${label}`]).catch(() => {});
  await rm(agentPath(), { force: true });
  if (await exists(shortcut()) && (await lstat(shortcut())).isSymbolicLink() && await readlink(shortcut()) === destination) await rm(shortcut());
  await rm(destination, { recursive: true, force: true });
  console.log("Agent Fleet app, Desktop shortcut and app login item removed. Background service remains installed.");
}
