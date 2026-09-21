/**
 * Top-level IDB plan dispatcher.
 *
 * `executeIdbPlan(db, plan)` is the single entry point for the IDB driver's
 * `execute()` path. It:
 *   1. Opens an IDB transaction scoped to the store(s) the plan touches.
 *   2. Dispatches to the appropriate op executor (ops.ts).
 *   3. Resolves the returned Promise only when `tx.oncomplete` fires —
 *      guaranteeing write durability before rows are delivered.
 *
 * Transaction modes:
 *   - Atomic read plans  (key-get, index-get, cursor-scan): `readonly`
 *   - Atomic write plans (add, put, delete):                 `readwrite`
 *   - Batch plans:        `readwrite` if any op is a write, `readonly` otherwise
 */
import type { IdbAtomicPlan, IdbBatchPlan, IdbPlanBody } from "../plan-body";
import { IdbExecuteError } from "./error";
import { executeOpInTx, planTxMode } from "./ops";

type Row = Record<string, unknown>;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Execute an IDB plan against a live database and collect all result rows.
 *
 * Batch plans run all ops inside a single transaction; atomic plans open a
 * single-store transaction. Resolves after `tx.oncomplete` so writes are
 * durable before the caller receives rows.
 */
export function executeIdbPlan(db: IDBDatabase, plan: IdbPlanBody): Promise<Row[]> {
  if (plan.kind === "batch") return executeBatchPlan(db, plan);
  return executeAtomicPlan(db, plan);
}

// ── Atomic plans ─────────────────────────────────────────────────────────────

function executeAtomicPlan(db: IDBDatabase, plan: IdbAtomicPlan): Promise<Row[]> {
  return new Promise<Row[]>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction([plan.storeName], planTxMode(plan));
    } catch (err) {
      reject(
        new IdbExecuteError(
          { code: "STORE_NOT_FOUND", planKind: plan.kind, storeName: plan.storeName, cause: err },
          `IDB store "${plan.storeName}" not found in database`
        )
      );
      return;
    }

    const rows: Row[] = [];

    tx.oncomplete = () => resolve(rows);
    tx.onerror = () =>
      reject(
        new IdbExecuteError(
          {
            code: "TRANSACTION_ABORTED",
            planKind: plan.kind,
            storeName: plan.storeName,
            cause: tx.error,
          },
          `IDB transaction failed on store "${plan.storeName}": ${String(tx.error)}`
        )
      );
    tx.onabort = () =>
      reject(
        new IdbExecuteError(
          { code: "TRANSACTION_ABORTED", planKind: plan.kind, storeName: plan.storeName },
          `IDB transaction aborted on store "${plan.storeName}"`
        )
      );

    const store = tx.objectStore(plan.storeName);
    executeOpInTx(
      store,
      plan,
      (opRows) => {
        for (const row of opRows) rows.push(row);
      },
      (err) => reject(err)
    );
  });
}

// ── Batch plans ──────────────────────────────────────────────────────────────

function executeBatchPlan(db: IDBDatabase, plan: IdbBatchPlan): Promise<Row[]> {
  return new Promise<Row[]>((resolve, reject) => {
    const mode: IDBTransactionMode = plan.ops.some(
      (op) =>
        op.kind === "add" ||
        op.kind === "put" ||
        op.kind === "delete" ||
        op.kind === "update" ||
        op.kind === "scan-write"
    )
      ? "readwrite"
      : "readonly";

    let tx: IDBTransaction;
    try {
      tx = db.transaction([...plan.storeNames], mode);
    } catch (err) {
      reject(
        new IdbExecuteError(
          { code: "STORE_NOT_FOUND", planKind: "batch", cause: err },
          `IDB batch transaction failed to open: ${String(err)}`
        )
      );
      return;
    }

    const rows: Row[] = [];

    tx.oncomplete = () => resolve(rows);
    tx.onerror = () =>
      reject(
        new IdbExecuteError(
          { code: "TRANSACTION_ABORTED", planKind: "batch", cause: tx.error },
          `IDB batch transaction failed: ${String(tx.error)}`
        )
      );
    tx.onabort = () =>
      reject(
        new IdbExecuteError({ code: "TRANSACTION_ABORTED", planKind: "batch" }, "IDB batch transaction was aborted")
      );

    // Run ops sequentially using recursive callbacks. Each op's `onComplete`
    // triggers the next op synchronously (still inside IDB event handlers),
    // which ensures we never cross a microtask boundary between IDB requests.
    runOpsSequentially(tx, plan.ops, 0, rows, reject);
  });
}

/**
 * Recursively runs batch ops one at a time — op N+1 is initiated from inside
 * op N's `onComplete` callback, which fires synchronously within the IDB
 * event handler. This keeps the transaction alive and prevents auto-commit
 * gaps between ops.
 */
function runOpsSequentially(
  tx: IDBTransaction,
  ops: ReadonlyArray<IdbAtomicPlan>,
  index: number,
  rows: Row[],
  onError: (err: unknown) => void
): void {
  const op = ops[index];
  if (op === undefined) return; // all ops initiated; tx.oncomplete will resolve

  let store: IDBObjectStore;
  try {
    store = tx.objectStore(op.storeName);
  } catch (err) {
    onError(
      new IdbExecuteError(
        { code: "STORE_NOT_FOUND", planKind: "batch", storeName: op.storeName, cause: err },
        `IDB batch: store "${op.storeName}" not found`
      )
    );
    return;
  }

  executeOpInTx(
    store,
    op,
    (opRows) => {
      for (const row of opRows) rows.push(row);
      runOpsSequentially(tx, ops, index + 1, rows, onError);
    },
    onError
  );
}
