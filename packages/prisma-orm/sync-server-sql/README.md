# `@prisma-idb/sync-server-sql`

Runs Prisma 8 IDB sync against a SQL database. It carries out the ownership checks that [`@prisma-idb/sync-server`](https://www.npmjs.com/package/@prisma-idb/sync-server) describes, and applies pushes and resolves pulls, through your Prisma 8 SQL ORM client. It works with any model in your schema.

```bash
npm install @prisma-idb/sync-server-sql
```

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
const pushed = await sqlSyncAdapter.applyPush(db, { events: body.events, scopeKey });
if (!pushed.ok) return json({ error: pushed.reason }, { status: 400 }); // "batch-too-large" | "duplicate-event-id"
return json(pushed.results);

// Pull endpoint. `lastChangelogId` is the last `changelogId` the client received.
const pulled = await sqlSyncAdapter.pull(db, { scopeKey, lastChangelogId: url.searchParams.get("since") });
if (!pulled.ok) return json({ error: pulled.reason }, { status: 400 }); // "invalid-cursor"
return json(pulled.logs);
```

Creates and updates require every populated outgoing tenant parent to reach the authenticated root. For example, Alice's FoodEntry cannot reference Bob's Meal or Recipe, even if its `userId` is Alice. Each parent's alternate root paths use OR. Null optional parents are skipped; missing populated parents fail. Updates check the stored row merged with the patch, so an omitted FK is rechecked. Checks run before entity and changelog writes in the same transaction. A resolved violation returns non-retryable `SCOPE_VIOLATION` and writes neither row. Database lookup failures retain ordinary SQLSTATE retry handling.

No relation policy configuration is needed. Upgrading the paired server and adapter packages tightens create/update acceptance by default. Lower-level `applyPushEvent` calls also enforce the rule when their scoped check lacks `parentReferences`. Unsupported checked joins and mismatched descriptors throw configuration errors. Only single-field FKs to parent primary keys are supported. Checked FK defaults, including database and ORM-generated defaults, are rejected because authorization needs their resolved values before insertion. Remove those defaults and supply the FKs explicitly. With `syncServer`, the adapter validates this metadata at construction; lower-level calls validate it before a transaction.

Existing-row access, pull and delete retain any-path OR authorization. Historical mixed-owner rows remain readable or deletable through either matching path. Patches retaining mixed-user parents fail; a complete repair to the caller's scope can pass. Global parents without root paths and inverse collections are excluded. Server-only tenant parents are checked. This does not clean up historical data or make a single User relation authoritative.

Through `applyPush`, a tenant rejection returns the unchanged target row under ordinary pull authorization, or `record: null` if missing or inaccessible. It never returns the attempted candidate or a foreign parent. Lower-level `applyPushEvent` keeps its existing result without a reconciliation record. See [ADR 022](../docs/adrs/ADR%20022%20-%20Rejected%20Pushes%20Reconcile%20to%20the%20Server%20Row.md).

## API

`createSqlSyncAdapter({ contract, syncServer?, getKeyField? })` returns:

| Member                                                    | Does                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `applyPush(db, { events, scopeKey, maxBatchSize? })`      | The whole push route: validates ownership and applies events in order until the first retryable failure. Returns `{ ok: true, results }` (the processed prefix, including that failure) or `{ ok: false, reason }` for a batch over `maxBatchSize` (default 1000, `"batch-too-large"`) or a repeated event id (`"duplicate-event-id"`). Nothing is applied when `ok` is false. Needs `syncServer`.          |
| `pull(db, { scopeKey, lastChangelogId?, limit? })`        | The whole pull route: the next `limit` (default 50) changes after `lastChangelogId` (a UUID v7 string, exclusive), each re-authorized and resolved to its current `record` (`null` if deleted or no longer the user's). Returns `{ ok: true, logs }` or `{ ok: false, reason: "invalid-cursor" }`. Needs `syncServer`. Invalid `limit` values (non-positive, non-integer or non-finite) throw `RangeError`. |
| `getKeyField(model)`                                      | The model's primary-key field.                                                                                                                                                                                                                                                                                                                                                                              |
| `toSyncPushPayload(operation, payload, keyField)`         | Turns a pushed payload into the shape `validatePush` expects.                                                                                                                                                                                                                                                                                                                                               |
| `applyPushEvent(db, event, model, check, scopeKey)`       | In one transaction: checks ownership, writes the record and its `Changelog` row. Safe to repeat.                                                                                                                                                                                                                                                                                                            |
| `resolvePullRecord(db, model, check, keyPath, operation)` | The record, if the user still owns it, or `null`.                                                                                                                                                                                                                                                                                                                                                           |

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
