import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, rename, rm, symlink, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { createArtifactService } from "../src/artifacts.mjs";

const run = promisify(execFile);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64");
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "agent-fleet-artifacts-"));
  const root = join(home, "project");
  await mkdir(root);
  const source = join(home, "synthetic.jsonl");
  await writeFile(source, "synthetic\n");
  t.after(() => rm(home, { recursive: true, force: true }));
  let time = 1_800_000_000_000;
  const node = { id: "codex:synthetic", agent: "codex", cwd: root, source, agentsviewId: "archive:synthetic" };
  const service = createArtifactService({ home }, { now: () => time });
  return { home, root, source, node, service, advance(ms) { time += ms; } };
}
const entry = (id, paths, kind = "linked") => ({ id, artifactCandidates: paths.map((path) => ({ path, kind })) });
const local = (...entries) => ({ local: { state: "available", entries } });
const archive = (revision, ...entries) => ({ archive: { state: "available", revision, entries } });
async function register(f, path, id = "message:one") { return (await f.service.register(f.node, local(entry(id, [path]))))[0]; }

test("artifacts expose opaque session-bound metadata and redacted text", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "answer.md"), "# Synthetic answer\nAPI_KEY=secret-value\n");
  const files = await f.service.register(f.node, local(entry("reply", ["answer.md"]), entry("writer", ["answer.md"], "written")));
  assert.equal(files.length, 1);
  assert.match(files[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(files[0].name, "answer.md");
  assert.equal(files[0].kind, "text");
  assert.equal(files[0].state, "available");
  assert.equal(files[0].associations.length, 2);
  assert.ok(files[0].modifiedAt);
  assert.equal(JSON.stringify(files).includes(f.root), false);
  const preview = await f.service.read(f.node, files[0].id);
  assert.equal(preview.state, "available");
  assert.match(preview.body, /API_KEY=\[redacted\]/);
  assert.equal(preview.body.includes("secret-value"), false);
  assert.equal((await f.service.read({ ...f.node, id: "codex:other" }, files[0].id)).state, "expired");
  const download = await f.service.read(f.node, files[0].id, { download: true });
  assert.equal(download.contentType, "text/plain; charset=utf-8");
  assert.ok(Buffer.isBuffer(download.body));
  assert.equal(download.body.toString("utf8"), preview.body);
});

test("ordinary polling preserves older tail associations but changed entries replace refs", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "one.txt"), "one");
  await writeFile(join(f.root, "two.txt"), "two");
  const one = await register(f, "one.txt", "old");
  let files = await f.service.register(f.node, local(entry("new", ["two.txt"])));
  assert.equal(files.length, 2);
  assert.equal((await f.service.read(f.node, one.id)).state, "available");
  files = await f.service.register(f.node, local(entry("old", ["two.txt"])));
  assert.equal(files.length, 1);
  assert.equal(files[0].associations.length, 2);
  assert.equal((await f.service.read(f.node, one.id)).state, "expired");
  assert.deepEqual(await f.service.register(f.node, local(entry("old", []), entry("new", []))), []);
});

test("archive revisions revoke archive-only refs and preserve independently local evidence", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "one.txt"), "one");
  await writeFile(join(f.root, "two.txt"), "two");
  let files = await f.service.register(f.node, { ...local(entry("local", ["one.txt"])), ...archive("r1", entry("archive", ["one.txt", "two.txt"])) });
  const two = files.find((x) => x.name === "two.txt");
  files = await f.service.register(f.node, archive("r2"));
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "one.txt");
  assert.deepEqual(files[0].associations, [{ entryId: "local", kind: "linked" }]);
  assert.equal((await f.service.read(f.node, two.id)).state, "expired");
  await f.service.register(f.node, archive("r2", entry("archive", ["two.txt"])));
  files = await f.service.register(f.node, { archive: { state: "mismatch", entries: [] } });
  assert.equal(files.length, 1);
  assert.deepEqual(await f.service.register(f.node, { local: { state: "restricted", entries: [] } }), []);
});

