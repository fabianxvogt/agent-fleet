# Agent Fleet

A live, always-on dashboard of every coding-agent session on this Mac and how the sessions relate.
It covers Claude Code (CLI and desktop app), Codex (CLI and the desktop app), OhMyPi, Pi and pi-agent-fleet DAG runs.

- **Status per session:** working, waiting for you, idle or parked, done, failed, stale.
- **Roles:** OMP L0/L1/L2, Codex `worker`, Claude subagent types, fleet worker types.
- **Relations:** who started whom, who sent messages to whom, who reported back, whose output feeds whom.
  An inferred process edge appears when one agent's shell starts another agent's process.
- **Session inspector:** last observed activity, inline chat history and expandable tool outputs/results. Older messages come from [agentsview](https://github.com/kenn-io/agentsview), running in the background on `127.0.0.1:8080`.
- **Claude desktop sessions:** opened in the app with a `claude://` deep link.

It reads only local files and the process table. It sends nothing anywhere and binds to `127.0.0.1` only.

## Run

```bash
node bin/agent-fleet.mjs serve            # http://127.0.0.1:7420
node bin/agent-fleet.mjs snapshot         # one collection, summary on stdout (--json for the graph)
node bin/agent-fleet.mjs install-service  # LaunchAgent: starts at login, restarts on crash
node bin/agent-fleet.mjs service-status
node bin/agent-fleet.mjs uninstall-service
npm test
```

You need Node 22 or later. There are no dependencies.
The LaunchAgent pins the Node binary that ran `install-service`, so re-run it after switching Node versions.
Logs go to `~/.agent-fleet/logs/agent-fleet.log`.

## Use

- **Live** shows sessions that are running now, the trees they belong to, and children that finished in the last 10 minutes.
- **Last 12 h** shows everything inside the collection window.
- **Parked sessions:** a session that has waited more than 2 hours counts as parked. Parked sessions are hidden in Live; the *Show parked sessions* toggle brings them back.
- **Waiting for you** lists sessions whose turn ended recently, newest first.
- **Session details:** select a node. Activity includes its observation time; **Chat** shows messages and tool calls, **Results** shows returned tool outputs and agent responses. Expand a tool to read its input/output. **Load earlier messages** fetches archive history; the refresh button reloads it. Technical metadata and relations are under **Session details & relations**.
- **Updates:** only the selected session's content refreshes, every 4 seconds while the tab is visible. If agentsview is unavailable, recent local log events remain readable. Content availability depends on the agent's logs; OpenCode process-only nodes have no transcript.
- **Navigation:** click a node for details and relations. Drag to pan. Pinch or ⌘-scroll to zoom. Navigation stops at the drawn graph's bounds, with a small margin; zooming out stops at the overview. `f` fits the entire graph, `/` searches, `Esc` deselects.

## Configure

Optional `~/.agent-fleet/config.json`:

```json
{ "port": 7420, "windowHours": 12, "parkAfterMinutes": 120, "intervalMs": 4000,
  "fleetRoots": ["/Users/you/Development"], "agentsviewUrl": "http://127.0.0.1:8080",
  "disabledAdapters": [] }
```

To add another agent, drop a module into `~/.agent-fleet/adapters/`; see [docs/ADAPTERS.md](docs/ADAPTERS.md).

## Status

**v0.2 local tool, INCREMENTAL engineering.** The inspector is verified with synthetic sessions and the installed agentsview v0.45.0 API on 2026-10-16. Known limits are listed in [ROADMAP.md](ROADMAP.md) and [docs/README.md](docs/README.md).
