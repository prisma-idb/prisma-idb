# `@prisma-idb/sync-server-sql`

Runs Prisma 8 IDB sync against a SQL database. It carries out the ownership checks that [`@prisma-idb/sync-server`](https://www.npmjs.com/package/@prisma-idb/sync-server) describes, and applies pushes and resolves pulls, through your Prisma 8 SQL ORM client. It works with any model in your schema.

```bash
npm install @prisma-idb/sync-server-sql
```

```ts
import { createSqlSyncAdapter } from "@prisma-idb/sync-server-sql";

const sqlSyncAdapter = createSqlSyncAdapter({ contract: serverContract });

// In the push endpoint, for each check from syncServer.validatePush():
const result = await sqlSyncAdapter.applyPushEvent(db, event, model, check, scopeKey);
```

## API

`createSqlSyncAdapter({ contract, getKeyField? })` returns:

| Member                                                    | Does                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `getKeyField(model)`                                      | The model's primary-key field.                                                                   |
| `toSyncPushPayload(operation, payload, keyField)`         | Turns a pushed payload into the shape `validatePush` expects.                                    |
| `applyPushEvent(db, event, model, check, scopeKey)`       | In one transaction: checks ownership, writes the record and its `Changelog` row. Safe to repeat. |
| `resolvePullRecord(db, model, check, keyPath, operation)` | The record, if the user still owns it, or `null`.                                                |

`db` is your Prisma 8 SQL client; it needs `.transaction(fn)` and `.orm.public.<Model>`.

Lower-level exports, for building your own adapter: `applyPushEvent`, `toSyncPushPayload` and `resolvePullRecord` as plain functions, `checkAuthorization`, `resolveRootKeyViaPath`, `ormRootFor` and `sqlGetKeyField`.

## Documentation

- [Sync tutorial](https://prisma-idb.dev/docs/prisma-8/sync)
- [Sync server reference](https://prisma-idb.dev/docs/prisma-8/sync/server)

## License

MIT
