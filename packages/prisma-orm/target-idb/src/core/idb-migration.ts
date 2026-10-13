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
 * IDB DDL operations are pure data. Constructing a migration requires no
 * control stack or adapter materialization.
 */
export abstract class IdbMigration extends Migration<IdbDdlOp, "idb", "idb"> {
  readonly targetId = "idb" as const;
}
