---
"@prisma-idb/client-idb": patch
"@prisma-idb/family-idb": patch
"@prisma-idb/target-idb": patch
---

Breaking: PSL store and index names now decode escape sequences, as upstream Prisma does. `@@map("a\nb")` names the store `a`, a newline, then `b`, where it used to keep the backslash and `n` as written. `"a\\b"` now gives one backslash instead of two. The same applies to `name:` and `map:` on `@@index` and `@@unique`. An unknown or incomplete escape, such as `\q` or `\u12`, stays as written. Names without a backslash are unchanged.

An index name that decodes differently can be dropped and recreated without deleting records. A store name that decodes to an unused name can cause the migration to create an empty store and drop the old store with its records.

Planning rejects a store move that would reuse a name when both contracts identify the moving model. The planner also reads model bindings from legacy snapshots without stored record shapes. Snapshots with neither source of model bindings are compared by store name.

During browser upgrades, each store has one owner at a time. A contract space can create a store under a name another space releases earlier in the same upgrade. An attempt to use a store still owned by another space aborts the upgrade.

To keep existing stores and their records, update affected `@@map` strings before emitting the contract so each decodes to its original store name. For example, use `@@map("a\\nb")` to keep a store named `a\nb`. Verify each model's emitted store name against the previous contract, then review the planned migration for store drops before applying it.
