---
"@prisma-idb/family-idb": patch
---

`prisma-idb migration preflight` now replays the chain through the browser's own upgrade, which also writes each migration's marker. Before, it used its own replay that wrote no marker, so it approved a chain without the `_prisma_next_marker` store, which fails to open in the browser. Preflight also fails when there are no migration packages, instead of reporting success.

Generating the contract space now fails when a migration package has a missing or unreadable `migration.json` or `ops.json`. Before, it skipped the package with a warning, which could leave the generated head on an earlier migration.
