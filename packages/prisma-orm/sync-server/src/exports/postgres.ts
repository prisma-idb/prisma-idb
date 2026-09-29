import type { PrismaNextConfig } from "@prisma/orm-framework/config/config-types";
import { defineConfig as coreDefineConfig } from "@prisma/orm-framework/config/config-types";
import { ifDefined } from "@prisma/orm-framework/utils/defined";
import postgresAdapter from "@prisma/orm-postgres/adapter/control";
import { PG_INT_CODEC_ID, PG_TEXT_CODEC_ID, PG_TIMESTAMPTZ_DATE_CODEC_ID } from "@prisma/orm-postgres/target/codec-ids";
import postgresDriver from "@prisma/orm-postgres/driver/control";
import sql from "@prisma/orm-postgres/family/control";
import postgres from "@prisma/orm-postgres/target/control";
import postgresPackRef from "@prisma/orm-postgres/target/pack";
import { postgresCreateNamespace } from "@prisma/orm-postgres/target/types";
import { sqlContractWithSync } from "../core/sql-contract";

export interface PostgresSyncConfigOptions {
  /** Path to the shared `schema.prisma` — the same file the browser/IDB config parses. */
  readonly schema: string;
  /**
   * Defaults to deriving from `schema`'s own directory (e.g.
   * `src/lib/prisma/contract.json`). Override this when that collides with
   * an IDB-family `contract.json` living alongside it.
   */
  readonly output?: string;
  readonly db?: { readonly connection?: string };
  readonly migrations?: { readonly dir?: string };
}

/**
 * `@prisma/orm-postgres`'s adapter with PSL `DateTime` bound to the JS-`Date`
 * codec. From rc.12 the stock adapter binds it to `pg/timestamptz-temporal@1`,
 * which throws on decode unless the runtime has a global `Temporal` (Node 24
 * LTS does not) and hands back `Temporal.Instant`s where every IDB client
 * reads and writes `Date`s. Same `timestamptz` column either way, so this
 * changes the JS representation only, not the database schema.
 */
const syncPostgresAdapter: typeof postgresAdapter = {
  ...postgresAdapter,
  authoring: {
    ...postgresAdapter.authoring,
    type: {
      ...postgresAdapter.authoring?.type,
      DateTime: {
        kind: "typeConstructor",
        documentation: "An instant stored as PostgreSQL timestamptz and represented as a JavaScript Date.",
        output: { codecId: PG_TIMESTAMPTZ_DATE_CODEC_ID, nativeType: "timestamptz" },
      },
    },
  },
};

/**
 * The Postgres-target config for a sync server: wires `@prisma/orm-postgres`'s
 * family/target/adapter/driver descriptors and {@link sqlContractWithSync}
 * through the core `defineConfig` (`@prisma/orm-framework/config/config-types`)
 * for you. That wiring can't go through `@prisma/orm-postgres/config`'s own
 * `defineConfig` — its `contract` option only accepts a schema path and
 * builds its own internal `prismaContract(...)` call, so it can't take
 * `sqlContractWithSync`'s `ContractConfig` return value.
 *
 * @example
 * ```ts
 * import { definePrismaConfig } from "@prisma/cli-engine";
 * import { defineConfig } from "@prisma-idb/sync-server/postgres";
 *
 * export default definePrismaConfig({
 *   orm: defineConfig({
 *     schema: "src/lib/prisma/schema.prisma",
 *     output: "src/lib/prisma/schema.postgres.generated.json",
 *     db: { connection: process.env.DATABASE_URL },
 *     migrations: { dir: "migrations-postgres" },
 *   }),
 * });
 * ```
 */
export function defineConfig(options: PostgresSyncConfigOptions): PrismaNextConfig<"sql", "postgres"> {
  return coreDefineConfig({
    family: sql,
    target: postgres,
    adapter: syncPostgresAdapter,
    driver: postgresDriver,
    contract: sqlContractWithSync(options.schema, {
      target: postgresPackRef,
      createNamespace: postgresCreateNamespace,
      enumInferenceCodecs: { text: PG_TEXT_CODEC_ID, int: PG_INT_CODEC_ID },
      ...ifDefined("output", options.output),
    }),
    ...ifDefined("db", options.db),
    ...ifDefined("migrations", options.migrations),
  });
}
