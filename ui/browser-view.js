const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clock = (at) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function visibleClicks(frame, status, now = Date.now()) {
  if (!frame || frame.runId !== status.runId || frame.documentId !== status.documentId) return [];
  return (status.clicks ?? []).filter((click) => click.documentId === frame.documentId &&
    [click.x, click.y, click.at].every(Number.isFinite) && click.x >= 0 && click.y >= 0 && click.x < frame.width && click.y < frame.height &&
    now - click.at >= 0 && now - click.at < 6000 && frame.at >= click.at);
}

export function createBrowserView(root, { eventSource = (url) => new EventSource(url), newImage = () => new Image() } = {}) {
  let id = null;
  let source = null;
  let reconnect = null;
  let epoch = 0;
  let imageSequence = 0;
  let decoder = null;
  let current = null;
  let status = { state: "connecting" };
  let receivedAt = 0;
  const labels = { connecting: "Connecting…", loading: "Page loading…", live: "Live", disconnected: "Disconnected · reconnecting…", stopped: "Browser stopped", unavailable: "No browser attached", restricted: "Live view unavailable for this context", paused: "Paused while this tab is hidden" };

  function clearImage() {
    imageSequence++;
    if (decoder) { decoder.onload = null; decoder.src = ""; decoder = null; }
    current = null;
    root.querySelector(".browser-image")?.removeAttribute("src");
    const layer = root.querySelector(".browser-clicks");
    if (layer) layer.innerHTML = "";
  }
  function renderStatus() {
    const state = Object.hasOwn(labels, status.state) ? status.state : "disconnected";
    root.querySelector(".browser-state").textContent = labels[state];
    root.querySelector(".browser-state").dataset.state = state;
    root.querySelector(".browser-location").textContent = status.url ?? "Terminal browser";
    root.querySelector(".browser-placeholder").hidden = Boolean(current);
    root.querySelector(".browser-placeholder").textContent = labels[state];
    root.querySelector(".browser-help").innerHTML = status.startCommand && state === "unavailable"
      ? `<p>Start the managed browser from this session's terminal. One browser can be attached at a time.</p><button data-copy="${esc(status.startCommand)}">Copy browser start command</button>` : "";
    const click = status.clicks?.at(-1);
    root.querySelector(".browser-caption").textContent = current
      ? `Read-only · last image ${clock(current.at)}${click ? ` · click observed ${clock(click.at)}` : ""}`
      : "Read-only · terminal actions appear here";
    drawClicks();
  }
  function drawClicks() {
    const clicks = visibleClicks(current, status);
    root.querySelector(".browser-clicks").innerHTML = clicks.map((c) => {
      const age = Math.max(0, (Date.now() - c.at) / 1000);
      return `<span class="browser-click" data-click-id="${esc(c.id)}" style="left:${c.x / current.width * 100}%;top:${c.y / current.height * 100}%;animation-delay:-${age}s" title="Observed click ${esc(clock(c.at))}"></span>`;
    }).join("");
  }
  function disconnect() {
    epoch++;
    source?.close(); source = null;
    clearTimeout(reconnect); reconnect = null;
    clearImage();
  }
  function retry() {
    epoch++;
    source?.close(); source = null;
    clearTimeout(reconnect);
    if (id && !document.hidden) reconnect = setTimeout(connect, 3000);
  }
  function connect() {
    if (!id || document.hidden) return;
    const expectedEpoch = ++epoch;
    receivedAt = Date.now();
    status = { state: "connecting" };
    renderStatus();
    source = eventSource(`/api/sessions/${encodeURIComponent(id)}/browser/events`);
    source.addEventListener("status", (event) => {
      if (expectedEpoch !== epoch) return;
      let next;
      try { next = JSON.parse(event.data); } catch { return; }
      receivedAt = Date.now();
      if (next.runId !== status.runId || next.documentId !== status.documentId || !["live", "loading"].includes(next.state)) clearImage();
      status = next;
      renderStatus();
      if (["unavailable", "disconnected", "stopped"].includes(next.state)) retry();
      if (next.state === "restricted") { epoch++; source?.close(); source = null; }
    });
    source.addEventListener("frame", (event) => {
      if (expectedEpoch !== epoch) return;
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      if (frame.runId !== status.runId || frame.documentId !== status.documentId || !["live", "loading"].includes(status.state) ||
          frame.width !== 1280 || frame.height !== 800 || !Number.isFinite(frame.at) || typeof frame.data !== "string" || frame.data.length > 2 * 1024 * 1024 || !/^[a-zA-Z0-9+/=]+$/.test(frame.data)) return;
      receivedAt = Date.now();
      const sequence = ++imageSequence;
      if (decoder) { decoder.onload = null; decoder.src = ""; }
      const image = newImage(); decoder = image;
      image.onload = () => {
        if (expectedEpoch !== epoch || sequence !== imageSequence || frame.documentId !== status.documentId) return;
        root.querySelector(".browser-image").src = image.src;
        current = frame; renderStatus();
      };
      image.src = `data:image/jpeg;base64,${frame.data}`;
    });
    source.onerror = () => {
      if (expectedEpoch !== epoch) return;
      clearImage(); status = { state: "disconnected" }; renderStatus(); retry();
    };
  }
  const visibility = () => {
    if (!id) return;
    disconnect();
    if (document.hidden) { status = { state: "paused" }; renderStatus(); }
    else connect();
  };
  document.addEventListener("visibilitychange", visibility);
  const watchdog = setInterval(() => {
    if (!id || document.hidden) return;
    if (source && Date.now() - receivedAt > 8000) {
      disconnect(); status = { state: "disconnected" }; renderStatus(); retry();
    } else drawClicks();
  }, 1000);
  root.hidden = true;
  return {
    select(nextId) {
      if (nextId === id) return;
      disconnect(); id = nextId;
      root.hidden = !id;
      if (!id) { root.innerHTML = ""; return; }
      root.innerHTML = `<div class="browser-toolbar"><strong class="browser-state"></strong><span class="browser-location"></span></div>
        <div class="browser-screen"><img class="browser-image" alt="Live view of the selected terminal browser" draggable="false"/><div class="browser-clicks" aria-hidden="true"></div><p class="browser-placeholder"></p></div>
        <p class="browser-caption"></p><div class="browser-help"></div>`;
      status = { state: document.hidden ? "paused" : "connecting" }; renderStatus(); connect();
    },
    destroy() { disconnect(); clearInterval(watchdog); document.removeEventListener("visibilitychange", visibility); },
  };
}
