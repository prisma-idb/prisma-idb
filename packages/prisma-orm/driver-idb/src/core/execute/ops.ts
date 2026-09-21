/**
 * Callback-based IDB operation executors.
 *
 * All functions are purely event-driven — no Promises or async/await inside
 * IDB transaction event handlers. This is required because IDB transactions
 * auto-commit when no pending requests exist and the microtask queue drains;
 * interleaving a microtask boundary (await) between IDB requests would risk
 * premature auto-commit.
 *
 * Pattern: each `exec*` function
 *   1. Issues one or more IDB requests **synchronously**.
 *   2. Calls `onComplete(rows)` when the op's work is done (inside onsuccess).
 *   3. Calls `onError(err)` if a request or the transaction fails.
 *
 * The caller (execute/index.ts) resolves the outer Promise from `tx.oncomplete`
 * so write durability is guaranteed before rows are delivered.
 */
import type {
  IdbAddPlan,
  IdbAtomicPlan,
  IdbCursorScanPlan,
  IdbDeletePlan,
  IdbIndexGetPlan,
  IdbKeyGetPlan,
  IdbPutPlan,
  IdbScanWritePlan,
  IdbUpdatePlan,
} from "../plan-body";
import { IdbExecuteError } from "./error";

type Row = Record<string, unknown>;
type OnComplete = (rows: Row[]) => void;
type OnError = (err: unknown) => void;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Dispatch an atomic plan to its IDB operation within a live transaction.
 *
 * All IDB requests are issued synchronously. `onComplete` is called once all
 * requests for this op have resolved (still inside IDB event handlers — no
 * async gap). `onError` is called on the first request failure.
 */
export function executeOpInTx(
  store: IDBObjectStore,
  plan: IdbAtomicPlan,
  onComplete: OnComplete,
  onError: OnError
): void {
  switch (plan.kind) {
    case "key-get":
      return execKeyGet(store, plan, onComplete, onError);
    case "index-get":
      return execIndexGet(store, plan, onComplete, onError);
    case "cursor-scan":
      return execCursorScan(store, plan, onComplete, onError);
    case "add":
      return execAdd(store, plan, onComplete, onError);
    case "put":
      return execPut(store, plan, onComplete, onError);
    case "update":
      return execUpdate(store, plan, onComplete, onError);
    case "delete":
      return execDelete(store, plan, onComplete, onError);
    case "scan-write":
      return execScanWrite(store, plan, onComplete, onError);
  }
}

/** Returns the IDB transaction mode appropriate for a given atomic plan. */
export function planTxMode(plan: IdbAtomicPlan): IDBTransactionMode {
  return plan.kind === "add" ||
    plan.kind === "put" ||
    plan.kind === "update" ||
    plan.kind === "delete" ||
    plan.kind === "scan-write"
    ? "readwrite"
    : "readonly";
}

// ── Per-operation executors ──────────────────────────────────────────────────

function execKeyGet(store: IDBObjectStore, plan: IdbKeyGetPlan, onComplete: OnComplete, onError: OnError): void {
  const req = store.get(plan.key);
  req.onsuccess = () => {
    const value = req.result as Row | undefined;
    onComplete(value !== undefined ? [value] : []);
  };
  req.onerror = () =>
    onError(
      new IdbExecuteError(
        { code: "KEY_GET_FAILED", planKind: "key-get", storeName: plan.storeName, cause: req.error },
        `IDB key-get failed on store "${plan.storeName}": ${String(req.error)}`
      )
    );
}

function execIndexGet(store: IDBObjectStore, plan: IdbIndexGetPlan, onComplete: OnComplete, onError: OnError): void {
  const req = store.index(plan.indexName).getAll(plan.range);
  req.onsuccess = () => onComplete(req.result as Row[]);
  req.onerror = () =>
    onError(
      new IdbExecuteError(
        {
          code: "INDEX_GET_FAILED",
          planKind: "index-get",
          storeName: plan.storeName,
          cause: req.error,
        },
        `IDB index-get failed on "${plan.storeName}"/"${plan.indexName}": ${String(req.error)}`
      )
    );
}

