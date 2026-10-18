# Using Agent Fleet

Start the dashboard using the [quick start](../README.md#quick-start), or open the installed Mac app. Both present the same views and controls.

## Graph and list

**Graph** shows session relationships. Select a node to inspect its activity, chat, results and relations. Spawn and inferred process links show parent/child relationships; message and dependency links show other observed connections.

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

Select a node or list row to open its inspector. Activity includes its observation time. **Chat** shows messages and tool calls; **Results** shows returned tool outputs and agent replies. Expand a tool to inspect its input/output. Technical metadata and relations are under **Session details & relations**.

Only the selected session's content refreshes, every four seconds while the dashboard tab is visible. Recent content comes from local logs. **Load earlier messages** requests archive history from the configured agentsview service; the refresh control reloads it. If agentsview is unavailable or the session is not indexed, recent local events remain readable. OpenCode process-only nodes currently have no transcript reader.

Content availability follows the runtime's recorded events. The inspector excludes private thinking/reasoning and system records; it displays text rather than executing log content. Credential redaction is a secondary defense, not a guarantee that all sensitive text is removed.

### Browser Live

Click a gold **LIVE** badge or choose **Live** in the inspector. Supported dedicated Chromium pages appear automatically when ownership is unambiguous. **Browser view** switches between multiple pages associated with a session. Multiple sessions can have available views at once.

The dashboard observes the selected page while the terminal agent retains control. Switching away or hiding the dashboard stops capture; the browser continues running. Optional terminal commands create a separate managed browser or attach an explicit existing browser. Private-pipe-only tools require another integration. See [browser commands and boundaries](BROWSER.md).

## Graph navigation

Drag the graph to pan. Pinch or Command-scroll to zoom. Navigation stays within the drawn graph's bounds, with a small margin; zooming out stops at the overview.

| Shortcut | Action |
| --- | --- |
| `f` | Fit the full graph |
| `/` | Focus search |
| `Esc` | Deselect the session |

The compact list scrolls normally without graph zoom gestures.
