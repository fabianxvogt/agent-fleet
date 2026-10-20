# Browser live views

The session inspector's **Live** tab automatically prioritizes a fresh supported browser image over recorded terminal output and agent activity. If no fresh image is available, those observations remain visible with their timestamps; see [Automatic Live](USAGE.md#automatic-live). Browser selection and setup remain available alongside the fallback. The tab offers every supported browser page associated with that session. A gold **LIVE** badge marks reachable views in the graph; clicking it or pressing Enter opens Live directly. Multiple sessions can have browsers concurrently. If a session has several browsers/pages, **Browser view** selects the one to display. Available views remain in Live scope even if their session is parked or finished. Hidden agent/search filters still apply.

## Automatic availability

The running dashboard discovers dedicated Chromium browsers with loopback debugging endpoints every four seconds. A unique nearest session process ancestor and compatible working context establish ordinary ownership. A unique fleet-worker worktree can establish ownership when there is no separate worker PID. A shared project directory alone, ambiguous shared hosts, private contexts and normal user browser profiles do not qualify. The browser PID/start identity, cwd, effective dedicated profile and listener are validated before page metadata is queried, and again before observation.

There is no per-session setup or scheduled chat follow-up for these supported browsers. Open any gold **LIVE** badge. Discovery reads metadata only; screenshots and click observation start when a view is opened, and stop on deselection, tab hiding or disconnect. Other browsers continue running. Multiple dashboard windows can watch different sessions concurrently, within the eight-viewer/pending-start safety limits.

Private-pipe-only browser tools still need an integration in their owning runtime. Agent Fleet cannot obtain their pictures by discovering the process alone. Set `autoDiscoverBrowsers: false` in the local config to disable discovery; explicitly started/attached browsers remain available.

## Optional managed terminal browser

Chrome or Chromium must be installed. Set `AGENT_FLEET_CHROME` to its executable if it is outside the usual installation paths. Node 22+ and the running Agent Fleet dashboard are required; no package dependencies are added.

1. Select the session in Agent Fleet and open **Live**. If it has no supported browser, copy its browser start command to that session's terminal. The command includes the exact node ID.
2. Start the managed browser, optionally with a URL. Use its terminal commands to navigate and interact.
3. Watch **Live**. Gold rings mark observed browser clicks, fading over six seconds.
4. Stop the browser when done. Stop waits for the profile to be removed before reporting success.

From the project directory:

```bash
node bin/agent-fleet.mjs browser start --session '<node-id>' --url http://127.0.0.1:7420/browser-demo
node bin/agent-fleet.mjs browser click --session '<node-id>' --selector '#increment'
node bin/agent-fleet.mjs browser open --session '<node-id>' --url https://example.com
node bin/agent-fleet.mjs browser fill --session '<node-id>' --selector '#query' --text 'example'
node bin/agent-fleet.mjs browser scroll --session '<node-id>' --dy 400
node bin/agent-fleet.mjs browser state --session '<node-id>'
node bin/agent-fleet.mjs browser stop --session '<node-id>'
```

`state` returns bounded visible page text and observed metadata; input values are excluded. CSS selectors target the main document. A returned `dispatched: true` means the browser received an input command; a non-null `click` means the observer saw a trusted click. It does not prove the intended application action succeeded. Disabled elements can receive a dispatch without generating a click.

Codex terminals with `CODEX_THREAD_ID` can omit `--session`. Other runtimes can use the copied node ID. Start refuses an unknown, process-only or restricted session. Each session has its own managed browser/profile/socket; starting again for that session returns its status. Other sessions are independent. A failed runner's directory can be recovered with `browser stop --session '<node-id>'` after the runner has exited. If no session is supplied or inferred, stop only selects a run when exactly one exists.

## Attach an existing terminal-agent browser

The browser must already expose a loopback Chrome DevTools HTTP endpoint, use a dedicated profile, and have a verified process cwd within the selected session's working context. Fleet workers use their individual worktree. Process start identity and listener ownership are checked again in the observer runner. The effective profile, including `Default`/last-used profile aliases, must remain inside the dedicated directory; regular/private profiles and ambiguous process flags are rejected.

```bash
node bin/agent-fleet.mjs browser targets --session '<node-id>' --endpoint http://127.0.0.1:9222 --browser-pid 12345
node bin/agent-fleet.mjs browser attach --session '<node-id>' --endpoint http://127.0.0.1:9222 --browser-pid 12345 --target '<page-id>'
node bin/agent-fleet.mjs browser detach --session '<node-id>'
```

This optional command provides an explicit association when automatic ancestry is unavailable. Use the exact ID from `targets`; no target is created or brought to the foreground. One explicit CLI binding is supported per session, alongside other sessions and automatically discovered pages. Replace only that session's explicit binding by stopping/detaching it first. The owning agent continues to navigate and click. Agent Fleet observes trusted click events in a separate JavaScript world and takes viewport screenshots at most once every 400 ms while viewed. It does not change viewport/emulation, start/stop the owner's screencast, navigate, dispatch input or close the target/browser. `state` reads bounded text; control commands are rejected. `detach` (also `stop` for an attached source) waits for observer cleanup and leaves the browser/profile running. A separately discoverable browser can still appear automatically after explicit detachment.

HTTP(S) pages and `about:blank` are supported. File/data/internal pages are excluded from target listings; navigation to one clears frames/markers and blocks capture until an allowed page returns. No profile data or page frames are copied into Git. The runner keeps only its private association metadata; the existing profile is not removed.

