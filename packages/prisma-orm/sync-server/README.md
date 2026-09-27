# `@prisma-idb/sync-server`

The server side of Prisma 8 IDB sync. From your schema's relations, it works out who owns each synced record, and tells you what to check before accepting a push or returning a pulled record. It never touches your database or HTTP framework, so it works with any of them.

```bash
npm install @prisma-idb/sync-server
```

```ts
import { createSyncServer } from "@prisma-idb/sync-server";
import { sqlGetKeyField } from "@prisma-idb/sync-server-sql";

const syncServer = createSyncServer({
  contract: serverContract, // the server's full contract
  clientContract, // the browser's contract: only its models sync
  rootModel: "User",
  getKeyField: sqlGetKeyField, // for a SQL contract
});

const checks = syncServer.validatePush(events, { scopeKey: signedInUserId });
```

For a SQL database, [`@prisma-idb/sync-server-sql`](https://www.npmjs.com/package/@prisma-idb/sync-server-sql) runs the checks and writes for you.

## Entry points

| Import                             | Contains                                                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `@prisma-idb/sync-server`          | `createSyncServer`, with `validatePush` and `buildPullQueries`. Also `buildOwnershipDag`, `resolveAuthorizationPaths` and `defaultGetKeyField`. |
| `@prisma-idb/sync-server/postgres` | `defineConfig`: a Postgres config that reads the shared schema, removes the `idb` attributes and adds the `Changelog` model.                    |
| `@prisma-idb/sync-server/schema`   | `sqlContractWithSync` for other SQL targets, and the text transforms `prepareSqlSchemaWithSync` and `injectChangelogModelSql`.                  |

## Documentation

- [Sync tutorial](https://prisma-idb.dev/docs/prisma-8/sync)
- [Sync server reference](https://prisma-idb.dev/docs/prisma-8/sync/server)
- [Client Contracts](https://prisma-idb.dev/docs/prisma-8/sync/client-contracts)

## License

MIT
