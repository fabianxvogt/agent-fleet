# Using Agent Fleet

Start the dashboard using the [quick start](../README.md#quick-start), or open the installed Mac app. Both present the same views and controls.

## Graph and list

**Graph** shows session relationships. Select a node to inspect its activity, chat, results and relations. Spawn and inferred process links show parent/child relationships; message, report and dependency links show other observed connections.

**List** shows compact rows ordered by latest activity, including title, agent, project, status and activity age. Select a row for details or its **LIVE** button for the browser. The list uses normal scrolling. The chosen view is remembered across reopening; selection survives switching views.

Both views use the same session filters. Header counters count matching sessions before graph folding. Graph folds do not hide list rows or attention items.

### Finished branches

Use a parent's **− N finished / + N finished** control to fold or expand its completed child branches. **Collapse finished** applies folding across the graph; **Expand all** clears the fold choices. Controls also accept Enter and Space.

Only entirely completed child branches can fold. Active work, requests, failures, uncertain or stale states, and available LIVE browsers keep their branch visible. An unfinished descendant remains a blocker even when a filter excludes it. Folded counts include only matching sessions, and the graph summary distinguishes matching, shown and folded sessions.

Selecting a hidden result from attention or relations opens its path. Folding a selected child moves selection to the visible parent. Resumed work automatically becomes visible. Fold choices survive updates, filters and view changes in the current window; reloading resets them.

## Filters and time scope

**Project** and **Status** combine with search and agent selection. Project choices cover the full collection window and stay selectable even with zero current matches. Ancestors must also match explicit filters to appear in the graph.

**Reset filters** clears project, status, search and hidden agents. It preserves the time scope, parked preference and graph folds.

- **Live** includes live sessions, failures, their trees, and children completed in the last ten minutes.
- **Last 12 h** includes everything inside the configured collection window.
- **Show parked sessions** includes quiet sessions parked after two hours by default. Recognized unanswered requests and failures remain visible without this option.

The attention rail applies the same explicit filters. Its recent-completion window remains ten minutes regardless of the graph's time scope.

## Status and attention

Session lifecycle and reply completion are separate. A finished reply in an open session can remain **Idle** with **Reply finished**. **Done** means the session ended. **Last known** describes retained source data alongside its last observed lifecycle status.

The attention rail separates:

- **Needs you:** explicit input/approval requests and conservatively inferred questions in final root-session replies. Inferences are labeled; an ordinary completed reply is not an input request.
- **Failed:** observed failures, which remain visible in Live.
- **Recently finished:** replies or sessions completed in the last ten minutes.

Recognition depends on the runtime's logs. Pi/OMP activity can still rely on file recency. Treat the observation timestamp as part of the status: a previous log entry does not prove what a process is doing now.

## Freshness and unavailable sources

The freshness indicator updates even when the graph does not change. **Current**, **Delayed** and **Source unavailable** describe collection health; source rows show the age of their underlying observations.

At the default four-second interval, an observation is stale after twelve seconds. A source that temporarily fails retains its last usable view for up to two minutes, labeled **Last known**. A newly published result does not reset the age of an old observation.

Sources publish independently. A delayed source stops animating while healthy sources keep updating. If the shared process observation or dashboard connection becomes stale, the view stops presenting its animation as current work. Retained data expires instead of remaining indefinitely.

If freshness remains delayed, inspect the source rows and run:

```bash
node bin/agent-fleet.mjs service-status
```

For an installed service, logs are at `~/.agent-fleet/logs/agent-fleet.log`. Service upgrades require `install-service` to refresh the launch registration; `install-app` alone preserves an existing registration. See the [service scheduling notes](VERIFICATION.md#v09-source-isolation-and-service-scheduling--2026-10-18) for the v0.9 investigation and measured limits.

## Session inspector

Select a node or list row to open its inspector. Activity includes its observation time. **Chat** shows messages and tool calls; **Results** shows returned tool outputs, agent replies and associated files. Expand a tool to inspect its input/output. Technical metadata and relations are under **Session details & relations**.

Only the selected session's content refreshes, every four seconds while the dashboard tab is visible. Recent content comes from local logs. **Load earlier messages** requests archive history from the configured agentsview service; the refresh control reloads it. If agentsview is unavailable or the session is not indexed, recent local events remain readable. OpenCode process-only nodes currently have no transcript reader.

For OMP, Pi and fleet, current Chat, Results and recorded Live activity follow the local transcript's active branch. Older archive messages appear under a separate collapsed **Archive history** disclosure because their branch cannot be verified. Expand it to read or load earlier archive messages; they do not become current activity or Results. It stays open across same-branch updates and closes when the branch changes. A detected branch switch or session-file replacement clears superseded local content; a read failure retains labeled last-known activity. Claude and Codex continue to combine supported local and archive history.

Content availability follows the runtime's recorded events. The inspector excludes private thinking/reasoning and system records; it displays text rather than executing log content. Credential redaction is a secondary defense, not a guarantee that all sensitive text is removed.

### Relations

Within **Session details & relations**, relations appear before technical facts. Each row shows the other session, the connection's direction, observed count and recorded date/time. Click a row or use Enter/Space to inspect that session; keyboard focus survives ordinary updates.

Supported OMP sessions can show worker starts, incoming messages, queued sends and returned reports. **Message queued** confirms the send receipt, not delivery or action. **Result received** can include failed or cancelled work. Counts cover events observed in the retained transcript window, not all-time totals, and can decrease when old evidence expires or the active branch changes.

Unknown or ambiguous endpoints stay unlinked. See [Agent relations and branch consistency](RELATIONS.md) for supported OMP formats and current limits.

### Files in Results

The **Files** section contains files explicitly linked in an assistant reply or written by a supported successful tool. Expand a file to see its size, modification time and association. **Linked in response** does not mean that the session created it.

PNG, JPEG, GIF and WebP files have image previews. Text, code, Markdown and JSON have readable text previews; HTML and SVG are shown as text. Long text is limited to 64 KiB with a truncation notice. PDF, Word, Excel and PowerPoint documents offer **Download**; in the Mac app, choose the destination in its save dialog. Images and downloads are limited to 8 MiB.

Only files within the selected session's workspace are eligible. Protected, missing, changed, oversized and unsupported files show an explanation. Opening a file does not scan the project or follow remote links. Open previews and reading position survive ordinary updates; changing session clears the previous selection. References are bounded and can expire, so use the inspector refresh control to check for newly observed references.

Supported association formats, retention and access boundaries are documented in [Session artifact previews](ARTIFACTS.md).

### Automatic Live

Choose **Live** in any selected session's inspector. Its heading states the current session lifecycle, such as **Agent is working**, **Agent is idle** or **Agent needs your input**. Retained source data is labeled **Last known status**. The content underneath automatically shows the most useful available evidence:

1. A fresh image from a supported browser.
2. A recent observed terminal command, with its working directory and output.
3. The latest tool action, agent response or session activity.
4. The last known observation with its timestamp, or the session status while content loads.

Commands distinguish waiting for output, running when last observed, completion and failure. Recorded activity shows its date and time; a previous command is not proof that it is still running. Output updates when the runtime writes it to the session log; the inspector polls every four seconds while visible. It does not stream the terminal screen or expose private reasoning. Refresh failures and old observations are labeled; a frozen or unavailable browser image gives way to recorded activity.

Supported Claude background-task notifications appear as readable **Session notices**, including when a command was marked stopped without confirmed completion. They remain secondary to meaningful command or response activity. The recognized runtime envelope is not displayed as raw XML or mislabeled **Latest instruction**; quoted examples and ordinary user messages remain messages. Other runtime notification formats may still need support.

A gold **LIVE** badge opens an available browser directly. Supported dedicated Chromium pages appear automatically when ownership is unambiguous. **Browser view** switches between multiple pages associated with a session. Multiple sessions can have available views at once.

The dashboard observes the selected page while the terminal agent retains control. Switching away or hiding the dashboard stops capture; the browser continues running. When no supported browser is available, optional browser setup stays collapsed so recorded activity remains easy to read. Expand it to copy the command for a separate managed browser; terminal commands can also attach an explicit existing browser. Private-pipe-only tools require another integration. See [browser commands and boundaries](BROWSER.md).

## Graph navigation

Drag the graph to pan. Pinch or Command-scroll to zoom. Navigation stays within the complete graph's bounds, with a small margin; zooming out stops at the overview. Large overviews use compact status-colored cards. Select a card with a click, Enter or Space to zoom to its details. At readable zoom, offscreen cards are omitted from drawing while selection, relations and the full list remain available. Switching back from List centers the selected session.

| Shortcut | Action |
| --- | --- |
| `f` | Fit the full graph |
| `/` | Focus search |
| `Esc` | Deselect the session |

The compact list scrolls normally without graph zoom gestures.
