# Writing an adapter

An adapter turns one agent's local state into graph nodes and edges. It must not write anything.

```js
// ~/.agent-fleet/adapters/opencode.mjs
import { edge, node } from "/path/to/agent-fleet/src/model.mjs";

export default function create() {
  return {
    id: "opencode",          // unique; also usable in config.disabledAdapters
    label: "OpenCode",
    async collect(ctx) {
      // ctx.now          ms timestamp of this tick
      // ctx.home         home directory
      // ctx.windowMs     ended sessions older than this should be skipped
      // ctx.procs        Map<pid, {pid, ppid, etime, comm, args, agent, cwd, openFiles}>
      // ctx.openFileOwners Map<path, pid> of session files held open by agent processes
      // ctx.config       merged config
      return {
        nodes: [node({ id: "opencode:abc", agent: "opencode", title: "Fix tests", status: "working", cwd: "/w/app", project: "app" })],
        edges: [edge("opencode:abc", "opencode:def", "spawn")],
      };
    },
  };
}
```

## Rules

- **Ids:** `<agent>:<native id>`, stable across ticks. Set `agentsviewId` when agentsview knows the session, so the transcript link works.
- **Status:** choose from `working | waiting | idle | queued | done | failed | stale`; meanings are in `src/model.mjs`.
  - `waiting` means the session's turn ended and it needs the human. The collector turns old `waiting` into parked `idle`.
  - `stale` means a session claims to run but its process or heartbeat is gone.
- **Edges:**
  - `spawn` (parent started child) and `process` (inferred OS ancestry) build the tree.
  - `message`, `report` and `dependency` are drawn as extra arrows.
  - Set `inferred: true` for heuristics.
- **Liveness:** prefer evidence over file recency. Good evidence is a pid in `ctx.procs`, a file in `ctx.openFileOwners`, or a heartbeat. Mark anything derived from mtime alone accordingly.
- **Cost:** stay cheap on every tick. Cache file heads by path+mtime (`fileCache()` in `src/util.mjs`) and read tails, not whole files.
- **Errors:** an exception only disables that adapter for the tick. The error shows under *Sources* in the UI.

The linker runs after all adapters. It adds process nodes for agent processes that no adapter claimed, cross-tool ancestry edges, and placeholder parents. A new adapter therefore gets cross-tool links for free once its nodes carry a `pid`.
