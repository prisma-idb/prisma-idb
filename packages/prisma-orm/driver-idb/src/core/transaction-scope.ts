/**
 * Multi-store IDB transaction scope.
 *
 * A single `IDBTransaction` spanning one or more object stores, exposed as a
 * typed execution surface for the ORM's `withMutationScope()` helper.
 *
 * Design notes:
 * - `execute(plan)` runs `executeOpInTx` directly in the pre-opened transaction —
 *   NO new transaction is opened per call, and the middleware chain is bypassed
 *   entirely. This keeps the shared IDB transaction alive across multiple awaited
 *   execute() calls (IDB auto-commits in a macro-task, not a microtask; each
 *   execute() issues new requests before the auto-commit check fires).
 * - `commit()` resolves when `tx.oncomplete` fires — the caller awaits this after
 *   all scope operations are complete to get write-durability confirmation.
 * - `rollback()` is idempotent: calling it on an already-aborted transaction is
 *   a no-op (the DOMException from IDB is swallowed).
 *
 * Issue #6 (scope hard-coding): since this scope's execute() bypasses both of
 * `RuntimeCore`'s middleware chains (query()'s and execute()'s alike), the
 * cache middleware never fires inside a scope → reads are always fresh.
 */
import type { IdbAtomicPlan } from "./plan-body";
import { IdbExecuteError } from "./execute/error";
import { executeOpInTx } from "./execute/ops";

type Row = Record<string, unknown>;

// ── Public interface ──────────────────────────────────────────────────────────

export interface IdbTransactionScope {
  /**
   * Execute a single atomic plan inside the shared IDB transaction.
   *
   * The plan runs synchronously inside IDB event callbacks; the returned
   * Promise resolves once the operation's `onsuccess` fires. The transaction
   * stays open — the next `execute()` call can be issued right after `await`.
   */
  execute(plan: IdbAtomicPlan): Promise<Row[]>;

  /**
   * Wait for the IDB transaction to fully commit.
   *
   * Resolves when `tx.oncomplete` fires (all writes are durable). Call this
   * after all `execute()` calls; `withMutationScope` does this automatically.
   */
  commit(): Promise<void>;

  /**
   * Abort the transaction, rolling back all uncommitted writes.
   *
   * Idempotent — safe to call when the transaction has already been aborted
   * (e.g. due to a request error). `withMutationScope` calls this on catch.
   */
  rollback(): void;
}

// ── Implementation ────────────────────────────────────────────────────────────

class IdbTransactionScopeImpl implements IdbTransactionScope {
  readonly #tx: IDBTransaction;
  readonly #onComplete: Promise<void>;

  constructor(tx: IDBTransaction) {
    this.#tx = tx;
    this.#onComplete = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(
          new IdbExecuteError(
            { code: "TRANSACTION_ABORTED", planKind: "batch", cause: tx.error },
            `IDB transaction scope failed: ${String(tx.error)}`
          )
        );
      tx.onabort = () =>
        reject(
          new IdbExecuteError({ code: "TRANSACTION_ABORTED", planKind: "batch" }, "IDB transaction scope aborted")
        );
    });
    // Suppress "unhandled rejection" when the scope is rolled back without
    // commit() being awaited (e.g. withMutationScope catches an error and
    // calls rollback() without ever calling commit()).
    this.#onComplete.catch(() => {});
  }

  execute(plan: IdbAtomicPlan): Promise<Row[]> {
    return new Promise<Row[]>((resolve, reject) => {
      let store: IDBObjectStore;
      try {
        store = this.#tx.objectStore(plan.storeName);
      } catch (err) {
        reject(
          new IdbExecuteError(
            { code: "STORE_NOT_FOUND", planKind: plan.kind, storeName: plan.storeName, cause: err },
            `IDB transaction scope: store "${plan.storeName}" not found`
          )
        );
        return;
      }

      const rows: Row[] = [];
      executeOpInTx(
        store,
        plan,
        (opRows) => {
          for (const row of opRows) rows.push(row);
          resolve(rows);
        },
        reject
      );
    });
  }

  commit(): Promise<void> {
    return this.#onComplete;
  }

  rollback(): void {
    try {
      this.#tx.abort();
    } catch {
      // Transaction already committed or aborted — no-op.
    }
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Open an IDB transaction spanning `storeNames` and wrap it in a scope.
 *
 * Throws synchronously if any store in `storeNames` is not found in the
 * database (IDB throws when opening a transaction with unknown store names).
 */
export function createTransactionScope(
  db: IDBDatabase,
  storeNames: string[],
  mode: IDBTransactionMode = "readwrite"
): IdbTransactionScope {
  const tx = db.transaction(storeNames, mode);
  return new IdbTransactionScopeImpl(tx);
}
