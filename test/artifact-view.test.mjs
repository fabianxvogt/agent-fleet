import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createArtifactView } from "../ui/artifact-view.js";

const artifact = (extra = {}) => ({
  id: "file-a", name: "report.txt", kind: "text", size: 1234, modifiedAt: "2026-10-20T12:00:00Z", state: "available",
  associations: [{ entryId: "message-1", kind: "linked" }], ...extra,
});
const reply = (extra = {}) => new Response(JSON.stringify({ state: "available", kind: "text", name: "report.txt", text: "Synthetic file contents", ...extra }));

function fixture(fetcher) {
  const handlers = new Map();
  const root = {
    html: "", writes: 0, entries: [], texts: [], scrollTop: 0, ownerDocument: { activeElement: null },
    set innerHTML(html) {
      if (this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = null;
      for (const entry of this.entries) for (const control of Object.values(entry.controls)) control.connected = false;
      this.html = html; this.writes++;
      this.entries = [...html.matchAll(/<details[^>]*data-artifact="([^"]+)"([^>]*)>([\s\S]*?)<\/details>/g)].map((match) => {
        const entry = { dataset: { artifact: match[1] }, open: /\bopen\b/.test(match[2]), controls: {}, querySelector: (selector) => entry.controls[selector] ?? null };
        const control = (selector) => ({
          connected: true, scrollTop: 0, scrollLeft: 0,
          closest: () => entry, matches: (requested) => requested === selector,
          focus() { if (this.connected) root.ownerDocument.activeElement = this; },
        });
        entry.controls.summary = control("summary");
        if (match[3].includes('class="artifact-text"')) entry.text = entry.controls[".artifact-text"] = control(".artifact-text");
        if (match[3].includes('class="artifact-download"')) entry.controls[".artifact-download"] = control(".artifact-download");
        if (match[3].includes("data-artifact-retry=")) entry.controls["[data-artifact-retry]"] = control("[data-artifact-retry]");
        return entry;
      });
      this.texts = this.entries.flatMap((entry) => entry.text ? [entry.text] : []);
    },
    get innerHTML() { return this.html; },
    contains(element) { return this.entries.some((entry) => Object.values(entry.controls).includes(element)); },
    querySelectorAll(selector) { return selector === ".artifact-text" ? this.texts : selector === "[data-artifact]" ? this.entries : []; },
    addEventListener(name, handler) { handlers.set(name, handler); },
    removeEventListener(name) { handlers.delete(name); },
    toggle(id, open = true) {
      const entry = this.entries.find((entry) => entry.dataset.artifact === id);
      assert.ok(entry, `File ${id} exists`);
      entry.open = open;
      handlers.get("toggle")?.({ target: entry });
    },
    retry(id) { handlers.get("click")?.({ target: { closest: () => ({ dataset: { artifactRetry: id } }) } }); },
    imageError(id) { handlers.get("error")?.({ target: { matches: () => true, closest: () => ({ dataset: { artifact: id } }) } }); },
  };
  return { root, view: createArtifactView(root, { fetcher }) };
}

test("Results files load on expansion, retain text reading position and preserve cached previews across polling", async (t) => {
  const calls = [];
  const { root, view } = fixture(async (url) => { calls.push(url); return reply(); });
  t.after(() => view.destroy());
  view.select("session", [artifact()]);
  assert.equal(calls.length, 0);
  root.toggle("file-a");
  await setImmediate();
  assert.equal(calls[0], "/api/sessions/session/artifacts/file-a/preview");
  assert.match(root.innerHTML, /Synthetic file contents/);
  root.texts[0].scrollTop = 150;
  root.texts[0].scrollLeft = 20;
  root.scrollTop = 80;
  const previousText = root.texts[0], writes = root.writes;
  view.select("session", [artifact()]);
  assert.equal(root.writes, writes);
  assert.equal(root.texts[0], previousText);
  view.select("session", [artifact(), artifact({ id: "second", name: "second.txt" })]);
  assert.equal(root.entries[0].open, true);
  assert.equal(root.texts[0].scrollTop, 150);
  assert.equal(root.texts[0].scrollLeft, 20);
  assert.equal(root.scrollTop, 80);
  assert.equal(calls.length, 1);
});

test("a response from an old selection is aborted and cannot populate another session", async (t) => {
  const pending = [];
  const { root, view } = fixture((url, options) => new Promise((resolve) => pending.push({ url, signal: options.signal, resolve })));
  t.after(() => view.destroy());
  view.select("first", [artifact()]);
  root.toggle("file-a");
  view.select("second", [artifact()]);
  assert.equal(pending[0].signal.aborted, true);
  root.toggle("file-a");
  pending[0].resolve(reply({ text: "OLD PRIVATE PREVIEW" }));
  pending[1].resolve(reply({ text: "CURRENT PREVIEW" }));
  await setImmediate();
  assert.doesNotMatch(root.innerHTML, /OLD PRIVATE PREVIEW/);
  assert.match(root.innerHTML, /CURRENT PREVIEW/);
});

