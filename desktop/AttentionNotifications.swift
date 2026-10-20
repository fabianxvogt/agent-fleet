import Foundation
import UserNotifications

struct AttentionNavigationIntent {
    private(set) var sessionId: String?
    private(set) var revision = 0
    mutating func select(_ session: String) {
        guard AttentionFeed.metadata(session, limit: 512) else { return }
        revision += 1; sessionId = session
    }
    mutating func complete(_ revision: Int) {
        if revision == self.revision { sessionId = nil }
    }
    mutating func cancel() { revision += 1; sessionId = nil }
    func url(dashboard: URL) -> URL {
        guard let session = sessionId, var parts = URLComponents(url: dashboard, resolvingAgainstBaseURL: false) else { return dashboard }
        // URLQueryItem preserves "+", while the dashboard's URLSearchParams
        // treats it as a space. Encode the complete value using RFC 3986 unreserved characters.
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        guard let encoded = session.addingPercentEncoding(withAllowedCharacters: allowed) else { return dashboard }
        parts.percentEncodedQuery = "session=" + encoded
        parts.fragment = nil
        return parts.url ?? dashboard
    }
}

struct AttentionKey: Hashable {
    let sourceId: String
    let sessionId: String
    let requestId: String
}

struct AttentionFeed: Decodable {
    struct Health: Decodable {
        let observedAt: String?
        let current: Bool
    }
    struct Source: Decodable {
        let id: String
        let observedAt: String?
        let current: Bool
    }
    struct Request: Decodable {
        let sessionId: String
        let requestId: String
        let sourceId: String
        let kind: String
        let at: String
        var key: AttentionKey { AttentionKey(sourceId: sourceId, sessionId: sessionId, requestId: requestId) }
    }
    let version: Int
    let instanceId: String
    let observedAt: String
    let staleAfterMs: Double
    let process: Health
    let sources: [Source]
    let requests: [Request]
    let truncated: Bool
    static let byteLimit = 4 * 1024 * 1024
    private static let timestampFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static func date(_ value: String?) -> Date? {
        guard let value = value, value.utf8.count <= 32, let date = timestampFormatter.date(from: value),
              timestampFormatter.string(from: date) == value else { return nil }
        return date
    }

    static func metadata(_ value: String, limit: Int) -> Bool {
        !value.isEmpty && value.utf8.count <= limit &&
        value == value.trimmingCharacters(in: .whitespacesAndNewlines) &&
        !value.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
    }

    static func decode(_ data: Data, now: Date) throws -> AttentionFeed {
        guard data.count <= byteLimit else { throw AttentionError.invalidFeed }
        let feed = try JSONDecoder().decode(AttentionFeed.self, from: data)
        guard feed.version == 1, UUID(uuidString: feed.instanceId) != nil,
              feed.staleAfterMs.isFinite, feed.staleAfterMs > 0, feed.staleAfterMs <= 3_600_000,
              let observed = date(feed.observedAt), observed <= now.addingTimeInterval(5),
              now.timeIntervalSince(observed) * 1000 <= feed.staleAfterMs,
              feed.sources.count <= 64, feed.requests.count <= 1024,
              !feed.truncated || feed.requests.isEmpty else { throw AttentionError.invalidFeed }
        var sourceIds = Set<String>()
        for source in feed.sources {
            guard metadata(source.id, limit: 128), sourceIds.insert(source.id).inserted else { throw AttentionError.invalidFeed }
            if let value = source.observedAt {
                guard let at = date(value), at <= observed, at <= now.addingTimeInterval(5) else { throw AttentionError.invalidFeed }
            }
        }
        if let value = feed.process.observedAt {
            guard let at = date(value), at <= observed, at <= now.addingTimeInterval(5) else { throw AttentionError.invalidFeed }
        }
        var requestIds = Set<AttentionKey>()
        for request in feed.requests {
            guard metadata(request.sessionId, limit: 512), sourceIds.contains(request.sourceId),
                  request.requestId.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                  ["question", "approval"].contains(request.kind),
                  let at = date(request.at), at <= observed,
                  requestIds.insert(request.key).inserted else { throw AttentionError.invalidFeed }
        }
        return feed
    }

