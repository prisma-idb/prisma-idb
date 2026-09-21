import type { ControlDriverInstance } from "@prisma/orm-framework/components/control";

/**
 * Extended IDB control driver for migrations.
 *
 * Carries the `IDBFactory`, database name, and target version number so
 * the migration runner can open the database and perform DDL inside the
 * `upgradeneeded` callback.
 *
 * The `targetVersion` is the IDB database version to upgrade **to**. The
 * caller is responsible for computing this value — typically by reading
 * `manifest.idbVersion ?? 0` and adding 1.
 *
 * After a successful `IdbMigrationRunner.execute()` call, the caller must
 * write the new `idbVersion` (= `targetVersion`) back to the manifest.
 * The runner itself does not touch the manifest.
 */
export type IdbMigrationControlDriver = ControlDriverInstance<"idb", "idb"> & {
  readonly dbName: string;
  readonly factory: IDBFactory;
  readonly targetVersion: number;
};

// ── Descriptor ────────────────────────────────────────────────────────────────

/**
 * Factory descriptor for `IdbMigrationControlDriver`.
 *
 * Usage:
 * ```ts
 * const driver = IdbMigrationControlDriverDescriptor.create({
 *   dbName: "my-app",
 *   factory: window.indexedDB,   // or new IDBFactory() from fake-indexeddb
 *   targetVersion: (manifest.idbVersion ?? 0) + 1,
 * });
 * ```
 */
export const IdbMigrationControlDriverDescriptor = {
  version: "1.0.0",
  create({
    dbName,
    factory,
    targetVersion,
  }: {
    readonly dbName: string;
    readonly factory: IDBFactory;
    readonly targetVersion: number;
  }): IdbMigrationControlDriver {
    return {
      familyId: "idb",
      targetId: "idb",
      dbName,
      factory,
      targetVersion,
      async close() {},
    };
  },
} as const;

// ── Extractor ─────────────────────────────────────────────────────────────────

/**
 * Narrows a `ControlDriverInstance<"idb","idb">` to `IdbMigrationControlDriver`.
 *
 * Throws a descriptive error if the driver was not created by
 * {@link IdbMigrationControlDriverDescriptor}.
 */
export function extractMigrationDriver(driver: ControlDriverInstance<"idb", "idb">): IdbMigrationControlDriver {
  if (!("dbName" in driver) || !("factory" in driver) || !("targetVersion" in driver)) {
    throw new Error(
      "IDB migration runner requires an IdbMigrationControlDriver. " +
        "Create one with IdbMigrationControlDriverDescriptor.create({ dbName, factory, targetVersion })."
    );
  }
  return driver as IdbMigrationControlDriver;
}
