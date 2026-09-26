# ADR 019: The browser applies planned migrations as written

- **Status:** Accepted
- **Date:** 2026-09-26
- **Area:** Migrations

## Summary

`createAutoMigratingIdbClient` applies every pending migration exactly as it was planned, including operations that drop stores or indexes. It has no runtime policy for skipping or refusing operations. Destructive changes are reviewed when they are planned: `prisma-idb migration plan` warns when a migration drops a store.

## Context

An early version of the IndexedDB target planned migrations in the browser. When the app opened the database, the runtime diffed the live schema against the contract and applied the difference. No developer ever saw that plan. Upstream review feedback pointed out that this could silently wipe a user's local data, such as drafts or queued offline work, and asked for a safe default. The client gained a `policy` option: it applied only `additive` and `widening` operations, and refused to open when a destructive one was pending unless the app passed `onDestructive: 'allow'`.

Since then, migrations have moved to design time ([ADR 018](ADR%20018%20-%20Separate%20prisma-idb%20CLI.md)). The developer runs `prisma-idb migration plan`, reviews the generated package and commits it. The browser only replays what was committed. The premise of the feedback, that nobody reviews the plan, no longer holds.

The policy then did more harm than good:

- **It stopped the app from opening.** Shipping a reviewed migration that dropped a store, or just dropped an index to change its definition, made every user's app throw on open until the app changed its code. Dropping an index loses no data at all.
- **It could corrupt the database silently.** Operations outside the allowed classes were skipped, but the marker still moved to the new contract hash. The database then claimed a schema it didn't have. No operation used another class yet, but record transforms ([ADR 016](ADR%20016%20-%20Declarative%20Record%20Transforms%20in%20IDB%20Migrations.md)) would have been `data` operations, skipped by default.

Upstream draws the same line. `prisma migrate`, which applies planned migration files, allows all four operation classes. Only `db init` and `db update`, which plan on the fly with nobody reviewing, restrict them.

## Decision

- **Apply the whole chain or nothing.** The browser applies every pending operation, in order, in one upgrade transaction ([ADR 002](ADR%20002%20-%20Two-Phase%20Migration.md)). It never skips an operation. If the chain is broken or a package fails its integrity check, it throws before touching the database.
- **Warn at plan time.** `prisma-idb migration plan` prints a warning to stderr when a migration drops a store, naming each store whose records will be deleted. Dropping an index isn't listed, because nothing is lost.
- **No runtime switch.** The `policy` option and the `MigrationPolicy` type are removed.

## Alternatives considered

- **Keep the policy, but default to allowing everything.** This fixes the default, but keeps a switch whose only effects are breaking the app (`refuse`) or corrupting the database (a class filter). Rejected.
- **Require a flag such as `--allow-destructive` to plan a destructive migration.** The generated `migration.ts` is already reviewed before it's committed, and a flag would mostly be passed by habit. A warning names the affected stores without getting in the way. We can add a flag later if warnings prove too easy to miss.

## Consequences

- Shipping a destructive migration is a normal release. The review is the developer's, at plan time.
- A migration that drops a store deletes that store's records on every user's device the next time they open the app. The warning at plan time is the only prompt.
- Data that exists only on the device, such as unsynced offline work, is lost if its store is dropped. Apps that need to keep it must move it before dropping the store. Until record transforms exist, that means keeping the old store for a release.

## Related

- [ADR 002](ADR%20002%20-%20Two-Phase%20Migration.md): schema changes and markers commit in one transaction.
- [ADR 018](ADR%20018%20-%20Separate%20prisma-idb%20CLI.md): where migrations are planned.
- `client-idb/src/core/auto-migrate.ts`: `walkChain` and `autoMigrate`.
- `family-idb/src/core/migration-plan.ts`: `warnAboutDeletedData`.
