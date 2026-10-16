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
