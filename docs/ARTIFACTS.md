# Session artifact previews

Implemented in **v0.11** (`INCREMENTAL / EMPIRICAL`). The inspector's **Results**
tab includes a **Files** section alongside tool outputs and agent replies.
Files come from observed session references, not a directory scan.

## User experience

Expand a file to see its size, modification time, association and available
preview. **Linked in response** and **Written by tool** distinguish how it was
observed; a link does not prove that the session created the file.

- PNG, JPEG, GIF and WebP: image previews loaded when expanded.
- Text, code, Markdown and JSON: expandable, escaped text with a clear truncation
  notice. HTML and SVG are text, never executable inline documents.
- PDF and Word, Excel and PowerPoint files: metadata and an explicit **Download**
  action. The native Mac app opens a save dialog without leaving the dashboard;
  in a browser, its normal download behavior applies. Embedded document rendering
  is not supported.
- Missing, changed, oversized, restricted and expired files: understandable states
  that leave the rest of the session usable.

Open previews, keyboard focus and text reading position survive ordinary
refreshes. Changing session cancels pending preview requests and clears that
selection's preview state. Late responses are ignored. Refresh failures leave
previously observed files visible with a notice; unavailable files do not prevent
reading the rest of the session.

## Association and access

Association comes from valid inline local Markdown links/images in assistant
replies or successful supported writes: `Write`, `Edit`, `MultiEdit`, `write`,
`edit` and `apply_patch`. Tool-specific fields and patch headers supply the path;
delete-only patches do not create file references. Relative paths resolve against
the session workspace, and absolute paths must still belong to that workspace.

Code examples, user messages, failed tools, read-tool inputs, bare paths and
arbitrary shell output do not establish association. Remote links, `file:` URLs
and reference-style Markdown links are excluded. No remote content is fetched.

Local Pi/OMP/fleet references follow the active branch. Their archive references
are excluded because the current archive response does not establish branch
identity. Other supported archive references require the existing session identity
checks; archive availability is optional.

The [artifact service](../src/artifacts.mjs) owns filesystem policy. HTTP clients
receive opaque IDs bound to a known session; preview and download routes accept
IDs, never a client-supplied path. Each read rechecks session identity, canonical
workspace, file identity, regular-file status and size. Original and resolved
paths must pass private-context and credential-path exclusions. Symlinks cannot
escape the workspace; `/`, the home directory and its ancestors are not valid
artifact roots. Outside-workspace files are unavailable without probing their
existence. There is no external output-root integration.

Limits are 32 candidates per entry, 128 registered files per session, 24 cached
sessions, 400 evidence entries per session, 64 KiB text previews and 8 MiB
images/downloads. Text previews use the existing credential-redaction rules.
Image signatures must match the declared format; this is not a full image-codec
validator. Responses use `no-store`, `nosniff` and restrictive content policies;
downloads use attachment disposition. HTML and SVG are always inert text.

## Lifetime

The UI keeps up to 400 observed local entries while a local read returns at most
120. A bounded in-memory registry retains older observed associations across
ordinary polling. Evidence expires 30 minutes after it was last observed; quotas,
service restart or session eviction can remove it earlier. A repeated observation
renews the evidence; merely opening a preview does not.

Changing an entry replaces its references. Session source or workspace replacement
revokes the previous IDs. Branch changes remove superseded local evidence; an
archive revision change removes evidence belonging only to the old revision.
File deletion, replacement, modification or new restrictions are checked again
before content is served. Changed files need a newly observed reference; an old ID
does not silently display replacement content.

## Verification and limits

Synthetic checks cover [content association](../test/content.test.mjs),
[filesystem access and lifetime](../test/artifacts.test.mjs),
[HTTP integration](../test/details.test.mjs),
[preview selection and rendering](../test/artifact-view.test.mjs) and
[native downloads](../test/native-download.test.mjs). Dated execution results and
UI checks are recorded in the [v0.11 verification notes](VERIFICATION.md#v011-files-and-readable-live--2026-10-20).

Association is bounded by the available transcript window and supported formats;
it is not a complete project output inventory. Redaction is a secondary defense,
not a guarantee that all sensitive content is removed. Documents are downloaded
for opening in the user's chosen application; they are not validated or executed
by the dashboard. No real transcript or captured user artifact is used as a
repository fixture.

Other implementation locations: [content normalization](../src/session-content.mjs),
[session details](../src/details.mjs), [HTTP routes](../src/server.mjs),
[preview UI](../ui/artifact-view.js), [inspector](../ui/inspector.js) and
[native downloads](../desktop/AgentFleet.swift). No package dependency is added.