    func fresh(_ timestamp: String?, current: Bool, now: Date) -> Bool {
        guard current, let at = Self.date(timestamp) else { return false }
        return at <= now.addingTimeInterval(5) && now.timeIntervalSince(at) * 1000 <= staleAfterMs
    }
}

enum AttentionError: Error { case invalidFeed, replay, transport }

/// A fresh complete source snapshot can resolve an ask. Silence or stale data cannot.
struct AttentionReducer {
    private(set) var instanceId: String?
    private(set) var healthy = Set<String>()
    private(set) var active: [AttentionKey: AttentionFeed.Request] = [:]
    private var seen: [AttentionKey: Date] = [:]
    private var activeSeen: [AttentionKey: Date] = [:]
    private var lastObservedAt: Date?
    let ledgerLimit: Int
    let ledgerTTL: TimeInterval

    init(ledgerLimit: Int = 8192, ledgerTTL: TimeInterval = 7 * 24 * 60 * 60) {
        self.ledgerLimit = ledgerLimit; self.ledgerTTL = ledgerTTL
    }

    mutating func interrupt() { healthy.removeAll() }

    mutating func apply(_ feed: AttentionFeed, now: Date) throws -> [AttentionFeed.Request] {
        if instanceId != feed.instanceId {
            instanceId = feed.instanceId; healthy.removeAll(); active.removeAll(); activeSeen.removeAll(); seen.removeAll(); lastObservedAt = nil
        }
        let observed = AttentionFeed.date(feed.observedAt)!
        if let previous = lastObservedAt, observed <= previous { throw AttentionError.replay }
        lastObservedAt = observed
        seen = seen.filter { now.timeIntervalSince($0.value) <= ledgerTTL }
        activeSeen = activeSeen.filter { now.timeIntervalSince($0.value) <= ledgerTTL }
        active = active.filter { activeSeen[$0.key] != nil }
        guard !feed.truncated, feed.fresh(feed.process.observedAt, current: feed.process.current, now: now) else {
            interrupt(); return []
        }
        let nextHealthy = Set(feed.sources.filter { feed.fresh($0.observedAt, current: $0.current, now: now) }.map(\.id))
        let current = feed.requests.filter { nextHealthy.contains($0.sourceId) }
        let currentKeys = Set(current.map(\.key))
        active = active.filter { !nextHealthy.contains($0.key.sourceId) || currentKeys.contains($0.key) }
        var discovered: [AttentionFeed.Request] = []
        for request in current {
            if healthy.contains(request.sourceId), seen[request.key] == nil { discovered.append(request) }
            active[request.key] = request
            activeSeen[request.key] = now
            seen[request.key] = now
        }
        healthy = nextHealthy
        if active.count > ledgerLimit {
            let keep = Set(active.keys.sorted {
                let left = currentKeys.contains($0), right = currentKeys.contains($1)
                return left != right ? left : activeSeen[$0, default: .distantPast] > activeSeen[$1, default: .distantPast]
            }.prefix(ledgerLimit))
            active = active.filter { keep.contains($0.key) }
        }
        activeSeen = activeSeen.filter { active[$0.key] != nil }
        if seen.count > ledgerLimit {
            // Keep currently pending asks first; evict the oldest resolved history.
            let sorted = seen.sorted {
                let left = active[$0.key] != nil, right = active[$1.key] != nil
                return left != right ? left : $0.value > $1.value
            }
            seen = Dictionary(uniqueKeysWithValues: sorted.prefix(ledgerLimit).map { ($0.key, $0.value) })
        }
        return discovered
    }

    func unresolved(_ key: AttentionKey) -> Bool { active[key] != nil }
    func candidate(_ keys: [AttentionKey]) -> String? {
        keys.first { healthy.contains($0.sourceId) && active[$0] != nil }?.sessionId
    }
    var candidates: [AttentionKey] {
        active.values.sorted { $0.at == $1.at ? $0.sessionId < $1.sessionId : $0.at < $1.at }.map(\.key)
    }
}

protocol AttentionFetching: AnyObject {
    func fetch(_ completion: @escaping (Result<Data, Error>) -> Void)
    func cancel()
}

/// Streaming bounds apply before JSON decoding; redirects never leave loopback.
final class AttentionHTTPClient: NSObject, AttentionFetching, URLSessionDataDelegate {
    let endpoint: URL
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var bytes = Data()
    private var completion: ((Result<Data, Error>) -> Void)?

