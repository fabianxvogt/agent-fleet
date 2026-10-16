const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const time = (at) => at ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "Time unavailable";

export function mergeContent(history, recent) {
  const entries = history.map((e) => ({ ...e, origin: "archive" }));
  const matched = new Set();
  for (const e of recent) {
    const i = entries.findIndex((a, index) => !matched.has(index) && (a.id === e.id || e.kind === "message" && a.kind === "message" && a.role === e.role && a.text === e.text && a.at && e.at && Math.abs(Date.parse(a.at) - Date.parse(e.at)) < 2000));
    if (i >= 0) {
      const previous = entries[i];
      entries[i] = { ...previous, ...e, id: previous.id, origin: "local", text: e.text ?? previous.text, name: e.name === "Tool result" ? previous.name ?? e.name : e.name, input: e.input || previous.input, status: e.status === "observed" && previous.status === "completed" ? "completed" : e.status };
      matched.add(i);
    } else entries.push({ ...e, origin: "local" });
  }
  let previousTime = 0;
  return entries.map((entry, index) => {
    previousTime = Number.isFinite(Date.parse(entry.at)) ? Date.parse(entry.at) : previousTime;
    return { entry, index, time: previousTime };
  }).sort((a, b) => a.time - b.time || a.index - b.index).map(({ entry }) => entry);
}

function renderEntry(e) {
  if (e.kind === "tool") {
    const status = e.status === "failed" ? "Failed" : e.text !== null ? "Returned" : "Call observed";
    return `<details class="tool-entry ${e.status === "failed" ? "tool-failed" : ""}" data-entry="${esc(e.id)}">
      <summary><span>${esc(e.name)}</span><span class="entry-state">${status}</span></summary>
      <div class="entry-time" title="${esc(e.at)}">${esc(time(e.at))} · ${e.origin === "local" ? "session log" : "archive"}</div>
      ${e.input ? `<div class="output-label">Input</div><pre>${esc(e.input)}</pre>` : ""}
      <div class="output-label">Output</div><pre>${e.text === null ? "No result observed yet." : esc(e.text) || "Returned without text output."}</pre>
    </details>`;
  }
  return `<article class="chat-entry ${e.role === "user" ? "from-user" : "from-agent"}" data-entry="${esc(e.id)}">
    <div class="entry-heading"><b>${e.role === "user" ? "You" : "Agent"}</b><time title="${esc(e.at)}">${esc(time(e.at))}</time></div>
    <div class="message-text">${esc(e.text)}</div>
  </article>`;
}

const ARCHIVE_NOTE = {
  offline: "Archive unavailable. Recent session-log events remain visible; retrying automatically.",
  "not-indexed": "This session is not indexed in the archive yet.",
  unavailable: "No archive history is available for this session.",
  mismatch: "Archive identity could not be verified for this session.",
  restricted: "Content is unavailable for this private context.",
  changed: "The archive changed while loading. Refresh to reload its history.",
};

