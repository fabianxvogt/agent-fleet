# Agent Fleet docs

- [ADAPTERS.md](ADAPTERS.md): adapter contract for adding agents.
- [../ROADMAP.md](../ROADMAP.md): Now / Next / Later / Done.

## Data sources (verified on this Mac, 2026-10-16)

| Agent | Sessions | Liveness | Relations |
|---|---|---|---|
| Claude Code | `~/.claude/sessions/<pid>.json` (busy/idle), `~/.claude/projects/*/<sid>.jsonl`, `…/<sid>/subagents/agent-*.jsonl` + `.meta.json` | registry pid alive in `ps` | subagent spawn |
| Claude desktop | `~/Library/Application Support/Claude/claude-code-sessions/*/*/local_*.json` | via registry (`cliSessionId` = registry `sessionId`) | `spawnedFrom` (spawn), `peerReceipts` (message), `sideSessionNotes` (report) |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, titles in `~/.codex/session_index.jsonl` | rollout file open by a `codex` process (`app-server` keeps loaded threads open) | `session_meta.source.subagent.thread_spawn.parent_thread_id`, `agent_role` |
| OhMyPi | `~/.omp/agent/sessions/<proj>/<ts>_<id>.jsonl`, children in `<ts>_<id>/<Name>.jsonl` | process cwd matches the session cwd, newest session touched since process start | directory nesting → L0/L1/L2 |
| Pi | `~/.pi/agent/sessions/<proj>/<ts>_<id>.jsonl` | same as OMP; pi opens files only while appending | nested dirs |
| pi-agent-fleet | `<project>/.fleet/<name>-<ts>/{fleet.json,state.json}` | controller `pid` alive + `heartbeat_at` < 2 min | fleet → worker (spawn), `depends_on` (dependency), host session by shared pid |
| any agent process | `ps` + `lsof` | process exists | parent-process chain → `process` edge (inferred) |

## Evidence and limits

All claims below are `EMPIRICAL` checks against this machine on 2026-10-16.

- **Matching:** All 24 live Claude registry sessions matched their desktop metadata (`cliSessionId`).
  - The desktop `startedBy` links match `spawnedFrom`, for example *3D-Ansicht merged* → two gatefall sessions.
  - Both running pi processes mapped to the session in their own cwd.
- **Waiting vs. idle:**
  - For Claude, "waiting" comes from the registry's `idle` state. It cannot tell "asked you a question" apart from "finished".
  - Codex and pi/omp use the end of the transcript and how recently the file changed.
- **OMP:** in-process L1/L2 children are `working` only while their file changed in the last 60 s; otherwise they are `idle` under a live root.
- **Cross-tool links:** these come only from process ancestry. A Codex thread started by Claude through the desktop app (no shared process tree) is not linked.
- **OpenCode:** not covered. Local storage held only empty `session_diff` files. A process node still appears when `opencode` runs.
- **Cost:** with warm caches a tick takes about 1 s, mostly `ps` and `lsof`. The server uses about 1–2 % CPU and about 95 MB RSS. Under very high system load (load average ~150 observed), ticks slow down and are skipped instead of queued.
- **Security:** an independent review checked the loopback-only bind, the Host-header guard (403 otherwise), CSP and `nosniff`, escaping of file-derived text, and allow-listing of statuses and edge kinds. A hostile `.fleet/state.json` in a cloned repo was the confirmed attack path; it is fixed and covered by a test.

Classification: **INCREMENTAL**, a local tooling prototype with no research claim.

## Navigation verification — 2026-10-16

`INCREMENTAL / EMPIRICAL`: pan and zoom are bounded by the complete drawn SVG, with a small margin. The overview is the minimum scale, capped at 1.05 for small graphs; users can zoom in to 2.2. Axes whose content fits stay centered. Limits update after snapshots and canvas resizes, including opening/closing details. This bounds the combined graph rectangle; gaps between individual project lanes still exist.

Evidence: [navigation regressions](../test/navigation.test.mjs) drove the production UI event handlers with synthetic data and failed before the fix. Seven cases cover wheel, pinch/buttons, drag, deep graphs, details, resize/live shrinkage and rendered curves outside lane bounds. All 23 project tests pass. Browser checks used synthetic sessions and confirmed the disabled overview zoom-out control, pan limits and detail-panel resizing. Independent review found that relation curves extend beyond layout rectangles; the corrected implementation measures SVG bounds including their origin. No benchmark or new scientific proof is claimed. Next check: owner use with real session-tree changes.

## Proposed session inspector

Owner direction, 2026-10-16: phase 1 is implemented as the v0.2 inspector. Browser/window capture and artifact previews below remain proposals. agentsview is retained as the background archive.

### Implemented activity, conversation and results

