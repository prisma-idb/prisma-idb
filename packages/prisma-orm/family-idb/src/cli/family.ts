import type { AnyCommand } from "@prisma/cli-engine";
import { defineCommandFamily } from "@prisma/cli-engine";
import { ormConfigSection } from "./config-section";
import { migrationContractSpaceCommand } from "./migration/contract-space";
import { migrationPlanCommand } from "./migration/plan";
import { migrationPreflightCommand } from "./migration/preflight";

const commands: Readonly<Record<string, AnyCommand>> = {
  "migration plan": migrationPlanCommand,
  "migration contract-space": migrationContractSpaceCommand,
  "migration preflight": migrationPreflightCommand,
};

/**
 * The unit this package contributes to a `@prisma/cli-engine` shell: its
 * config section (reused from the ORM family, see `config-section.ts`) and
 * its 3 commands. These have no generic equivalent — the real `prisma` CLI's
 * `migration new`/`plan`/etc. work against a live database or a SQL/Mongo
 * on-disk model; ours works against `fake-indexeddb` and a hand-rolled
 * contract-space convention.
 */
export const idbCommandFamily = defineCommandFamily({
  configSection: ormConfigSection,
  commands,
});
