---
"@prisma-idb/target-idb": minor
"@prisma-idb/family-idb": minor
"@prisma-idb/client-idb": minor
"@prisma-idb/sync-extension-idb": minor
"@prisma-idb/sync-server": minor
"@prisma-idb/sync-server-sql": minor
---

Upgrade to Prisma `8.0.0-rc.24` (`prisma` CLI `8.0.0-rc.34`, `@prisma/cli-engine` `0.10.0`).

- IDB codecs follow the new codec model: each data type reads and spells its own JSON form, and `codecValueToJson` and `codecValueFromJson` from `@prisma-idb/target-idb/runtime` replace a codec's `encodeJson` and `decodeJson`.
- Value objects live in storage, as Prisma now stores them. `decodeJsonRecord` takes the whole contract instead of its domain.
- The CLI migration runner refuses with `MIGRATION.IDB_CLI_UNSUPPORTED`, replacing `IDB-RUNNER-CLI-UNSUPPORTED`.
- The Postgres sync config uses Prisma's own `DateTime`, which is now `timestamptz(3)` read as a JavaScript `Date`. An existing server database needs a one-time migration of each `DateTime` column to `timestamptz(3)`; see "Upgrade a database created before 0.10" in the sync server docs. The injected `Changelog.id` uses `@onCreate(uuid(7))`, because SQL `@default` now sets database defaults only.
- Postgres clients take `contract: contractFromJson<Contract>(json)` in place of `contractJson`.
