# `@prisma-idb/sync-server-sql`

This adapter runs Prisma 8 IDB sync against a SQL database through your Prisma 8 SQL ORM client.
It executes the authorization checks from [`@prisma-idb/sync-server`](https://www.npmjs.com/package/@prisma-idb/sync-server), applies pushes and resolves pulls.

## Set up the adapter

1. Install the package.

```bash
npm install @prisma-idb/sync-server-sql
```

2. Create the server and adapter from your contracts.
3. Call `applyPush` and `pull` from your endpoints. Take `scopeKey` from the authenticated session.

```ts
import { createSyncServer } from "@prisma-idb/sync-server";
import { createSqlSyncAdapter, sqlGetKeyField } from "@prisma-idb/sync-server-sql";

const syncServer = createSyncServer({
  contract: serverContract,
  clientContract,
  rootModel: "User",
  getKeyField: sqlGetKeyField,
});
const sqlSyncAdapter = createSqlSyncAdapter({ contract: serverContract, syncServer });

// Push endpoint. `scopeKey` comes from the session, never the request body.
// The browser sends its contract fingerprint in a header (see "Contract fingerprint" below).
const pushed = await sqlSyncAdapter.applyPush(db, {
  events: body.events,
  scopeKey,
  clientContractFingerprint: request.headers.get("x-contract-fingerprint"),
});
if (!pushed.ok) {
  // "batch-too-large" | "duplicate-event-id" | "contract-mismatch"
  return json({ error: pushed.reason }, { status: pushed.reason === "contract-mismatch" ? 409 : 400 });
}
return json(pushed.results);

// Pull endpoint. `lastChangelogId` is the last `changelogId` the client received.
const pulled = await sqlSyncAdapter.pull(db, {
  scopeKey,
  lastChangelogId: url.searchParams.get("since"),
  clientContractFingerprint: request.headers.get("x-contract-fingerprint"),
});
if (!pulled.ok) {
  // "invalid-cursor" | "contract-mismatch"
  return json({ error: pulled.reason }, { status: pulled.reason === "contract-mismatch" ? 409 : 400 });
}
return json(pulled.logs);
```

## Contract fingerprint

`pull` and `applyPush` compare `clientContractFingerprint` with `syncServer.contractFingerprint()` before they read or write anything. A missing or different fingerprint returns `{ ok: false, reason: "contract-mismatch", expected }`. Answer it with HTTP 409. The browser worker then keeps its pull cursor and queued edits, and retries after the user updates.

Set `contractFingerprintCheck: "off"` only if your deploys keep clients and server on one contract. The default is `"required"`. See the [server guide](https://prisma-idb.dev/docs/prisma-8/sync/server#contract-fingerprint) for how the digest is computed.

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

### Example: Alice's FoodEntry

Alice creates a `FoodEntry` with `userId: "alice"` and `mealId` pointing to Bob's `Meal`.
The adapter rejects it with `SCOPE_VIOLATION`, even though its direct `User` path reaches Alice.
The same rule applies if `recipeId` points to Bob's `Recipe`.

### Supported relations

- Checked relations must use a single-field foreign key to the tenant parent's primary key.
- Unsupported checked relations and mismatched `parentReferences` descriptors cause configuration errors.
- Checked foreign keys cannot have database or ORM-generated defaults. Authorization requires their resolved values before insertion.
- With `syncServer`, the adapter validates this metadata at construction. Lower-level calls validate it before opening a transaction.

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

1. Remove database and ORM-generated defaults from checked foreign keys.
2. Supply those foreign keys explicitly when creating records.
3. When updating historical rows, replace any tenant parents outside the caller's scope in the same patch.

## API

`createSqlSyncAdapter({ contract, syncServer?, getKeyField?, contractFingerprintCheck? })` returns:

| Member                                                                           | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `applyPush(db, { events, scopeKey, maxBatchSize?, clientContractFingerprint? })` | The whole push route: validates ownership and applies events in order until the first retryable failure. Returns `{ ok: true, results }` (the processed prefix, including that failure) or `{ ok: false, reason }` for a batch over `maxBatchSize` (default 1000, `"batch-too-large"`) a repeated event id (`"duplicate-event-id"`) or a contract mismatch (`"contract-mismatch"`). Nothing is applied when `ok` is false. Needs `syncServer`.                        |
| `pull(db, { scopeKey, lastChangelogId?, limit?, clientContractFingerprint? })`   | The whole pull route: the next `limit` (default 50) changes after `lastChangelogId` (a UUID v7 string, exclusive), each re-authorized and resolved to its current `record` (`null` if deleted or no longer the user's). Returns `{ ok: true, logs }` or `{ ok: false, reason: "invalid-cursor" }` or `{ ok: false, reason: "contract-mismatch", expected }`. Needs `syncServer`. Invalid `limit` values (non-positive, non-integer or non-finite) throw `RangeError`. |
| `getKeyField(model)`                                                             | The model's primary-key field.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `toSyncPushPayload(operation, payload, keyField)`                                | Turns a pushed payload into the shape `validatePush` expects.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `applyPushEvent(db, event, model, check, scopeKey)`                              | In one transaction: checks ownership, writes the record and its `Changelog` row. Safe to repeat.                                                                                                                                                                                                                                                                                                                                                                      |
| `resolvePullRecord(db, model, check, keyPath, operation)`                        | The record, if the user still owns it, or `null`.                                                                                                                                                                                                                                                                                                                                                                                                                     |

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
