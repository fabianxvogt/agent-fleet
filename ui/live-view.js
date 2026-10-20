import { createBrowserView } from "./browser-view.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const timestamp = (at) => Number.isFinite(Date.parse(at)) ? Date.parse(at) : null;
const clock = (at) => timestamp(at) === null ? "Time unavailable" : new Date(at).toLocaleString([], { dateStyle: "short", timeStyle: "medium" });
const eventTime = (entry) => entry.resultAt ?? entry.at;
const ended = (context) => ["done", "failed", "waiting", "idle", "stale"].includes(context.session?.status);

/** Choose recorded evidence, never infer a running command from output prose. */
export function liveActivity(context = {}, now = Date.now()) {
  const { activity, session = {}, error, loading } = context;
  if (context.localState === "restricted" || context.archiveState === "restricted") {
    return { kind: "restricted", label: "Activity unavailable for this private context", detail: "Session content is not displayed.", at: null, stale: true };
  }
  const entries = [...(context.entries ?? [])].map((entry, index) => ({ entry, index }))
    .sort((a, b) => (timestamp(eventTime(a.entry)) ?? 0) - (timestamp(eventTime(b.entry)) ?? 0) || a.index - b.index)
    .map(({ entry }) => entry);
  // A newer observation of the same process supersedes its earlier running state.
  const processes = new Map();
  for (const entry of entries) if (entry.terminal) processes.set(entry.terminal.sessionId ?? entry.id, entry);
  const turnEnded = ["Turn finished", "Turn stopped", "Session reported an error"].includes(activity?.label);
  const active = context.localState === "available" && !ended(context) && !error && !session.stale && !turnEnded
    ? entries.findLast((entry) => {
      const at = timestamp(eventTime(entry));
      return entry.terminal && entry.origin !== "archive" && processes.get(entry.terminal.sessionId ?? entry.id) === entry
        && ["pending", "running"].includes(entry.terminal.state) && at !== null && now - at >= 0 && now - at <= 120_000;
    }) : null;
  const latest = entries.at(-1);
  const newerActivity = activity && timestamp(activity.at) !== null && (timestamp(activity.at) > (timestamp(latest && eventTime(latest)) ?? 0));
  const chosen = active ?? (!newerActivity ? latest : null);
  const at = chosen ? eventTime(chosen) : activity?.at ?? session.lastActivityAt ?? null;
  const ms = timestamp(at);
  const stale = Boolean(error || session.stale || chosen?.origin === "local" && context.localState !== "available" || ms === null || now - ms > 120_000);
  if (chosen?.terminal) {
    const terminal = chosen.terminal;
    const failed = chosen.status === "failed" || Number.isInteger(terminal.exitCode) && terminal.exitCode !== 0;
    const label = failed ? "Command failed"
      : active === chosen && terminal.state === "running" ? "Running when last observed"
      : active === chosen && terminal.state === "pending" ? "Command observed · waiting for output"
      : terminal.state === "exited" ? `Command finished${Number.isInteger(terminal.exitCode) ? ` · exit ${terminal.exitCode}` : ""}`
      : "Last observed terminal activity";
    return { kind: "terminal", label, at, stale, command: terminal.command, cwd: terminal.cwd, output: chosen.text, entryId: chosen.id };
  }
  if (newerActivity || !chosen && activity) return { kind: "activity", label: activity.label, detail: activity.detail, at, stale };
  if (chosen?.kind === "tool") return {
    kind: "tool", label: `${chosen.name || "Tool"}${chosen.status === "failed" ? " failed" : chosen.text === null ? " · call observed" : " · result observed"}`,
    detail: chosen.input, output: chosen.text, at, stale, entryId: chosen.id,
  };
  if (chosen?.kind === "message") return {
    kind: "activity", label: chosen.role === "assistant" ? "Latest agent response" : "Latest instruction",
    detail: chosen.text, at, stale, entryId: chosen.id,
  };
  const labels = { working: "Agent is working", waiting: "Agent needs your input", failed: "Session reported a failure", done: "Session finished", idle: "Agent is idle", queued: "Waiting to start", stale: "Last known session state" };
  return {
    kind: "activity", label: loading ? "Loading observed activity…" : labels[session.status] ?? context.status ?? "Waiting for activity",
    detail: session.title ? `${session.title}\nNo recent command or response is available yet.` : "No recent command or response is available yet.",
    at, stale,
  };
}

