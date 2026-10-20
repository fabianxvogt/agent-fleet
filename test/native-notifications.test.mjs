import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);

test("native notifications baseline fresh sources, deduplicate requests and invalidate late callbacks", { skip: process.platform !== "darwin", timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-fleet-notifications-"));
  let server;
  try {
    const swift = join(directory, "main.swift"), binary = join(directory, "notifications");
    await writeFile(swift, String.raw`
import Foundation

var assertions = 0
func check(_ condition: @autoclosure () -> Bool, _ message: String = "") {
    assertions += 1
    precondition(condition(), message)
}
func rejects(_ action: () throws -> Void) {
    do { try action(); preconditionFailure("Expected rejection") } catch { assertions += 1 }
}
let base = AttentionFeed.date("2026-10-21T10:00:00.000Z")!
let instance = "11111111-2222-3333-4444-555555555555"
let formatter = ISO8601DateFormatter()
formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
func iso(_ date: Date) -> String { formatter.string(from: date) }
func ask(_ id: Int, source: String = "codex", session: String = "codex:one", at: Date = base) -> [String: Any] {
    ["sessionId": session, "requestId": String(format: "%064x", id), "sourceId": source, "kind": "question", "at": iso(at)]
}
func body(_ time: Date, _ requests: [[String: Any]] = [], health: [String: Bool] = ["codex": true, "claude": true], process: Bool = true, truncated: Bool = false, instanceId: String = instance) -> [String: Any] {
    ["version": 1, "instanceId": instanceId, "observedAt": iso(time), "staleAfterMs": 12000,
     "process": ["observedAt": iso(time), "current": process],
     "sources": health.keys.sorted().map { ["id": $0, "observedAt": iso(time), "current": health[$0]!] as [String: Any] },
     "requests": requests, "truncated": truncated]
}
func data(_ value: [String: Any]) -> Data { try! JSONSerialization.data(withJSONObject: value) }
func feed(_ time: Date, _ requests: [[String: Any]] = [], health: [String: Bool] = ["codex": true, "claude": true], process: Bool = true, truncated: Bool = false, instanceId: String = instance) -> AttentionFeed {
    try! AttentionFeed.decode(data(body(time, requests, health: health, process: process, truncated: truncated, instanceId: instanceId)), now: time)
}

var navigation = AttentionNavigationIntent()
navigation.select("codex:first")
let firstLoad = navigation.revision
// Native completion is keyed by the load revision, not by a query parameter
// that the dashboard can already have consumed through history.replaceState.
navigation.complete(firstLoad)
check(navigation.sessionId == nil, "consumed URL still completes the native intent")
navigation.select("codex:first")
let oldLoad = navigation.revision
navigation.select("codex:second")
navigation.complete(oldLoad)
check(navigation.sessionId == "codex:second", "late old navigation preserves newer click")
navigation.complete(navigation.revision)
check(navigation.sessionId == nil)
navigation.select("invalid\nsession")
check(navigation.sessionId == nil)
navigation.select("codex:first"); navigation.cancel()
check(navigation.sessionId == nil, "closing the window cancels a pending native intent")
let unusualSession = "codex:a+b&c/#? ü"
navigation.select(unusualSession)
let selectionURL = navigation.url(dashboard: URL(string: "http://127.0.0.1:7420/")!)
check(selectionURL.absoluteString.contains("%2B") && !selectionURL.absoluteString.contains("+"), "query plus cannot decode as a space")
check(URLComponents(url: selectionURL, resolvingAgainstBaseURL: false)!.queryItems!.first!.value == unusualSession, "session navigation round-trips reserved and Unicode characters")
check(selectionURL.host == "127.0.0.1" && selectionURL.path == "/", "metadata cannot change navigation origin/path")

if CommandLine.arguments.count > 1 {
    let client = AttentionHTTPClient(dashboard: URL(string: CommandLine.arguments[1])!)
    var done = false, success = false
    client.fetch { result in done = true; if case .success = result { success = true } }
    let deadline = Date().addingTimeInterval(7)
    while !done && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
    check(done, "transport callback must finish")
    check(success == (CommandLine.arguments[2] == "success"), "transport result")
    client.cancel()
    print("Transport checks passed")
    exit(0)
}

var reducer = AttentionReducer()
check(try! reducer.apply(feed(base, [ask(1)]), now: base).isEmpty, "startup baseline")
check(try! reducer.apply(feed(base.addingTimeInterval(1), [ask(1)]), now: base.addingTimeInterval(1)).isEmpty, "unchanged")
check(try! reducer.apply(feed(base.addingTimeInterval(2), [ask(1), ask(2), ask(3)]), now: base.addingTimeInterval(2)).count == 2, "concurrent asks")
check(try! reducer.apply(feed(base.addingTimeInterval(3), [ask(2)]), now: base.addingTimeInterval(3)).isEmpty)
check(reducer.active.count == 1, "fresh complete source resolves missing asks")
check(try! reducer.apply(feed(base.addingTimeInterval(4), [ask(1), ask(2)]), now: base.addingTimeInterval(4)).isEmpty, "same ask cannot resurface")
let retained = ask(1)
check(try! reducer.apply(feed(base.addingTimeInterval(5), [ask(8, source: "claude", session: "claude:a")], health: ["codex": false, "claude": true]), now: base.addingTimeInterval(5)).count == 1)
check(reducer.active.values.contains { $0.requestId == retained["requestId"] as! String }, "stale source is not resolved")
check(try! reducer.apply(feed(base.addingTimeInterval(6), [ask(9), ask(8, source: "claude", session: "claude:a"), ask(10, source: "claude", session: "claude:b")]), now: base.addingTimeInterval(6)).map(\.sessionId) == ["claude:b"], "only recovered source is baselined")
check(try! reducer.apply(feed(base.addingTimeInterval(7), [], health: ["claude": true]), now: base.addingTimeInterval(7)).isEmpty)
check(reducer.active.values.contains { $0.sourceId == "codex" }, "missing source is unknown")
check(try! reducer.apply(feed(base.addingTimeInterval(8), [ask(11)]), now: base.addingTimeInterval(8)).isEmpty, "missing source recovery baseline")
check(try! reducer.apply(feed(base.addingTimeInterval(9), [], process: false), now: base.addingTimeInterval(9)).isEmpty)
check(reducer.healthy.isEmpty && !reducer.active.isEmpty, "unhealthy process preserves unresolved references")
check(try! reducer.apply(feed(base.addingTimeInterval(10), [ask(12)]), now: base.addingTimeInterval(10)).isEmpty)
check(try! reducer.apply(feed(base.addingTimeInterval(11), [], truncated: true), now: base.addingTimeInterval(11)).isEmpty)
check(try! reducer.apply(feed(base.addingTimeInterval(12), [ask(13)]), now: base.addingTimeInterval(12)).isEmpty, "truncation recovery baseline")
check(try! reducer.apply(feed(base.addingTimeInterval(13), [ask(14)], instanceId: "22222222-2222-3333-4444-555555555555"), now: base.addingTimeInterval(13)).isEmpty, "server replacement baseline")
rejects { _ = try reducer.apply(feed(base.addingTimeInterval(13), [ask(15)], instanceId: "22222222-2222-3333-4444-555555555555"), now: base.addingTimeInterval(13)) }
reducer.interrupt()
check(try! reducer.apply(feed(base.addingTimeInterval(14), [ask(16)], instanceId: "22222222-2222-3333-4444-555555555555"), now: base.addingTimeInterval(14)).isEmpty, "failure recovery baseline")
var staleBody = body(base.addingTimeInterval(15), [ask(16)])
staleBody["sources"] = [["id": "codex", "current": true, "observedAt": iso(base)]]
let staleFeed = try! AttentionFeed.decode(data(staleBody), now: base.addingTimeInterval(15))
var staleReducer = AttentionReducer()
check(try! staleReducer.apply(staleFeed, now: base.addingTimeInterval(15)).isEmpty && staleReducer.healthy.isEmpty, "stale timestamps override current flag")
var bounded = AttentionReducer(ledgerLimit: 2, ledgerTTL: 2)
_ = try! bounded.apply(feed(base, [ask(1)]), now: base)
_ = try! bounded.apply(feed(base.addingTimeInterval(1), [ask(2)], health: ["codex": true]), now: base.addingTimeInterval(1))
_ = try! bounded.apply(feed(base.addingTimeInterval(4), [], health: [:]), now: base.addingTimeInterval(4))
check(bounded.active.isEmpty, "unknown references expire within bounded lifetime")

for edit in [
    { (v: inout [String: Any]) in v["version"] = 2 },
    { v in v["instanceId"] = "not-a-uuid" },
    { v in v["observedAt"] = iso(base.addingTimeInterval(60)) },
    { v in v["observedAt"] = iso(base.addingTimeInterval(-60)) },
    { v in v["staleAfterMs"] = -1 },
    { v in v["staleAfterMs"] = 3_600_001 },
    { v in v["process"] = ["current": true, "observedAt": "bad"] },
    { v in v["sources"] = [["id": "codex", "current": true, "observedAt": iso(base)], ["id": "codex", "current": true, "observedAt": iso(base)]] },
    { v in v["sources"] = [["id": "codex\n", "current": true, "observedAt": iso(base)]] },
    { v in v["requests"] = [ask(1), ask(1)] },
    { v in v["requests"] = [ask(1, source: "missing")] },
    { v in v["requests"] = [ask(1, session: " session")] },
    { v in v["requests"] = [ask(1, session: "codex:\u{0001}")] },
    { v in v["requests"] = [ask(1, session: String(repeating: "x", count: 513))] },
    { v in var a = ask(1); a["requestId"] = String(repeating: "A", count: 64); v["requests"] = [a] },
    { v in var a = ask(1); a["kind"] = "completed"; v["requests"] = [a] },
    { v in v["requests"] = [ask(1, at: base.addingTimeInterval(1))] },
    { v in v["requests"] = (1...1025).map { ask($0) } },
    { v in v["truncated"] = true; v["requests"] = [ask(1)] }
] {
    var invalid = body(base)
    edit(&invalid)
    rejects { _ = try AttentionFeed.decode(data(invalid), now: base) }
}
rejects { _ = try AttentionFeed.decode(Data(repeating: 32, count: AttentionFeed.byteLimit + 1), now: base) }
check((try! AttentionFeed.decode(data(body(base, [ask(1, at: base.addingTimeInterval(-86400))])), now: base)).requests.count == 1, "old active asks remain valid")

let endpoint = URL(string: "http://127.0.0.1:7420/api/attention")!
func response(_ code: Int, _ headers: [String: String], url: URL = endpoint) -> HTTPURLResponse {
    HTTPURLResponse(url: url, statusCode: code, httpVersion: "HTTP/1.1", headerFields: headers)!
}
check(AttentionHTTPClient.accepts(response(200, ["Content-Type": "application/json", "Content-Length": "100"]), endpoint: endpoint))
check(!AttentionHTTPClient.accepts(response(200, ["Content-Type": "application/json", "Content-Length": "4194305"]), endpoint: endpoint))
check(!AttentionHTTPClient.accepts(response(404, ["Content-Type": "application/json"]), endpoint: endpoint))
check(!AttentionHTTPClient.accepts(response(200, ["Content-Type": "text/html"]), endpoint: endpoint))
check(!AttentionHTTPClient.accepts(response(200, ["Content-Type": "application/json"], url: URL(string: "http://localhost:7420/api/attention")!), endpoint: endpoint))

final class Fetcher: AttentionFetching {
    var callbacks: [(Result<Data, Error>) -> Void] = []
    var cancelCount = 0
    func fetch(_ completion: @escaping (Result<Data, Error>) -> Void) { callbacks.append(completion) }
    func cancel() { cancelCount += 1 }
    func answer(_ index: Int, _ value: [String: Any]) { callbacks[index](.success(data(value))) }
}
final class Delivery: AttentionDelivery {
    var onClick: ((String) -> Void)?
    var status = AttentionAuthorization.allowed
    var permissionRequests = 0, removals = 0
    var permission: ((Bool, Error?) -> Void)?
    var sent: [(String, Int, (Error?) -> Void)] = []
    var removed: [String] = []
    func authorization(_ completion: @escaping (AttentionAuthorization) -> Void) { completion(status) }
    func requestAuthorization(_ completion: @escaping (Bool, Error?) -> Void) { permissionRequests += 1; permission = completion }
    func deliver(id: String, sessions: Int, completion: @escaping (Error?) -> Void) { sent.append((id, sessions, completion)) }
    func remove(_ ids: [String]) { removed += ids }
    func removeOwned() { removals += 1 }
}
var time = base
let delivery = Delivery(), fetcher = Fetcher()
var saved: [Bool] = [], opened: [String?] = []
let controller = AttentionNotifications(enabled: false, delivery: delivery, fetcher: fetcher, persist: { saved.append($0) }, now: { time })
controller.onOpen = { opened.append($0) }
controller.start(schedule: false)
check(fetcher.callbacks.isEmpty && delivery.permissionRequests == 0 && controller.state == "off")
controller.toggle()
check(fetcher.callbacks.count == 1 && saved == [true])
controller.poll()
check(fetcher.callbacks.count == 1, "single flight")
fetcher.answer(0, body(time, [ask(1)]))
check(delivery.sent.isEmpty && controller.state == "on")
time = base.addingTimeInterval(1); controller.poll()
fetcher.answer(1, body(time, [ask(1), ask(2), ask(3), ask(4, session: "codex:two")]))
check(delivery.sent.count == 1 && delivery.sent[0].1 == 2, "one batch counts distinct sessions")
delivery.sent[0].2(nil)
delivery.onClick?(delivery.sent[0].0)
check(opened.count == 1 && opened[0] == nil, "click opens window then revalidates")
time = base.addingTimeInterval(2)
fetcher.answer(2, body(time, [ask(4, session: "codex:two")]))
check(opened.last! == "codex:two", "click selects first still-pending candidate")
time = base.addingTimeInterval(3); controller.poll()
fetcher.answer(3, body(time))
check(delivery.removed.contains(delivery.sent[0].0), "resolved batch removed")
time = base.addingTimeInterval(4); controller.poll()
controller.toggle()
check(controller.state == "off" && !controller.enabled)
fetcher.answer(4, body(time, [ask(5)]))
check(delivery.sent.count == 1, "disabled late feed ignored")
controller.toggle()
time = base.addingTimeInterval(5); fetcher.answer(5, body(time, [ask(5)]))
check(delivery.sent.count == 1, "re-enable baseline")
time = base.addingTimeInterval(6); controller.poll()
fetcher.answer(6, body(time, [ask(6)]))
check(delivery.sent.count == 2)
controller.toggle()
delivery.sent[1].2(nil)
check(delivery.removed.contains(delivery.sent[1].0), "late delivery after off removed")

let deniedDelivery = Delivery(), deniedFetcher = Fetcher()
deniedDelivery.status = .notDetermined
let denied = AttentionNotifications(enabled: false, delivery: deniedDelivery, fetcher: deniedFetcher, persist: { _ in }, now: { time })
denied.start(schedule: false)
check(deniedDelivery.permissionRequests == 0)
denied.toggle()
check(deniedDelivery.permissionRequests == 1 && denied.state == "updating")
deniedDelivery.permission?(false, nil)
check(denied.state == "blocked" && deniedFetcher.callbacks.isEmpty)
for _ in 0..<5 { time.addTimeInterval(61); denied.tick() }
check(deniedDelivery.permissionRequests == 1, "periodic recheck never prompts")
deniedDelivery.status = .allowed; denied.checkAuthorization()
check(deniedFetcher.callbacks.count == 1, "settings recovery starts baseline")
deniedFetcher.answer(0, body(time, [ask(9)]))
check(deniedDelivery.sent.isEmpty)
denied.stop()
denied.poll()
check(deniedFetcher.callbacks.count == 1)

let lateDelivery = Delivery(), lateFetcher = Fetcher()
lateDelivery.status = .notDetermined
let late = AttentionNotifications(enabled: false, delivery: lateDelivery, fetcher: lateFetcher, persist: { _ in })
late.start(schedule: false); late.toggle(); late.toggle()
lateDelivery.permission?(true, nil)
check(late.state == "off" && lateFetcher.callbacks.isEmpty, "late authorization cannot re-enable")

let failingDelivery = Delivery(), failingFetcher = Fetcher()
time = base
let failing = AttentionNotifications(enabled: true, delivery: failingDelivery, fetcher: failingFetcher, persist: { _ in }, now: { time })
failing.start(schedule: false)
failingFetcher.answer(0, body(time))
time.addTimeInterval(1); failing.poll()
failingFetcher.callbacks[1](.failure(AttentionError.transport))
check(failing.state == "updating")
time.addTimeInterval(1); failing.poll()
failingFetcher.answer(2, body(time, [ask(1)]))
check(failingDelivery.sent.isEmpty, "network recovery baseline")
time.addTimeInterval(1); failing.poll()
failingFetcher.answer(3, body(time, [ask(2)]))
check(failingDelivery.sent.count == 1)
failingDelivery.status = .blocked; failing.checkAuthorization()
failingDelivery.sent[0].2(nil)
check(failing.state == "blocked" && failingDelivery.removed.contains(failingDelivery.sent[0].0))

let clickDelivery = Delivery(), clickFetcher = Fetcher()
var clickOpened: [String?] = []
time = base
let clicking = AttentionNotifications(enabled: true, delivery: clickDelivery, fetcher: clickFetcher, persist: { _ in }, now: { time })
clicking.onOpen = { clickOpened.append($0) }
clicking.start(schedule: false); clickFetcher.answer(0, body(time))
time.addTimeInterval(1); clicking.poll(); clickFetcher.answer(1, body(time, [ask(1, session: "codex:original")]))
let originalId = clickDelivery.sent[0].0
clickDelivery.onClick?(originalId)
time.addTimeInterval(1); clickFetcher.answer(2, body(time, [ask(2, session: "codex:unrelated")]))
check(clickOpened.count == 1 && clickOpened[0] == nil, "resolved clicked batch cannot select an unrelated newer ask")
check(clickDelivery.removed.filter { $0 == originalId }.count == 1)
clickDelivery.sent[0].2(nil)
check(clickDelivery.removed.filter { $0 == originalId }.count == 2, "late OS add for resolved batch is removed again")
clickDelivery.onClick?(SystemAttentionDelivery.prefix + "unknown")
time.addTimeInterval(1); clickFetcher.answer(3, body(time, [ask(2, session: "codex:unrelated")]))
check(clickOpened.count == 2 && clickOpened[1] == nil, "unknown old notification opens overview only")
let currentId = clickDelivery.sent[1].0
clickDelivery.onClick?(currentId)
clickFetcher.callbacks[4](.failure(AttentionError.transport))
time.addTimeInterval(1); clicking.poll(); clickFetcher.answer(5, body(time, [ask(2, session: "codex:unrelated")]))
check(clickOpened.count == 3 && clickOpened[2] == nil, "failed click revalidation cannot jump on a later recovery")
clickDelivery.onClick?(currentId)
clicking.cancelPendingNavigation()
time.addTimeInterval(1); clickFetcher.answer(6, body(time, [ask(2, session: "codex:unrelated")]))
check(clickOpened.count == 4 && clickOpened[3] == nil, "closing during revalidation cancels the jump")
clickDelivery.onClick?(currentId)
clickDelivery.status = .blocked; clicking.checkAuthorization()
clickDelivery.status = .allowed; clicking.checkAuthorization()
time.addTimeInterval(1); clickFetcher.answer(8, body(time, [ask(2, session: "codex:unrelated")]))
check(clickOpened.count == 5 && clickOpened[4] == nil, "permission recovery cannot revive an interrupted click")
time.addTimeInterval(1); clicking.poll(); clickFetcher.answer(9, body(time, [ask(3)]))
let failedId = clickDelivery.sent.last!.0
clickDelivery.sent.last!.2(AttentionError.transport)
check(clicking.state == "blocked" && clickDelivery.removed.contains(failedId), "failed delivery cleans both notification ledgers")
print("Native notification checks passed: \(assertions)")
`);
    const architecture = process.arch === "arm64" ? "arm64" : "x86_64";
    await exec("xcrun", ["swiftc", "-swift-version", "5", "-target", `${architecture}-apple-macosx13.0`, "-framework", "UserNotifications", "-module-cache-path", join(directory, "modules"), fileURLToPath(new URL("../desktop/AttentionNotifications.swift", import.meta.url)), swift, "-o", binary], { timeout: 90_000, maxBuffer: 1024 * 1024 });
    const result = await exec(binary, [], { timeout: 10_000 });
    assert.match(result.stdout, /Native notification checks passed: \d+/);
    let mode = "valid", redirectHits = 0;
    server = createServer((req, res) => {
      if (req.url === "/redirect-target") { redirectHits++; res.end("{}"); return; }
      if (mode === "redirect") { res.writeHead(302, { location: "/redirect-target" }); res.end(); return; }
      if (mode === "timeout") return;
      if (mode === "header-limit") {
        res.writeHead(200, { "content-type": "application/json", "content-length": 4 * 1024 * 1024 + 1 }); res.end("{}"); return;
      }
      if (mode === "chunked-limit") {
        res.writeHead(200, { "content-type": "application/json" }); res.write(Buffer.alloc(4 * 1024 * 1024 + 1, 32)); res.end(); return;
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end("{}");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    for (const scenario of ["valid", "redirect", "header-limit", "chunked-limit", "timeout"]) {
      mode = scenario;
      const { stdout } = await exec(binary, [url, scenario === "valid" ? "success" : "failure"], { timeout: 9000, maxBuffer: 1024 * 1024 });
      assert.match(stdout, /Transport checks passed/, scenario);
    }
    assert.equal(redirectHits, 0, "the native client must not follow a redirect");
  } finally {
    server?.closeAllConnections();
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
