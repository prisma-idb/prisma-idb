# Prisma 8 IDB Kanban

A local-only Svelte kanban board backed by Prisma 8 IDB.

The example demonstrates explicit Prisma 8 migration packages, the browser IndexedDB runtime, and a tiny PWA shell that works offline after the app has loaded once.

## What is included

- Local users, boards, and todos stored in IndexedDB
- Auto-migrating client setup in `src/lib/prisma/db.ts`
- Chainable ORM usage in `src/lib/stores/kanban.svelte.ts`
- Barebones PWA metadata and service worker caching

## Development

From the repository root:

```sh
pnpm --filter @prisma-idb/prisma-orm-kanban-example dev
```

## Validation

```sh
pnpm --filter @prisma-idb/prisma-orm-kanban-example check
pnpm --filter @prisma-idb/prisma-orm-kanban-example build
pnpm --filter @prisma-idb/prisma-orm-kanban-example test:e2e
```

## Prisma 8 workflow

```sh
pnpm --filter @prisma-idb/prisma-orm-kanban-example contract:emit
pnpm --filter @prisma-idb/prisma-orm-kanban-example migration:plan
pnpm --filter @prisma-idb/prisma-orm-kanban-example migration:contract-space
pnpm --filter @prisma-idb/prisma-orm-kanban-example migration:preflight
```

## Links

- Live app: https://next-kanban.prisma-idb.dev/
- Docs: https://prisma-idb.dev/docs/prisma-8/kanban-example
- Source: https://github.com/prisma-idb/prisma-idb/tree/main/apps/prisma-idb-kanban-example
