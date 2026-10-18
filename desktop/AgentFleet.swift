import AppKit
import WebKit

final class FleetApp: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    var waiting: NSTextField!
    var timer: Timer?
    var checking = false
    var needsLoad = true
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
        content.addUserScript(WKUserScript(source: """
        (() => {
          document.addEventListener('click', event => {
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
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { needsLoad = true; waiting.isHidden = false }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { needsLoad = true; waiting.isHidden = false }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { needsLoad = true; checkService() }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        if sameOrigin(url) || url?.absoluteString == "about:blank" { decisionHandler(.allow); return }
        if navigationAction.navigationType == .linkActivated && navigationAction.sourceFrame.isMainFrame, let url = url, ["http", "https", "claude"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.navigationType == .linkActivated && navigationAction.sourceFrame.isMainFrame, let url = navigationAction.request.url, ["http", "https", "claude"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        return nil
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, sameOrigin(message.frameInfo.request.url), let text = message.body as? String, text.utf8.count <= 16000 else { return }
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
    }
    func windowWillClose(_ notification: Notification) {
        timer?.invalidate(); timer = nil; needsLoad = true
        webView.loadHTMLString("", baseURL: nil)
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(); return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

let application = NSApplication.shared
let delegate = FleetApp()
application.setActivationPolicy(.regular)
application.delegate = delegate
application.run()