    init(dashboard: URL) { endpoint = URL(string: "/api/attention", relativeTo: dashboard)!.absoluteURL }

    static func accepts(_ response: URLResponse, endpoint: URL) -> Bool {
        guard let http = response as? HTTPURLResponse else { return false }
        return http.statusCode == 200 && http.url == endpoint &&
            http.mimeType?.lowercased() == "application/json" &&
            http.expectedContentLength <= AttentionFeed.byteLimit
    }

    func fetch(_ completion: @escaping (Result<Data, Error>) -> Void) {
        guard task == nil else { return }
        self.completion = completion; bytes.removeAll(keepingCapacity: false)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 3
        configuration.timeoutIntervalForResource = 5
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
        self.session = session
        var request = URLRequest(url: endpoint)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        task = session.dataTask(with: request)
        task?.resume()
    }

    func cancel() {
        completion = nil; task?.cancel(); task = nil
        session?.invalidateAndCancel(); session = nil
        bytes.removeAll(keepingCapacity: false)
    }

    private func finish(_ result: Result<Data, Error>) {
        let callback = completion
        cancel()
        callback?(result)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
        if session === self.session { finish(.failure(AttentionError.transport)) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        completionHandler(.cancelAuthenticationChallenge, nil)
        if session === self.session { finish(.failure(AttentionError.transport)) }
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard session === self.session, Self.accepts(response, endpoint: endpoint) else {
            completionHandler(.cancel)
            if session === self.session { finish(.failure(AttentionError.transport)) }
            return
        }
        completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard session === self.session else { return }
        guard bytes.count + data.count <= AttentionFeed.byteLimit else { finish(.failure(AttentionError.invalidFeed)); return }
        bytes.append(data)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard session === self.session else { return }
        if let error = error { finish(.failure(error)) } else { finish(.success(bytes)) }
    }
}

enum AttentionAuthorization { case notDetermined, allowed, blocked }

protocol AttentionDelivery: AnyObject {
    var onClick: ((String) -> Void)? { get set }
    func authorization(_ completion: @escaping (AttentionAuthorization) -> Void)
    func requestAuthorization(_ completion: @escaping (Bool, Error?) -> Void)
    func deliver(id: String, sessions: Int, completion: @escaping (Error?) -> Void)
    func remove(_ ids: [String])
    func removeOwned()
}

final class SystemAttentionDelivery: NSObject, AttentionDelivery, UNUserNotificationCenterDelegate {
    static let prefix = "agent-fleet.attention."
    let center: UNUserNotificationCenter
    var onClick: ((String) -> Void)?
    private var deliveryRevision = 0
    private var issued: [String: Int] = [:]

