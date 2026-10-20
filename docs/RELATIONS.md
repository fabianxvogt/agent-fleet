# Agent relations and branch consistency

The v0.12 implementation adds OMP communication and managed-worker relations from
structured records. It also keeps the inspector's current branch separate from
archive history whose branch cannot be verified. Classification:
**INCREMENTAL / EMPIRICAL**.

## Reading relations

Open **Session details & relations** for the selected session. Relations appear
before technical facts, with the other session, direction, observed count and
recorded date/time. Select a relation with a click, Enter or Space to inspect its
other endpoint. Keyboard focus survives ordinary refreshes while that relation
remains available.

| Relation | Meaning |
| --- | --- |
| Started / Started by | A supported parent/worker association |
| Sent messages to / Messages from | A supported queued-send receipt or received message |
| Reported to / Reports from | A supported result receipt or terminal task report |
| Started process / Process started by | An existing operating-system ancestry inference, labeled as inferred |

**Message queued** does not confirm delivery or that a worker acted on it.
**Result received** does not prove success: a report can describe a failed or
cancelled task. Counts describe distinct events still observed in the bounded
active tail and collection window, not lifetime totals. They can decrease after
branch changes, tail truncation or expiry. The timestamp is the latest supported
event time, not the time of a dashboard refresh.

## Identity and supported OMP records

A session header UUID identifies the persisted session. OMP's runtime agent ID,
such as `Main` or a worker name, is a different identity. The adapter resolves a
runtime ID only when current session files and structured receipts establish one
unambiguous endpoint.

For native task sessions, the exact JSONL filename without its extension supplies
the runtime alias within a verified root. `parentSession` must point to an
observed session in that root. `Main` names the root. Dots in a filename are part
of its exact name; they do not establish a parent or justify shortening a name.
The verified parent determines the spawn edge and displayed L-depth even when
child files are stored in a flat directory. Advisor aliases containing the
supported `__advisor` forms are excluded from communication resolution.

Managed L1 workers can live beside root session files. A matched `l1_session`
call and successful structured result can bind a worker ID to an exact, already
known `sessionFile`, or to `outputFile` with the exact `.l1-result.txt` suffix.
The adapter does not search for a matching filename fragment. Start/launch
receipts establish spawn relations; list/status receipts can establish managed
ownership and subagent role without claiming a launch. Managed workers do not
take their host's process assignment. Conflicting ownership and duplicate
aliases remain unresolved. A recent successful result receipt can retain an old
known worker endpoint; the presence of a result file alone does not establish
delivery.

Supported communication evidence:

- `irc:incoming` uses structured message ID and sender ID. `wakeRelay: true`
  represents a report; other supported incoming IRC records represent messages.
- `async-result` uses structured `task` jobs with `jobId`, an agent ID and terminal
  status `completed`, `failed` or `cancelled`. A running job or a non-task job does
  not create a report.
- Matched `l1_session` `send` receipts create **Message queued** observations.
  Supported `results` and `close` receipts create **Result received**
  observations. Tool failures and unmatched results do not establish relations.

`live-delegation` currently lacks the structured endpoint identity needed by this
resolver and is unsupported. Message prose, result text, shared working
directories and similar-looking names do not identify endpoints. Unknown,
ambiguous, self-referential or out-of-window observations remain unlinked. The
resolver does not create placeholder communication endpoints.

## Bounded reads and privacy

The session-tree adapter reads up to six head records within 32 KiB and a 24 KiB
tail. Relation extraction considers at most 512 tail records, limits structured
tool/worker/job/result arrays to 64 items each and retains at most 128 relation
observations and 128 outstanding matched-call candidates per session read.
The OMP root prepass parses collection-window/process candidates plus at most
128 explicitly referenced root files already found by discovery; it does not
parse every historical transcript. Incomplete evidence stays incomplete.

