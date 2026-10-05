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
  IdbCountPlan,
  IdbCursorScanPlan,
  IdbDeletePlan,
  IdbGetAllPlan,
  IdbKeyGetPlan,
  IdbKeysPlan,
  IdbPutPlan,
  IdbScanWritePlan,
  IdbUpdatePlan,
} from "../plan-body";
import {
  IdbExecuteError,
  isTransactionInactiveError,
  transactionInactiveError,
  type IdbExecuteErrorCode,
} from "./error";
import { toOptionalIdbKeyRange } from "./key-range";

type Row = Record<string, unknown>;
type OnComplete = (rows: Row[]) => void;
type OnError = (err: unknown) => void;

/**
 * The error for a failed request: `IDB <what> failed on <target>: <cause>`.
 * `target` defaults to the plan's store; pass it when the message also names an index.
 */
function opError(
  code: IdbExecuteErrorCode,
  plan: IdbAtomicPlan,
  what: string,
  cause: unknown,
  target = `store "${plan.storeName}"`
): IdbExecuteError {
  return new IdbExecuteError(
    { code, planKind: plan.kind, storeName: plan.storeName, cause },
    `IDB ${what} failed on ${target}: ${String(cause)}`
  );
}

/** `store "users"` or `store "users" (index "by_name")`, for plans that may read through an index. */
function storeTarget(plan: { storeName: string; indexName?: string }): string {
  const index = plan.indexName !== undefined ? ` (index "${plan.indexName}")` : "";
  return `store "${plan.storeName}"${index}`;
}

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
  try {
    dispatchOp(store, plan, onComplete, onError);
  } catch (err) {
    // Requests are issued synchronously, so a dead transaction surfaces here as a
    // thrown DOMException. Anything else (DataError, unknown index, ...) is unchanged.
    if (isTransactionInactiveError(err)) return onError(transactionInactiveError(plan.kind, plan.storeName, err));
    throw err;
  }
}

