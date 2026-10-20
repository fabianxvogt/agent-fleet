import AppKit
import WebKit

private final class ArtifactTransfer {
    let download: WKDownload
    var destinationHandler: ((URL?) -> Void)?
    var filename = "artifact"
    var destination: URL?
    var stagingDirectory: URL?

    init(_ download: WKDownload) { self.download = download }
}

final class FleetApp: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var waiting: NSTextField!
    var timer: Timer?
    var checking = false
    var needsLoad = true
    private var transfers: [ObjectIdentifier: ArtifactTransfer] = [:]
    private var destinationQueue: [ObjectIdentifier] = []
    private var savePanel: NSSavePanel?
    private var saveIdentifier: ObjectIdentifier?
    private var downloadErrors: [String] = []
    private var closingWindow = false
    private var downloadGeneration = 0
    let testURL: String?
    let dashboard: URL

    override init() {
        let args = CommandLine.arguments
        testURL = args.firstIndex(of: "--test-url").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil }
        let value = testURL ?? (Bundle.main.object(forInfoDictionaryKey: "AgentFleetURL") as? String ?? "http://127.0.0.1:7420/")
        guard let url = URL(string: value), url.scheme == "http", ["127.0.0.1", "localhost", "::1", "[::1]"].contains(url.host ?? ""), url.port != nil, url.user == nil, url.password == nil else {
            fatalError("Agent Fleet requires a loopback dashboard URL")
        }
        dashboard = url
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.appearance = NSAppearance(named: .darkAqua)
        makeMenu()
        let content = WKUserContentController()
        let clipboardWorld = WKContentWorld.world(name: "AgentFleetClipboard")
        content.add(self, contentWorld: clipboardWorld, name: "copy")
        content.add(self, contentWorld: clipboardWorld, name: "download")
        content.addUserScript(WKUserScript(source: """
        (() => {
          document.addEventListener('click', event => {
            const link = event.target.closest?.('a[download]');
            if (event.isTrusted && link) {
              event.preventDefault(); event.stopImmediatePropagation();
              window.webkit.messageHandlers.download.postMessage(link.href);
              return;
            }
            const button = event.target.closest?.('button[data-copy]');
            if (!event.isTrusted || !button || button.dataset.copy.length > 16000) return;
            event.preventDefault(); event.stopImmediatePropagation();
            window.webkit.messageHandlers.copy.postMessage(button.dataset.copy);
            const label = button.textContent; button.textContent = 'Copied';
            setTimeout(() => { if (button.isConnected) button.textContent = label; }, 1200);
          }, true);
        })();
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: clipboardWorld))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = content
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.autoresizingMask = [.width, .height]
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1380, height: 880), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = testURL == nil ? "Agent Fleet" : "Agent Fleet — UI Test"
        window.minSize = NSSize(width: 980, height: 620)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentView = webView
        if testURL == nil { window.setFrameAutosaveName("AgentFleetWindow") }
        window.center()
        waiting = NSTextField(labelWithString: "Agent Fleet is starting…")
        waiting.alignment = .center
        waiting.font = .systemFont(ofSize: 16)
        waiting.textColor = .secondaryLabelColor
        waiting.translatesAutoresizingMaskIntoConstraints = false
        webView.addSubview(waiting)
        NSLayoutConstraint.activate([waiting.centerXAnchor.constraint(equalTo: webView.centerXAnchor), waiting.centerYAnchor.constraint(equalTo: webView.centerYAnchor)])
        if testURL == nil { startService() }
        showWindow()
    }

    func makeMenu() {
        let menu = NSMenu()
        let app = NSMenuItem(); menu.addItem(app)
        let appMenu = NSMenu(); app.submenu = appMenu
        appMenu.addItem(withTitle: "Hide Agent Fleet", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Agent Fleet", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let edit = NSMenuItem(); edit.title = "Edit"; menu.addItem(edit)
        let editMenu = NSMenu(title: "Edit"); edit.submenu = editMenu
        for (title, action, key) in [("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            editMenu.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        let view = NSMenuItem(); view.title = "View"; menu.addItem(view)
        let viewMenu = NSMenu(title: "View"); view.submenu = viewMenu
        let reload = viewMenu.addItem(withTitle: "Reload", action: #selector(reloadPage), keyEquivalent: "r"); reload.target = self
        let browser = viewMenu.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "o"); browser.target = self; browser.keyEquivalentModifierMask = [.command, .shift]
        NSApp.mainMenu = menu
    }

    func showWindow() {
        closingWindow = false
        window.makeKeyAndOrderFront(nil)
        if !CommandLine.arguments.contains("--background") { NSApp.activate(ignoringOtherApps: true) }
        if timer == nil { timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in self?.checkService() } }
        checkService()
    }

    func startService() {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = ["kickstart", "gui/\(getuid())/local.agent-fleet"]
        task.standardOutput = FileHandle.nullDevice; task.standardError = FileHandle.nullDevice
        try? task.run()
    }

    func sameOrigin(_ url: URL?) -> Bool {
        guard let url = url else { return false }
        return url.scheme == dashboard.scheme && url.host == dashboard.host && url.port == dashboard.port && url.user == nil && url.password == nil
    }

    func artifactDownloadURL(_ url: URL?) -> Bool {
        guard sameOrigin(url), let url = url, let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.query == nil, parts.fragment == nil else { return false }
        // Keep encoded session IDs as one segment; never accept a filesystem path.
        let path = parts.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: false)
        guard path.count == 7, path[0].isEmpty, path[1] == "api", path[2] == "sessions",
              !path[3].isEmpty, path[4] == "artifacts", path[6] == "download" else { return false }
        let id = String(path[5])
        return id.range(of: "^(?:[a-fA-F0-9]{32,64}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})$", options: .regularExpression) != nil
    }

    func artifactResponseAccepted(_ response: URLResponse, request: URLRequest?) -> Bool {
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              artifactDownloadURL(http.url), http.url == request?.url,
              http.expectedContentLength >= 0, http.expectedContentLength <= 8 * 1024 * 1024 else { return false }
        let disposition = http.value(forHTTPHeaderField: "Content-Disposition")?
            .split(separator: ";", maxSplits: 1).first?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return disposition == "attachment"
    }

    func artifactFilename(_ suggested: String) -> String {
        let leaf = (suggested.replacingOccurrences(of: "\\", with: "/") as NSString).lastPathComponent
        let scalars = leaf.unicodeScalars.filter {
            !CharacterSet.controlCharacters.contains($0) &&
            ![0x200E, 0x200F, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069].contains(Int($0.value))
        }
        var name = String(String.UnicodeScalarView(scalars)).replacingOccurrences(of: ":", with: "-")
            .trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: ".")))
            .precomposedStringWithCanonicalMapping
        if name.isEmpty { name = "artifact" }
        let ext = (name as NSString).pathExtension
        let suffix = !ext.isEmpty && ext.utf8.count <= 24 ? "." + ext : ""
        var base = suffix.isEmpty ? name : (name as NSString).deletingPathExtension
        while base.utf8.count + suffix.utf8.count > 240 { base.removeLast() }
        return (base.isEmpty ? "artifact" : base) + suffix
    }

    private func registerDownload(_ download: WKDownload) {
        guard !closingWindow, window.isVisible, artifactDownloadURL(download.originalRequest?.url) else { download.cancel(nil); return }
        transfers[ObjectIdentifier(download)] = ArtifactTransfer(download)
        download.delegate = self
    }

    private func showDownloadError(_ message: String) {
        guard !closingWindow, window.isVisible else { return }
        downloadErrors.append(message)
        presentDownloadDialog()
    }

    private func presentDownloadDialog() {
        guard !closingWindow, window.isVisible, savePanel == nil, window.attachedSheet == nil else { return }
        if !downloadErrors.isEmpty {
            let alert = NSAlert()
            alert.messageText = "File could not be saved"
            alert.informativeText = downloadErrors.removeFirst()
            alert.addButton(withTitle: "OK")
            alert.beginSheetModal(for: window) { [weak self] _ in
                DispatchQueue.main.async { self?.presentDownloadDialog() }
            }
            return
        }
        while !destinationQueue.isEmpty {
            let id = destinationQueue.removeFirst()
            guard let transfer = transfers[id], transfer.destinationHandler != nil else { continue }
            let panel = NSSavePanel()
            panel.title = "Save session file"
            panel.message = "Choose where to save this file from the selected session."
            panel.nameFieldStringValue = transfer.filename
            panel.canCreateDirectories = true
            savePanel = panel; saveIdentifier = id
            panel.beginSheetModal(for: window) { [weak self] result in
                guard let self = self else { return }
                self.savePanel = nil; self.saveIdentifier = nil
                guard let current = self.transfers[id] else { self.presentDownloadDialog(); return }
                guard !self.closingWindow, result == .OK, let destination = panel.url else {
                    self.finishDownload(current.download, cancel: true); return
                }
                guard !self.transfers.values.contains(where: { $0 !== current && $0.destination?.standardizedFileURL == destination.standardizedFileURL }) else {
                    self.finishDownload(current.download, cancel: true, error: "Another download is already saving to this location. Choose a different filename and try again."); return
                }
                let handler = current.destinationHandler; current.destinationHandler = nil
                do {
                    // WKDownload requires a nonexistent file. Stage the bytes so a failed
                    // transfer cannot truncate a destination that the user chose to replace.
                    let staging = destination.deletingLastPathComponent().appendingPathComponent(".agent-fleet-download-" + UUID().uuidString, isDirectory: true)
                    try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
                    current.destination = destination; current.stagingDirectory = staging
                    handler?(staging.appendingPathComponent("download"))
                } catch {
                    self.finishDownload(current.download, cancel: true, error: "The selected folder could not be written. Choose another location and try again.")
                    handler?(nil)
                }
                DispatchQueue.main.async { self.presentDownloadDialog() }
            }
            return
        }
    }

    private func finishDownload(_ download: WKDownload, cancel: Bool = false, error: String? = nil) {
        let id = ObjectIdentifier(download)
        guard let transfer = transfers.removeValue(forKey: id) else { return }
        destinationQueue.removeAll { $0 == id }
        let handler = transfer.destinationHandler; transfer.destinationHandler = nil
        handler?(nil)
        if saveIdentifier == id { savePanel?.cancel(nil) }
        if cancel { download.cancel(nil) }
        if let staging = transfer.stagingDirectory { try? FileManager.default.removeItem(at: staging) }
        if let error = error { showDownloadError(error) }
        DispatchQueue.main.async { [weak self] in self?.presentDownloadDialog() }
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard let transfer = transfers[ObjectIdentifier(download)] else { completionHandler(nil); return }
        transfer.destinationHandler = completionHandler
        guard artifactResponseAccepted(response, request: download.originalRequest) else {
            let status = (response as? HTTPURLResponse)?.statusCode
            let message: String
            switch status {
            case 403: message = "This file is no longer available under the session's access rules."
            case 404, 410: message = "This file is missing or its session reference has expired. Refresh Results and try again."
            case 409: message = "This file changed since it was listed. Refresh Results before downloading it."
            case 413: message = "This file exceeds the 8 MiB download limit."
            default: message = "The service did not return a downloadable file. Refresh Results and try again."
            }
            finishDownload(download, cancel: true, error: message)
            return
        }
        transfer.filename = artifactFilename(suggestedFilename)
        destinationQueue.append(ObjectIdentifier(download))
        presentDownloadDialog()
    }

    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
        decisionHandler(.cancel)
        finishDownload(download, cancel: true, error: "The file request was redirected. Refresh Results and try again.")
    }

    func download(_ download: WKDownload, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        completionHandler(.cancelAuthenticationChallenge, nil)
        finishDownload(download, cancel: true, error: "The file service unexpectedly requested authentication.")
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let transfer = transfers[ObjectIdentifier(download)], let staging = transfer.stagingDirectory,
              let destination = transfer.destination else { finishDownload(download); return }
        do {
            let source = staging.appendingPathComponent("download")
            let attributes = try FileManager.default.attributesOfItem(atPath: source.path)
            guard attributes[.type] as? FileAttributeType == .typeRegular,
                  (attributes[.size] as? NSNumber)?.int64Value ?? Int64.max <= 8 * 1024 * 1024 else {
                finishDownload(download, error: "The downloaded file exceeded the supported size or had an invalid format."); return
            }
            if FileManager.default.fileExists(atPath: destination.path) {
                _ = try FileManager.default.replaceItemAt(destination, withItemAt: source)
            } else {
                try FileManager.default.moveItem(at: source, to: destination)
            }
            finishDownload(download)
        } catch {
            finishDownload(download, error: "The file could not be saved at the selected location. Check that the folder is writable and try again.")
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        finishDownload(download, error: "The download was interrupted before it completed. Check that Agent Fleet is running and try again.")
    }

    private func cancelDownloads() {
        closingWindow = true
        downloadGeneration += 1
        downloadErrors.removeAll()
        for transfer in Array(transfers.values) { finishDownload(transfer.download, cancel: true) }
        savePanel?.cancel(nil)
        if let sheet = window.attachedSheet { window.endSheet(sheet, returnCode: .cancel) }
    }

    func checkService() {
        guard !checking else { return }; checking = true
        let health = URL(string: "/api/health", relativeTo: dashboard)!
        var request = URLRequest(url: health); request.timeoutInterval = 1.2; request.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            let value = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            // Open a usable dashboard even when a source is degraded; its UI explains freshness.
            let ready = (response as? HTTPURLResponse)?.statusCode == 200 && (value?["ready"] as? Bool ?? value?["ok"] as? Bool) == true
            DispatchQueue.main.async {
                guard let self = self else { return }; self.checking = false
                guard self.window.isVisible else { return }
                if ready {
                    if self.needsLoad { self.needsLoad = false; self.webView.load(URLRequest(url: self.dashboard)) }
                } else {
                    self.needsLoad = true; self.waiting.isHidden = false
                    self.waiting.stringValue = "Waiting for the Agent Fleet background service…"
                }
            }
        }.resume()
    }

    @objc func reloadPage() { needsLoad = true; checkService() }
    @objc func openInBrowser() { NSWorkspace.shared.open(dashboard) }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { waiting.isHidden = true }
    private func navigationFailed(_ error: Error) {
        let value = error as NSError
        // Converting a navigation into a download must leave the dashboard loaded.
        if (value.domain == "WebKitErrorDomain" && value.code == 102) || (value.domain == NSURLErrorDomain && value.code == NSURLErrorCancelled) { return }
        needsLoad = true; waiting.isHidden = false
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { navigationFailed(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { navigationFailed(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { needsLoad = true; checkService() }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        if artifactDownloadURL(url) || (sameOrigin(url) && navigationAction.shouldPerformDownload) {
            decisionHandler(.cancel)
            if navigationAction.navigationType == .linkActivated { showDownloadError("Use the Download action in the session's Results tab to save a supported file.") }
            return
        }
        if sameOrigin(url) || url?.absoluteString == "about:blank" { decisionHandler(.allow); return }
        if navigationAction.navigationType == .linkActivated && navigationAction.sourceFrame.isMainFrame, let url = url, ["http", "https", "claude"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        // Downloads are admitted only through the isolated trusted-click bridge,
        // never by navigating to an attachment or by a script-created request.
        let response = navigationResponse.response as? HTTPURLResponse
        let attachment = response?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().hasPrefix("attachment") == true
        decisionHandler(artifactDownloadURL(response?.url) || attachment ? .cancel : .allow)
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.cancel(nil) }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.cancel(nil) }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if artifactDownloadURL(navigationAction.request.url) { return nil }
        if navigationAction.navigationType == .linkActivated && navigationAction.sourceFrame.isMainFrame, let url = navigationAction.request.url, ["http", "https", "claude"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        return nil
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, sameOrigin(message.frameInfo.request.url), let text = message.body as? String, text.utf8.count <= 16000 else { return }
        if message.name == "download" {
            guard !closingWindow, window.isVisible, let url = URL(string: text), artifactDownloadURL(url) else {
                showDownloadError("This link is not a downloadable session file."); return
            }
            let generation = downloadGeneration
            var request = URLRequest(url: url)
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.timeoutInterval = 30
            webView.startDownload(using: request) { [weak self] download in
                guard let self = self, generation == self.downloadGeneration else { download.cancel(nil); return }
                self.registerDownload(download)
            }
            return
        }
        guard message.name == "copy" else { return }
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
    }
    func windowWillClose(_ notification: Notification) {
        cancelDownloads()
        timer?.invalidate(); timer = nil; needsLoad = true
        webView.loadHTMLString("", baseURL: nil)
    }
    func applicationWillTerminate(_ notification: Notification) { cancelDownloads() }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(); return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

let application = NSApplication.shared
let delegate = FleetApp()
application.setActivationPolicy(.regular)
application.delegate = delegate
application.run()
