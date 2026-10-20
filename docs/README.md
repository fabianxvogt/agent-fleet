# Documentation

Start with the [project README](../README.md) for requirements and a quick start.

- [Usage](USAGE.md): graph/list navigation, filters, attention, freshness and configuration.
- [Mac app](DESKTOP.md): install, update, login startup and removal.
- [Browser live views](BROWSER.md): automatic discovery, terminal commands, attachment and limits.
- [Adapters](ADAPTERS.md): data-source contract and custom adapters.
- [Agent relations and branch consistency](RELATIONS.md): supported OMP messages/reports, exact identities, active branches and separate archive history.
- [Session artifact previews](ARTIFACTS.md): Results Files, image/text previews, document saving and access boundaries.
- [Development](DEVELOPMENT.md): tests, native checks, source map and repository hygiene.
- [Verification and limitations](VERIFICATION.md): dated measurements, regression coverage and remaining validation.
- [Roadmap](../ROADMAP.md): Now / Next / Later / Done.

The current release is **v0.12.0** (`INCREMENTAL / EMPIRICAL`). It adds structured
OMP communication and managed-worker relations, direct navigation between agents,
active-branch consistency and a separate OMP/Pi/fleet archive disclosure.
Files in Results, automatic Live, source freshness, graph folding, lists and
filters remain available. See the [contract](RELATIONS.md) and
[v0.12 verification notes](VERIFICATION.md#v012-agent-relations-and-branch-consistency--2026-10-20).
Evidence is synthetic and bounded; everyday runtime coverage, sustained workloads
and a real logout/login cycle still need validation.
