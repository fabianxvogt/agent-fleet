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
      // ctx.procs        Map<pid, {pid, ppid, etime, procStart, comm, args, agent, cwd, openFiles}>
      // ctx.openFileOwners Map<path, pid> of session files held open by agent processes
      // ctx.config       merged config
      // ctx.signal       AbortSignal cancelled when this collection exceeds its deadline
      // ctx.processObservedAt ISO timestamp of the process observation used by this read
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
  - `waiting` means there is evidence of an unresolved human input/approval request, not merely a finished turn.
  - Set `attention: { kind: "question" | "approval" | "completed", reason, at, evidence: "explicit" | "inferred" }` when supported. Reasons should be static labels, never transcript excerpts. Completed live sessions use `idle`; unknown idle sessions must not assert completion. Event time falls back to the observed file time, never the refresh clock.
  - Recognized unanswered requests remain visible. Quiet idle sessions and legacy waiting states without a request become parked after the configured age.
  - `stale` means a session claims to run but its process or heartbeat is gone.
- **Edges:**
  - `spawn` (parent started child) and `process` (inferred OS ancestry) build the tree.
  - `message`, `report` and `dependency` are drawn as extra arrows.
  - Set `inferred: true` for heuristics.
  - Communication endpoints require unambiguous identity evidence. Do not turn a runtime display name, message body or shared working directory into a session ID. Counts describe observed events within the retained window; a report does not assert successful completion.
- **Liveness:** prefer evidence over file recency. Good evidence is a pid in `ctx.procs`, a file in `ctx.openFileOwners`, or a heartbeat. Mark anything derived from mtime alone accordingly.
  - Claude registries containing `procStart` must match the process's canonical UTC/C `ps lstart` value. Invalid, missing observed or mismatched start values reject process ownership. Registries without that field retain legacy PID-only matching. Start values have one-second precision.
- **Cost:** stay cheap on every tick. Use `fileCache()` in `src/util.mjs`, keyed by path and file revision (device, inode, change time, modification time and size), and read bounded heads/tails rather than whole files. A matching size and modification time alone do not prove that a source is the same file.
- **Errors:** a failed/timed-out adapter retains its last successful data for at most `retainStaleMs` (default two minutes from observation), marked `meta.dataStale` with `dataObservedAt`. Source diagnostics include `lastSuccessAt` (completion), `observedAt` (captured process observation), `updating`, `stale`, `retained` and `error`. The collector adds `meta.dataSource` for UI freshness attribution. It never overlaps a timed-out invocation or accepts its late result. Honor `ctx.signal` where possible; stop also cancels reads. An explicit successful empty result removes previous nodes immediately.
- **Deadlines:** defaults are 8 seconds per adapter and 10 seconds for process discovery, allowing loaded hosts to finish while still bounding hangs. Failed process discovery skips adapter interpretation rather than making every process appear dead. Freshness is independent of graph change; health becomes stale after `max(3 × intervalMs, 10 seconds)`.

Sources publish independently as they finish. A slow adapter does not block fresh results or later reads from healthy adapters. The linker runs on each merged publication, adding process nodes for agent processes that no adapter has claimed, cross-tool ancestry edges and placeholder parents. A new adapter gets cross-tool links once its nodes carry a `pid`. In-flight results captured before a process-discovery failure are rejected even if discovery has since recovered.

Opt-in native notifications require `attention.requests` and
`attention.requestsComplete` from the shared attention reader. These describe
all supported pending explicit requests within its bounded input, not only the
latest question. Stable runtime IDs and recorded event times are required;
display fallbacks such as file modification time cannot establish notification
eligibility. See the [metadata feed contract](NOTIFICATIONS.md#local-observation-contract).

## OMP relations and branched sessions

The OMP reader uses [session-relations.mjs](../src/adapters/session-relations.mjs)
for structured IRC, terminal task reports and matched `l1_session` receipts.
Session UUIDs and runtime worker IDs are distinct. Native aliases use exact
filenames within a verified `parentSession` root; managed workers require exact
known session/output paths from successful receipts. The resolver never reads
result-file bodies or adds transcript text to graph metadata. See the
[relation contract](RELATIONS.md) for supported events, bounds and omissions.

Use [selectSessionBranch](../src/session-branch.mjs) consistently when deriving
content, attention or relation evidence from Pi-format branches. OMP's late usage
rows can specify `activeLeafId`; they must not resurrect the usage owner's
abandoned branch. A missing selected leaf stays unknown. Preserve this behavior
in any new reader or cache.

The details API keeps local content revisions opaque and separates branch-
unverified OMP/Pi/fleet archive history from current content. Archive messages
must not restore an old branch's current activity or file associations. Existing
Claude/Codex history merging remains separate from this runtime-specific rule.
