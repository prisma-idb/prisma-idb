/// <reference types="node" />

import "dotenv/config";
import { definePrismaConfig } from "@prisma/cli-engine";
import { defineConfig } from "@prisma-idb/sync-server/postgres";

/**
 * Test-only fixture config — a real Postgres contract this package's own
 * integration suite (test/sql-sync-adapter.test.ts) runs against, in place
 * of the in-memory ORM fake this package used to carry. The sync-server
 * `defineConfig` applies the sync-schema transform (strip `@idb.exclude`,
 * append the synthetic `Changelog` model) to test/fixtures/schema.prisma
 * entirely in memory — no `.generated.prisma` file lands on disk — and wires
 * the SQL family/Postgres target/adapter/driver descriptors for you.
 *
 * `definePrismaConfig` (the rc.4-era `@prisma/cli-engine` envelope, not the
 * deprecated `defineConfig` alias some vendor examples still use) nests the
 * ORM section under the `orm` key, matching the shape `ormCommandFamily`
 * (the generic, family-agnostic `contract emit`/`db init`/etc. commands)
 * expects.
 *
 * Emit with: `pnpm contract:emit:postgres`
 * Create the schema with: `pnpm db:init`
 */
if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set — point it at a reachable Postgres (see .env.example) before running tests."
  );
}

export default definePrismaConfig({
  orm: defineConfig({
    schema: "test/fixtures/schema.prisma",
    // Matches the old file-based path's derived name (schema.generated.prisma
    // → schema.generated.json) — test/helpers.ts imports this filename
    // directly, and the default here would otherwise derive `contract.json`
    // from the source schema's own name instead.
    output: "test/fixtures/schema.generated.json",
    db: {
      connection: process.env.DATABASE_URL,
    },
    migrations: {
      dir: "test/fixtures/migrations-postgres",
    },
  }),
});