    override init() {
        center = UNUserNotificationCenter.current()
        super.init()
        center.delegate = self
    }
    func authorization(_ completion: @escaping (AttentionAuthorization) -> Void) {
        center.getNotificationSettings { settings in
            let status: AttentionAuthorization
            switch settings.authorizationStatus {
            case .authorized, .provisional: status = settings.alertSetting == .enabled ? .allowed : .blocked
            case .notDetermined: status = .notDetermined
            default: status = .blocked
            }
            DispatchQueue.main.async { completion(status) }
        }
    }
    func requestAuthorization(_ completion: @escaping (Bool, Error?) -> Void) {
        center.requestAuthorization(options: [.alert]) { allowed, error in DispatchQueue.main.async { completion(allowed, error) } }
    }
    func deliver(id: String, sessions: Int, completion: @escaping (Error?) -> Void) {
        deliveryRevision += 1; issued[id] = deliveryRevision
        let content = UNMutableNotificationContent()
        content.title = sessions == 1 ? "An agent needs your input" : "\(sessions) agents need your input"
        content.body = "Open Agent Fleet to review the request."
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { error in
            DispatchQueue.main.async { completion(error) }
        }
    }
    func remove(_ ids: [String]) {
        center.removePendingNotificationRequests(withIdentifiers: ids)
        center.removeDeliveredNotifications(withIdentifiers: ids)
        for id in ids { issued.removeValue(forKey: id) }
    }
    func removeOwned() {
        let revision = deliveryRevision
        center.getDeliveredNotifications { notifications in
            DispatchQueue.main.async {
                let ids = notifications.map { $0.request.identifier }.filter { $0.hasPrefix(Self.prefix) && self.issued[$0, default: 0] <= revision }
                self.center.removeDeliveredNotifications(withIdentifiers: ids)
            }
        }
        center.getPendingNotificationRequests { requests in
            DispatchQueue.main.async {
                let ids = requests.map(\.identifier).filter { $0.hasPrefix(Self.prefix) && self.issued[$0, default: 0] <= revision }
                self.center.removePendingNotificationRequests(withIdentifiers: ids)
                // Keep newer delivery revisions until their own lifecycle ends.
                self.issued = self.issued.filter { $0.value > revision }
            }
        }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler(notification.request.identifier.hasPrefix(Self.prefix) ? [.banner, .list] : [])
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier, response.notification.request.identifier.hasPrefix(Self.prefix) {
            DispatchQueue.main.async { self.onClick?(response.notification.request.identifier) }
        }
        completionHandler()
    }
}

/// Used only by the explicit --test-url + --test-notifications launch mode.
final class MemoryAttentionDelivery: AttentionDelivery {
    var onClick: ((String) -> Void)?
    var onChange: (() -> Void)?
    var status: AttentionAuthorization = .notDetermined
    private(set) var requests: [(id: String, sessions: Int)] = []
    func authorization(_ completion: @escaping (AttentionAuthorization) -> Void) { completion(status) }
    func requestAuthorization(_ completion: @escaping (Bool, Error?) -> Void) {
        status = .allowed; completion(true, nil)
    }
    func deliver(id: String, sessions: Int, completion: @escaping (Error?) -> Void) {
        requests.append((id, sessions)); onChange?(); completion(nil)
    }
    func remove(_ ids: [String]) { requests.removeAll { ids.contains($0.id) }; onChange?() }
    func removeOwned() { requests.removeAll(); onChange?() }
    func openLatest() { if let latest = requests.last { onClick?(latest.id) } }
}

final class AttentionNotifications {
    private(set) var enabled: Bool
    private(set) var state = "off"
    private(set) var detail = "Input notifications are off."
    var onChange: (() -> Void)?
    var onError: ((String) -> Void)?
    var onOpen: ((String?) -> Void)?
    private let delivery: AttentionDelivery
    private let fetcher: AttentionFetching
    private let persist: (Bool) -> Void
    private let now: () -> Date
    private var timer: Timer?
    private var generation = 0
    private var allowed = false
    private var authorizing = false
    private var fetching = false
    private var lastAuthorization: Date?
    private var reducer = AttentionReducer()
    private var delivered: [String: [AttentionKey]] = [:]
    private var pendingClick: [AttentionKey]?
    private var stopped = false

    init(enabled: Bool, delivery: AttentionDelivery, fetcher: AttentionFetching, persist: @escaping (Bool) -> Void, now: @escaping () -> Date = Date.init) {
        self.enabled = enabled; self.delivery = delivery; self.fetcher = fetcher; self.persist = persist; self.now = now
        delivery.onClick = { [weak self] id in self?.openNotification(id) }
    }

