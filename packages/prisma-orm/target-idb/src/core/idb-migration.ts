import { Migration } from "@prisma/orm-toolchain/migration-tools/migration";
import type { IdbDdlOp } from "./migration-factories";

/**
 * Target-owned base class for IDB migrations.
 *
 * Fixes the framework's `Migration` generic to IDB target identity (operations
 * narrowed to `IdbDdlOp`, family/target ids both `'idb'`) so user-authored
 * migrations and renderer-generated scaffolds can `extends Migration` against
 * the facade re-export from `@prisma-idb/target-idb/migration` without
 * redeclaring target-local identity.
 *
 * Unlike SQL/Mongo, IDB has no per-instance control adapter to materialize —
 * IDB DDL ops are pure data. The base constructor signature still accepts the
 * `ControlStack` so the framework's `MigrationCLI` orchestration can pass one
 * uniformly, but it is unused inside an IDB migration.
 */
export abstract class IdbMigration extends Migration<IdbDdlOp, "idb", "idb"> {
  readonly targetId = "idb" as const;
}
