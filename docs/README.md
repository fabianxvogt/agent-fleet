# Documentation

Start with the [project README](../README.md) for requirements and a quick start.

- [Usage](USAGE.md): graph/list navigation, filters, attention, freshness and configuration.
- [Mac app](DESKTOP.md): install, update, login startup and removal.
- [Browser live views](BROWSER.md): automatic discovery, terminal commands, attachment and limits.
- [Adapters](ADAPTERS.md): data-source contract and custom adapters.
- [Session artifact previews](ARTIFACTS.md): Results Files, image/text previews, document saving and access boundaries.
- [Development](DEVELOPMENT.md): tests, native checks, source map and repository hygiene.
- [Verification and limitations](VERIFICATION.md): dated measurements, regression coverage and remaining validation.
- [Roadmap](../ROADMAP.md): Now / Next / Later / Done.

The current release is **v0.11.0** (`INCREMENTAL / EMPIRICAL`). It adds
session-associated files in Results, bounded image/text/code previews and native
document saving. Live separates current lifecycle from recorded activity, makes
supported runtime notices readable and keeps optional browser setup collapsed.
Compact graph overviews, source freshness, graph folding, lists and filters remain
available. See the [v0.11 verification notes](VERIFICATION.md#v011-files-and-readable-live--2026-10-20).
Evidence is synthetic and bounded; everyday runtime coverage, sustained workloads
and a real logout/login cycle still need validation.
