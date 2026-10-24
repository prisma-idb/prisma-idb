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

The `internal` subpath supports companion packages such as `sync-extension-idb` and custom managed factories. Other application code uses the entry points above. For nested writes, pass a relation callback to `create()` or `update()`; the client supplies the relation mutator.

## Schema enums

Clients expose Prisma 8's runtime enum accessors by namespace and enum name:

```ts
const Role = db.enums.__unbound__.Role;
const role: typeof Role.Value = Role.members.ADMIN;
const roles = Role.values;
const valid = Role.has(input);
```

`__unbound__` is the default PSL domain namespace. `members` maps names to application values, including mapped strings. Accessors also provide `names`, `hasName`, `nameOf`, and `ordinalOf`; `Value` is type-only. Existing field types and string literals remain compatible. Auto-migrating clients expose the same accessors. Managed handles expose `managedDb.enums` synchronously with the same type and values, without opening IndexedDB. This also works during server rendering. When wrapping a custom factory with `createManagedIdbClient`, pass `enums: createIdbEnums(contract)` in its options, using `createIdbEnums` from the `internal` subpath and the factory's contract.

## Delete by primary key

`delete(key)` returns the deleted row. If no row matches, it throws `PrismaClientKnownRequestError` with code `P2025`. Referential actions apply in the same transaction before the deleted row is returned.

## Primary-key updates

`update()`, `updateAll()`, `updateCount()` and the update arm of `upsert()` reject changes to an existing row’s primary key with code `PRIMARY_KEY_CHANGE_UNSUPPORTED`. The entire mutation rolls back, including referential actions and sync outbox changes. The update input types leave out primary-key fields, so typed code can't set one. This applies to models the contract resolves; for any other model name, only the runtime check applies. At runtime, a patch that repeats the existing key is still allowed, and a query with no matching rows performs no write.

Primary keys are immutable. Delete the row and create it again only after handling dependent records. Restrictive relations can block the delete, and cascading relations can delete dependent records. See [ADR 020](../docs/adrs/ADR%20020%20-%20Primary%20Keys%20Are%20Immutable.md) for the reasons.

## Documentation

- [Quick Start](https://prisma-idb.dev/docs/prisma-8/getting-started)
- [Client](https://prisma-idb.dev/docs/prisma-8/client)
- [API reference](https://prisma-idb.dev/docs/prisma-8/api)

## License

MIT