test("changed identity, removed references and restriction revoke pending or cached content", async (t) => {
  const pending = [];
  const { root, view } = fixture((url, options) => new Promise((resolve) => pending.push({ signal: options.signal, resolve })));
  t.after(() => view.destroy());
  view.select("session", [artifact()]);
  root.toggle("file-a");
  view.select("session", [artifact({ state: "changed" })]);
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve(reply({ text: "REVOKED PREVIEW" }));
  await setImmediate();
  assert.match(root.innerHTML, /file changed since it was observed/);
  assert.doesNotMatch(root.innerHTML, /REVOKED PREVIEW/);
  view.select("session", [artifact()]);
  pending[1].resolve(reply({ text: "LOADED PREVIEW" }));
  await setImmediate();
  assert.match(root.innerHTML, /LOADED PREVIEW/);
  view.select("session", []);
  assert.doesNotMatch(root.innerHTML, /LOADED PREVIEW/);
  view.select("session", [artifact()]);
  root.toggle("file-a");
  view.select("session", [artifact()], { restricted: true });
  assert.equal(pending[2].signal.aborted, true);
  pending[2].resolve(reply({ text: "RESTRICTED PREVIEW" }));
  await setImmediate();
  assert.match(root.innerHTML, /Files are unavailable for this private context/);
  assert.doesNotMatch(root.innerHTML, /RESTRICTED PREVIEW|report\.txt/);
});

test("replacement metadata aborts the old request and reloads an expanded preview", async (t) => {
  const pending = [];
  const { root, view } = fixture((url, options) => new Promise((resolve) => pending.push({ signal: options.signal, resolve })));
  t.after(() => view.destroy());
  view.select("session", [artifact()]); root.toggle("file-a");
  view.select("session", [artifact({ size: 42, modifiedAt: "2026-10-20T12:30:00Z" })]);
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(pending.length, 2);
  pending[1].resolve(reply({ text: "NEW IDENTITY" }));
  pending[0].resolve(reply({ text: "OLD IDENTITY" }));
  await setImmediate();
  assert.match(root.innerHTML, /NEW IDENTITY/);
  assert.doesNotMatch(root.innerHTML, /OLD IDENTITY/);
});

