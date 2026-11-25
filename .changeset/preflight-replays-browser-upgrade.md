---
"@prisma-idb/family-idb": patch
"@prisma-idb/target-idb": patch
---

`prisma-idb migration preflight` replays the chain through the browser's own upgrade, which also writes each migration's marker. The upgrade fails if the chain omits the `_prisma_next_marker` store or creates it with a key path other than `space`.

Breaking: `prisma-idb migration preflight` now exits 2 with `IDB-CLI.PREFLIGHT_FAILED` and prints "No migration packages found" when the migrations directory has no packages. Before, it exited 0 with "Nothing to preflight". A CI job that runs preflight before the first `migration plan` must now plan the baseline first, or skip the step. The `prisma-orm-usage` and `prisma-orm-kanban-example` apps already have migration chains, so their scripts are unaffected.

Generating the contract space fails when a migration package has a missing, unreadable, or malformed `migration.json` or `ops.json`. The error names the file. The operations file must contain a JSON array.
