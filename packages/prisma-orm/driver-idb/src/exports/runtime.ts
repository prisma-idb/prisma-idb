import type { RuntimeDriverDescriptor } from "@prisma/orm-framework/components/execution";
import { idbDriverDescriptorMeta } from "../core/descriptor-meta";
import { IdbRuntimeDriverInstance } from "../core/idb-driver";

export type {
  IdbPlanBody,
  IdbAtomicPlan,
  IdbBatchPlan,
  IdbAddPlan,
  IdbCursorScanPlan,
  IdbKeyGetPlan,
  IdbIndexGetPlan,
  IdbPutPlan,
  IdbUpdatePlan,
  IdbDeletePlan,
  IdbScanWritePlan,
  IdbRowFilter,
  IdbRowComparator,
  IdbMarkerRecord,
} from "../core/plan-body";
export { MARKER_STORE_NAME } from "../core/plan-body";
export type { IdbRuntimeDriverInstance } from "../core/idb-driver";
export { IdbExecuteError } from "../core/execute/error";
export type { IdbExecuteErrorCode } from "../core/execute/error";
export type { IdbTransactionScope } from "../core/transaction-scope";
export { createTransactionScope } from "../core/transaction-scope";

/**
 * Creates a runtime driver descriptor for IndexedDB.
 *
 * The returned descriptor's `create()` opens the named IDB database
 * lazily — the connection resolves in the background and is awaited by
 * the adapter inside `runDriver()` for the first query.
 *
 * @param dbName  - The IDB database name to open.
 * @param version - The IDB version number (default: 1). Bumping this
 *   triggers `upgradeneeded`-based migrations via `IdbMigrationRunner`.
 *
 * @example
 * ```ts
 * const stack = createRuntimeStack({
 *   target:  idbRuntimeTargetDescriptor,
 *   adapter: idbRuntimeAdapterDescriptor,
 *   driver:  createIDBRuntimeDriver("my-app"),
 * });
 * ```
 */
export function createIDBRuntimeDriver(
  dbName: string,
  version?: number,
  options?: { readonly factory?: IDBFactory }
): RuntimeDriverDescriptor<"idb", "idb", void, IdbRuntimeDriverInstance> {
  return {
    ...idbDriverDescriptorMeta,
    create(): IdbRuntimeDriverInstance {
      return new IdbRuntimeDriverInstance(dbName, version, options?.factory);
    },
  };
}