    func start(schedule: Bool = true) {
        stopped = false
        if schedule && timer == nil { timer = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in self?.tick() } }
        if enabled { checkAuthorization() } else { delivery.removeOwned(); update("off", "Input notifications are off.") }
    }
    func stop() {
        stopped = true; generation += 1; timer?.invalidate(); timer = nil
        fetcher.cancel(); fetching = false; authorizing = false; pendingClick = nil
    }
    private func update(_ state: String, _ detail: String) {
        self.state = state; self.detail = detail; onChange?()
    }
    func toggle() {
        guard !stopped else { return }
        enabled.toggle(); persist(enabled); generation += 1
        fetcher.cancel(); fetching = false; authorizing = false; allowed = false
        reducer = AttentionReducer(); delivered.removeAll(); pendingClick = nil
        if enabled { checkAuthorization(userInitiated: true) }
        else { delivery.removeOwned(); update("off", "Input notifications are off.") }
    }
    func checkAuthorization(userInitiated: Bool = false) {
        guard enabled, !stopped, !authorizing else { return }
        authorizing = true
        let current = generation
        if !allowed { update("updating", "Checking notification permission…") }
        delivery.authorization { [weak self] status in
            guard let self = self, current == self.generation, self.enabled, !self.stopped else { return }
            if status == .notDetermined && userInitiated {
                self.delivery.requestAuthorization { [weak self] granted, error in
                    guard let self = self, current == self.generation, self.enabled, !self.stopped else { return }
                    self.authorizing = false; self.lastAuthorization = self.now()
                    self.applyAuthorization(granted && error == nil)
                    if error != nil { self.onError?("Notification permission could not be updated. Check Agent Fleet in macOS System Settings → Notifications.") }
                }
            } else {
                self.authorizing = false; self.lastAuthorization = self.now()
                self.applyAuthorization(status == .allowed)
                if userInitiated && status != .allowed { self.onError?("Notifications are blocked. Allow Agent Fleet in macOS System Settings → Notifications, or turn alerts off.") }
            }
        }
    }
    private func applyAuthorization(_ value: Bool) {
        if allowed != value {
            generation += 1; fetcher.cancel(); fetching = false; reducer.interrupt()
        }
        allowed = value
        if value { poll() }
        else {
            pendingClick = nil
            delivery.removeOwned(); delivered.removeAll()
            update("blocked", "Allow Agent Fleet in macOS System Settings → Notifications, or turn alerts off.")
        }
    }
    func tick() {
        guard enabled, !stopped else { return }
        if lastAuthorization == nil || now().timeIntervalSince(lastAuthorization!) >= 60 { checkAuthorization() }
        poll()
    }
    func poll() {
        guard enabled, allowed, !stopped, !fetching else { return }
        fetching = true
        let current = generation
        fetcher.fetch { [weak self] result in
            guard let self = self, current == self.generation, self.enabled, self.allowed, !self.stopped else { return }
            self.fetching = false
            do {
                let data = try result.get()
                let feed = try AttentionFeed.decode(data, now: self.now())
                let added = try self.reducer.apply(feed, now: self.now())
                self.removeResolved()
                self.update(self.reducer.healthy.isEmpty ? "updating" : "on", self.reducer.healthy.isEmpty ? "Waiting for current source data. Existing requests will not trigger catch-up alerts." : "New questions and approvals can show a private, generic notification.")
                if !added.isEmpty { self.notify(added, generation: current) }
                self.resolvePendingClick()
            } catch {
                // The next complete healthy observation is a baseline, not a backlog.
                self.generation += 1; self.authorizing = false; self.reducer.interrupt()
                self.pendingClick = nil
                self.update("updating", "Waiting for current source data. Existing requests will not trigger catch-up alerts.")
            }
        }
    }
    private func notify(_ requests: [AttentionFeed.Request], generation current: Int) {
        let id = SystemAttentionDelivery.prefix + UUID().uuidString
        delivered[id] = requests.map(\.key)
        delivery.deliver(id: id, sessions: Set(requests.map(\.sessionId)).count) { [weak self] error in
            guard let self = self else { return }
            guard current == self.generation, self.enabled, !self.stopped, self.delivered[id] != nil else { self.delivery.remove([id]); return }
            if error != nil {
                self.delivered.removeValue(forKey: id)
                self.delivery.remove([id])
                self.update("blocked", "macOS could not display an input notification.")
                self.onError?("macOS could not display an input notification. Check Agent Fleet in System Settings → Notifications.")
            }
        }
    }
    private func removeResolved() {
        for (id, keys) in delivered {
            let remaining = keys.filter { reducer.unresolved($0) }
            if remaining.isEmpty { delivered.removeValue(forKey: id); delivery.remove([id]) }
            else { delivered[id] = remaining }
        }
    }
    private func openNotification(_ id: String) {
        guard id.hasPrefix(SystemAttentionDelivery.prefix), !stopped else { return }
        pendingClick = delivered[id] ?? []
        onOpen?(nil)
        // Revalidate on every click, including after the app spent time in the
        // background. A cached request must not choose a now-resolved session.
        if enabled && allowed { poll() } else { pendingClick = nil }
    }
    func cancelPendingNavigation() { pendingClick = nil }
    private func resolvePendingClick() {
        guard let candidates = pendingClick else { return }
        pendingClick = nil
        if let session = reducer.candidate(candidates) { onOpen?(session) }
    }
}
