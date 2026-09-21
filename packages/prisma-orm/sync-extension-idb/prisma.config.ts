import { definePrismaConfig } from "@prisma/cli-engine";
import { defineConfig as ormConfig, typescriptContract } from "@prisma-idb/family-idb/config-types";
import idbFamily from "@prisma-idb/family-idb/control";
import idbTarget from "@prisma-idb/target-idb/control";
import idbAdapter from "@prisma-idb/adapter-idb/control";
import idbDriver from "@prisma-idb/driver-idb/control";
import { syncContract } from "./src/contract";

/**
 * Prisma 8 config for the sync extension's contract space (ADR 212
 * contract-space package layout — `prisma.config.ts` at the package root,
 * per the convention every extension package follows; rc.5 unified naming).
 *
 * This wires the **framework-generic** CLI (`prisma contract emit`) so
 * `src/contract.json` + `src/contract.d.ts` are real emitted artifacts
 * instead of a live TS object imported directly — matching the ADR 212
 * package layout `src/exports/control.ts` JSON-imports from.
 *
 * The IDB-specific migration tooling (`prisma-idb migration plan
 * --space idb-sync`) reads `src/contract.json` produced by this config's
 * `contract emit`, not this file directly — it resolves that path from
 * this file's own `contract.output`, not a hardcoded default, so no
 * `--contract` flag is needed on the `migration:plan` script below.
 *
 * As with the app usage example, the CLI's `db verify`/`db init`/`db update`
 * are refusal-only for IDB (no live IndexedDB on the Node side) — this
 * config exists for `contract emit`, not for applying migrations.
 */
export default definePrismaConfig({
  orm: ormConfig({
    family: idbFamily,
    target: idbTarget,
    adapter: idbAdapter,
    driver: idbDriver,
    db: {
      // Not used by IDB — the framework requires the field but `idbDriver`
      // ignores it.
      connection: ":memory:",
    },
    contract: typescriptContract(syncContract, "src/contract.json"),
    migrations: {
      dir: "migrations",
    },
  }),
});
