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

## Documentation

- [Quick Start](https://prisma-idb.dev/docs/prisma-8/getting-started)
- [Client](https://prisma-idb.dev/docs/prisma-8/client)
- [API reference](https://prisma-idb.dev/docs/prisma-8/api)

## License

MIT
