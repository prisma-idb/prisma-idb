import { definePrismaConfig } from "@prisma/cli-engine";
import { defineConfig as ormConfig, typescriptContract } from "@prisma-idb/family-idb/config-types";
import idbFamily from "@prisma-idb/family-idb/control";
import idbTarget from "@prisma-idb/target-idb/control";
import idbAdapter from "@prisma-idb/adapter-idb/control";
import idbDriver from "@prisma-idb/driver-idb/control";
import { contract } from "./src/lib/prisma/contract.server";

/**
 * Prisma 8 config for the IDB usage app, rc.5, unified `prisma.config.ts`
 * naming.
 *
 * IndexedDB is a browser API, so the CLI control plane is **refusal-only**:
 *
 * ```bash
 * pnpm contract:emit               # Generates contract.json + .d.ts
 * pnpm migration:plan              # Auto-creates the first/next migration
 * pnpm migration:contract-space    # Bundles into contract-space.generated.ts
 * pnpm migration:preflight         # Validates the chain against fake-indexeddb
 * ```
 *
 * These map straight onto the `prisma-idb` bin (a thin `@prisma/cli-engine`
 * shell) — see the scripts of the same name in this package's `package.json`.
 *
 * Migrations actually apply in the browser via `createAutoMigratingIdbClient`
 * (see `src/lib/prisma/db.ts`). The CLI's `db verify`/`db init`/`db update`
 * return `IDB-CLI-UNSUPPORTED` envelopes — there is no live IndexedDB on the
 * Node side. The framework still requires a `driver` value in the config;
 * `idbDriver` is a no-op stub that satisfies the type without touching IDB.
 */
export default definePrismaConfig({
  orm: ormConfig({
    family: idbFamily,
    target: idbTarget,
    adapter: idbAdapter,
    driver: idbDriver,
    db: {
      // Not used by IDB — the framework requires the field but `idbDriver`
      // ignores it. The browser app reads the database name from
      // `src/lib/prisma/db.ts`'s `resolveDbName()` instead.
      connection: ":memory:",
    },
    contract: typescriptContract(contract, "src/lib/prisma/contract.json"),
    migrations: {
      dir: "migrations",
    },
  }),
});