Select a session to read its latest observed event, Chat, and Results. Results includes returned tool output, explicitly final replies where the runtime records that flag, and the latest agent reply (without claiming finality). Tool input/output expands in place. Private thinking/reasoning and system records are excluded. Text is escaped rather than executed; images, HTML and arbitrary files are not opened by the content endpoint.

The server reads only the selected node's known transcript, with a 1 MiB tail and at most 120 normalized entries per read. Claude desktop/registry nodes carry a separate transcript path. Approved source roots are resolved before use; paths outside them and body-os contexts (including cwd aliases) cannot supply content. Common credential formats are redacted as a secondary defense; this is not a general secret-detection guarantee. No transcript content is written into the repository or a new database.

The selected inspector polls every 4 seconds while visible. It keeps up to 400 observed local events across updates and marks that limit when reached. agentsview supplies history in pages of 40; a request is bounded to 4 MiB and each upstream fetch times out after 3.5 seconds. Metadata ID/cwd must match before messages are accepted. A changed archive revision replaces loaded archive pages, because ordinals can be reused during compaction/rebuild; pagination uses the revision that produced its cursor. During ongoing archive updates an earlier page may require a refresh. Disconnected/unindexed/unsupported sources are labeled, and local events remain available independently of the archive. OpenCode/process-only nodes currently have no content reader.

Evidence (`EMPIRICAL`, 2026-10-16): installed agentsview v0.45.0 session metadata, descending message pagination, transcript revision and embedded tool-output fields checked against an Agent Fleet-related session without copying its transcript. 42 automated tests cover formats, branch selection, redaction, stable identities, archive/live merging, pagination, selection races, archive replacement, unavailable sources, file boundaries/aliases, HTTP guards and the existing graph behavior. Synthetic browser checks verified Chat, earlier-message loading and expanded Results. Independent review identified analysis-channel exposure, local-tail rollover loss, pagination gaps/empty-cursor handling, cwd aliases and archive revision mixing; these are corrected and regression-covered. No formal guarantee or cross-runtime completeness claim. Next check: owner use across live Claude/OMP/Pi sessions; native/binary previews remain outside phase 1.

The project graph remains the overview. Its larger inspector now presents observed activity and conversation/tool history; associated visual outputs are the next extension. A previous log entry is not proof of what a process is doing now.

| Surface | Candidate implementation | Main gate |
| --- | --- | --- |
| Current tool, command, file | Implemented: normalize selected-session log events on demand and poll while visible | Coverage follows the runtime's recorded events; observation time is explicit |
| Conversation and tool results | Implemented: Agent Fleet UI, local recent events and server-side agentsview messages integration | Installed v0.45.0 verified; sessions still need to be indexed for older history |
| Images and changed files | Explicit session-associated artifacts; safe image/text/diff rendering | Associate outputs with the producing session, restrict file access, escape content, and limit sizes; never execute file HTML |
| Browser, including terminal agents | Capture an explicitly associated Chromium target using DevTools screenshot/screencast support | Available endpoint, stable target/session IDs, multiple tabs, coexistence with the controlling tool, and headless-runtime compatibility |
| Game or native app | A small macOS helper captures a selected window using ScreenCaptureKit | OS recording permission, window lifecycle, capture performance and explicit association with the agent |

**Adopted archive decision:** Agent Fleet is the primary interface; agentsview stays in the background for history/search/usage. Its service still runs. Eliminating it requires owning the necessary importers, archive/index and maintenance, or another validated integration; copying the chat UI alone does not achieve that. Graph collection and recent log content work without agentsview.

**Remaining pilot order:** one terminal-controlled browser with live frames and tool-event click markers; then selected-window capture and richer artifacts. Existing browsers without an accessible capture source can expose only their available logs/artifacts until an integration exists. A C++ game can be viewed as a window independently of its language; this has not been tested with Everwild.

**Click markers and resources:** browser automation does not necessarily move the OS cursor. Accurate markers need tool-action events with coordinates (or resolved targets), timestamp and target ID aligned to the frames; distinguish an attempted click from confirmed execution. Stream the selected view first, use low-rate thumbnails elsewhere, and show stale/disconnected states. Begin with viewing; interaction takeover is a separate design decision. Shared browsers or processes require explicit association rather than a guessed owner. No capture permissions, debugging endpoints or recording are enabled by this proposal.

Technical basis, checked 2026-10-16: [agentsview upstream API](https://github.com/kenn-io/agentsview/blob/main/openapi.yaml) documents session messages, tool calls and watch endpoints; [Chromium DevTools Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/) provides screenshot/screencast primitives (screencast is experimental); [Apple's capture sample](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos) demonstrates window filtering and recording permission. These support feasibility, not compatibility with every installed runtime. Estimates of integration effort remain engineering judgments until the browser pilot.