test("references expire after 30 minutes while renewed evidence extends only its own lifetime", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "one.txt"), "one");
  await writeFile(join(f.root, "two.txt"), "two");
  const first = await register(f, "one.txt", "old");
  f.advance(20 * 60_000);
  const files = await f.service.register(f.node, local(entry("new", ["two.txt"])));
  const second = files.find((x) => x.name === "two.txt");
  f.advance(11 * 60_000);
  assert.equal((await f.service.read(f.node, first.id)).state, "expired");
  assert.equal((await f.service.read(f.node, second.id)).state, "available");
  f.advance(20 * 60_000);
  assert.equal((await f.service.read(f.node, second.id)).state, "expired");
});

test("traversal, external absolute paths, protected filenames and private aliases are restricted", async (t) => {
  const f = await fixture(t);
  const privateRoot = join(f.home, "body-os", "me");
  await mkdir(privateRoot, { recursive: true });
  await symlink(privateRoot, join(f.root, "alias"));
  await symlink(join(f.home, "outside-missing"), join(f.root, "outside-link"));
  const paths = ["../outside.txt", join(f.home, "outside.txt"), "alias/private.txt", "outside-link", "body-os/missing.txt", "Sokra/secret.txt", ".env", ".env.production", ".ssh/id_ed25519", "config.pem", "credentials.json", ".aws/config", ".npmrc", ".git/config", ".docker/config.json"];
  const files = await f.service.register(f.node, local(entry("unsafe", paths)));
  assert.equal(files.length, paths.length - 1, "normalized paths are deduplicated");
  assert.ok(files.every((f) => f.state === "restricted"));
  for (const file of files) assert.equal((await f.service.read(f.node, file.id)).state, "restricted");
});

test("a symlink to another allowed file works but changing it revokes its captured identity", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "one.txt"), "one");
  await writeFile(join(f.root, "two.txt"), "two");
  await symlink("one.txt", join(f.root, "alias.txt"));
  const file = await register(f, "alias.txt");
  assert.equal((await f.service.read(f.node, file.id)).body, "one");
  await unlink(join(f.root, "alias.txt"));
  await symlink("two.txt", join(f.root, "alias.txt"));
  assert.equal((await f.service.read(f.node, file.id)).state, "changed");
  const updated = await register(f, "alias.txt");
  assert.notEqual(updated.id, file.id);
  assert.equal((await f.service.read(f.node, file.id)).state, "changed");
  assert.equal((await f.service.read(f.node, updated.id)).body, "two");
});

test("credential targets and root aliases cannot bypass literal or resolved exclusions", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, ".env"), "synthetic credential");
  await symlink(".env", join(f.root, "public.txt"));
  assert.equal((await register(f, "public.txt")).state, "restricted");
  const blocked = join(f.home, "body-os", "project");
  await mkdir(blocked, { recursive: true });
  await symlink(blocked, join(f.home, "alias-root"));
  const files = await f.service.register({ ...f.node, cwd: join(f.home, "alias-root") }, local(entry("test", ["answer.txt"])));
  assert.equal(files[0].state, "restricted");
});

test("filesystem root, home and ancestors of home are never artifact roots", async (t) => {
  const f = await fixture(t);
  for (const cwd of ["/", f.home, tmpdir(), "relative/workspace"]) {
    const node = { ...f.node, cwd };
    const [file] = await f.service.register(node, local(entry("test", ["readme.txt"])));
    assert.equal(file.state, "restricted", cwd);
    assert.equal((await f.service.read(node, file.id)).state, "restricted");
  }
});

test("nonregular files are unavailable without opening blocking FIFOs", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "directory.txt"));
  await run("mkfifo", [join(f.root, "pipe.txt")]);
  const files = await f.service.register(f.node, local(entry("test", ["directory.txt", "pipe.txt"])));
  assert.deepEqual(files.map((f) => f.state), ["unsupported", "unsupported"]);
  for (const file of files) assert.equal((await f.service.read(f.node, file.id)).state, "unsupported");
});

