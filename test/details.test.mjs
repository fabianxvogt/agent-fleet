import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile, stat, rename, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { test } from "node:test";
import { createDetailsService } from "../src/details.mjs";
import { createDashboardServer } from "../src/server.mjs";

const T = "2026-10-16T12:00:00Z";
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "agent-fleet-details-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, ".codex", "sessions");
  await mkdir(root, { recursive: true });
  const source = join(root, "test.jsonl");
  await writeFile(source, JSON.stringify({ type: "response_item", timestamp: T, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Synthetic question" }] } }) + "\n");
  const node = { id: "codex:fixture", agent: "codex", kind: "session", cwd: "/synthetic/demo", source, agentsviewId: "codex:fixture" };
  return { home, root, source, node, config: { home, agentsviewUrl: "http://127.0.0.1:8080" } };
}

test("details use bounded local logs and paginate the verified archive", async (t) => {
  const f = await fixture(t);
  const calls = [];
  const service = createDetailsService(f.config, { fetcher: async (url) => {
    calls.push(url);
    if (!url.pathname.endsWith("/messages")) return json({ id: f.node.agentsviewId, cwd: f.node.cwd });
    return json({ messages: Array.from({ length: 40 }, (_, i) => ({ ordinal: 80 - i, role: "user", timestamp: T, content: `Archived ${i}` })), transcript_revision: "rev-1" });
  } });
  const data = await service.get(f.node);
  assert.equal(data.local.entries[0].text, "Synthetic question");
  assert.equal(data.archive.entries[0].ordinal, 41);
  assert.equal(data.archive.before, 40);
  assert.equal(data.archive.hasMore, true);
  await service.get(f.node);
  assert.equal(calls.length, 2, "repeat latest reads use a small cache");
  await service.get(f.node, { before: 40, revision: "rev-1" });
  assert.equal(calls.at(-1).searchParams.get("from"), "40");
  assert.equal(calls.at(-1).searchParams.get("expected_revision"), "rev-1");
});

test("local content survives archive failure and updates when the log grows", async (t) => {
  const f = await fixture(t);
  const service = createDetailsService(f.config, { fetcher: async () => { throw new Error("offline"); } });
  assert.equal((await service.get(f.node)).archive.state, "offline");
  await writeFile(f.source, JSON.stringify({ type: "event_msg", timestamp: T, payload: { type: "task_complete" } }) + "\n");
  const next = await service.get(f.node);
  assert.equal(next.local.activity.label, "Turn finished");
});

test("unverified identity, redirected archives and non-loopback URLs cannot supply content", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const service = createDetailsService(f.config, { fetcher: async (url, options) => {
    calls++;
    assert.equal(options.redirect, "error");
    return json({ id: f.node.agentsviewId, cwd: "/different/project" });
  } });
  assert.equal((await service.get(f.node)).archive.state, "mismatch");
  assert.equal(calls, 1);
  const remote = createDetailsService({ ...f.config, agentsviewUrl: "https://external.invalid" }, { fetcher: async () => { throw new Error("must not call"); } });
  assert.equal((await remote.get(f.node)).archive.state, "unavailable");
});

test("source paths cannot escape through symlinks or expose private contexts", async (t) => {
  const f = await fixture(t);
  const outside = join(f.home, "outside.jsonl");
  await writeFile(outside, "not a transcript");
  await symlink(outside, join(f.root, "escape.jsonl"));
  const service = createDetailsService(f.config, { fetcher: async () => json({}, 404) });
  const escaped = await service.get({ ...f.node, source: join(f.root, "escape.jsonl"), agentsviewId: null });
  assert.equal(escaped.local.state, "restricted");
  const restricted = await service.get({ ...f.node, cwd: "/synthetic/body-os/me", source: "must-not-read.jsonl" });
  assert.equal(restricted.local.state, "restricted");
  assert.deepEqual(restricted.archive.entries, []);
  const privateDir = join(f.home, "body-os", "me");
  await mkdir(privateDir, { recursive: true });
  const alias = join(f.home, "innocent-alias");
  await symlink(privateDir, alias);
  assert.equal((await service.get({ ...f.node, cwd: alias })).local.state, "restricted");
});

test("archive revision conflicts and oversized responses return bounded fallbacks", async (t) => {
  const f = await fixture(t);
  for (const oversized of [false, true]) {
    const service = createDetailsService(f.config, { fetcher: async (url) => url.pathname.endsWith("/messages")
      ? oversized ? new Response("x".repeat(5 * 1024 * 1024)) : json({}, 409)
      : json({ id: f.node.agentsviewId, cwd: f.node.cwd }) });
    const data = await service.get(f.node);
    assert.equal(data.archive.state, oversized ? "offline" : "changed");
    assert.equal(data.local.state, "available");
  }
});

test("HTTP details require a known session, valid cursor, same origin and loopback Host", async (t) => {
  const f = await fixture(t);
  const details = createDetailsService(f.config, { fetcher: async () => json({}, 404) });
  const server = createDashboardServer({ latest: () => ({ nodes: [f.node] }) }, details);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const path = `/api/sessions/${encodeURIComponent(f.node.id)}/details`;
  const response = await fetch(base + path);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).local.entries[0].text, "Synthetic question");
  for (const [url, options, expected] of [
    [path + "?before=-1", {}, 400], [path + "?before=abc", {}, 400],
    ["/api/sessions/unknown/details", {}, 404], ["/api/sessions/%ZZ/details", {}, 400],
    [path, { headers: { origin: "https://external.invalid" } }, 403],
  ]) assert.equal((await fetch(base + url, options)).status, expected, `${url} ${JSON.stringify(options)}`);
  const badHost = await new Promise((resolve, reject) => {
    const req = request(base + path, { headers: { host: "external.invalid" } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject); req.end();
  });
  assert.equal(badHost, 403);
  for (const asset of ["/", "/app.js", "/inspector.js"]) assert.equal((await fetch(base + asset)).status, 200);
});

