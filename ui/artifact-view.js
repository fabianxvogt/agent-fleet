const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const states = {
  missing: "This file is no longer available.",
  changed: "This file changed since it was observed. A new file reference is needed.",
  oversized: "This file exceeds the preview and download size limit.",
  restricted: "This file is unavailable in this context.",
  unsupported: "This file type is not supported yet.",
  expired: "This file reference expired. Refresh the session to check for newer references.",
};
const kinds = { image: "Image", text: "Text", document: "Document", unsupported: "File" };
const stateLabels = { missing: "Missing", changed: "Changed", oversized: "Too large", restricted: "Unavailable", unsupported: "Unsupported", expired: "Expired" };
const identity = (file) => JSON.stringify([file.id, file.name, file.kind, file.size, file.modifiedAt, file.state]);
const bytes = (size) => !Number.isFinite(size) ? "Size unavailable" : size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / (1024 * 1024)).toFixed(1)} MiB`;
const modified = (at) => Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleString() : "Modification time unavailable";
const validImage = (value) => typeof value === "string" && value.length <= 12_000_000 && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);

/** Session-bound previews. Only supplied opaque IDs are sent to the server. */
export function createArtifactView(root, { fetcher = (...args) => fetch(...args) } = {}) {
  let sessionId = null, generation = 0, files = [], context = {}, signature = "", previewRevision = 0;
  const previews = new Map(), requests = new Map(), expanded = new Set();
  let destroyed = false;
  function setPreview(id, preview) { previews.set(id, preview); previewRevision++; }

  function cancel(id) {
    const request = requests.get(id);
    if (request) { requests.delete(id); clearTimeout(request.timeout); request.controller.abort(); }
  }
  function clear() {
    for (const id of requests.keys()) cancel(id);
    previews.clear(); expanded.clear(); signature = ""; previewRevision++;
  }
  function captureFocus() {
    const focus = root.ownerDocument?.activeElement;
    if (!root.contains?.(focus)) return null;
    const fileId = focus.closest?.("[data-artifact]")?.dataset.artifact;
    if (!fileId) return null;
    const control = [".artifact-text", "[data-artifact-retry]", ".artifact-download"].find((selector) => focus.matches?.(selector)) ?? "summary";
    return { sessionId, fileId, control };
  }
  function restoreFocus(saved) {
    if (!saved || saved.sessionId !== sessionId || root.hidden || destroyed) return;
    const entry = [...root.querySelectorAll("[data-artifact]")].find((candidate) => candidate.dataset.artifact === saved.fileId);
    // Loading or revocation may remove a focused preview/retry control. Keep
    // keyboard users on the same file's summary when it still exists.
    (entry?.querySelector(saved.control) ?? entry?.querySelector("summary"))?.focus({ preventScroll: true });
  }
  function previewMarkup(file) {
    const preview = previews.get(file.id);
    const state = file.state !== "available" ? file.state : preview?.state;
    if (states[state]) return `<p class="artifact-note" role="status">${states[state]}</p>`;
    if (file.kind === "unsupported") return `<p class="artifact-note" role="status">${states.unsupported}</p>`;
    const download = file.kind === "document" && file.state === "available"
      ? `<a class="artifact-download" href="/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(file.id)}/download" download="${esc(file.name)}">Download ${esc(file.name)}</a>` : "";
    if (download) return `<p class="artifact-note">Download this document to open it in your preferred app.</p>${download}`;
    if (preview?.state === "error") return `<p class="artifact-note artifact-error" role="status">Preview could not be loaded.</p><button type="button" data-artifact-retry="${esc(file.id)}">Retry preview</button>`;
    if (!preview || preview.state === "loading") return `<p class="artifact-note" role="status">${preview?.state === "loading" ? "Loading preview…" : "Expand to load a preview."}</p>`;
    if (file.kind === "image" && preview.image) return `<img class="artifact-image" src="${esc(preview.image)}" alt="Preview of ${esc(file.name)}">`;
    return `${preview.truncated ? `<p class="artifact-note" role="status">Preview truncated. Showing the first part of this file.</p>` : ""}<pre class="artifact-text" tabindex="0" aria-label="Contents of ${esc(file.name)}">${esc(preview.text)}</pre>`;
  }
  function render() {
    // A poll must not serialize multi-megabyte image payloads merely to decide
    // whether the already mounted previews need updating.
    const next = JSON.stringify([sessionId, files, context, previewRevision]);
    if (signature === next) return;
    signature = next;
    const scroll = new Map([...root.querySelectorAll(".artifact-text")].map((pre) => [pre.closest("[data-artifact]").dataset.artifact, { top: pre.scrollTop, left: pre.scrollLeft }]));
    const top = root.scrollTop;
    const focus = captureFocus();
    root.innerHTML = `<div class="artifact-heading"><h4>Files <span>${files.length}</span></h4></div>
      ${context.error ? `<p class="artifact-note" role="status">File information could not be refreshed.${files.length ? " Previously observed files are shown." : " Try refreshing the session."}</p>` : ""}
      ${files.length ? files.map((file) => {
        const labels = [...new Set((file.associations ?? []).map((association) => association.kind === "written" ? "Written by tool" : association.kind === "linked" ? "Linked in response" : null).filter(Boolean))];
        return `<details class="artifact-entry" data-artifact="${esc(file.id)}" ${expanded.has(file.id) ? "open" : ""}>
          <summary><span class="artifact-name">${esc(file.name)}</span><span class="artifact-kind">${esc(kinds[file.kind] ?? "File")}${stateLabels[file.state] ? ` · ${stateLabels[file.state]}` : ""}</span></summary>
          <div class="artifact-metadata">${esc(bytes(file.size))} · <time datetime="${esc(file.modifiedAt ?? "")}">${esc(modified(file.modifiedAt))}</time></div>
          <div class="artifact-associations">${labels.map((label) => `<span>${label}</span>`).join("")}</div>
          <div class="artifact-preview" aria-busy="${previews.get(file.id)?.state === "loading"}">${previewMarkup(file)}</div>
        </details>`;
      }).join("") : `<p class="artifact-empty" role="status">${context.restricted ? "Files are unavailable for this private context." : context.loading ? "Looking for linked files…" : "No files linked or written in the observed session entries."}</p>`}`;
    root.scrollTop = top;
    for (const pre of root.querySelectorAll(".artifact-text")) {
      const position = scroll.get(pre.closest("[data-artifact]").dataset.artifact);
      if (position) { pre.scrollTop = position.top; pre.scrollLeft = position.left; }
    }
    restoreFocus(focus);
  }
  async function load(file) {
    if (destroyed || !sessionId || file.state !== "available" || !["text", "image"].includes(file.kind) || requests.has(file.id) || previews.get(file.id)?.state === "available") return;
    const selected = sessionId, epoch = generation, key = identity(file), controller = new AbortController();
    const request = { controller, timeout: setTimeout(() => controller.abort(), 12_000) };
    requests.set(file.id, request);
    setPreview(file.id, { state: "loading" });
    render();
    const current = () => !destroyed && epoch === generation && selected === sessionId && requests.get(file.id) === request && files.some((candidate) => identity(candidate) === key);
    try {
      const response = await fetcher(`/api/sessions/${encodeURIComponent(selected)}/artifacts/${encodeURIComponent(file.id)}/preview`, { signal: controller.signal });
      const data = await response.json();
      if (!current()) return;
      if (states[data.state]) setPreview(file.id, { state: data.state });
      else {
        if (!response.ok || data.state !== "available" || data.kind !== file.kind) throw new Error("Invalid preview");
        if (file.kind === "image") {
          if (!validImage(data.image)) throw new Error("Invalid image preview");
          setPreview(file.id, { state: "available", image: data.image });
        } else {
          if (typeof data.text !== "string" || data.text.length > 65_536) throw new Error("Invalid text preview");
          setPreview(file.id, { state: "available", text: data.text, truncated: Boolean(data.truncated) });
        }
      }
    } catch {
      if (current()) setPreview(file.id, { state: "error" });
    } finally {
      clearTimeout(request.timeout);
      if (requests.get(file.id) === request) { requests.delete(file.id); render(); }
    }
  }
  function onToggle(event) {
    const entry = event.target;
    const file = files.find((file) => file.id === entry.dataset?.artifact);
    if (!file) return;
    if (entry.open) {
      expanded.add(file.id);
      if (!previews.has(file.id)) void load(file);
    } else expanded.delete(file.id);
  }
  function onClick(event) {
    const id = event.target.closest?.("[data-artifact-retry]")?.dataset.artifactRetry;
    const file = files.find((file) => file.id === id);
    if (file) void load(file);
  }
  function onImageError(event) {
    if (!event.target.matches?.(".artifact-image")) return;
    const id = event.target.closest?.("[data-artifact]")?.dataset.artifact;
    if (previews.get(id)?.state === "available") { setPreview(id, { state: "error" }); render(); }
  }
  root.addEventListener("toggle", onToggle, true);
  root.addEventListener("click", onClick);
  root.addEventListener("error", onImageError, true);
  return {
    captureFocus,
    restoreFocus,
    select(nextId, nextFiles = [], nextContext = {}) {
      if (destroyed) return;
      if (sessionId !== nextId) { generation++; clear(); sessionId = nextId; }
      const available = nextContext.restricted ? [] : nextFiles;
      for (const previous of files) {
        const fresh = available.find((file) => file.id === previous.id);
        if (!fresh || identity(fresh) !== identity(previous)) {
          cancel(previous.id);
          if (previews.delete(previous.id)) previewRevision++;
          if (!fresh) expanded.delete(previous.id);
        }
      }
      files = available; context = nextContext;
      render();
      for (const file of files) if (expanded.has(file.id) && !previews.has(file.id)) void load(file);
    },
    destroy() {
      destroyed = true; generation++; clear();
      root.removeEventListener("toggle", onToggle, true); root.removeEventListener("click", onClick);
      root.removeEventListener("error", onImageError, true);
      root.innerHTML = "";
    },
  };
}