Private-pipe-only Playwright launches have no second externally accessible endpoint. This adapter cannot attach to them after launch. They need a runtime-specific observation export or a future browser launch configured by its owner. Agent Fleet does not restart another agent's browser to add a port. Existing authentication/profile state is never moved to the managed pilot.

## Boundaries and lifecycle

- Managed Chromium runs headless with its own profile under `~/.agent-fleet/browser-views/<session-hash>/profile`. It does not use the owner's regular browser profile. Stop removes only that run's profile, cookies and local storage. A crash may leave a stale profile until stop; no frame recording is saved. The old singleton `browser-pilot` run remains readable until stopped and is never moved while running. A custom `browserDir` retains that legacy path and uses its `-sessions` sibling for new runs.
- The controller uses Chrome's private debugging pipe. The terminal helper uses a private Unix socket; directory/profile metadata is owner-only. There is no Chrome debugging TCP port and no browser-control HTTP endpoint.
- Frames exist in memory, with bounded queues and slow-viewer disconnection. Managed capture uses delayed screencast acknowledgments at roughly four frames per second; attached capture polls at most 2.5 times per second. Actual rate depends on the page/machine. Selecting another content tab/session or hiding the dashboard tab disconnects its viewer. Closing the dashboard does not stop the browser.
- A trusted click listener runs in an isolated JavaScript world. Page scripts cannot call its binding; script-generated DOM clicks are ignored. Marker coordinates, run ID, document generation and timestamps must match the displayed frame. Navigation clears old frames/markers. The dashboard shows image and click observation times; stale connections lose their image and reconnect.
- Only HTTP(S) URLs without embedded credentials, plus `about:blank`, are accepted as start/open commands. Displayed URLs omit credentials, query and fragment. Page content is visible to the local dashboard; do not treat this as a universal secret-redaction system.
- Sokra and body-os session contexts, including cwd symlink aliases, are excluded from this pilot.

## Evidence and remaining scope

Classification **INCREMENTAL / EMPIRICAL**, verified on this Mac on 2026-10-16 with Chrome 155.0.8059.80. [Browser integration tests](../test/browser.test.mjs) exercise the actual CLI and isolated Chromium against synthetic local pages: session association, profile/socket permissions, concurrent controller/viewer, JPEG frames, trusted/script/disabled clicks, hidden binding, invalid/fragment navigation, expired/disconnected queued actions, HTTP restrictions, IPv6, stop followed immediately by restart, and failed-run recovery. [View tests](../test/browser-view.test.mjs) cover click/frame alignment, selection and decode races, navigation invalidation, disconnects and visibility. At the original managed-browser checkpoint, the full project suite had 60 passing tests. Browser UI verification uses one synthetic session and the local demo's live clock/counter, with a terminal click visible as a ring. No private transcripts or existing user profiles are used as fixtures.

v0.4 evidence (`EMPIRICAL`, 2026-10-16): [existing-browser tests](../test/external-browser.test.mjs) launch Chrome independently of Agent Fleet, attach a second CDP observer, and verify owner navigation/input/screencast coexistence, unchanged viewport and pixel density, trusted click/frame alignment, scroll/resize/navigation invalidation, blocked file pages, oversized text/title bounds, explicit process association, profile aliases, capture-limit recovery, detach and target closure. [Graph](../test/navigation.test.mjs), [scope](../test/layout.test.mjs) and [inspector](../test/inspector.test.mjs) tests verify badge visibility and direct Live opening. Synthetic browser UI checks confirm the gold badge and independent terminal-controller click in the attached view. Review findings are corrected, including profile aliases/duplicate flags, unrestricted file targets, unbounded CDP text/title replies and stale images after failed capture.

An independently running terminal-agent browser was identified through its working context, but exited before attachment. No external agent's active workload has yet been observed with this adapter. Other inspected browsers exposed only private debugging pipes. The remaining gate is an owner-selected agent with a live supported endpoint; the implementation/test fixture is not evidence that a real agent workload is currently attached. There is no formal correctness proof. Popup following, iframe click coordinates, arbitrary existing browser tools, video-rate streaming, mouse trails and interactive takeover remain unimplemented. Native game/window capture and image/file artifact previews are separate roadmap items. agentsview continues as the background archive.

v0.5 (`INCREMENTAL / EMPIRICAL`, 2026-10-16): the owner requested automatic availability across all supported sessions and simultaneous browser bindings. [Discovery/catalog tests](../test/browser-discovery.test.mjs) verify two independently launched real browsers, simultaneous session streams, multiple pages in one session, observed owner clicks, source removal and surviving peer browsers. Synthetic regressions cover ambiguous ancestry, legacy/per-session coexistence, metadata-only discovery, late attachment after removal, HTTP cancellation before capture and awaited shutdown cleanup. Review identified those last three lifecycle races; they are corrected and regression-covered. No external agent workload is claimed by these synthetic fixtures. Next check: everyday use with independently running terminal agents; private-pipe exports remain a separate integration.

At the v0.5 checkpoint, all **85 project tests passed**. An actual dashboard UI check with two synthetic sessions and independently controlled browsers confirmed both LIVE badges, switching between two pages of one session, changing clocks/click markers and the second session's independent image. The fixture was removed afterward. The installed background service was restarted and passed its health check; its existing legacy managed view remains available alongside the new registry.

Protocol basis: [Chrome DevTools Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/), [Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/) and [Runtime](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/). Screencast is an experimental Chromium API; compatibility with other browser versions/runtimes is unproven.
