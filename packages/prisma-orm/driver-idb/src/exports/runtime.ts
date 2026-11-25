import type { RuntimeDriverDescriptor } from "@prisma/orm-framework/components/execution";
import { idbDriverDescriptorMeta } from "../core/descriptor-meta";
import { IdbRuntimeDriverInstance as BuiltInIdbRuntimeDriver } from "../core/idb-driver";

export type {
  IdbPlanBody,
  IdbAtomicPlan,
  IdbBatchPlan,
  IdbAddPlan,
  IdbCursorScanPlan,
  IdbCountPlan,
  IdbKeysPlan,
  IdbKeyGetPlan,
  IdbGetAllPlan,
  IdbPutPlan,
  IdbUpdatePlan,
  IdbDeletePlan,
  IdbScanWritePlan,
  IdbKeyRangeDescriptor,
  IdbScanDirection,
  IdbRowFilter,
  IdbRowComparator,
  IdbMarkerRecord,
} from "../core/plan-body";
export { MARKER_STORE_NAME } from "../core/plan-body";
/** A custom driver can omit connection generations if its connection never changes. */
export type IdbRuntimeDriverInstance = Omit<BuiltInIdbRuntimeDriver, "connectionGeneration"> & {
  readonly connectionGeneration?: number;
};
export { IdbExecuteError } from "../core/execute/error";
export type { IdbExecuteErrorCode } from "../core/execute/error";
export type { IdbTransactionScope } from "../core/transaction-scope";
export { createTransactionScope } from "../core/transaction-scope";

/**
 * Creates a runtime driver descriptor for IndexedDB.
 *
 * The returned descriptor's `create()` starts opening the named IDB database
 * in the background; the driver awaits the connection before its first query.
 *
 * @param dbName  - The IDB database name to open.
 * @param version - The IDB version number. When omitted, IndexedDB opens the
 *   database at its current version (version 1 for a new database). The
 *   driver never runs migrations; `openAndUpgrade` (target-idb) bumps the version.
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
  options?: {
    readonly factory?: IDBFactory;
    /**
     * The `IDBKeyRange` of the same implementation as `factory`. Needed when the
     * global scope has none, for example fake-indexeddb's `IDBKeyRange` outside a browser.
     */
    readonly keyRange?: typeof IDBKeyRange;
  }
): RuntimeDriverDescriptor<"idb", "idb", void, IdbRuntimeDriverInstance> {
  return {
    ...idbDriverDescriptorMeta,
    create(): IdbRuntimeDriverInstance {
      return new BuiltInIdbRuntimeDriver(dbName, version, options?.factory, options?.keyRange);
    },
  };
}