test("deleting, replacing or editing a file cannot serve its old reference", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "one.txt"), "one");
  let file = await register(f, "one.txt");
  await unlink(join(f.root, "one.txt"));
  assert.equal((await f.service.read(f.node, file.id)).state, "missing");
  await writeFile(join(f.root, "one.txt"), "two");
  assert.equal((await f.service.read(f.node, file.id)).state, "changed");
  file = await register(f, "one.txt");
  await writeFile(join(f.root, "one.txt"), "new bytes with same inode");
  assert.equal((await f.service.read(f.node, file.id)).state, "changed");
  const next = await register(f, "one.txt");
  assert.equal((await f.service.read(f.node, next.id)).body, "new bytes with same inode");
});

test("source replacement, disappearance, transcript identity and session root changes revoke IDs", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "one.txt"), "one");
  let file = await register(f, "one.txt");
  await rename(f.source, `${f.source}.old`);
  await writeFile(f.source, "new transcript");
  assert.equal((await f.service.read(f.node, file.id)).state, "expired");
  file = await register(f, "one.txt");
  await unlink(f.source);
  assert.equal((await f.service.read(f.node, file.id)).state, "expired");
  await writeFile(f.source, "new transcript");
  for (const change of [{ agentsviewId: "other" }, { transcript: `${f.source}.other` }, { source: `${f.source}.other` }, { cwd: join(f.home, "other") }]) {
    file = await register(f, "one.txt");
    assert.equal((await f.service.read({ ...f.node, ...change }, file.id)).state, "expired");
  }
  file = await register(f, "one.txt");
  await rename(f.root, `${f.root}-old`);
  await mkdir(f.root);
  await writeFile(join(f.root, "one.txt"), "one");
  assert.equal((await f.service.read(f.node, file.id)).state, "expired");
});

test("growing the same transcript does not revoke valid artifact IDs", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "one.txt"), "one");
  const file = await register(f, "one.txt");
  await writeFile(f.source, "longer transcript with same inode");
  assert.equal((await f.service.read(f.node, file.id)).state, "available");
});

test("image headers must match the filename extension and HTML/SVG are inert text", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "image.png"), png);
  await writeFile(join(f.root, "mismatch.jpg"), png);
  await writeFile(join(f.root, "spoof.png"), "<script>alert('synthetic')</script>");
  await writeFile(join(f.root, "page.html"), "<script>alert('synthetic')</script>");
  await writeFile(join(f.root, "image.svg"), "<svg onload='synthetic()'></svg>");
  const files = await f.service.register(f.node, local(entry("test", ["image.png", "mismatch.jpg", "spoof.png", "page.html", "image.svg"])));
  const outputs = await Promise.all(files.map((file) => f.service.read(f.node, file.id)));
  assert.equal(outputs[0].contentType, "image/png");
  assert.deepEqual(outputs[0].body, png);
  assert.equal(outputs[1].state, "unsupported");
  assert.equal(outputs[2].state, "unsupported");
  assert.equal(outputs[3].contentType, "text/plain; charset=utf-8");
  assert.equal(outputs[4].contentType, "text/plain; charset=utf-8");
});

test("text previews and downloads are bounded; binary bytes cannot be served as text", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "large.txt"), "a".repeat(70 * 1024));
  let file = await register(f, "large.txt");
  let output = await f.service.read(f.node, file.id);
  assert.equal(output.body.length, 64 * 1024);
  assert.equal(output.truncated, true);
  output = await f.service.read(f.node, file.id, { download: true });
  assert.equal(output.body.length, 70 * 1024);
  await truncate(join(f.root, "large.txt"), 8 * 1024 * 1024 + 1);
  file = await register(f, "large.txt");
  assert.equal((await f.service.read(f.node, file.id, { download: true })).state, "oversized");
  await writeFile(join(f.root, "binary.txt"), Buffer.from([65, 0, 66]));
  file = await register(f, "binary.txt", "binary");
  const binary = (await f.service.register(f.node, local(entry("binary", ["binary.txt"])))).find((f) => f.name === "binary.txt");
  assert.equal((await f.service.read(f.node, binary.id)).state, "unsupported");
});

