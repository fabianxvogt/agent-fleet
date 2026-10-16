# Roadmap

## Now
- Owner use of v0.3: inline session content plus one terminal-controlled Chromium browser with read-only live frames and observed click markers. agentsview remains the background archive. Verify coverage during normal work.

## Next
- **Artifact previews:** explicitly associated image/file outputs, with safe access and rendering. Current Results displays text/tool outputs and agent responses.
- **Browser coverage:** integrate a specific existing terminal browser tool when selected. The managed pilot currently owns one main tab; multiple tabs, iframe clicks and attaching existing browser sessions remain unimplemented.
- **"Asked you a question" vs. "finished":** read the last assistant message type for Claude and Codex, so *Waiting for you* means a real ask.
- **OMP inter-agent messages:** `irc:incoming`, `async-result` and `live-delegation` custom messages become `message`/`report` edges.
- **OMP L1 results:** `*.l1-result.txt` and l1_session send/receive become `report` edges.
- **Codex threads started from Claude:** link them when a Claude Bash call runs `codex exec`/`codex resume` and the thread id shows up in the transcript.
- **Stale Claude registry check:** compare the registry's `procStart` with the process start time, so a reused pid is caught.
- **OpenCode adapter:** once its 1.18 session store is located.
- **Notifications:** a macOS notification when a session switches to *waiting* (opt-in).

## Later
- **Proposed native views:** capture a selected game/application window through a local macOS helper; validate with an isolated demo before any Everwild integration. Session-to-window mapping and OS recording permission are separate gates.
- Decide whether agentsview can be retired after archive/search/usage requirements and migration costs are established. No removal selected yet.
- Per-session token and cost badges, read from agentsview's `/api/v1/sessions/{id}/usage`.
- Timeline view: how a session tree grew over the last hours.
- Remote machines over SSH (same adapters, remote `ps`/`lsof`).

## Done
- 2026-10-16 v0.3 browser pilot (`INCREMENTAL / EMPIRICAL`):
  - explicit session binding, isolated temporary Chromium profile and terminal start/open/click/fill/scroll/state/stop commands
  - selected-session Live tab; read-only JPEG frames while visible, trusted DOM click markers aligned by run/document/time, disconnection and navigation invalidation
  - private debugging pipe and Unix socket, loopback viewer, no HTTP control route; bounded messages, queues and viewers
  - independent review findings fixed: navigation readiness, delayed queued actions, bootstrap recovery, stop/restart race, IPv6 and URL credentials
  - [commands, evidence and limitations](docs/BROWSER.md); 60 tests including real isolated Chrome and synthetic UI regression coverage
- 2026-10-16 v0.2 session inspector (`INCREMENTAL / EMPIRICAL`):
  - selected-session activity from Claude, Codex, OMP, Pi and fleet logs; observation time and call/return status
  - inline Chat and Results, expandable tool input/output, latest agent response, archive pagination and metadata disclosure
  - agentsview remains optional background archive; installed v0.45.0 API verified
  - bounded file/network reads and caches, known-node-only API, inert text rendering, private-context checks including aliases
  - abort stale selection requests, retain recent events while the archive is unavailable, invalidate archive rows across revision changes
  - independent review findings corrected; 42 tests and synthetic browser checks for chat, pagination and results
- 2026-10-16 bounded graph navigation (`INCREMENTAL / EMPIRICAL`):
  - pan limited to the complete rendered SVG, including relation curves outside project lanes
  - minimum zoom follows the graph overview; deep graphs can fit below the old fixed minimum
  - canvas resize, detail panel changes and live graph shrinkage recalculate limits
  - independent review identified clipped outlying relation curves; corrected with origin-aware SVG bounds
  - 23 tests, including seven navigation regressions; synthetic browser checks of overview, scroll limits and detail panel
- 2026-10-16 v0.1:
  - adapters for Claude CLI/desktop, Codex CLI/app, OMP, Pi and pi-agent-fleet
  - process-tree linker
  - SSE server on loopback
  - masonry graph UI with *Waiting for you*, filters, a parked toggle, a detail panel and agentsview/Claude-app links
  - LaunchAgent
  - independent code review; confirmed findings fixed: XSS via fleet status strings, per-tick rebroadcast, malformed fleet specs, pid flapping, ai-title, selection dimming, shell quoting, hung ps/lsof, unbounded caches
  - 16 tests
