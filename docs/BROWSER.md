# Terminal browser pilot

The session inspector's **Live** tab displays one managed Chromium browser controlled from the terminal. This is a real browser and a read-only view, with an explicit Agent Fleet session ID. Existing Codex/Claude/OpenCode browser tools are not automatically attached.

## Use

Chrome or Chromium must be installed. Set `AGENT_FLEET_CHROME` to its executable if it is outside the usual installation paths. Node 22+ and the running Agent Fleet dashboard are required; no package dependencies are added.

1. Select the session in Agent Fleet and open **Live**. Copy its browser start command to that session's terminal. The command includes the exact node ID.
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

Codex terminals with `CODEX_THREAD_ID` can omit `--session`. Other runtimes can use the copied node ID. Start refuses an unknown, process-only or restricted session. Only one managed browser can run at a time. Starting again for its existing session returns its status; stop it before binding another session. A failed runner's directory can be recovered with `browser stop` after the runner has exited.

## Boundaries and lifecycle

- Chromium runs headless with its own profile under `~/.agent-fleet/browser-pilot/profile`. It does not use the owner's regular browser profile. Stop removes the profile, cookies and local storage. A crash may leave a stale profile until stop; no frame recording is saved.
- The controller uses Chrome's private debugging pipe. The terminal helper uses a private Unix socket; directory/profile metadata is owner-only. There is no Chrome debugging TCP port and no browser-control HTTP endpoint.
- Frames exist in memory, with bounded queues and slow-viewer disconnection. Capture runs only while a Live viewer is connected, with delayed screencast acknowledgments at roughly four frames per second; it is not a video-rate guarantee. Selecting another content tab/session or hiding the dashboard tab disconnects its viewer. Closing the dashboard does not stop the browser.
- A trusted click listener runs in an isolated JavaScript world. Page scripts cannot call its binding; script-generated DOM clicks are ignored. Marker coordinates, run ID, document generation and timestamps must match the displayed frame. Navigation clears old frames/markers. The dashboard shows image and click observation times; stale connections lose their image and reconnect.
- Only HTTP(S) URLs without embedded credentials, plus `about:blank`, are accepted as start/open commands. Displayed URLs omit credentials, query and fragment. Page content is visible to the local dashboard; do not treat this as a universal secret-redaction system.
- Sokra and body-os session contexts, including cwd symlink aliases, are excluded from this pilot.

## Evidence and remaining scope

Classification **INCREMENTAL / EMPIRICAL**, verified on this Mac on 2026-10-16 with Chrome 155.0.8059.80. [Browser integration tests](../test/browser.test.mjs) exercise the actual CLI and isolated Chromium against synthetic local pages: session association, profile/socket permissions, concurrent controller/viewer, JPEG frames, trusted/script/disabled clicks, hidden binding, invalid/fragment navigation, expired/disconnected queued actions, HTTP restrictions, IPv6, stop followed immediately by restart, and failed-run recovery. [View tests](../test/browser-view.test.mjs) cover click/frame alignment, selection and decode races, navigation invalidation, disconnects and visibility. The full project suite has 60 passing tests. Browser UI verification uses one synthetic session and the local demo's live clock/counter, with a terminal click visible as a ring. No private transcripts or existing user profiles are used as fixtures.

Independent review findings are corrected and covered by regressions. There is no formal correctness proof. Main-tab viewing and control are implemented; popup selection, iframe click coordinates, arbitrary existing browser tools, video-rate streaming, mouse trails and interactive takeover are not. The next useful gate is owner use of the managed pilot, followed by one selected real terminal-tool integration. Native game/window capture and image/file artifact previews remain separate roadmap items. agentsview continues as the background archive.

Protocol basis: [Chrome DevTools Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/), [Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/) and [Runtime](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/). Screencast is an experimental Chromium API; compatibility with other browser versions/runtimes is unproven.