async function artifactFixture(t) {
  const f = await fixture(t);
  const cwd = join(f.home, "project");
  await mkdir(cwd);
  const files = [
    ["report.txt", "API_KEY='synthetic secret value'\n<script>inert text</script>\n"],
    ["picture.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTh8AAAAASUVORK5CYII=", "base64")],
    ['résumé "final".pdf', "%PDF-1.4\nSynthetic fixture\n%%EOF\n"],
  ];
  for (const [name, value] of files) await writeFile(join(cwd, name), value);
  const text = files.map(([name]) => `[Result](<${join(cwd, name)}>)`).join("\n");
  await writeFile(f.source, JSON.stringify({ type: "response_item", timestamp: T, payload: { type: "message", role: "assistant", phase: "final", content: [{ type: "output_text", text }] } }) + "\n");
  const node = { ...f.node, cwd, agentsviewId: null };
  const details = createDetailsService(f.config);
  const nodes = [node, { ...node, id: "codex:another-session" }];
  const server = createDashboardServer({ latest: () => ({ nodes }) }, details);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { ...f, node, cwd, details, nodes, base: `http://127.0.0.1:${server.address().port}`, prefix: `/api/sessions/${encodeURIComponent(node.id)}` };
}

test("artifact evidence reaches session-bound HTTP previews and explicit downloads", async (t) => {
  const f = await artifactFixture(t);
  const data = await (await fetch(f.base + f.prefix + "/details")).json();
  assert.equal(data.artifactState, "available");
  assert.equal(data.artifacts.length, 3);
  assert.ok(!data.local.entries.some((entry) => Object.hasOwn(entry, "artifactCandidates")));
  assert.ok(data.artifacts.every((file) => !Object.hasOwn(file, "path")));
  const text = data.artifacts.find((file) => file.kind === "text");
  assert.equal(text.associations[0].kind, "linked");
  const response = await fetch(`${f.base}${f.prefix}/artifacts/${text.id}/preview`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  const preview = await response.json();
  assert.equal(preview.state, "available");
  assert.match(preview.text, /\[redacted\]/);
  assert.doesNotMatch(preview.text, /synthetic secret value/);
  assert.match(preview.text, /<script>inert text<\/script>/, "JSON contains text, never an executable document");
  const textDownload = await fetch(`${f.base}${f.prefix}/artifacts/${text.id}/download`);
  assert.equal(textDownload.status, 200);
  assert.match(textDownload.headers.get("content-disposition"), /^attachment;/);
  assert.doesNotMatch(await textDownload.text(), /synthetic secret value/);
  const picture = data.artifacts.find((file) => file.kind === "image");
  const image = await (await fetch(`${f.base}${f.prefix}/artifacts/${picture.id}/preview`)).json();
  assert.match(image.image, /^data:image\/png;base64,/);
  const document = data.artifacts.find((file) => file.kind === "document");
  const download = await fetch(`${f.base}${f.prefix}/artifacts/${document.id}/download`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /^attachment; filename=/);
  assert.match(download.headers.get("content-disposition"), /filename\*=UTF-8''r%C3%A9sum%C3%A9/);
  assert.equal(download.headers.get("content-type"), "application/octet-stream");
  assert.match(await download.text(), /^%PDF-1.4/);
  assert.equal((await fetch(f.base + "/artifact-view.js")).status, 200);
});

test("artifact HTTP routes reject cross-origin access, cross-session IDs and revoked sessions", async (t) => {
  const f = await artifactFixture(t);
  const data = await f.details.get(f.node);
  const file = data.artifacts.find((file) => file.kind === "text");
  const path = `${f.prefix}/artifacts/${file.id}/preview`;
  for (const headers of [{ origin: "https://external.invalid" }, { "sec-fetch-site": "cross-site" }]) {
    assert.equal((await fetch(f.base + path, { headers })).status, 403);
  }
  const cross = await (await fetch(`${f.base}/api/sessions/codex%3Aanother-session/artifacts/${file.id}/preview`)).json();
  assert.equal(cross.state, "expired");
  assert.equal((await fetch(f.base + path, { method: "POST" })).status, 405);
  assert.equal((await fetch(f.base + `${f.prefix}/artifacts/%2Fetc%2Fpasswd/preview`)).status, 404);
  f.nodes[0] = { ...f.node, cwd: join(f.home, "body-os") };
  assert.equal((await (await fetch(f.base + path)).json()).state, "expired");
  f.nodes.splice(0, 1);
  assert.equal((await fetch(f.base + path)).status, 404);
});

test("artifact requests revalidate deleted files instead of serving retained bytes", async (t) => {
  const f = await artifactFixture(t);
  const data = await f.details.get(f.node);
  const file = data.artifacts.find((file) => file.kind === "image");
  await rm(join(f.cwd, file.name));
  const response = await fetch(`${f.base}${f.prefix}/artifacts/${file.id}/preview`);
  assert.notEqual((await response.json()).state, "available");
  const download = await fetch(`${f.base}${f.prefix}/artifacts/${file.id}/download`);
  assert.ok([404, 409, 410].includes(download.status));
  assert.equal(download.headers.get("content-disposition"), null);
});

test("same-sized source replacement cannot bind cached artifact evidence to a new transcript", async (t) => {
  const f = await artifactFixture(t);
  await writeFile(join(f.cwd, "old.txt"), "old");
  await writeFile(join(f.cwd, "new.txt"), "new");
  const transcript = (name) => JSON.stringify({ type: "response_item", timestamp: T, payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `[Result](${name}.txt)` }] } }) + "\n";
  await writeFile(f.source, transcript("old"));
  const previous = await f.details.get(f.node);
  const oldId = previous.artifacts[0].id;
  const stamp = await stat(f.source);
  const replacement = f.source + ".replacement";
  await writeFile(replacement, transcript("new"));
  await utimes(replacement, stamp.atime, stamp.mtime);
  await rename(replacement, f.source);
  const changed = await f.details.get(f.node);
  assert.match(changed.local.entries[0].text, /new\.txt/);
  assert.deepEqual(changed.artifacts.map((file) => file.name), ["new.txt"]);
  assert.equal((await f.details.artifact(f.node, oldId)).state, "expired");
  assert.equal(changed.local.sourceIdentity, undefined);
});