function dispatchOp(store: IDBObjectStore, plan: IdbAtomicPlan, onComplete: OnComplete, onError: OnError): void {
  switch (plan.kind) {
    case "key-get":
      return execKeyGet(store, plan, onComplete, onError);
    case "get-all":
      return execGetAll(store, plan, onComplete, onError);
    case "cursor-scan":
      return execCursorScan(store, plan, onComplete, onError);
    case "count":
      return execCount(store, plan, onComplete, onError);
    case "keys":
      return execKeys(store, plan, onComplete, onError);
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
    default: {
      // Unreachable for a well-typed plan; a stale driver build receiving a newer plan kind
      // would otherwise never call onComplete/onError and hang the caller.
      const unknown: never = plan;
      return onError(new Error(`Unknown IDB plan kind: ${String((unknown as { kind?: unknown }).kind)}`));
    }
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
  req.onerror = () => onError(opError("KEY_GET_FAILED", plan, "key-get", req.error));
}

function execGetAll(store: IDBObjectStore, plan: IdbGetAllPlan, onComplete: OnComplete, onError: OnError): void {
  // getAll(undefined, 0) would read everything, so a zero cap is answered without a request.
  if (plan.count === 0) return onComplete([]);

  const source = plan.indexName !== undefined ? store.index(plan.indexName) : store;
  const req = source.getAll(toOptionalIdbKeyRange(plan.range), plan.count);
  req.onsuccess = () => onComplete(req.result as Row[]);
  req.onerror = () => onError(opError("GET_ALL_FAILED", plan, "get-all", req.error, storeTarget(plan)));
}

function execCount(store: IDBObjectStore, plan: IdbCountPlan, onComplete: OnComplete, onError: OnError): void {
  const source: IDBObjectStore | IDBIndex = plan.indexName !== undefined ? store.index(plan.indexName) : store;
  const range = toOptionalIdbKeyRange(plan.range);
  const req = range !== undefined ? source.count(range) : source.count();
  req.onsuccess = () => onComplete([{ count: req.result }]);
  req.onerror = () => onError(opError("COUNT_FAILED", plan, "count", req.error, storeTarget(plan)));
}

function execKeys(store: IDBObjectStore, plan: IdbKeysPlan, onComplete: OnComplete, onError: OnError): void {
  const source: IDBObjectStore | IDBIndex = plan.indexName !== undefined ? store.index(plan.indexName) : store;
  const fail = (cause: unknown) => onError(opError("KEYS_FAILED", plan, "keys read", cause, storeTarget(plan)));
  const range = toOptionalIdbKeyRange(plan.range);

  // getKey() requires a query (null/absent throws), so a range-less single-key
  // read is expressed as getAllKeys(undefined, 1) instead.
  if (plan.take === 1 && range !== undefined) {
    const req = source.getKey(range);
    req.onsuccess = () => onComplete(req.result === undefined ? [] : [{ key: req.result }]);
    req.onerror = () => fail(req.error);
    return;
  }

  if (plan.take === 0) {
    onComplete([]);
    return;
  }

  const req = source.getAllKeys(range, plan.take);
  req.onsuccess = () => onComplete((req.result as IDBValidKey[]).map((key) => ({ key })));
  req.onerror = () => fail(req.error);
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

  // Nothing can be returned, so don't open a cursor.
  if (take === 0) return onComplete([]);

  const source: IDBObjectStore | IDBIndex = plan.indexName !== undefined ? store.index(plan.indexName) : store;

  // openCursor accepts null to mean "no range restriction".
  const req = source.openCursor(toOptionalIdbKeyRange(plan.range) ?? null, plan.direction ?? "next");
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

  req.onerror = () => onError(opError("CURSOR_SCAN_FAILED", plan, "cursor-scan", req.error));
}

/**
 * The record as stored: `record` itself, plus the generated key when an
 * `autoIncrement` store with an inline `keyPath` filled it in. IDB writes the
 * generated key into its own stored copy, never into the caller's object, so
 * the echo needs it set from `req.result`.
 */
function withGeneratedKey(
  store: IDBObjectStore,
  record: Record<string, unknown>,
  key: IDBValidKey
): Record<string, unknown> {
  if (!store.autoIncrement || typeof store.keyPath !== "string" || record[store.keyPath] !== undefined) return record;
  return { ...record, [store.keyPath]: key };
}

function execAdd(store: IDBObjectStore, plan: IdbAddPlan, onComplete: OnComplete, onError: OnError): void {
  // Use the optional out-of-line key when provided; otherwise IDB derives the
  // key from the record via the store's keyPath.
  const req = plan.key !== undefined ? store.add(plan.record, plan.key) : store.add(plan.record);
  // Echo the record back — IDB has no RETURNING clause.
  req.onsuccess = () => onComplete([withGeneratedKey(store, plan.record, req.result)]);
  req.onerror = () => onError(opError("ADD_FAILED", plan, "add", req.error));
}

function execPut(store: IDBObjectStore, plan: IdbPutPlan, onComplete: OnComplete, onError: OnError): void {
  // Use the optional out-of-line key when provided; otherwise IDB derives the
  // key from the record via the store's keyPath.
  const req = plan.key !== undefined ? store.put(plan.record, plan.key) : store.put(plan.record);
  // Echo the record back — IDB has no RETURNING clause.
  req.onsuccess = () => onComplete([withGeneratedKey(store, plan.record, req.result)]);
  req.onerror = () => onError(opError("PUT_FAILED", plan, "put", req.error));
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
    putReq.onerror = () => onError(opError("PUT_FAILED", plan, "update (put phase)", putReq.error));
  };
  getReq.onerror = () => onError(opError("KEY_GET_FAILED", plan, "update (get phase)", getReq.error));
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
    delReq.onerror = () => onError(opError("DELETE_FAILED", plan, "delete", delReq.error));
  };
  req.onerror = () => onError(opError("DELETE_FAILED", plan, "delete", req.error));
}

function execScanWrite(store: IDBObjectStore, plan: IdbScanWritePlan, onComplete: OnComplete, onError: OnError): void {
  // A zero limit writes nothing; without this the first match would be written before the limit check.
  if (plan.take === 0) return onComplete([]);

  // Cursor must be opened on a readwrite transaction (enforced by planTxMode).
  const source = plan.indexName !== undefined ? store.index(plan.indexName) : store;
  const req = source.openCursor(toOptionalIdbKeyRange(plan.range) ?? null, "next");
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
      delReq.onerror = () => onError(opError("DELETE_FAILED", plan, "scan-write (delete)", delReq.error));
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
      updReq.onerror = () => onError(opError("PUT_FAILED", plan, "scan-write (put-merged)", updReq.error));
    }
  };

  req.onerror = () => onError(opError("CURSOR_SCAN_FAILED", plan, "scan-write cursor", req.error));
}
