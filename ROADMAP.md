# Roadmap

## Now
- Owner review of the v0.1 prototype: is the live graph the right shape, and which relations are missing?

## Next
- **"Asked you a question" vs. "finished":** read the last assistant message type for Claude and Codex, so *Waiting for you* means a real ask.
- **OMP inter-agent messages:** `irc:incoming`, `async-result` and `live-delegation` custom messages become `message`/`report` edges.
- **OMP L1 results:** `*.l1-result.txt` and l1_session send/receive become `report` edges.
- **Codex threads started from Claude:** link them when a Claude Bash call runs `codex exec`/`codex resume` and the thread id shows up in the transcript.
- **Stale Claude registry check:** compare the registry's `procStart` with the process start time, so a reused pid is caught.
- **OpenCode adapter:** once its 1.18 session store is located.
- **Notifications:** a macOS notification when a session switches to *waiting* (opt-in).

## Later
- Per-session token and cost badges, read from agentsview's `/api/v1/sessions/{id}/usage`.
- Timeline view: how a session tree grew over the last hours.
- Remote machines over SSH (same adapters, remote `ps`/`lsof`).

## Done
- 2026-10-16 v0.1:
  - adapters for Claude CLI/desktop, Codex CLI/app, OMP, Pi and pi-agent-fleet
  - process-tree linker
  - SSE server on loopback
  - masonry graph UI with *Waiting for you*, filters, a parked toggle, a detail panel and agentsview/Claude-app links
  - LaunchAgent
  - independent code review; confirmed findings fixed: XSS via fleet status strings, per-tick rebroadcast, malformed fleet specs, pid flapping, ai-title, selection dimming, shell quoting, hung ps/lsof, unbounded caches
  - 16 tests
