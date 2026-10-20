# Session artifact previews

Status: **planned for v0.10; not implemented yet**. This is the next feature
after the measured deep-tree robustness fixes and large-graph rendering work.
The current Results tab displays text and tool replies only.

## User experience

Add a Files section to Results without replacing existing replies. Show a file's
name, type, size, modification time and association with its originating entry.
Distinguish **Linked in response** from **Written by tool**: a link does not prove
that the session created the file.

- PNG, JPEG, GIF and WebP: inline image previews.
- Text, code, Markdown and JSON: expandable, escaped text with a clear truncation
  notice. HTML and SVG are text, never executable inline documents.
- Supported documents such as PDF and Office files: metadata and an explicit
  download action. Embedded document rendering is a later extension.
- Missing, changed, oversized, restricted and expired files: understandable states
  that leave the rest of the session usable.

Open previews and reading position should survive normal refreshes. Loading a
preview for an old selection must never alter the newly selected session.
Downloads must also work in the native Mac window without navigating it away from
the dashboard.

## Association and access

Association comes from explicit local Markdown links/images in assistant replies
or successful, supported file-writing tool fields. Parse these before transcript
normalization discards structure. Exclude code examples, user messages, failed
tools, read-tool inputs, bare paths and arbitrary shell output. Do not scan project
directories or fetch remote links. Respect active Pi/OMP branches and verified
archive identities.

Keep filesystem policy in one artifact module owned by the details module.
Callers supply a known session and normalized evidence; clients receive opaque
session-bound IDs. The HTTP route accepts IDs, never a client-provided path.

For every preview/download, revalidate the session identity, canonical workspace,
file identity, regular-file status and size. Both original and resolved paths must
pass private-context and credential-file exclusions. Symlinks cannot escape the
workspace; broad roots such as `/` or the home directory are not valid artifact
roots. Files outside the workspace remain visibly unavailable without probing
their existence. External output roots require a separate explicit contract.

Bound the initial implementation to 32 candidates per entry, 128 registered files
per session, 24 cached sessions, 64 KiB text previews and 8 MiB images/downloads.
Verify image signatures, redact text using the existing content rules, and send
`no-store`, `nosniff` and restrictive response policies. Downloads use attachment
disposition. No profile data, real session fixtures or captured user output enters
the repository.

## Lifetime

The UI keeps up to 400 observed local entries while a local read returns at most
120. Ordinary polling must not immediately discard older loaded associations.
Use a bounded registry with explicit expiry, replace references when an entry
changes, and revoke IDs when the session source/root changes. An archive revision
change invalidates associations supported only by the superseded revision.
Deletion, replacement or a newly restricted path stops serving immediately.

## Acceptance evidence

- Synthetic Codex, Claude, Pi/OMP and archive records exercise valid association,
  escaped paths, code-example exclusions, failed tools and abandoned branches.
- HTTP tests exercise cross-session IDs, source replacement, traversal, private
  aliases, credential paths, nonregular files, symlink/replacement races, payload
  limits, MIME spoofing and hostile filenames/text.
- UI tests cover stale requests, polling retention, replaced archive revisions,
  open-preview preservation and accessible empty/error states.
- Browser and native-window checks demonstrate an image, text preview, document
  download, deleted file and unavailable preview using synthetic data.

Implementation locations: [content normalization](../src/session-content.mjs),
[session details](../src/details.mjs), [HTTP routes](../src/server.mjs),
[inspector](../ui/inspector.js) and [native navigation](../desktop/AgentFleet.swift).
No new package dependency is currently required by this design.
