/**
 * Multi-store mutation scope for the IDB ORM.
 *
 * `withMutationScope` opens one IDB transaction spanning the named stores,
 * runs the callback with an `IdbTransactionScope` (raw driver-level execute),
 * then commits or rolls back depending on whether the callback throws.
 *
 * Pattern is a direct port of `withMutationScope` from
 * `sql-orm-client/mutation-executor.ts`, adapted for IDB's explicit
 * transaction scope API.
 *
 * @example
 * ```ts
 * await withMutationScope(runtime, ["users", "posts"], async (scope) => {
 *   const userRow = await scope.execute({ kind: "put", storeName: "users", ... });
 *   await scope.execute({ kind: "put", storeName: "posts", ... });
 * });
 * ```
 */
import type { IdbQueryExecutor } from "./executor";
import type { IdbTransactionScope } from "@prisma-idb/driver-idb/runtime";

// ── Interface ─────────────────────────────────────────────────────────────────

/**
 * Extends the basic {@link IdbQueryExecutor} with multi-store transaction
 * support. `IdbRuntime` satisfies this interface — `runtime.transaction()`
 * delegates to `driver.transaction()` which opens the IDB transaction.
 */
export interface IdbQueryExecutorWithTransaction extends IdbQueryExecutor {
  /**
   * Open a multi-store IDB transaction and return a scope object.
   *
   * The returned scope's `execute()` runs `IdbAtomicPlan`s directly inside
   * the transaction — no new transaction is opened per call, and the
   * middleware chain is bypassed. `commit()` resolves when `tx.oncomplete`
   * fires; `rollback()` calls `tx.abort()`.
   */
  transaction(storeNames: string[], mode?: IDBTransactionMode): Promise<IdbTransactionScope>;
}

// ── withMutationScope ─────────────────────────────────────────────────────────

/**
 * Run a callback inside a single multi-store IDB readwrite transaction.
 *
 * Opens the transaction, passes the `IdbTransactionScope` to `run`, then:
 * - On success: awaits `scope.commit()` (waits for `tx.oncomplete`).
 * - On error: calls `scope.rollback()` and rethrows.
 *
 * The callback receives the low-level scope, not the ORM accessor.
 * Use this for multi-store atomic writes that span several object stores.
 */
export async function withMutationScope<T>(
  executor: IdbQueryExecutorWithTransaction,
  storeNames: string[],
  run: (scope: IdbTransactionScope) => Promise<T>
): Promise<T> {
  const tx = await executor.transaction(storeNames, "readwrite");
  try {
    const result = await run(tx);
    await tx.commit();
    return result;
  } catch (err) {
    tx.rollback();
    throw err;
  }
}