/** Fetch only the selected session; abort old requests and preserve reading position. */
export function createInspector(root, { fetcher = (...args) => fetch(...args), browserView = null } = {}) {
  let id = null;
  let generation = 0;
  let controller = null;
  let tab = "chat";
  let history = [];
  let recent = [];
  let local = null;
  let archive = null;
  let oldest = null;
  let loading = false;
  let loadingOlder = false;
  let error = null;
  let signature = "";
  let status = null;
  let recentLimited = false;
  let gapUntil = null;
  let historyRevision = null;

  function render({ reset = false, prepend = false } = {}) {
    const next = JSON.stringify([id, tab, history, recent, local, archive, oldest, loading, loadingOlder, error, status, recentLimited, gapUntil]);
    if (!reset && signature === next) return;
    signature = next;
    const thread = root.querySelector(".session-thread");
    const scrollTop = thread?.scrollTop ?? 0;
    const scrollHeight = thread?.scrollHeight ?? 0;
    const atBottom = !thread || scrollHeight - scrollTop - thread.clientHeight < 60;
    const expanded = new Set([...root.querySelectorAll("details[data-entry][open]")].map((d) => d.dataset.entry));
    const entries = mergeContent(history, recent);
    const results = entries.filter((e) => e.kind === "tool" ? e.text !== null : e.role === "assistant" && e.final);
    // Archived messages do not have a final-phase flag. Show the latest agent
    // response as a response, without claiming it is the session's final result.
    const latestReply = entries.findLast((e) => e.kind === "message" && e.role === "assistant");
    if (latestReply && !results.some((e) => e.id === latestReply.id)) results.push(latestReply);
    const shown = tab === "results" ? results : entries;
    const activity = local?.activity;
    const observation = activity ?? (latestReply ? { label: "Last archived response", detail: latestReply.text.slice(0, 220), at: latestReply.at } : null);
    const note = archive && ARCHIVE_NOTE[archive.state];
    root.innerHTML = `
      <section class="current-activity" aria-label="Current activity">
        <div class="inspector-eyebrow">${activity ? "Last observed activity" : "Activity"}<span>${esc(status ?? "")}</span></div>
        <strong>${esc(observation?.label ?? (loading ? "Loading activity…" : "No activity observed"))}</strong>
        ${observation?.detail ? `<p>${esc(observation.detail)}</p>` : ""}
        <div class="entry-time" title="${esc(observation?.at)}">${esc(observation ? time(observation.at) : "")}${observation ? ` · ${activity ? "session log" : "archive"}` : ""}</div>
      </section>
      <div class="inspector-tabs" role="tablist" aria-label="Session content">
        <button role="tab" data-content-tab="chat" aria-selected="${tab === "chat"}">Chat <span>${entries.length}</span></button>
        <button role="tab" data-content-tab="results" aria-selected="${tab === "results"}">Results <span>${results.length}</span></button>
        <button role="tab" data-content-tab="live" aria-selected="${tab === "live"}">Live</button>
        <button class="inspector-refresh" data-inspector-refresh aria-label="Refresh session" ${loading || loadingOlder ? "disabled" : ""}>↻</button>
      </div>
      <div class="inspector-note" role="status">${esc(error ?? note ?? (loading ? "Updating…" : local?.truncated ? "Recent log window shown; older messages come from the archive." : local?.state === "available" ? "Recent events from the session log; history from the archive." : "History from the archive; current log activity is unavailable."))}${gapUntil !== null ? " Some archive messages are not loaded yet; load earlier messages to fill the gap." : ""}${recentLimited ? " Local view is limited to 400 events; use the archive for older history." : ""}</div>
      <div class="session-thread" role="region" aria-label="${tab === "chat" ? "Chat history" : "Session results"}" tabindex="0" aria-busy="${loading || loadingOlder}">
        ${oldest?.hasMore ? `<button class="load-history" data-load-history ${loading || loadingOlder ? "disabled" : ""}>${loadingOlder ? "Loading earlier messages…" : "Load earlier messages"}</button>` : ""}
        ${shown.length ? shown.map(renderEntry).join("") : `<p class="inspector-empty">${loading ? "Loading session content…" : tab === "results" ? "No results observed yet." : "No messages available yet."}</p>`}
      </div>`;
    for (const d of root.querySelectorAll("details[data-entry]")) if (expanded.has(d.dataset.entry)) d.open = true;
    const nextThread = root.querySelector(".session-thread");
    if (reset || atBottom && !prepend) nextThread.scrollTop = nextThread.scrollHeight;
    else nextThread.scrollTop = prepend ? scrollTop + nextThread.scrollHeight - scrollHeight : scrollTop;
    root.querySelector(".session-thread").hidden = tab === "live";
    root.querySelector(".inspector-note").hidden = tab === "live";
    browserView?.select(tab === "live" ? id : null);
  }

  async function refresh(older = false) {
    if (!id || loading || loadingOlder || older && !oldest?.hasMore) return;
    const selected = id;
    const epoch = generation;
    controller = new AbortController();
    const requestController = controller;
    const timeout = setTimeout(() => requestController.abort(), 12_000);
    if (older) loadingOlder = true;
    else loading = true;
    error = null;
    // Keep existing content still while polling, including expanded outputs.
    if (!recent.length && !history.length || older) render();
    try {
      const query = older ? `?before=${oldest.before}${oldest.revision ? `&revision=${encodeURIComponent(oldest.revision)}` : ""}` : "";
      const response = await fetcher(`/api/sessions/${encodeURIComponent(selected)}/details${query}`, { signal: requestController.signal });
      if (!response.ok) throw new Error(response.status === 404 ? "Session is no longer in the collection window." : "Session content could not be loaded. Retrying automatically.");
      const data = await response.json();
      if (epoch !== generation || selected !== id) return;
      if (data.id !== selected) throw new Error("Session response did not match the selection.");
      if (older) {
        if (data.archive.state !== "available") throw new Error(ARCHIVE_NOTE[data.archive.state] ?? "Earlier messages could not be loaded.");
        const known = new Set(history.map((e) => e.id));
        history = [...data.archive.entries.filter((e) => !known.has(e.id)), ...history];
        oldest = data.archive;
        const first = Math.min(...data.archive.entries.map((e) => e.ordinal).filter(Number.isSafeInteger));
        if (!oldest.hasMore || first <= gapUntil + 1) gapUntil = null;
      } else {
        local = data.local;
        const accumulated = mergeContent(recent, data.local?.entries ?? []);
        recentLimited = recentLimited || accumulated.length > 400;
        recent = accumulated.slice(-400);
        archive = data.archive;
        if (data.archive.state === "available") {
          // Ordinals are meaningful only within the returned archive revision.
          // A rebuild/compaction can reuse them for entirely different messages.
          if (historyRevision !== data.archive.revision) {
            history = [];
            oldest = null;
            gapUntil = null;
            historyRevision = data.archive.revision;
          }
          const previousOrdinals = history.map((e) => e.ordinal).filter(Number.isSafeInteger);
          const nextOrdinals = data.archive.entries.map((e) => e.ordinal).filter(Number.isSafeInteger);
          const previousLast = previousOrdinals.length ? Math.max(...previousOrdinals) : null;
          const nextFirst = nextOrdinals.length ? Math.min(...nextOrdinals) : null;
          if (!history.length || !oldest || oldest.state !== "available") oldest = data.archive;
          else if (previousLast !== null && nextFirst !== null && nextFirst > previousLast + 1) {
            gapUntil = Math.min(gapUntil ?? previousLast, previousLast);
            oldest = data.archive;
          }
          const fresh = new Map(data.archive.entries.map((e) => [e.id, e]));
          history = history.map((e) => fresh.get(e.id) ?? e);
          const known = new Set(history.map((e) => e.id));
          history.push(...data.archive.entries.filter((e) => !known.has(e.id)));
        }
      }
    } catch (cause) {
      if (epoch === generation) error = cause.name === "AbortError" ? "Session request timed out. Retrying automatically." : cause.message;
    } finally {
      clearTimeout(timeout);
      if (epoch === generation) {
        loading = loadingOlder = false;
        render({ prepend: older });
      }
    }
  }

  root.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.contentTab) { tab = button.dataset.contentTab; render({ reset: true }); }
    if (button.hasAttribute("data-load-history")) void refresh(true);
    if (button.hasAttribute("data-inspector-refresh")) { history = []; oldest = null; gapUntil = null; historyRevision = null; void refresh(); }
  });
  const timer = setInterval(() => { if (id && !document.hidden) void refresh(); }, 4000);
  return {
    select(nextId, nextStatus = null) {
      status = nextStatus;
      if (nextId === id) return;
      generation++;
      controller?.abort();
      id = nextId;
      tab = "chat";
      history = []; recent = []; local = archive = oldest = null;
      loading = loadingOlder = false; error = null; signature = ""; recentLimited = false; gapUntil = null; historyRevision = null;
      if (id) { render({ reset: true }); void refresh(); }
      else { root.innerHTML = ""; browserView?.select(null); }
    },
    destroy() { generation++; controller?.abort(); clearInterval(timer); browserView?.destroy(); },
  };
}
