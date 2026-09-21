# Prisma IDB

[![Prisma IDB — Type-safe IndexedDB with the Prisma API](https://raw.githubusercontent.com/prisma-idb/idb-client-generator/main/apps/docs/public/og.png)](https://prisma-idb.dev/)

> You already write Prisma on the server. Now write it in the browser.

Type-safe IndexedDB with the Prisma API you already know — offline-first, no server required.

**[Documentation](https://prisma-idb.dev/) · [Live Demo](https://kanban.prisma-idb.dev/)**

## Two flavors

|                  | Generator (stable)                                                                                   | Prisma 8 IDB extension                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Package**      | [`@prisma-idb/idb-client-generator`](https://www.npmjs.com/package/@prisma-idb/idb-client-generator) | [`@prisma-next-idb/client-idb`](https://www.npmjs.com/package/@prisma-next-idb/client-idb) + CLI packages |
| **How it works** | Prisma generator — runs `prisma generate`, emits a typed client                                      | Prisma 8 driver + adapter + target stack for IndexedDB                                                    |
| **Status**       | Stable, published                                                                                    | Preview, built on [Prisma 8](https://www.prisma.io/blog/prisma-next-call-for-extension-authors)           |
| **Source**       | `packages/generator`                                                                                 | `packages/prisma-next/*`                                                                                  |

## The difference (vs raw IndexedDB)

Even with the [`idb`](https://github.com/jakearchibald/idb) library, querying across relations means manual index lookups, joins in application code, and zero type safety:

```typescript
const db = await openDB("MyDB", 1);

const posts = await db.getAllFromIndex("posts", "byAuthor", userId);

const result = [];
for (const post of posts) {
  if (!post.published) continue;
  const comments = await db.getAllFromIndex("comments", "byPost", post.id);
  result.push({ ...post, comments });
}
result.sort((a, b) => b.createdAt - a.createdAt);
// manual joins, no types, no filtering
```

Prisma IDB:

```typescript
const posts = await idb.post.findMany({
  where: { authorId: userId, published: true },
  include: {
    comments: { orderBy: { createdAt: "desc" } },
  },
  orderBy: { createdAt: "desc" },
});
```

Same API as Prisma Client. Fully typed. Works offline.

## Generator quick start

### Install

```bash
pnpm add idb
pnpm add @prisma-idb/idb-client-generator --save-dev
```

### Configure

Add the generator to your `schema.prisma`:

```prisma
generator prismaIDB {
  provider = "idb-client-generator"
  output   = "./prisma-idb"
}

model Todo {
  id    String  @id @default(cuid())
  title String
  done  Boolean @default(false)
}
```

### Generate & use

```bash
pnpm exec prisma generate
```

```typescript
import { PrismaIDBClient } from "./prisma-idb";

const idb = await PrismaIDBClient.createClient();

await idb.todo.create({ data: { title: "Ship it", done: false } });

const todos = await idb.todo.findMany({ where: { done: false } });

await idb.todo.update({ where: { id: todoId }, data: { done: true } });

await idb.todo.delete({ where: { id: todoId } });
```

### Optional sync engine

```prisma
generator prismaIDB {
  provider   = "idb-client-generator"
  output     = "./prisma-idb"
  outboxSync = true    // ← one flag
  rootModel  = "User"
}
```

- **Outbox pattern** — mutations queue locally, push reliably with retry and batching
- **Ownership DAG** — authorization is structural, every record traces back to its owner
- **Conflict resolution** — server-authoritative changelog materialization on pull

## Prisma 8 IDB quick start

> Implements the [Prisma 8](https://www.prisma.io/blog/prisma-next-call-for-extension-authors) driver + adapter + target architecture for IndexedDB. Runtime queries use a bundled contract space; the CLI emits the contract and migration artifacts at build time.

```bash
pnpm add @prisma-next-idb/client-idb @prisma/orm-toolchain
pnpm add -D prisma@latest @prisma/cli-engine @prisma/orm-framework \
  @prisma-next-idb/family-idb @prisma-next-idb/target-idb \
  @prisma-next-idb/adapter-idb @prisma-next-idb/driver-idb
```

The usual flow is `pnpm exec prisma contract emit`, `pnpm exec prisma-idb migration plan`, `pnpm exec prisma-idb migration contract-space`, then `createAutoMigratingIdbClient({ contractSpace, dbName })` in browser code. The former `prisma-next-idb` command remains available as an alias. See the [Prisma 8 IDB documentation](https://prisma-idb.dev/docs/prisma-next) for full setup.

## Resources

- [Documentation](https://prisma-idb.dev/)
- [Live Kanban Demo](https://kanban.prisma-idb.dev/)
- [Generator on npm](https://www.npmjs.com/package/@prisma-idb/idb-client-generator)
- [Extension family on npm](https://www.npmjs.com/package/@prisma-next-idb/family-idb)
- [Generator example app](./apps/usage)
- [Extension framework example app](./apps/prisma-next-idb-kanban-example)

## Contributing

Contributions welcome. See [CONTRIBUTING.md](./.github/CONTRIBUTING.md).

## Security

See [SECURITY.md](./.github/SECURITY.md) for reporting vulnerabilities.

## License

MIT. See [LICENSE](./LICENSE).

## Disclaimer

Prisma is a trademark of Prisma. Prisma IDB is an independent open-source project, not affiliated with or endorsed by Prisma.
