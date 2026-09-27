import { definePrismaConfig } from "@prisma/cli-engine";
import { defineConfig as ormConfig, typescriptContract } from "@prisma-idb/family-idb/config-types";
import idbFamily from "@prisma-idb/family-idb/control";
import idbTarget from "@prisma-idb/target-idb/control";
import idbAdapter from "@prisma-idb/adapter-idb/control";
import idbDriver from "@prisma-idb/driver-idb/control";
import { contract } from "./src/contract.server";

/**
 * Only used to emit `src/contract.json` and `src/contract.d.ts`
 * (`pnpm contract:emit`). The benchmark builds its stores straight from the
 * emitted contract, so there are no migrations.
 */
export default definePrismaConfig({
  orm: ormConfig({
    family: idbFamily,
    target: idbTarget,
    adapter: idbAdapter,
    driver: idbDriver,
    // Required by the framework, ignored by the IDB driver.
    db: { connection: ":memory:" },
    contract: typescriptContract(contract, "src/contract.json"),
  }),
});