Relation metadata contains endpoint IDs, static labels, counts and event times.
It does not contain message bodies, tool input/output bodies or result-file
contents. `.l1-result.txt` paths are association evidence only; the relation
adapter does not open their bodies.

Shared file caches include device, inode, change time, modification time and size
in the revision key. The OMP reader also checks the file revision after its
bounded head/tail reads, withholding relation evidence if the source changed
during observation. A matching size and modification time alone cannot preserve
cached relation evidence when the other identity/revision fields change.

## Active branch and archive history

OMP, Pi and fleet transcripts can contain abandoned branches. The shared branch
selector follows the selected leaf's known parent chain for content, attention,
file associations and OMP relations. OMP's trailing `model_usage.activeLeafId`
can select the active leaf independently of that usage row's parent. An explicit
`null` clears it. A selected leaf outside the bounded tail does not authorize
falling back to an abandoned branch.

For OMP, Pi and fleet, the details response sets `branchScoped: true` and available
local content carries an opaque `local.revision`. Unchanged content and verified
same-branch appends retain that revision. A fork, explicit clear, unknown
ancestry, source replacement/rewrite or cache eviction creates a new revision and
clears the superseded local view. Internal source identity and ancestry are not
sent to the browser. Read failures retain labeled last-known evidence; they do
not prove a branch change.

Continuity checks compare selected ancestry and fingerprints of overlapping
records in the bounded 1 MiB inspector tail. Rewrites entirely outside a
truncated observed tail cannot be ruled out; this is not a whole-file append
integrity check. The same revision change revokes superseded local file
associations.

For OMP, Pi and fleet, **Chat**, **Results** and recorded **Live** activity use
local branch evidence. **Archive history** remains readable in a separate
collapsed disclosure: **These older messages may belong to another conversation
branch.** It stays open across ordinary same-branch refreshes and closes on a
branch change. Loading earlier archive pages also rechecks the local branch.
Archive history does not supply current activity, Results or file associations.
Claude and Codex retain their existing combined local/archive presentation.

## Provenance, evidence and remaining scope

The supported OMP contract was checked against the installed
`@oh-my-pi/pi-coding-agent` **18.12.3** source and the local Development
`.omp/tools/l1-session.ts` launcher:

- `src/session/session-entries.ts`, `src/task/executor.ts`,
  `src/task/output-manager.ts` and `src/registry/persisted-agents.ts` establish
  header identity, native filenames, parent/root scope and advisor exceptions.
- `src/session/irc-bridge.ts`, `src/session/async-job-delivery.ts`,
  `src/async/job-manager.ts` and `src/session/session-manager.ts` establish the
  supported durable communication envelopes and terminal statuses.
- `src/live/controller.ts` supplies the content-only `live-delegation` envelope;
  `src/session/session-entries.ts` defines the usage row's active-leaf pointer.
  The local launcher supplies its own structured worker and send/result receipts.

These are source paths within the inspected installation, not additional files
vendored into this repository. This is version-specific source evidence, not a
claim that every OMP release or launcher emits the same records. Repository tests
use synthetic fixtures rather than copied private session data.

Implementation: [relation extraction and resolution](../src/adapters/session-relations.mjs),
[session-tree reader](../src/adapters/session-tree.mjs),
[shared branch selector](../src/session-branch.mjs),
[content details](../src/details.mjs) and [inspector](../ui/inspector.js).
Synthetic cases live in [relation tests](../test/session-relations.test.mjs) and
[branch tests](../test/session-branch.test.mjs). Execution results and visual checks
belong in the [v0.12 verification notes](VERIFICATION.md#v012-agent-relations-and-branch-consistency--2026-10-20).

Next validation: observe an ordinary OMP task tree and a managed L1 exchange
against the supported installed version; check a real branch switch and archive
pagination without reintroducing old activity. New runtime versions,
`live-delegation` identities and other agents' communication formats require
their own source evidence and synthetic cases before adding coverage. Bounded
tails cannot establish a complete communication history.
