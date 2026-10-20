import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

test("native artifact downloads admit only bounded same-origin attachments and safe filenames", { skip: process.platform !== "darwin", timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-fleet-native-policy-"));
  try {
    const app = await readFile(new URL("../desktop/AgentFleet.swift", import.meta.url), "utf8");
    const marker = "\n@main\nstruct AgentFleetMain";
    assert.equal(app.split(marker).length, 2, "the harness must exclude the actual application launch");
    const source = app.split(marker)[0] + String.raw`

let app = FleetApp()
let valid = "http://127.0.0.1:7420/api/sessions/codex%3Aexample%2Fsession/artifacts/11111111-2222-3333-4444-555555555555/download"
let url = URL(string: valid)!
precondition(app.artifactDownloadURL(url))
precondition(app.artifactDownloadURL(URL(string: valid.replacingOccurrences(of: "11111111-2222-3333-4444-555555555555", with: String(repeating: "a", count: 64)))))
for invalid in [
    valid.replacingOccurrences(of: "127.0.0.1", with: "localhost"),
    valid.replacingOccurrences(of: ":7420", with: ":7421"),
    valid.replacingOccurrences(of: "http:", with: "https:"),
    valid.replacingOccurrences(of: "127.0.0.1", with: "user@127.0.0.1"),
    valid.replacingOccurrences(of: "11111111-2222-3333-4444-555555555555", with: "../secrets"),
    valid.replacingOccurrences(of: "11111111-2222-3333-4444-555555555555", with: "%2e%2e"),
    valid.replacingOccurrences(of: "codex%3Aexample%2Fsession", with: ""),
    valid + "?path=/tmp/document.pdf", valid + "#x",
    "file:///tmp/document.pdf", "blob:http://127.0.0.1:7420/id",
    "http://127.0.0.1:7420/api/control"
] { precondition(!app.artifactDownloadURL(URL(string: invalid)), invalid) }

func response(_ status: Int = 200, _ headers: [String: String] = ["Content-Disposition": "attachment; filename=document.pdf", "Content-Length": "100"], _ responseURL: URL = url) -> HTTPURLResponse {
    HTTPURLResponse(url: responseURL, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
}
let request = URLRequest(url: url)
precondition(app.artifactResponseAccepted(response(), request: request))
precondition(app.artifactResponseAccepted(response(200, ["Content-Disposition": "ATTACHMENT; filename=empty.txt", "Content-Length": "0"]), request: request))
precondition(app.artifactResponseAccepted(response(200, ["Content-Disposition": "attachment", "Content-Length": "8388608"]), request: request))
for status in [204, 301, 302, 400, 403, 404, 409, 410, 413, 500, 503] {
    precondition(!app.artifactResponseAccepted(response(status), request: request))
}
for headers in [
    ["Content-Type": "application/json", "Content-Length": "100"],
    ["Content-Disposition": "inline; filename=document.pdf", "Content-Length": "100"],
    ["Content-Disposition": "attachment-extra", "Content-Length": "100"],
    ["Content-Disposition": "attachment"],
    ["Content-Disposition": "attachment", "Content-Length": "8388609"]
] { precondition(!app.artifactResponseAccepted(response(200, headers), request: request)) }
precondition(!app.artifactResponseAccepted(response(200, ["Content-Disposition": "attachment", "Content-Length": "100"], URL(string: valid.replacingOccurrences(of: "codex%3Aexample%2Fsession", with: "another-session"))!), request: request))
precondition(!app.artifactResponseAccepted(response(), request: nil))

precondition(app.artifactFilename("../../document.pdf") == "document.pdf")
precondition(app.artifactFilename("C:\\directory\\document.pdf") == "document.pdf")
precondition(app.artifactFilename("..") == "artifact")
precondition(app.artifactFilename(" .\n. ") == "artifact")
precondition(app.artifactFilename("bad:\u{202E}name\n.pdf") == "bad-name.pdf")
let long = app.artifactFilename(String(repeating: "é", count: 200) + ".pdf")
precondition(long.utf8.count <= 240 && long.hasSuffix(".pdf"))
precondition(app.artifactFilename("a" + String(repeating: "\u{0301}", count: 200) + ".pdf") == "artifact.pdf")
print("Native download policy checks passed")
`;
    const swift = join(directory, "main.swift");
    const binary = join(directory, "native-policy");
    await writeFile(swift, source);
    const architecture = process.arch === "arm64" ? "arm64" : "x86_64";
    await exec("xcrun", ["swiftc", "-swift-version", "5", "-target", `${architecture}-apple-macosx13.0`, "-framework", "AppKit", "-framework", "WebKit", "-framework", "UserNotifications", "-module-cache-path", join(directory, "modules"), new URL("../desktop/AttentionNotifications.swift", import.meta.url).pathname, swift, "-o", binary], { timeout: 110_000, maxBuffer: 1024 * 1024 });
    const { stdout } = await exec(binary, [], { timeout: 5000 });
    assert.match(stdout, /Native download policy checks passed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