test("images and document downloads enforce 8 MiB and documents have no inline body", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "large.png"), png);
  await truncate(join(f.root, "large.png"), 8 * 1024 * 1024 + 1);
  await writeFile(join(f.root, "report.pdf"), "%PDF-1.7\nSynthetic document\n");
  const files = await f.service.register(f.node, local(entry("test", ["large.png", "report.pdf"])));
  assert.equal(files[0].state, "oversized");
  assert.equal((await f.service.read(f.node, files[0].id)).state, "oversized");
  assert.equal((await f.service.read(f.node, files[1].id)).state, "unsupported");
  const download = await f.service.read(f.node, files[1].id, { download: true });
  assert.equal(download.state, "available");
  assert.equal(download.contentType, "application/pdf");
  assert.equal(download.filename, "report.pdf");
});

test("registry bounds candidates, files, sessions and explicit revocation", async (t) => {
  const f = await fixture(t);
  const many = Array.from({ length: 160 }, (_, i) => `missing-${i}.txt`);
  let files = await f.service.register(f.node, local(entry("bounded", many)));
  assert.equal(files.length, 32);
  files = await f.service.register(f.node, local(...Array.from({ length: 5 }, (_, i) => entry(`batch-${i}`, many.slice(i * 32, i * 32 + 32)))));
  assert.equal(files.length, 128);
  const id = files[0].id;
  for (let i = 0; i < 24; i++) await f.service.register({ ...f.node, id: `other-${i}` }, local(entry("test", ["missing.txt"])));
  assert.equal((await f.service.read(f.node, id)).state, "expired");
  files = await f.service.register(f.node, local(entry("test", ["missing.txt"])));
  f.service.revoke(f.node.id);
  assert.equal((await f.service.read(f.node, files[0].id)).state, "expired");
});

test("canonical aliases of the configured home remain broad roots", async (t) => {
  const f = await fixture(t);
  const alias = join(f.home, "home-alias");
  await symlink(f.home, alias);
  const service = createArtifactService({ home: alias });
  const node = { ...f.node, cwd: f.home };
  const [file] = await service.register(node, local(entry("test", ["synthetic.jsonl"])));
  assert.equal(file.state, "restricted");
});

test("partial private-key blocks at the preview boundary cannot leak key material", async (t) => {
  const f = await fixture(t);
  const secret = "-----BEGIN PRIVATE KEY-----\n" + "synthetic-secret-material".repeat(5000) + "\n-----END PRIVATE KEY-----";
  await writeFile(join(f.root, "notes.txt"), secret);
  const file = await register(f, "notes.txt");
  const output = await f.service.read(f.node, file.id);
  assert.equal(output.state, "available");
  assert.equal(output.truncated, true);
  assert.equal(output.body, "[redacted private key]");
  const download = await f.service.read(f.node, file.id, { download: true });
  assert.equal(download.body.toString(), "[redacted private key]");
});

test("reference associations are bounded even when every entry mentions the same file", async (t) => {
  const f = await fixture(t);
  const make = (offset) => Array.from({ length: 400 }, (_, i) => entry(`entry-${i + offset}`, ["missing.txt"]));
  await f.service.register(f.node, local(...make(0)));
  let files = await f.service.register(f.node, local(...make(400)));
  assert.equal(files.length, 1);
  assert.equal(files[0].associations.length, 400);
  files = await f.service.register(f.node, local(entry("x".repeat(513), ["another.txt"])));
  assert.equal(files.length, 1);
});

test("an in-flight read cannot survive explicit registry revocation", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "one.txt"), "one");
  const file = await register(f, "one.txt");
  const pending = f.service.read(f.node, file.id);
  f.service.revoke(f.node.id);
  const output = await pending;
  assert.equal(output.state, "expired");
  assert.equal(output.body, undefined);
});

