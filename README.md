# Prisma IDB

[![Prisma IDB — Type-safe IndexedDB with the Prisma API](https://raw.githubusercontent.com/prisma-idb/prisma-idb/main/apps/docs/public/og.png)](https://prisma-idb.dev/)

> You already write Prisma on the server. Now write it in the browser.

Type-safe IndexedDB with the Prisma API you already know — offline-first, no server required.

**[Documentation](https://prisma-idb.dev/) · [Live Demo](https://kanban.prisma-idb.dev/)**

Featured in the [Prisma ORM Manifesto 2026](https://www.prisma.io/blog/prisma-orm-manifesto-2026) and [Local-First News](https://www.localfirstnews.com/2026-11-19/).

## Two flavors

|                  | Generator (stable)                                                                                   | Prisma 8 IDB extension                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Package**      | [`@prisma-idb/idb-client-generator`](https://www.npmjs.com/package/@prisma-idb/idb-client-generator) | [`@prisma-idb/client-idb`](https://www.npmjs.com/package/@prisma-idb/client-idb) + CLI packages |
| **How it works** | Prisma generator — runs `prisma generate`, emits a typed client                                      | Prisma 8 driver + adapter + target stack for IndexedDB                                          |
| **Status**       | Stable, published                                                                                    | Preview, built on [Prisma 8](https://www.prisma.io/blog/prisma-next-call-for-extension-authors) |
| **Source**       | `packages/generator`                                                                                 | `packages/prisma-orm/*`                                                                         |

## What it looks like

Querying related records in IndexedDB normally means manual index lookups and joins in application code, with no types. With Prisma IDB, you write the query you already know:

```typescript
const posts = await idb.post.findMany({
  where: { authorId: userId, published: true },
  include: { comments: { orderBy: { createdAt: "desc" } } },
  orderBy: { createdAt: "desc" },
});
```

The client is typed from your Prisma schema and runs entirely in the browser.

## Get started

The docs walk through setup, the query API, migrations and sync:

- **Prisma 8 IDB:** [Quick start](https://prisma-idb.dev/docs/prisma-8/getting-started) · [Migrations](https://prisma-idb.dev/docs/prisma-8/migrations) · [Sync](https://prisma-idb.dev/docs/prisma-8/sync)
- **Generator:** [Quick start](https://prisma-idb.dev/docs/quick-start) · [CRUD reference](https://prisma-idb.dev/docs/crud) · [Sync](https://prisma-idb.dev/docs/sync)

Install the generator:

```bash
pnpm add idb
pnpm add -D @prisma-idb/idb-client-generator
```

Or install the Prisma 8 client. The [quick start](https://prisma-idb.dev/docs/prisma-8/getting-started) lists the build-time packages it needs:

```bash
pnpm add @prisma-idb/client-idb @prisma/orm-toolchain
```

## Repository

| Path                                | What it is                                |
| ----------------------------------- | ----------------------------------------- |
| `packages/generator`                | The Prisma generator                      |
| `packages/prisma-orm/*`             | The Prisma 8 packages, including sync     |
| `apps/docs`                         | [prisma-idb.dev](https://prisma-idb.dev/) |
| `apps/usage`, `apps/kanban-example` | Example apps for the generator            |
| `apps/prisma-orm-kanban-example`    | Example app for Prisma 8 IDB              |

## Contributing

Contributions welcome. See [CONTRIBUTING.md](./.github/CONTRIBUTING.md).

## Security

See [SECURITY.md](./.github/SECURITY.md) for reporting vulnerabilities.

## License

MIT. See [LICENSE](./LICENSE).

## Disclaimer

Prisma is a trademark of Prisma. Prisma IDB is an independent open-source project, not affiliated with or endorsed by Prisma.
