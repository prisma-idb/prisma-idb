---
"@prisma-idb/family-idb": patch
---

`prisma-idb migration preflight` now replays the chain through the browser's own upgrade, which also writes each migration's marker. Before, it used its own replay that wrote no marker, so it approved a chain without the `_prisma_next_marker` store, which fails to open in the browser.

Breaking: `prisma-idb migration preflight` now exits 2 with `IDB-CLI.PREFLIGHT_FAILED` and prints "No migration packages found" when the migrations directory has no packages. Before, it exited 0 with "Nothing to preflight". A CI job that runs preflight before the first `migration plan` must now plan the baseline first, or skip the step. The `prisma-orm-usage` and `prisma-orm-kanban-example` apps already have migration chains, so their scripts are unaffected.

Generating the contract space now fails when a migration package has a missing or unreadable `migration.json` or `ops.json`. Before, it skipped the package with a warning, which could leave the generated head on an earlier migration.