test("active branches preserve straight appends but revoke abandoned local associations", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "one.txt"), "one");
  await writeFile(join(f.root, "two.txt"), "two");
  const branch = (head, ancestry, ...entries) => ({ local: { state: "available", branch: { head, ancestry }, entries } });
  const [one] = await f.service.register(f.node, branch("head-1", ["head-1"], entry("old", ["one.txt"])));
  let files = await f.service.register(f.node, branch("head-2", ["head-2", "head-1"], entry("new", ["two.txt"])));
  assert.equal(files.length, 2);
  assert.equal((await f.service.read(f.node, one.id)).state, "available");
  await f.service.register(f.node, archive("r1", entry("archived", ["one.txt"])));
  files = await f.service.register(f.node, branch("fork", ["fork", "head-1"], entry("new-branch", ["two.txt"])));
  assert.equal(files.length, 2);
  assert.deepEqual(files.find((file) => file.name === "one.txt").associations, [{ entryId: "archived", kind: "linked" }]);
  await f.service.register(f.node, archive("r2"));
  assert.equal((await f.service.read(f.node, one.id)).state, "expired");
  files = await f.service.register(f.node, branch("after-gap", ["after-gap"], entry("after-gap-entry", ["one.txt"])));
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "one.txt");
});

test("stale local evidence cannot register files after its source identity is replaced", async (t) => {
  const f = await fixture(t);
  const { realpath, stat } = await import("node:fs/promises");
  await writeFile(join(f.root, "one.txt"), "one");
  const st = await stat(f.source, { bigint: true });
  const sourceIdentity = { path: await realpath(f.source), dev: String(st.dev), ino: String(st.ino) };
  const evidence = { local: { state: "available", sourceIdentity, entries: [entry("test", ["one.txt"])] } };
  const [file] = await f.service.register(f.node, evidence);
  assert.equal((await f.service.read(f.node, file.id)).state, "available");
  await rename(f.source, `${f.source}.old`);
  await writeFile(f.source, "new source");
  assert.deepEqual(await f.service.register(f.node, evidence), []);
  assert.equal((await f.service.read(f.node, file.id)).state, "expired");
});

test("file-cap eviction removes older evidence before the newest prior file", async (t) => {
  const f = await fixture(t);
  const entries = Array.from({ length: 128 }, (_, i) => entry(`entry-${i}`, [`missing-${i}.txt`]));
  const before = await f.service.register(f.node, local(...entries));
  const oldest = before.find((file) => file.name === "missing-0.txt");
  const newest = before.find((file) => file.name === "missing-127.txt");
  const after = await f.service.register(f.node, local(entry("entry-128", ["missing-128.txt"])));
  assert.equal(after.length, 128);
  assert.equal((await f.service.read(f.node, oldest.id)).state, "expired");
  assert.equal((await f.service.read(f.node, newest.id)).state, "missing");
});

test("unverified archive branches cannot reintroduce abandoned Pi, OMP or fleet artifacts", async (t) => {
  const f = await fixture(t);
  for (const agent of ["pi", "omp", "fleet"]) {
    const node = { ...f.node, agent };
    assert.deepEqual(await f.service.register(node, archive("r1", entry("archived", ["answer.txt"]))), []);
    const files = await f.service.register(node, { ...archive("r1", entry("archived", ["other.txt"])), ...local(entry("local", ["answer.txt"])) });
    assert.equal(files.length, 1);
    assert.equal(files[0].name, "answer.txt");
  }
});

test("case-insensitive home and ancestor aliases remain restricted", async (t) => {
  const f = await fixture(t);
  const caseHome = join(f.home, "CaseHome");
  await mkdir(caseHome);
  await writeFile(join(caseHome, "synthetic.txt"), "synthetic");
  const { realpath } = await import("node:fs/promises");
  const alternate = join(f.home, "casehome");
  if (await realpath(alternate).catch(() => null) !== await realpath(caseHome)) return;
  let service = createArtifactService({ home: caseHome });
  let node = { ...f.node, cwd: alternate };
  let [file] = await service.register(node, local(entry("test", ["synthetic.txt"])));
  assert.equal(file.state, "restricted");
  const nestedHome = join(caseHome, "User");
  await mkdir(nestedHome);
  service = createArtifactService({ home: nestedHome });
  [file] = await service.register(node, local(entry("test", ["synthetic.txt"])));
  assert.equal(file.state, "restricted");
});

