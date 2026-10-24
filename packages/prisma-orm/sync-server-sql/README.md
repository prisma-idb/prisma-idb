# `@prisma-idb/sync-server-sql`

This adapter runs Prisma 8 IDB sync against a SQL database through your Prisma 8 SQL ORM client.
It executes the authorization checks from [`@prisma-idb/sync-server`](https://www.npmjs.com/package/@prisma-idb/sync-server), applies pushes and resolves pulls.

## Set up the adapter

1. Install the package.

```bash
npm install @prisma-idb/sync-server-sql
```

2. Emit both configs with `prisma-idb contract emit` (pass `--config prisma.config.postgres.ts` for SQL). Create the HTTP handlers from their typed runtime modules. Resolve `scopeKey` from the authenticated session.

```ts
import { createSqlSync } from "@prisma-idb/sync-server-sql";
import serverContract from "./schema.postgres.generated.runtime";
import clientContract from "./contract.runtime";

const handlers = createSqlSync({
  contract: serverContract,
  clientContract,
  rootModel: "User",
  db, // Or a lazy (request) => db resolver.
  scopeKey: requireAuthenticatedUserId, // Reject requests without a session.
});

return handlers.push(request);
// Pull endpoint: return handlers.pull(request);
```

In Hono, pass `c.req.raw`: `handlers.push(c.req.raw)` or `handlers.pull(c.req.raw)`.
No Hono dependency is required. Authenticate in middleware or the scope resolver.
The scope resolver runs before the database resolver. Both accept asynchronous functions.

Push reads `{ storageHash, events }` from JSON. Pull reads `storageHash` and the exclusive cursor `since` from the query string.
A different hash returns HTTP 409. Malformed or missing fields return HTTP 400.
An absent or empty cursor starts from the beginning. Every pull response sets `Cache-Control: no-store`.
Options `maxBatchSize` and `pullLimit` override the adapter's default limits.
Unexpected database errors reject the promise for your app's error middleware.

Use `createSyncFetchHandlers` from `@prisma-idb/sync-extension-idb/client` on the client to send the storage hash and raise `ContractMismatchError` automatically.
The lower-level `adapter.applyPush` and `adapter.pull` remain available for custom transports.

## Contract check

`pull` and `applyPush` compare `clientStorageHash` with `syncServer.clientStorageHash` before they read or write anything. A missing or different storage hash returns `{ ok: false, reason: "contract-mismatch", expected }`. Answer it with HTTP 409. The browser worker then keeps its pull cursor and queued edits, and retries after the user updates.

Set `contractCheck: "off"` only if your deploys keep clients and server on one contract. The default is `"required"`. See the [server guide](https://prisma-idb.dev/docs/prisma-8/sync/server#contract-check) for how the digest is computed.

## Tenant parent rules

Creates and updates require every populated tenant parent to belong to the caller's scope.
See the [term definitions](../sync-server/README.md#tenant-parent-rules) for scope, tenant parent and candidate row.

- Each tenant parent needs at least one path to the caller's scope.
- Null optional tenant parents need no check. A populated foreign key that references a missing tenant parent fails.
- Updates check the complete candidate row, including foreign keys omitted from the patch.
- Checks include server-only tenant parents. They exclude inverse collections and global parents with no path to the root.
- The adapter runs checks before the record and changelog writes, within the same transaction.
- A resolved violation returns non-retryable `SCOPE_VIOLATION`. Neither write occurs.
- Database lookup failures retain ordinary SQLSTATE retry handling.
- Lower-level `applyPushEvent` calls also enforce these rules when a scoped check omits `parentReferences`.

### Concurrent ownership changes

On PostgreSQL, a push locks an update or delete target with `FOR UPDATE`.
It then locks ownership hops and tenant parents with `FOR SHARE`, from child to root, before taking the scope advisory lock.
Updates include both stored and candidate parents.
These locks stay held until commit, so a parent cannot be reassigned or deleted after authorization.
Pushes to different children can share parent locks.
Pull and rejected-record reads remain lock-free.

Application transactions that lock a parent before a child can deadlock with a push.
PostgreSQL aborts one transaction to resolve the deadlock.
If it aborts the push, the result is `retryable: true`.
Serialization failures and lock timeouts are also retryable.
The adapter sets no lock timeout; the application may configure PostgreSQL's `lock_timeout`.
SQLite needs no extra lock because it permits one writer at a time.

### Example: Alice's FoodEntry

Alice creates a `FoodEntry` with `userId: "alice"` and `mealId` pointing to Bob's `Meal`.
The adapter rejects it with `SCOPE_VIOLATION`, even though its direct `User` path reaches Alice.
The same rule applies if `recipeId` points to Bob's `Recipe`.

### Supported relations

Since version 0.7, these restrictions apply to relations checked along ownership paths to the root model:

- Checked relations must use a single-field foreign key to the tenant parent's single-field primary key. References to other `@unique` fields and compound keys are unsupported.
- Unsupported checked relations and mismatched `parentReferences` descriptors cause configuration errors.
- Checked foreign keys cannot have database or ORM-generated defaults. Authorization requires their resolved values before insertion.
- The default restriction applies to the referencing foreign key. A default on the parent's primary key alone does not violate this rule.
- With `syncServer`, the adapter validates this metadata at construction. Lower-level calls validate it before opening a transaction.

For example, `ownerId String` with `owner User @relation(fields: [ownerId], references: [id])` is supported when `User.id` is its single-field primary key. `ownerId String @default("system")` is unsupported, even when every create supplies `ownerId`.

An unsupported join throws `Unsupported tenant parent join "Board.owner": expected a single-field FK to the parent's key.` A defaulted foreign key throws `Unsupported tenant parent "Board.ownerId": FK defaults must be resolved before ownership checks. Remove the default and supply the FK explicitly.` Both errors identify the relation or field to change.

### Historical rows

- Existing-row access, pull and delete require at least one path to the caller's scope.
- Historical rows with tenant parents in different scopes remain readable or deletable through any matching path.
- An update that retains a tenant parent outside the caller's scope fails.
- A complete repair to the caller's scope may pass. No single `User` relation determines who may repair the row.
- The adapter does not clean up historical data.

### Rejected pushes

- `applyPush` returns the unchanged target row if ordinary pull authorization allows access.
- It returns `record: null` if the target row is missing or inaccessible.
- It never returns the candidate row or a foreign tenant parent.
- Lower-level `applyPushEvent` results do not include a reconciliation record.

See [ADR 022](../docs/adrs/ADR%20022%20-%20Rejected%20Pushes%20Reconcile%20to%20the%20Server%20Row.md) for rejection reconciliation.

## Upgrade the server and adapter

Upgrading both packages tightens create and update acceptance by default. No relation policy configuration is required.

1. Change checked relations that reference non-primary unique fields or compound keys to reference the parent's single-field primary key.
2. Remove database and ORM-generated defaults from checked foreign keys. For example, change `ownerId String @default("system")` to `ownerId String`.
3. Supply those foreign keys explicitly when creating records.
4. Regenerate the server and client contracts, and migrate the SQL schema to match.
5. When updating historical rows, replace any tenant parents outside the caller's scope in the same patch.

See the [server reference](https://prisma-idb.dev/docs/prisma-8/sync/server#checked-foreign-keys) for the supported schema shapes and configuration errors.

## API

Returned pull and rejected-push records contain only top-level fields from the client contract. Authorization uses the full server row before projection, so server-only ownership foreign keys still work. Projection happens before wire encoding.

`createSqlSyncAdapter({ contract, syncServer?, getKeyField?, contractCheck? })` returns:

| Member                                                                   | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `applyPush(db, { events, scopeKey, maxBatchSize?, clientStorageHash? })` | The whole push route: validates ownership and applies events in order until the first retryable failure. Returns `{ ok: true, results }` (the processed prefix, including that failure) or `{ ok: false, reason }` for a batch over `maxBatchSize` (default 1000, `"batch-too-large"`) a repeated event id (`"duplicate-event-id"`) or a contract mismatch (`"contract-mismatch"`). Nothing is applied when `ok` is false. Needs `syncServer`.                        |
| `pull(db, { scopeKey, lastChangelogId?, limit?, clientStorageHash? })`   | The whole pull route: the next `limit` (default 50) changes after `lastChangelogId` (a UUID v7 string, exclusive), each re-authorized and resolved to its current `record` (`null` if deleted or no longer the user's). Returns `{ ok: true, logs }` or `{ ok: false, reason: "invalid-cursor" }` or `{ ok: false, reason: "contract-mismatch", expected }`. Needs `syncServer`. Invalid `limit` values (non-positive, non-integer or non-finite) throw `RangeError`. |
| `getKeyField(model)`                                                     | The model's primary-key field.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `toSyncPushPayload(operation, payload, keyField)`                        | Turns a pushed payload into the shape `validatePush` expects.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `applyPushEvent(db, event, model, check, scopeKey)`                      | In one transaction: checks ownership, writes the record and its `Changelog` row. Safe to repeat.                                                                                                                                                                                                                                                                                                                                                                      |
| `resolvePullRecord(db, model, check, keyPath, operation)`                | The current record with only client-contract fields, if the user still owns it, or `null`. Needs `syncServer`.                                                                                                                                                                                                                                                                                                                                                        |

`db` is your Prisma 8 SQL client; it needs `.transaction(fn)` and `.orm.public.<Model>`.

Malformed records and patches return `RECORD_VALIDATION_FAILURE`; malformed keys return `KEYPATH_VALIDATION_FAILURE`. These failures are non-retryable and open no transaction. The batch helper revives native dates, bigint and bytes from their JSON representations before validating against the server contract. Updates cannot change the primary key. The adapter's `applyPushEvent` accepts `validatePush`'s `validation-failure` check and returns its code directly.

For required Postgres `Json` fields (`pg/json@1` and `pg/jsonb@1`), wire `null` is stored as JSON null on create and update. Nullable JSON fields retain the ORM's SQL NULL behavior. The required-field conversion happens only at the ORM write boundary, after validation and ownership checks.

Pulls report malformed changelog keys as `{ changelogId, model, operation, keyPath, validationError: "KEYPATH_VALIDATION_FAILURE" }`, with no `record` field. `applyPull` consumes these rows as validation failures without changing local records or version metadata. Ordinary pull logs keep their existing shape: `record: null` still applies a real delete or revoked ownership. Update clients to handle the marker before deploying a server that emits it. The shared wire schema and types live in `@prisma-idb/sync-extension-idb/schemas`; the SQL adapter imports only its type, with no client runtime import. Database and ORM errors still reject the pull.

Push results stop at the first retryable failure. Later events are omitted even if their payloads are malformed: the client worker keeps events without results pending and does not count a try against them. This lets a dependent Todo wait until its Board succeeds on retry.

The `reason` unions in `ApplyPushOutcome` and `PullOutcome` may gain new values in future releases. Handle each known reason explicitly, and review new values when upgrading (an exhaustive TypeScript check can flag them).

The package exports `createSqlSyncAdapter`, `sqlGetKeyField` (a `getKeyField` resolver for `createSyncServer`), the defaults `DEFAULT_MAX_PUSH_BATCH_SIZE` and `DEFAULT_PULL_LIMIT`, and the types the adapter's methods use: `CreateSqlSyncAdapterOptions`, `SqlSyncAdapter`, `ApplyPushInput`, `ApplyPushOutcome`, `SqlPushWireEvent`, `SqlPushEvent`, `SqlPushResult`, `PullInput`, `PullOutcome` and `SqlPullLog`.

## Documentation

- [Sync tutorial](https://prisma-idb.dev/docs/prisma-8/sync)
- [Sync server reference](https://prisma-idb.dev/docs/prisma-8/sync/server)

## License

MIT
