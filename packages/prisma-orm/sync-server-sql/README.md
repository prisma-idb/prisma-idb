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

## API

`createSqlSyncAdapter({ contract, syncServer?, getKeyField? })` returns:

| Member                                                    | Does                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `applyPush(db, { events, scopeKey, maxBatchSize? })`      | The whole push route: validates ownership and applies every event in order. Returns `{ ok: true, results }` (one per event, in order) or `{ ok: false, reason }` for a batch over `maxBatchSize` (default 1000, `"batch-too-large"`) or a repeated event id (`"duplicate-event-id"`). Nothing is applied when `ok` is false. Needs `syncServer`. |
| `pull(db, { scopeKey, lastChangelogId?, limit? })`        | The whole pull route: the next `limit` (default 50) changes after `lastChangelogId` (a UUID v7 string, exclusive), each re-authorized and resolved to its current `record` (`null` if deleted or no longer the user's). Returns `{ ok: true, logs }` or `{ ok: false, reason: "invalid-cursor" }`. Needs `syncServer`.                           |
| `getKeyField(model)`                                      | The model's primary-key field.                                                                                                                                                                                                                                                                                                                   |
| `toSyncPushPayload(operation, payload, keyField)`         | Turns a pushed payload into the shape `validatePush` expects.                                                                                                                                                                                                                                                                                    |
| `applyPushEvent(db, event, model, check, scopeKey)`       | In one transaction: checks ownership, writes the record and its `Changelog` row. Safe to repeat.                                                                                                                                                                                                                                                 |
| `resolvePullRecord(db, model, check, keyPath, operation)` | The record, if the user still owns it, or `null`.                                                                                                                                                                                                                                                                                                |

`db` is your Prisma 8 SQL client; it needs `.transaction(fn)` and `.orm.public.<Model>`.

Lower-level exports, for building your own adapter: `applyPush`, `pull`, `applyPushEvent`, `toSyncPushPayload` and `resolvePullRecord` as plain functions, `checkAuthorization`, `resolveRootKeyViaPath`, `ormRootFor` and `sqlGetKeyField`.

## Documentation

- [Sync tutorial](https://prisma-idb.dev/docs/prisma-8/sync)
- [Sync server reference](https://prisma-idb.dev/docs/prisma-8/sync/server)

## License

MIT
