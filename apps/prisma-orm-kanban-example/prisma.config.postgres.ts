/// <reference types="node" />

import "dotenv/config";
import { definePrismaConfig } from "@prisma/cli-engine";
import { defineConfig } from "@prisma-idb/sync-server/postgres";

/**
 * The kanban app's real server — SQL family, Postgres target. The
 * sync-server `defineConfig` (`@prisma-idb/sync-server/postgres`)
 * wires `@prisma/orm-postgres`'s family/target/adapter/driver descriptors
 * and the sync-schema transform for you — the wiring `@prisma/orm-postgres/config`'s
 * own `defineConfig` can't do, since its `contract` option only accepts a
 * schema path and builds its own internal `prismaContract()` call.
 * rc.5, unified `prisma.config.ts` naming, `@prisma/cli-engine` envelope.
 *
 * One schema, not two: `src/lib/prisma/schema.prisma` is the only
 * hand-authored source for User/Board/Todo/AuditLog — the same file
 * `prisma.config.ts` (IDB family, browser client) parses. Under the hood
 * this strips `@idb.exclude`/`@@idb.exclude` (meaningless to a real server;
 * the SQL parser hard-errors on the unrecognized `idb` namespace otherwise)
 * and appends a SQL-flavored `Changelog` (real enum, real DB-generated id) —
 * entirely in memory, so no generated `.prisma` file lands in
 * `src/lib/prisma/`.
 *
 * `createSyncServer` (`src/lib/server/sync.ts`) reads this contract
 * directly as its ownership-DAG source too — no separate IDB-shaped "full"
 * config exists just to feed it (ADR 014's "Genuinely family-agnostic").
 *
 * Emit with: `pnpm contract:emit:postgres` (now the real `prisma` binary).
 * Create the schema with: `pnpm db:init`
 * Author a migration with: `pnpm migration:postgres:new`
 */
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set — copy .env.example to .env and run `pnpm db:up && pnpm db:init`.");
}

export default definePrismaConfig({
  orm: defineConfig({
    schema: "src/lib/prisma/schema.prisma",
    // output is explicit: the default derives from the schema's own
    // directory (src/lib/prisma/contract.json), which would collide with
    // the IDB side's own contract.json living in the same directory.
    output: "src/lib/prisma/schema.postgres.generated.json",
    db: {
      connection: process.env.DATABASE_URL,
    },
    // A distinct directory from the IDB side's `migrations/app/*` (the
    // `migrations: { dir: "migrations" }` default in prisma.config.ts) —
    // sharing one would make `migration new`/`db init` treat the two
    // completely unrelated migration lineages (browser IDB, real Postgres
    // server) as one graph, computing nonsense `from` hashes across families.
    migrations: {
      dir: "migrations-postgres",
    },
  }),
});
