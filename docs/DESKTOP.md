# Mac app and automatic startup

The installer places Agent Fleet at `~/Applications/Agent Fleet.app`, with a shortcut at `~/Desktop/Agent Fleet.app`. Open the shortcut, search for **Agent Fleet** in Spotlight, or keep its running icon in the Dock. The app presents the dashboard in its own window using the system WebKit engine.

After installation, both the background service and the window start **after you log in**. They do not run before login. Closing the window pauses its live view; reopening the app restores the dashboard. Command-Q quits the app. The background service continues to collect sessions and serves the dashboard at `http://127.0.0.1:7420`.

## Install or rebuild

Requires macOS 13+, the Xcode command-line Swift tools and Node 22+. No npm package is added. From the project directory, quit the existing app, then run:

```bash
node bin/agent-fleet.mjs install-app
```

The installer compiles the checked-in [Swift window](../desktop/AgentFleet.swift) and [icon drawing](../desktop/Icon.swift), signs the result locally and installs it for this user. Build files are temporary and the app bundle is kept outside Git. An unrelated app or Desktop item with the same name is preserved and stops installation.

The installer enables the existing background service, installing it if missing, and adds a separate window login item. Opening the app also asks the installed service to start. The window waits for a ready dashboard and retries interrupted page loads. Source errors remain visible once the dashboard opens.

The app stores the configured loopback host/port at build time. Re-run `install-app` after changing these. The service pins the Node binary used by `install-service`; re-run that command after switching Node versions.

Since v0.9, the service uses launchd's **Interactive** process classification because dashboard responsiveness depends on its reads. The default classification throttled CPU and I/O under load even after removing the earlier Nice 5 priority. `install-service` updates this setting; `install-app` alone does not replace an existing service registration.

Service replacement tolerates the short gap between launchd acknowledging removal and finishing teardown. A matching bootstrap failure is retried up to four times, without stopping the replacement again. Persistent failures are reported; see the [installer regression evidence](VERIFICATION.md#v09-repository-release-checks--2026-10-18).

| Installed item | Purpose |
| --- | --- |
| `~/Applications/Agent Fleet.app` | Native dashboard window and icon |
| `~/Desktop/Agent Fleet.app` | Shortcut to the app |
| `~/Library/LaunchAgents/local.agent-fleet.plist` | Background service; starts at login and restarts after failure |
| `~/Library/LaunchAgents/local.agent-fleet.app.plist` | Opens the window once at login; quitting is respected |

The window loads only its configured local dashboard origin. Clicked web and Claude links open in their usual apps. Copy buttons use an isolated WebKit bridge and require a real click. The View menu provides Reload (Command-R) and Open in Browser (Command-Shift-O).

Since v0.6, the window checks dashboard readiness separately from source health. A usable dashboard opens even when a source is delayed or unavailable, so its freshness and error information remains accessible.

## Remove

Quit Agent Fleet with Command-Q, then run:

```bash
node bin/agent-fleet.mjs uninstall-app
```

This removes the app, its owned Desktop shortcut and its window login item. It leaves the background service installed. To stop and remove that separately:

```bash
node bin/agent-fleet.mjs uninstall-service
```

## Verification — 2026-10-16

Classification: **INCREMENTAL / EMPIRICAL**. The Swift build, app signature and launch plists passed validation on this Mac. Both login entries are enabled with `RunAtLoad`; the service also has `KeepAlive`. The native app opened a synthetic session graph, its gold LIVE shortcut and an updating managed-browser view. An intentionally interrupted initial page load recovered on retry. Command-Q ended the client while the real background service stayed healthy; the regular installed app reopened successfully.

Independent review identified a page-accessible clipboard bridge, missing recovery after a committed navigation failure and removal while the app was running. The bridge now lives in an isolated content world, both navigation failures trigger retries, and removal refuses a running installed app before changing files. These are engineering checks, not a formal security proof. No logout or reboot was performed; the next real login is the remaining end-to-end startup check.

Update verified 2026-10-18: v0.6 Swift source type-checks, the installed app bundle reports version 0.6.0 and passes signature verification. The updated app reopened with the live service, including its degraded-source display under high system load. No reboot/login test was added.

Later update on 2026-10-18: v0.7.0 was built, installed and signature-verified. The native window exposes Graph/List and Project/Status controls; List was opened with real session metadata. The background collector remained running during this UI update. No reboot/login test was added.

v0.8 update on 2026-10-18: v0.8.0 was built, installed and signature-verified. Graph was opened with Collapse finished / Expand all controls. Synthetic browser verification covered folding and nested selection; the existing collector remained running and reported degraded/stale source data. This UI update does not alter collection. No reboot/login test was added.

v0.9.0 update on 2026-10-18: the app was rebuilt and signature-verified, and the background service was reinstalled with independent source publication and Interactive scheduling. The native Graph view showed Current after reconnection. The first service bootstrap raced the old job's teardown; a retry succeeded. No reboot/login test was added. See [source-delay measurements](VERIFICATION.md#v09-source-isolation-and-service-scheduling--2026-10-18).

v0.9.1 update on 2026-10-20: the app was rebuilt, installed and signature-verified. Its reopened window showed Current and Graph/List controls. The existing background collector remained healthy throughout the window update. Deep-tree changes and remaining extreme-graph rendering limits are recorded in [verification](VERIFICATION.md#v091-deep-tree-robustness--2026-10-20). No reboot/login test was added.
