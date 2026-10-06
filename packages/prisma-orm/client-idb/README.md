# `@prisma-idb/client-idb`

A typed IndexedDB client for Prisma 8. Write a Prisma schema, plan migrations with the `prisma-idb` CLI, and query IndexedDB from the browser with chained, typed calls. The client applies pending migrations when it opens the database, and enforces foreign keys and `onDelete`/`onUpdate` actions like a SQL database.

```bash
npm install @prisma-idb/client-idb @prisma/orm-toolchain
```

```ts
import { createAutoMigratingIdbClient } from "@prisma-idb/client-idb/client-auto";
import { contractSpace } from "./prisma/contract-space.generated";

const db = await createAutoMigratingIdbClient({ contractSpace, dbName: "my-app" });

await db.orm.todo.create({ id: crypto.randomUUID(), title: "Write docs", done: false, userId });
const open = await db.orm.todo.where({ done: false }).orderBy({ title: "asc" }).all();
```

`contract-space.generated.ts` comes from the build-time tools. The [Quick Start](https://prisma-idb.dev/docs/prisma-8/getting-started) sets them up.

## Entry points

| Import                               | Contains                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `@prisma-idb/client-idb/client-auto` | `createAutoMigratingIdbClient`, `createManagedAutoIdbClient`: open the database and migrate it. |
| `@prisma-idb/client-idb/client`      | `createIdbClient`, `createManagedIdbClient`: open an already-migrated database.                 |
| `@prisma-idb/client-idb/orm`         | `idbOrm`, the accessor types, and the `and`, `or` and `not` filter helpers.                     |

The `internal` subpath is for companion packages such as `sync-extension-idb`. Application code uses the entry points above. For nested writes, pass a relation callback to `create()` or `update()`; the client supplies the relation mutator.

## Primary-key updates

`update()`, `updateAll()`, `updateCount()` and the update arm of `upsert()` reject changes to an existing row’s primary key with code `PRIMARY_KEY_CHANGE_UNSUPPORTED`. The entire mutation rolls back, including referential actions and sync outbox changes. A patch may repeat the existing key; a query with no matching rows performs no write.

Primary keys are immutable. Delete the row and create it again only after handling dependent records. Restrictive relations can block the delete, and cascading relations can delete dependent records.

## Documentation

- [Quick Start](https://prisma-idb.dev/docs/prisma-8/getting-started)
- [Client](https://prisma-idb.dev/docs/prisma-8/client)
- [API reference](https://prisma-idb.dev/docs/prisma-8/api)

## License

MIT
