# Prisma 8 IDB Usage

A SvelteKit app that exercises the Prisma 8 IDB family packages end-to-end. It serves as the E2E test host for the `@prisma-idb/*` packages and doubles as a minimal reference for how to wire up the client, run migrations, and query IndexedDB with the Prisma 8 ORM API.

Sync support is not included in this app. The sync-enabled kanban example covers that workflow.

## What is included

- Local data stored in IndexedDB via the Prisma 8 IDB runtime
- Auto-migrating client setup demonstrating the ContractSpace-driven migration flow
- Chainable ORM usage through the `idbOrm` query builder
- Playwright E2E tests covering the core CRUD and migration paths

## Development

From the repository root:

```sh
pnpm --filter @prisma-idb/prisma-orm-usage dev
```

## Validation

```sh
pnpm --filter @prisma-idb/prisma-orm-usage check
pnpm --filter @prisma-idb/prisma-orm-usage build
pnpm --filter @prisma-idb/prisma-orm-usage test:e2e
```

## Prisma 8 workflow

```sh
pnpm --filter @prisma-idb/prisma-orm-usage migration:plan
pnpm --filter @prisma-idb/prisma-orm-usage migration:contract-space
pnpm --filter @prisma-idb/prisma-orm-usage migration:preflight
```

## Links

- Docs: https://prisma-idb.dev/docs/prisma-8/usage
- Source: https://github.com/prisma-idb/prisma-idb/tree/main/apps/prisma-orm-usage