test("HTML, SVG, filenames and associations render as inert text; documents use explicit download links", async (t) => {
  let calls = 0;
  const { root, view } = fixture(async () => { calls++; return reply({ text: '<svg onload="alert(1)"></svg><script>secret()</script>', truncated: true }); });
  t.after(() => view.destroy());
  view.select("session/encoded", [
    artifact({ name: 'example.svg" onload="bad', associations: [{ kind: "linked", entryId: "1" }, { kind: "written", entryId: "2" }] }),
    artifact({ id: "doc:1", name: 'report.pdf" target="bad', kind: "document" }),
  ]);
  root.toggle("file-a"); root.toggle("doc:1");
  await setImmediate();
  assert.equal(calls, 1);
  assert.match(root.innerHTML, /&lt;svg onload=&quot;/);
  assert.doesNotMatch(root.innerHTML, /<svg|<script|<iframe|<object| target="bad/);
  assert.match(root.innerHTML, /Preview truncated/);
  assert.match(root.innerHTML, /Linked in response/);
  assert.match(root.innerHTML, /Written by tool/);
  assert.match(root.innerHTML, /href="\/api\/sessions\/session%2Fencoded\/artifacts\/doc%3A1\/download" download="report.pdf&quot; target=&quot;bad"/);
});

test("validated raster data images render while executable or remote image sources fail closed", async (t) => {
  for (const image of ["data:image/png;base64,aGVsbG8=", "data:image/svg+xml;base64,aGVsbG8=", 'https://remote.example/image.png', 'data:image/png;base64,a" onerror="bad']) {
    const { root, view } = fixture(async () => reply({ kind: "image", image }));
    t.after(() => view.destroy());
    view.select("session", [artifact({ kind: "image", name: "image.png" })]);
    root.toggle("file-a");
    await setImmediate();
    if (image.startsWith("data:image/png;base64,aGV")) assert.match(root.innerHTML, /<img class="artifact-image"/);
    else {
      assert.match(root.innerHTML, /Preview could not be loaded/);
      assert.doesNotMatch(root.innerHTML, /<img/);
    }
  }
});

test("empty, unavailable, loading and per-file failure states are accessible; retry recovers", async (t) => {
  let failed = true, calls = 0;
  const { root, view } = fixture(async () => { calls++; if (failed) throw new Error("private diagnostic"); return reply(); });
  t.after(() => view.destroy());
  view.select("session", [], { loading: true });
  assert.match(root.innerHTML, /role="status">Looking for linked files/);
  view.select("session", [], { error: true });
  assert.match(root.innerHTML, /File information could not be refreshed/);
  for (const state of ["missing", "changed", "oversized", "restricted", "unsupported", "expired"]) {
    view.select("session", [artifact({ state })]);
    root.toggle("file-a");
    assert.match(root.innerHTML, /role="status"/);
  }
  assert.equal(calls, 0);
  view.select("session", [artifact()]);
  await setImmediate();
  assert.match(root.innerHTML, /Preview could not be loaded/);
  assert.doesNotMatch(root.innerHTML, /private diagnostic/);
  failed = false; root.retry("file-a");
  await setImmediate();
  assert.match(root.innerHTML, /Synthetic file contents/);
});

test("a preview response may revoke availability and destroying the view prevents late rendering", async () => {
  let resolve, signal;
  const { root, view } = fixture((_, options) => { signal = options.signal; return new Promise((done) => { resolve = done; }); });
  view.select("session", [artifact()]); root.toggle("file-a");
  resolve(reply({ state: "missing" }));
  await setImmediate();
  assert.match(root.innerHTML, /file is no longer available/);
  view.select("session", [artifact({ id: "new" })]); root.toggle("new");
  view.destroy();
  assert.equal(signal.aborted, true);
  resolve(reply({ text: "LATE CONTENT" }));
  await setImmediate();
  assert.equal(root.innerHTML, "");
});

test("undecodable raster content exposes a retryable error instead of a broken image", async (t) => {
  const { root, view } = fixture(async () => reply({ kind: "image", image: "data:image/png;base64,aGVsbG8=" }));
  t.after(() => view.destroy());
  view.select("session", [artifact({ kind: "image" })]); root.toggle("file-a");
  await setImmediate();
  root.imageError("file-a");
  assert.doesNotMatch(root.innerHTML, /<img/);
  assert.match(root.innerHTML, /Preview could not be loaded/);
  assert.match(root.innerHTML, /Retry preview/);
});

test("logical file focus survives parent detachment and metadata replacement with a fresh control", async (t) => {
  const { root, view } = fixture(async () => reply());
  t.after(() => view.destroy());
  view.select("session", [artifact(), artifact({ id: "document", kind: "document" })]);
  root.toggle("file-a"); root.toggle("document");
  await setImmediate();
  for (const [id, selector] of [["file-a", ".artifact-text"], ["document", ".artifact-download"], ["file-a", "summary"]]) {
    const previous = root.entries.find((entry) => entry.dataset.artifact === id).querySelector(selector);
    previous.focus();
    const saved = view.captureFocus();
    assert.deepEqual(saved, { sessionId: "session", fileId: id, control: selector });
    // Replacing the inspector's surrounding markup clears document focus;
    // the artifact reconciliation then replaces the formerly focused node.
    root.ownerDocument.activeElement = null;
    view.select("session", [artifact(), artifact({ id: "document", kind: "document" })], { error: selector !== "summary" });
    if (previous.connected) {
      view.select("session", [artifact(), artifact({ id: "document", kind: "document" })], { loading: true });
    }
    assert.equal(previous.connected, false);
    view.restoreFocus(saved);
    const current = root.entries.find((entry) => entry.dataset.artifact === id).querySelector(selector);
    assert.equal(root.ownerDocument.activeElement, current);
    assert.notEqual(current, previous);
  }
  const saved = view.captureFocus();
  view.select("another-session", [artifact()]);
  root.ownerDocument.activeElement = null;
  view.restoreFocus(saved);
  assert.equal(root.ownerDocument.activeElement, null);
});

test("another preview completing retains keyboard focus on the document download anchor", async (t) => {
  let resolve;
  const { root, view } = fixture(() => new Promise((done) => { resolve = done; }));
  t.after(() => view.destroy());
  view.select("session", [artifact(), artifact({ id: "document", kind: "document" })]);
  root.toggle("file-a"); root.toggle("document");
  const download = root.entries[1].querySelector(".artifact-download");
  download.focus();
  resolve(reply()); await setImmediate();
  assert.equal(download.connected, false);
  assert.equal(root.ownerDocument.activeElement, root.entries[1].querySelector(".artifact-download"));
});
