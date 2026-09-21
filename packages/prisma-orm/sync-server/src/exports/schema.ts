import { injectChangelogModelSql, prepareSqlSchemaWithSync } from "../core/changelog-schema";
import { sqlContractWithSync } from "../core/sql-contract";

/**
 * Plain PSL-text transform — appends the `Changelog` model (ADR 014's
 * push/pull log shape: real enum, real DB-generated `autoincrement()` id)
 * to raw schema text, unparsed. Doesn't strip `@idb.exclude` — pair with
 * `@prisma-idb/family-idb/contract-psl`'s `stripIdbExcludeAttributes`
 * if the schema you're appending to was authored for family-idb, or use
 * {@link prepareSqlSchemaWithSync}, which already does both.
 */
export { injectChangelogModelSql };

/**
 * `stripIdbExcludeAttributes` (family-idb's `idb.exclude` namespace is
 * meaningless to a real server, and the SQL parser hard-errors on it) then
 * `injectChangelogModelSql` — the one call a SQL-family config needs to
 * turn a schema authored for family-idb into the real server schema.
 * Pure text in, text out — no file I/O. {@link sqlContractWithSync} runs
 * this under the hood; call it directly only if you're composing a schema
 * loader it doesn't target.
 */
export { prepareSqlSchemaWithSync };

/**
 * Reads `schemaPath` once, runs it through {@link prepareSqlSchemaWithSync}
 * in memory, and returns a `ContractConfig` directly — no generated
 * `.prisma` file lands on disk.
 *
 * On Postgres, prefer `@prisma-idb/sync-server/postgres`'s
 * `defineConfig` — it wires all of this (plus the family/target/adapter/driver
 * descriptors) behind a handful of options. Reach for this function directly
 * only for a different SQL target, or when you need control the facade
 * doesn't expose.
 *
 * This needs the core `defineConfig` (`@prisma/orm-framework/config/config-types`)
 * wired by hand — a target's own convenience `defineConfig` (e.g.
 * `@prisma/orm-postgres/config`) only accepts a schema *path* for
 * `contract`, since it builds its own internal `prismaContract(...)` call,
 * so it can't take this function's `ContractConfig` return value.
 *
 * `options` is forwarded to the SQL family's own `prismaContract` — for
 * Postgres in particular, that means `enumInferenceCodecs` needs to be
 * supplied explicitly here (Postgres's own `defineConfig` normally fills it
 * in for you); see the example below.
 *
 * @example
 * ```ts
 * import { definePrismaConfig } from "@prisma/cli-engine";
 * import { defineConfig } from "@prisma/orm-framework/config/config-types";
 * import postgresAdapter from "@prisma/orm-postgres/adapter/control";
 * import postgresDriver from "@prisma/orm-postgres/driver/control";
 * import sql from "@prisma/orm-postgres/family/control";
 * import { PG_INT_CODEC_ID, PG_TEXT_CODEC_ID } from "@prisma/orm-postgres/target/codec-ids";
 * import postgres from "@prisma/orm-postgres/target/control";
 * import postgresPackRef from "@prisma/orm-postgres/target/pack";
 * import { postgresCreateNamespace } from "@prisma/orm-postgres/target/types";
 * import { sqlContractWithSync } from "@prisma-idb/sync-server/schema";
 *
 * export default definePrismaConfig({
 *   orm: defineConfig({
 *     family: sql,
 *     target: postgres,
 *     adapter: postgresAdapter,
 *     driver: postgresDriver,
 *     contract: sqlContractWithSync("src/lib/prisma/schema.prisma", {
 *       target: postgresPackRef,
 *       createNamespace: postgresCreateNamespace,
 *       enumInferenceCodecs: { text: PG_TEXT_CODEC_ID, int: PG_INT_CODEC_ID },
 *       // Optional — defaults to deriving from schemaPath's own directory
 *       // (e.g. src/lib/prisma/contract.json), which collides with an
 *       // IDB-family contract.json living in the same directory.
 *       output: "src/lib/prisma/schema.postgres.generated.json",
 *     }),
 *     db: { connection: process.env.DATABASE_URL },
 *   }),
 * });
 * ```
 */
export { sqlContractWithSync };