function execCursorScan(
  store: IDBObjectStore,
  plan: IdbCursorScanPlan,
  onComplete: OnComplete,
  onError: OnError
): void {
  // Capture plan fields to avoid repeated property access inside the hot loop.
  const comparator = plan.comparator;
  const filter = plan.filter;
  const skip = plan.skip;
  const take = plan.take;

  const source: IDBObjectStore | IDBIndex = plan.indexName !== undefined ? store.index(plan.indexName) : store;

  // openCursor accepts null to mean "no range restriction".
  const req = source.openCursor(plan.range ?? null, plan.direction ?? "next");
  const collected: Row[] = [];
  let skippedCount = 0;

  req.onsuccess = () => {
    const cursor = req.result as IDBCursorWithValue | null;

    if (cursor === null) {
      // Cursor exhausted. If a comparator is set we collected all matching rows
      // before sorting; apply sort + skip/take now.
      if (comparator !== undefined) {
        collected.sort(comparator);
        const offset = skip ?? 0;
        onComplete(take !== undefined ? collected.slice(offset, offset + take) : collected.slice(offset));
      } else {
        onComplete(collected);
      }
      return;
    }

    const row = cursor.value as Row;

    if (filter === undefined || filter(row)) {
      if (comparator !== undefined) {
        // Must collect ALL matching rows before sorting — can't apply skip/take
        // inline because earlier rows might be sorted out.
        collected.push(row);
      } else {
        // No comparator: apply skip/take inline so we avoid collecting rows
        // that will be discarded.
        if (skip !== undefined && skippedCount < skip) {
          skippedCount++;
        } else if (take === undefined || collected.length < take) {
          collected.push(row);
          if (take !== undefined && collected.length === take) {
            // Take limit reached — stop the cursor early. The transaction has
            // no more pending requests and will auto-commit, triggering
            // tx.oncomplete → resolve(rows) in the outer wrapper.
            onComplete(collected);
            return; // intentionally no cursor.continue()
          }
        }
      }
    }

    cursor.continue();
  };

  req.onerror = () =>
    onError(
      new IdbExecuteError(
        {
          code: "CURSOR_SCAN_FAILED",
          planKind: "cursor-scan",
          storeName: plan.storeName,
          cause: req.error,
        },
        `IDB cursor-scan failed on store "${plan.storeName}": ${String(req.error)}`
      )
    );
}

function execAdd(store: IDBObjectStore, plan: IdbAddPlan, onComplete: OnComplete, onError: OnError): void {
  // Use the optional out-of-line key when provided; otherwise IDB derives the
  // key from the record via the store's keyPath.
  const req = plan.key !== undefined ? store.add(plan.record, plan.key) : store.add(plan.record);
  // Echo the record back — IDB has no RETURNING clause.
  req.onsuccess = () => onComplete([plan.record]);
  req.onerror = () =>
    onError(
      new IdbExecuteError(
        { code: "ADD_FAILED", planKind: "add", storeName: plan.storeName, cause: req.error },
        `IDB add failed on store "${plan.storeName}": ${String(req.error)}`
      )
    );
}

function execPut(store: IDBObjectStore, plan: IdbPutPlan, onComplete: OnComplete, onError: OnError): void {
  // Use the optional out-of-line key when provided; otherwise IDB derives the
  // key from the record via the store's keyPath.
  const req = plan.key !== undefined ? store.put(plan.record, plan.key) : store.put(plan.record);
  // Echo the record back — IDB has no RETURNING clause.
  req.onsuccess = () => onComplete([plan.record]);
  req.onerror = () =>
    onError(
      new IdbExecuteError(
        { code: "PUT_FAILED", planKind: "put", storeName: plan.storeName, cause: req.error },
        `IDB put failed on store "${plan.storeName}": ${String(req.error)}`
      )
    );
}

function execUpdate(store: IDBObjectStore, plan: IdbUpdatePlan, onComplete: OnComplete, onError: OnError): void {
  // Step 1: read the current record.
  const getReq = store.get(plan.key);
  getReq.onsuccess = () => {
    const existing = (getReq.result as Row | undefined) ?? {};
    // Step 2: shallow-merge patch onto existing record.
    const merged: Row = { ...existing, ...plan.patch };
    // Step 3: write the merged record back.
    const putReq = store.put(merged);
    putReq.onsuccess = () => onComplete([merged]);
    putReq.onerror = () =>
      onError(
        new IdbExecuteError(
          { code: "PUT_FAILED", planKind: "update", storeName: plan.storeName, cause: putReq.error },
          `IDB update (put phase) failed on store "${plan.storeName}": ${String(putReq.error)}`
        )
      );
  };
  getReq.onerror = () =>
    onError(
      new IdbExecuteError(
        { code: "KEY_GET_FAILED", planKind: "update", storeName: plan.storeName, cause: getReq.error },
        `IDB update (get phase) failed on store "${plan.storeName}": ${String(getReq.error)}`
      )
    );
}