/** Browser frames take priority; recorded terminal/activity is always available as fallback. */
export function createLiveView(root, { browserFactory = createBrowserView, now = Date.now } = {}) {
  let id = null;
  let viewerId = null;
  let context = {};
  let browser = { state: "unavailable", hasFrame: false };
  let signature = "";
  root.innerHTML = `<div class="live-source-heading"><strong class="live-source-label"></strong><span>Automatic</span></div>
    <p class="live-source-note"></p><section class="live-browser" aria-label="Browser live view"></section>
    <section class="live-fallback" aria-label="Observed agent activity"></section>`;
  const browserRoot = root.querySelector(".live-browser");
  const fallback = root.querySelector(".live-fallback");
  function render() {
    if (!id) return;
    const chosen = liveActivity(context, now());
    const showBrowser = browser.hasFrame && chosen.kind !== "restricted";
    browserRoot.hidden = chosen.kind === "restricted";
    browserRoot.dataset.hasFrame = String(showBrowser);
    fallback.hidden = showBrowser;
    root.querySelector(".live-source-label").textContent = showBrowser ? "Browser" : chosen.kind === "terminal" ? "Terminal" : "Agent activity";
    root.querySelector(".live-source-note").textContent = showBrowser
      ? "The available browser view takes priority. Commands and activity appear when no fresh browser image is available."
      : `${context.error ? `${context.error} ` : ""}${browser.state === "loading" || browser.state === "connecting" ? "Waiting for a browser image. " : ""}${chosen.stale ? "Last known activity. " : ""}Showing recorded session activity; output updates when the agent records it.`;
    const next = JSON.stringify(chosen);
    if (signature === next) return;
    signature = next;
    const oldOutput = fallback.querySelector(".live-output");
    const scroll = oldOutput?.scrollTop ?? 0;
    const atEnd = !oldOutput || oldOutput.scrollHeight - scroll - oldOutput.clientHeight < 48;
    const oldEntry = fallback.dataset.entry;
    fallback.dataset.entry = chosen.entryId ?? "";
    fallback.innerHTML = `<div class="live-activity-heading"><strong>${esc(chosen.label)}</strong><time>${esc(clock(chosen.at))}</time></div>
      ${chosen.cwd ? `<p class="live-cwd">${esc(chosen.cwd)}</p>` : ""}
      ${chosen.kind === "terminal" ? `<pre class="live-command" aria-label="Observed command">${esc(chosen.command || "Command not present in the recent log window")}</pre>` : ""}
      ${chosen.detail ? `<pre class="live-detail">${esc(chosen.detail)}</pre>` : ""}
      ${chosen.kind === "terminal" || chosen.kind === "tool" ? `<pre class="live-output" tabindex="0" aria-label="Observed output">${chosen.output == null ? "No output has been recorded yet." : esc(chosen.output) || "Returned without text output."}</pre>` : ""}`;
    const output = fallback.querySelector(".live-output");
    if (output) output.scrollTop = oldEntry !== (chosen.entryId ?? "") || atEnd ? output.scrollHeight : scroll;
  }
  const viewer = browserFactory(browserRoot, { onState(next) {
    if (next.id !== id) return;
    browser = next;
    render();
  } });
  const timer = setInterval(() => { if (!document.hidden) render(); }, 1000);
  root.hidden = true;
  return {
    select(nextId, nextContext = {}) {
      context = nextContext;
      if (nextId !== id) {
        id = nextId;
        browser = { state: "connecting", hasFrame: false };
        signature = "";
        fallback.innerHTML = "";
      }
      const restricted = liveActivity(context, now()).kind === "restricted";
      if (restricted) browser = { state: "restricted", hasFrame: false };
      const nextViewerId = restricted ? null : id;
      if (nextViewerId !== viewerId) { viewerId = nextViewerId; viewer.select(viewerId); }
      root.hidden = !id;
      if (id) render();
    },
    destroy() { clearInterval(timer); viewer.destroy(); root.hidden = true; },
  };
}
