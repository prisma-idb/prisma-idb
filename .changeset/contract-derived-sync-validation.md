---
"@prisma-idb/target-idb": minor
"@prisma-idb/sync-server": minor
"@prisma-idb/sync-server-sql": minor
"@prisma-idb/sync-extension-idb": minor
---

Validate synced records and keys using cached arktype validators derived from the contract. Extra fields and invalid enum values are rejected without mutating input.

Push checks now return a `validation-failure` check with `RECORD_VALIDATION_FAILURE` or `KEYPATH_VALIDATION_FAILURE` before ownership work. SQL pushes validate create records and partial update patches, returning non-retryable failures before opening a transaction. Consumers of `validatePush` must handle the new check kind. The exported low-level `validatePush` function now requires the client contract as its third argument; the bound `SyncServer.validatePush` signature is unchanged.

Pulls validate decoded records and keys before writing, report corrupt rows through `validationFailed` in both `ApplyPullResult` and `pullcompleted`, and advance the cursor past corrupt rows while valid rows in the same batch still apply.

SQL push validation retains wire-form keys for ownership checks and changelog JSON, while ORM lookups use native keys. BigInt root and scoped keys round-trip through push and pull without getting stuck in the outbox.

Required JSON scalars accept JSON `null` independently of database nullability, while missing values and `undefined` remain invalid. Pull cursor documentation now explains that advancing past a later applied or corrupt row can also pass an earlier transaction failure; cursor behavior is unchanged.

SQL pushes encode required Postgres JSON nulls at the ORM write boundary so create and update succeed instead of becoming stuck retryable events.

SQL validation covers legacy Date/time codecs and native text arrays. Unsupported contract validators fail at server construction instead of rejecting pushes at runtime.

Push record validation and construction preflight use only client-visible fields. Required server-only fields must be supplied by the server before insertion; key validation and ownership checks retain the full server contract.
