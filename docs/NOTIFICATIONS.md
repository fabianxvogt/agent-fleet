# Input notifications

The native Mac app can notify you when a supported session records a new,
explicit question or approval request. Notifications start **off**. Enable
**Alerts off** in the dashboard toolbar, or **View → Input Notifications** in
the Mac menu. macOS asks for permission on that explicit action only.
The control is hidden in an ordinary browser.

Notifications contain a generic request to open Agent Fleet. They do not include
session titles, projects, paths, question text or tool arguments, and request no
sound. A batch containing multiple sessions uses a session count. Click a
notification to open the dashboard and recheck the request before selecting its
session. Existing filters and collapsed branches do not hide that destination.
If the request is resolved, its source is unavailable, or its notification
mapping was lost on app restart, the dashboard opens without selecting another
session or scheduling a later jump.

## Lifecycle and freshness

The native app checks the local service every four seconds while alerts are
enabled and permitted. Closing the window leaves this monitor running.
**Command-Q stops notifications**; the independent background collector continues.
The preference persists between normal app launches.

- Startup, enabling alerts and restarting the service establish a baseline.
  Existing requests do not produce a catch-up batch.
- Failed or delayed source observations pause the affected source. Its
  first complete recovery is another baseline. Healthy sources remain
  independent. Process failures, transport failures and truncated feeds pause
  all sources; their first complete recovery baselines all current requests.
- Distinct pending requests are tracked separately, including concurrent
  questions within one session. Repeated observations do not notify again.
- Completed replies, runtime notices, inferred prose questions and events
  without a stable runtime request identity do not notify.
- **Alerts blocked** means permission or delivery needs attention. Check
  **System Settings → Notifications → Agent Fleet**, or turn alerts off.
  Permission is rechecked when the app activates and periodically while enabled.
- **Alerts updating** means the monitor is waiting for usable source data.
  Last-known requests remain visible while their source data is retained.

This intentionally favors avoiding stale alerts. A request first seen during
startup or recovery stays visible in the dashboard without generating a
notification. macOS Focus and notification settings can also affect delivery.

## Local observation contract

[`GET /api/attention`](../src/notifications.mjs) returns metadata from one captured
collector snapshot. It uses the same loopback and cross-site restrictions as
session APIs, with `Cache-Control: no-store`.

Version 1 contains a per-server `instanceId`, response `observedAt`,
`staleAfterMs`, process health, per-source health, a `requests` array and
`truncated`. Each request contains only `sourceId`, `sessionId`, `requestId`,
`kind` and the recorded event time. The request ID is a SHA-256 digest scoped
to the runtime and request kind; the native monitor additionally scopes it by
source and session. No transcript content is included.

The attention reader exports all pending explicit requests in its supported
bounded input, with `requestsComplete`. Missing or malformed IDs/timestamps are
ineligible for notification; file modification time is not a replacement for a
notification event time. A feed exceeding 1,024 requests is marked `truncated`
with an empty request array. That means unknown, not resolved.

The native client bounds responses to 4 MiB and rejects redirects, malformed
feeds and replayed observation times. Deduplication history is bounded to 8,192
keys and seven days. Session logs are bounded reads, so omitted historical
events and unsupported runtime formats remain coverage limits.

## Verification

The pure Swift reducer and injected notification adapter are tested without
requesting OS permission. A dedicated UI test mode requires both `--test-url`
and `--test-notifications`; it uses only an in-memory permission/delivery adapter
and does not read or write the real notification preference. The View menu
exposes simulated deliveries and permission changes for synthetic UI checks.

See [verification notes](VERIFICATION.md) for executed checks and remaining
limits. Actual Notification Center delivery and Focus behavior require a normal
user-enabled run; simulated delivery is not evidence of those OS behaviors.

Implementation uses Apple's
[permission API](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications)
and [notification delegate](https://developer.apple.com/documentation/usernotifications/unusernotificationcenterdelegate).