async function interceptOpen(intercept, work) {
  const original = fs.promises.open;
  fs.promises.open = (...args) => intercept(original, ...args);
  syncBuiltinESMExports();
  try { return await work(); }
  finally { fs.promises.open = original; syncBuiltinESMExports(); }
}

test("replacement during a bounded read discards all captured bytes", async (t) => {
  const f = await fixture(t);
  const path = join(f.root, "one.txt");
  await writeFile(path, "original allowed content");
  const file = await register(f, "one.txt");
  let swapped = false;
  const output = await interceptOpen(async (original, ...args) => {
    const handle = await original(...args);
    const read = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      if (!swapped) {
        swapped = true;
        await rename(path, `${path}.old`);
        await writeFile(path, "replacement content");
      }
      return read(...readArgs);
    };
    return handle;
  }, () => f.service.read(f.node, file.id));
  assert.equal(swapped, true);
  assert.equal(output.state, "changed");
  assert.equal(output.body, undefined);
});

test("a parent-directory escape between validation and open never reads outside bytes", async (t) => {
  const f = await fixture(t);
  const directory = join(f.root, "output");
  const outside = join(f.home, "outside");
  await mkdir(directory);
  await mkdir(outside);
  await writeFile(join(directory, "one.txt"), "allowed content");
  await writeFile(join(outside, "one.txt"), "outside synthetic content");
  const file = await register(f, "output/one.txt");
  let reads = 0;
  const output = await interceptOpen(async (original, ...args) => {
    await rename(directory, `${directory}.old`);
    await symlink(outside, directory);
    const handle = await original(...args);
    const read = handle.read.bind(handle);
    handle.read = (...readArgs) => { reads++; return read(...readArgs); };
    return handle;
  }, () => f.service.read(f.node, file.id));
  assert.equal(output.state, "changed");
  assert.equal(reads, 0);
  assert.equal(output.body, undefined);
});

test("a FIFO substituted immediately before open cannot block or produce a preview", { timeout: 3000 }, async (t) => {
  const f = await fixture(t);
  const path = join(f.root, "one.txt");
  await writeFile(path, "allowed content");
  const file = await register(f, "one.txt");
  const output = await interceptOpen(async (original, ...args) => {
    await unlink(path);
    await run("mkfifo", [path]);
    return original(...args);
  }, () => f.service.read(f.node, file.id));
  assert.equal(output.state, "changed");
  assert.equal(output.body, undefined);
});

test("text byte limits preserve complete UTF-8 characters at the preview boundary", async (t) => {
  const f = await fixture(t);
  const text = "€".repeat(23_000);
  await writeFile(join(f.root, "unicode.txt"), text);
  const file = await register(f, "unicode.txt");
  const preview = await f.service.read(f.node, file.id);
  assert.equal(preview.state, "available");
  assert.equal(preview.truncated, true);
  assert.ok(Buffer.byteLength(preview.body) <= 64 * 1024);
  assert.equal(preview.body.includes("�"), false);
  assert.ok(text.startsWith(preview.body));
  assert.equal((await f.service.read(f.node, file.id, { download: true })).body.toString(), text);
});

test("workspace aliases accept canonical absolute links without widening the boundary", async (t) => {
  const f = await fixture(t);
  const { realpath } = await import("node:fs/promises");
  await writeFile(join(f.root, "answer.txt"), "allowed artifact");
  const alias = join(f.home, "project-link");
  await symlink(f.root, alias);
  const canonical = await realpath(f.root);
  const node = { ...f.node, cwd: alias };
  const paths = [join(canonical, "answer.txt"), join(alias, "answer.txt"), join(canonical, ".env"), join(canonical, "..", "outside.txt")];
  const files = await f.service.register(node, local(entry("test", paths)));
  assert.deepEqual(files.map((file) => file.state), ["available", "available", "restricted", "restricted"]);
  for (const file of files.slice(0, 2)) assert.equal((await f.service.read(node, file.id)).body, "allowed artifact");
  const [relative] = await f.service.register(node, local(entry("test", ["answer.txt"])));
  assert.equal((await f.service.read(node, relative.id)).body, "allowed artifact");
});
