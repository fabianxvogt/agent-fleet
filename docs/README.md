# Documentation

Start with the [project README](../README.md) for requirements and a quick start.

- [Usage](USAGE.md): graph/list navigation, filters, attention, freshness and configuration.
- [Mac app](DESKTOP.md): install, update, login startup and removal.
- [Input notifications](NOTIFICATIONS.md): opt-in Mac alerts, privacy, freshness and bounded request tracking.
- [Browser live views](BROWSER.md): automatic discovery, terminal commands, attachment and limits.
- [Adapters](ADAPTERS.md): data-source contract and custom adapters.
- [Agent relations and branch consistency](RELATIONS.md): supported OMP messages/reports, exact identities, active branches and separate archive history.
- [Session artifact previews](ARTIFACTS.md): Results Files, image/text previews, document saving and access boundaries.
- [Development](DEVELOPMENT.md): tests, native checks, source map and repository hygiene.
- [Verification and limitations](VERIFICATION.md): dated measurements, regression coverage and remaining validation.
- [Roadmap](../ROADMAP.md): Now / Next / Later / Done.

The current release is **v0.13.0** (`INCREMENTAL / EMPIRICAL`). It adds opt-in
Mac notifications for supported explicit input requests, direct session links
and Claude process-start identity checks. Agent relations, active branches,
Files in Results, automatic Live, source freshness, graph folding, lists and
filters remain available. See the [notification contract](NOTIFICATIONS.md) and
[verification notes](VERIFICATION.md).
Evidence is synthetic and bounded; everyday runtime coverage, sustained workloads
and a real logout/login cycle still need validation.
