# Development

Use macOS with Node.js 22 or newer. The project uses Node's standard library and
browser modules, with no npm dependencies or frontend build step.

## Verify a change

```bash
npm test
node bin/agent-fleet.mjs help
```

The test command runs files sequentially so the real Chromium integration suites
do not compete for host resources. Install Chrome or Chromium to run those tests;
otherwise they report skips. `AGENT_FLEET_CHROME` can point to an executable outside
the usual locations. Check the skip count before claiming full verification.
Browser tests use temporary dedicated profiles and synthetic local pages; they do
not attach to personal browser profiles. Test servers, profiles and fixture files
are removed by their cleanup hooks.

For changes to the native window, also type-check with the Xcode command-line tools:

```bash
xcrun swiftc -swift-version 5 -typecheck -framework AppKit -framework WebKit desktop/AgentFleet.swift
xcrun swiftc -swift-version 5 -typecheck -framework AppKit desktop/Icon.swift
```

For graph computation changes, run the synthetic benchmark:

```bash
npm run benchmark:layout
npm run benchmark:layout -- --baseline bbe95c1
```

It measures selection, fold projection and full layout independently on balanced
and deep 1,000/3,000-session fixtures. The optional baseline reads the historical
self-contained layout module from Git without changing the checkout. Versions
are interleaved; compare medians across the three samples. Deep chains are stress
cases, and these measurements exclude browser painting and source collection.

Use the [desktop instructions](DESKTOP.md) for a full app build and local install.
UI changes should also be checked in a browser or the native window, using
synthetic sessions for screenshots and fixtures. Do not run two dashboard servers
on the same port; an installed background service already owns the default port.

## Source map

| Path | Responsibility |
| --- | --- |
| `bin/` | Command-line entry points and browser runner |
| `src/adapters/` | Runtime-specific metadata readers; see the [adapter contract](ADAPTERS.md) |
| `src/collector.mjs`, `src/procs.mjs` | Independent source refreshes, process ownership and freshness |
| `src/attention.mjs` | Supported input, completion and failure events |
| `src/server.mjs`, `src/details.mjs`, `src/session-content.mjs` | Local HTTP/SSE server and bounded inspector content |
| `src/browser/` | Managed browsers, discovery and observation of supported existing browsers |
| `src/service.mjs`, `src/desktop.mjs`, `desktop/` | macOS login service and native app |
| `ui/layout.js`, `ui/graph-scene.js` | Complete graph geometry and viewport projection |
| `ui/app.js`, `ui/inspector.js`, `ui/live-view.js`, `ui/browser-view.js` | Navigation, content, automatic Live selection and browser observation |
| `test/` | Node test runner suites with synthetic fixtures |

## Repository hygiene

Keep runtime configuration, session transcripts, logs, browser profiles, screenshots
of real sessions, credentials and compiled app bundles out of Git. Local state lives
under `~/.agent-fleet/`; the native app is installed under `~/Applications/`.
Review `git diff --check` and `git status --short` before committing.

Keep the [README](../README.md), [roadmap](../ROADMAP.md) and affected reference docs
consistent with behavior. Record meaningful verification and limitations in
[VERIFICATION.md](VERIFICATION.md). Historical measurements there describe their
recorded fixtures and host conditions, not performance guarantees.
