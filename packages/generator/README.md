# Prisma IDB

> You already write Prisma on the server. Now write it in the browser.

`@prisma-idb/idb-client-generator` is the npm package that generates a type-safe IndexedDB client with the Prisma-style API you already know, plus an optional sync engine for offline-first apps.

**[Documentation](https://prisma-idb.dev/) · [Live Demo](https://kanban.prisma-idb.dev/) · [Repository](https://github.com/prisma-idb/prisma-idb)**

---

## What this package does

This package is a Prisma generator. You add it to your Prisma schema, run `prisma generate`, and it produces a client in your app that talks to IndexedDB with familiar Prisma-style queries.

## The difference

Even with the [`idb`](https://github.com/jakearchibald/idb) library, querying across relations means manual index lookups, joins in application code, and no generated types:

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

Same API shape as Prisma Client. Fully typed. Local-first.

## And when you need sync

Most IndexedDB libraries stop at CRUD. Prisma IDB can also generate a bidirectional sync layer that handles the harder parts:

```prisma
generator prismaIDB {
  provider   = "idb-client-generator"
  output     = "./prisma-idb"
  outboxSync = true
  rootModel  = "User"
}
```

- Outbox pattern for reliable local mutations and retries
- Ownership DAG so sync authorization is structural
- Conflict handling through server-authoritative changelog materialization

## Quick Start

### Install

```bash
pnpm add idb
pnpm add -D @prisma-idb/idb-client-generator
```

You will also need your normal Prisma setup, including `prisma` and `@prisma/client`.

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

If you enable sync, use a single client-generated ID field such as `cuid()` or `uuid()` on syncable models.

### Generate

```bash
pnpm exec prisma generate
```

### Use the generated client

```typescript
import { PrismaIDBClient } from "./prisma-idb";

const idb = await PrismaIDBClient.createClient();

await idb.todo.create({
  data: { title: "Ship it", done: false },
});

const todos = await idb.todo.findMany({
  where: { done: false },
});

await idb.todo.update({
  where: { id: todoId },
  data: { done: true },
});
```

## Features

- Prisma-compatible API for IndexedDB CRUD and queries
- Full type safety generated from your Prisma schema
- `include` and `select` support for relations
- Offline-first operation with no network dependency for local reads and writes
- Optional sync for bidirectional server reconciliation
- Client-generated IDs for local creates without round-trips

## Resources

- [Documentation](https://prisma-idb.dev/)
- [Live Kanban Demo](https://kanban.prisma-idb.dev/)
- [Example App Source](https://github.com/prisma-idb/prisma-idb/tree/main/apps/kanban-example)
- [Issue Tracker](https://github.com/prisma-idb/prisma-idb/issues)

## Contributing

Contributions welcome. See [CONTRIBUTING.md](https://github.com/prisma-idb/prisma-idb/blob/main/.github/CONTRIBUTING.md).

## Security

See [SECURITY.md](https://github.com/prisma-idb/prisma-idb/blob/main/.github/SECURITY.md) for reporting vulnerabilities.

## License

MIT. See [LICENSE](https://github.com/prisma-idb/prisma-idb/blob/main/LICENSE).

## Disclaimer

Prisma is a trademark of Prisma. Prisma IDB is an independent open-source project, not affiliated with or endorsed by Prisma.