function execDelete(store: IDBObjectStore, plan: IdbDeletePlan, onComplete: OnComplete, onError: OnError): void {
  // `plan.key` may be a single key or an `IDBKeyRange` spanning several
  // records (deleteMany). Walk a cursor over it so every matched record is
  // captured (and its key individually deleted) before moving on — this
  // both echoes the deleted row(s), mirroring add/put/update, and gives an
  // accurate affected-row count for both the single-key and range cases via
  // the same drain-and-count `runExecute()` already uses for every other op.
  const req = store.openCursor(plan.key);
  const collected: Row[] = [];

  req.onsuccess = () => {
    const cursor = req.result as IDBCursorWithValue | null;
    if (cursor === null) {
      onComplete(collected);
      return;
    }
    collected.push(cursor.value as Row);
    const delReq = cursor.delete();
    delReq.onsuccess = () => cursor.continue();
    delReq.onerror = () =>
      onError(
        new IdbExecuteError(
          { code: "DELETE_FAILED", planKind: "delete", storeName: plan.storeName, cause: delReq.error },
          `IDB delete failed on store "${plan.storeName}": ${String(delReq.error)}`
        )
      );
  };
  req.onerror = () =>
    onError(
      new IdbExecuteError(
        { code: "DELETE_FAILED", planKind: "delete", storeName: plan.storeName, cause: req.error },
        `IDB delete failed on store "${plan.storeName}": ${String(req.error)}`
      )
    );
}

function execScanWrite(store: IDBObjectStore, plan: IdbScanWritePlan, onComplete: OnComplete, onError: OnError): void {
  // Cursor must be opened on a readwrite transaction (enforced by planTxMode).
  const req = store.openCursor(null, "next");
  const collected: Row[] = [];

  req.onsuccess = () => {
    const cursor = req.result as IDBCursorWithValue | null;

    if (cursor === null) {
      // Cursor exhausted — deliver all collected rows.
      onComplete(collected);
      return;
    }

    const row = cursor.value as Row;

    // Skip rows that don't match the filter.
    if (plan.filter !== undefined && !plan.filter(row)) {
      cursor.continue();
      return;
    }

    if (plan.write === "delete") {
      // Capture the row value before deleting (so deleteAll can return it).
      collected.push(row);
      const delReq = cursor.delete();
      delReq.onsuccess = () => {
        if (plan.take !== undefined && collected.length >= plan.take) {
          onComplete(collected);
          return; // intentionally no cursor.continue() — transaction auto-commits
        }
        cursor.continue();
      };
      delReq.onerror = () =>
        onError(
          new IdbExecuteError(
            { code: "DELETE_FAILED", planKind: "scan-write", storeName: plan.storeName, cause: delReq.error },
            `IDB scan-write (delete) failed on store "${plan.storeName}": ${String(delReq.error)}`
          )
        );
    } else {
      // put-merged: shallow-merge patch onto existing row, write back in-place.
      const merged: Row = { ...row, ...plan.patch };
      const updReq = cursor.update(merged);
      updReq.onsuccess = () => {
        collected.push(merged);
        if (plan.take !== undefined && collected.length >= plan.take) {
          onComplete(collected);
          return; // intentionally no cursor.continue()
        }
        cursor.continue();
      };
      updReq.onerror = () =>
        onError(
          new IdbExecuteError(
            { code: "PUT_FAILED", planKind: "scan-write", storeName: plan.storeName, cause: updReq.error },
            `IDB scan-write (put-merged) failed on store "${plan.storeName}": ${String(updReq.error)}`
          )
        );
    }
  };

  req.onerror = () =>
    onError(
      new IdbExecuteError(
        { code: "CURSOR_SCAN_FAILED", planKind: "scan-write", storeName: plan.storeName, cause: req.error },
        `IDB scan-write cursor failed on store "${plan.storeName}": ${String(req.error)}`
      )
    );
}
