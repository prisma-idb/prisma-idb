# Run the Prisma 8 IDB Kanban example

This Svelte app stores boards and todos in IndexedDB and syncs them with Postgres. You can sign in as a guest or configure Google sign-in. Its PWA shell supports offline reloads after the first visit.

## Set up the app

Run these commands from the repository root. You need Docker for the local Postgres database.

```sh
pnpm install
cp apps/prisma-orm-kanban-example/.env.example apps/prisma-orm-kanban-example/.env
pnpm build --filter=@prisma-idb/prisma-orm-kanban-example
pnpm --filter @prisma-idb/prisma-orm-kanban-example db:up
pnpm --filter @prisma-idb/prisma-orm-kanban-example db:init
pnpm --filter @prisma-idb/prisma-orm-kanban-example dev
```

Open the URL printed by Vite and select **Continue as guest**. Create a board, then add a todo. Edit, complete, or delete the todo to exercise tracked writes. The sync status shows pending changes and connectivity.

To use Google sign-in, set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the app's `.env`. Follow the redirect URL instructions in `.env.example`.

## Validate changes

Keep Postgres running while you run the browser tests. They cover local records, login, offline reloads, and cross-device sync.

```sh
pnpm --filter @prisma-idb/prisma-orm-kanban-example check
pnpm --filter @prisma-idb/prisma-orm-kanban-example lint
pnpm --filter @prisma-idb/prisma-orm-kanban-example build
pnpm --filter @prisma-idb/prisma-orm-kanban-example test:e2e:install
pnpm --filter @prisma-idb/prisma-orm-kanban-example test:e2e
```

## Update contracts and migrations

After editing `src/lib/prisma/schema.prisma`, emit the browser contract and prepare its migration:

```sh
pnpm --filter @prisma-idb/prisma-orm-kanban-example contract:emit
pnpm --filter @prisma-idb/prisma-orm-kanban-example migration:plan
pnpm --filter @prisma-idb/prisma-orm-kanban-example migration:contract-space
pnpm --filter @prisma-idb/prisma-orm-kanban-example migration:preflight
```

For a Postgres schema change, emit the server contract, create a migration, and apply it:

```sh
pnpm --filter @prisma-idb/prisma-orm-kanban-example contract:emit:postgres
pnpm --filter @prisma-idb/prisma-orm-kanban-example migration:postgres:new
pnpm --filter @prisma-idb/prisma-orm-kanban-example db:update
```

See the [kanban explanation](https://prisma-idb.dev/docs/prisma-8/kanban-example) for the client setup in `src/lib/prisma/db.ts`, ORM calls in `src/lib/stores/kanban.svelte.ts`, and sync transport in `src/lib/prisma/sync.ts`.

## Stop the database

```sh
pnpm --filter @prisma-idb/prisma-orm-kanban-example db:down
```

Try the [live app](https://next-kanban.prisma-idb.dev/) or browse the [source](https://github.com/prisma-idb/prisma-idb/tree/main/apps/prisma-orm-kanban-example).
