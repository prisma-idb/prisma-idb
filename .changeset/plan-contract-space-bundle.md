---
"@prisma-idb/family-idb": minor
---

Regenerate the app contract-space bundle after planning a migration, keeping the browser migration chain current. Write beside the resolved contract by default, or use `migration plan --out` for a custom path. Extension-space planning is unchanged.

Refuse an app schema revert to an earlier contract hash before writing a cyclic package or updating the bundle, with a clear error and exit code 1.
