# ADR 018: A separate `prisma-idb` CLI for three migration commands

- **Status:** Accepted, meant to be temporary
- **Date:** 2026-09-26
- **Area:** Migrations, CLI

## Summary

IndexedDB lives only in the browser, so the `prisma` CLI, which runs in Node, has no database to connect to. Most `prisma` commands still work for an IndexedDB project. Three jobs have no upstream equivalent, so a small companion CLI, `prisma-idb`, provides them:

| Command                               | What it does                                                             |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `prisma-idb migration plan`           | Plans the next migration, starting from the newest migration on disk.    |
| `prisma-idb migration contract-space` | Bundles the migrations into a TypeScript module the browser can import.  |
| `prisma-idb migration preflight`      | Applies every migration to an in-memory IndexedDB to check that it runs. |

We would rather have these jobs inside `prisma` itself. This CLI is a stopgap until the framework has a way to support them.

## Context

### How migrations differ for a browser database

| Step   | Server database (for example Postgres)                                             | IndexedDB                                                                                                |
| ------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Plan   | `prisma migration plan` diffs from the contract the database is at (the `db` ref). | Same planner, but there is no `db` ref, because no database is reachable from Node.                      |
| Apply  | `prisma migrate` runs the migrations from Node.                                    | The app applies them in each user's browser when it opens the database (`createAutoMigratingIdbClient`). |
| Verify | `prisma db verify` compares the live database with the contract.                   | Nothing to connect to.                                                                                   |

The browser cannot read the `migrations/` folder, so the migrations must be shipped inside the app's JavaScript bundle.

### What `prisma` already does for IndexedDB

Checked against the `prisma` CLI 8.0.0-rc.7 on 2026-09-26, using `apps/prisma-orm-usage`:

- `prisma contract emit` works.
- `prisma migration list`, `migration status` and `migration check` work.
- `prisma migration plan` works when given `--from <newest migration>`. Without `--from` it has no `db` ref to start from, so it plans a full baseline again.
- `prisma db verify`, `db init` and `db update` fail with a message explaining that IndexedDB only exists in the browser. The error codes are the framework's generic ones (`CONTRACT.VERIFY_FAILED`, `MIGRATION.RUNNER_FAILED`).
- `prisma db sign` currently fails with `CLI.INTERNAL_ERROR` instead of that message. This is a bug.

Both CLIs read the same `prisma.config.ts`. The three `prisma-idb` commands only use the standard `orm` section (`contract.output` and `migrations.dir`). There is no IndexedDB-specific config.

## Decision

Ship the three commands as a separate binary, `prisma-idb`, in `@prisma-idb/family-idb`. It is built on `@prisma/cli-engine`, the same engine as `prisma`, so help text, `--json` output and exit codes behave the same way.

### `migration plan`

This command uses the same IndexedDB planner as `prisma migration plan`. The only difference is where it starts. It diffs from the newest migration package on disk, so you don't have to pass `--from`.

This is safe for IndexedDB and would not be safe for a server database. A server database can be migrated separately from the files on disk, which is why `prisma` tracks it with the `db` ref. An IndexedDB database is only ever migrated by the app, from the migrations bundled into it. So the files on disk are the only state there is.

The command also takes `--space <id>` to plan migrations for an extension's contract space, such as `sync-extension-idb`'s. See [ADR 011](ADR%20011%20-%20No%20Migration%20Materialization%20for%20IDB%20Extensions.md).

This is the weakest of the three reasons for a separate CLI. It would go away if the framework let a family choose the default `--from` when there is no `db` ref.

### `migration contract-space`

A server target applies migrations by reading the `migrations/` folder from Node. The browser can't do that. This command reads every migration package under `migrations/app/`, checks that they form a single chain, and writes `contract-space.generated.ts`. That module imports each package's `migration.json` and `ops.json` and builds a `ContractSpace` from them. The app imports it, and the browser walks it to migrate the database on open.

Server targets never need to bundle migrations into client code, so `prisma` has no equivalent.

The generated module includes the head of the chain directly. The command does not write `migrations/refs/head.json`, because the framework treats every top-level folder under `migrations/` as a contract space, and a `refs/` folder there would be read as one.

### `migration preflight`

This command applies every migration's `ops.json`, in chain order, to a fresh [`fake-indexeddb`](https://github.com/dumbmatter/fakeIndexedDB) database, an in-memory implementation of IndexedDB for Node.

`prisma migration check` verifies hashes and the shape of the migration graph, but it never runs the operations. For a server database, the first real run happens when a developer runs `prisma migrate` against a local database. IndexedDB has no local database in Node. Without preflight, the first time a migration actually runs is in a user's browser.

Preflight is a separate command that you run in CI. It is not built into `plan` or into the app, for three reasons:

- `fake-indexeddb` does not match real browsers in every edge case, so it can't be the final word on whether a migration works.
- Running it automatically would stand in for real tests of the migrations.
- Building it into the app would ship a test-only package to production.

Preflight checks that the chain applies without errors. It does not check that the result matches the contract.

## Alternatives considered

### Put all three jobs inside `prisma`, delegating to the family

This is the framework's model: one consistent set of commands, whose behaviour each database family supplies. Users don't have to learn different commands for different databases. We prefer this model. It would need three framework extension points that don't exist today:

- For `plan`: let the family supply the default `--from` when there is no `db` ref.
- For `contract-space`: a family step that bundles migrations for a client-side runtime.
- For `preflight`: a family-supplied offline apply check, for example as part of `migration check`.

Upstream maintainers said in September 2026 that there is no plan for families to add their own commands. They also said that many existing commands already delegate their implementation to the family. The three points above would fit that pattern.

### A family-scoped command group in `prisma`

For example, `prisma family idb contract-space`. This would keep everything in one CLI and make it clear which commands belong to which family. It goes against the framework's goal of one command set for every database, so we did not pursue it.

### Run preflight automatically

Rejected for the reasons listed under `migration preflight` above.

## Consequences

- An IndexedDB project uses two CLIs: `prisma` for `contract emit` and the read-only `migration` commands, and `prisma-idb` for the three commands above.
- The framework still requires a `driver` in `prisma.config.ts`, even though no command can use one. IndexedDB projects pass the stub `@prisma-idb/driver-idb/control`.
- The framework's control interface has no way to say "this can't run here". So for IndexedDB, `introspect`, `readMarker` and `readAllMarkers` return empty results, and `verify` and `sign` return a failure with the explanation in its summary. A proper "unsupported" result in the framework would be cleaner, and would avoid bugs like the `db sign` crash above. We have raised this upstream.
- `fake-indexeddb` is a dependency of `family-idb` only because of preflight. The browser runtime never uses it.
