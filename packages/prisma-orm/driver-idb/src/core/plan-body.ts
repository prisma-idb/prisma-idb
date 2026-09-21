import type { ExecutionPlan } from "@prisma/orm-framework/components/runtime";

// ── Marker store ─────────────────────────────────────────────────────────────

/**
 * Name of the object store that holds the contract marker.
 *
 * Created during `upgradeneeded` by the migration runner and verified by the
 * runtime before every query execution to detect schema drift.
 *
 * Upstream equivalent: `_prisma_marker` table in SQLite/Postgres,
 * `_prisma_marker` collection in MongoDB.
 */
export const MARKER_STORE_NAME = "_prisma_next_marker";

/**
 * Shape of a marker record stored in {@link MARKER_STORE_NAME}.
 *
 * Mirrors the framework's `ContractMarkerRecord` plus the `space` keying
 * field. Records are keyed by `space` (`"app"` for the single app space) so
 * the storage layout can accommodate future IDB extension spaces.
 *
 * `updatedAt` is a JavaScript `Date` (not an ISO string) because IndexedDB
 * serialises Dates natively via structured-clone.
 *
 * Non-key fields are optional for forward compatibility with future contract
 * versions that may add or remove marker metadata.
 */
export interface IdbMarkerRecord {
  /** Contract-space identifier (`"app"` for the single app space). */
  readonly space?: string;
  /** The `storageHash` from the contract that was last signed. */
  readonly storageHash: string;
  /** The `profileHash` from the contract that was last signed. */
  readonly profileHash?: string;
  /** Date the marker was last written. */
  readonly updatedAt?: Date | string;
  readonly invariants?: readonly string[];
  readonly contractJson?: unknown;
  readonly canonicalVersion?: number | null;
  readonly appTag?: string | null;
  readonly meta?: Record<string, unknown>;
}

/**
 * In-memory predicate applied to each row while iterating a cursor.
 * Returns true if the row should be included in the result set.
 */
export type IdbRowFilter = (row: Record<string, unknown>) => boolean;

/**
 * In-memory comparator for ORDER BY.
 * Follows the same contract as Array.prototype.sort: negative / zero / positive.
 */
export type IdbRowComparator = (a: Record<string, unknown>, b: Record<string, unknown>) => number;

/**
 * Full cursor scan over an object store or index.
 *
 * Used for `findMany`, `findFirst`, and any query where an exact key lookup
 * isn't possible. Supports key-range restriction, in-memory filtering,
 * in-memory ordering, and OFFSET + LIMIT.
 *
 * When `indexName` is set, the cursor iterates the named secondary index
 * instead of the primary key order.
 */
export interface IdbCursorScanPlan extends ExecutionPlan {
  readonly kind: "cursor-scan";
  readonly storeName: string;
  readonly indexName?: string; // if set, iterate via this index
  readonly range?: IDBKeyRange; // restrict the cursor's key range
  readonly direction?: IDBCursorDirection; // "next" | "nextunique" | "prev" | "prevunique"
  readonly filter?: IdbRowFilter; // in-memory WHERE
  readonly comparator?: IdbRowComparator; // in-memory ORDER BY (when index order isn't enough)
  readonly skip?: number; // OFFSET
  readonly take?: number; // LIMIT (undefined = no limit)
}

/**
 * Primary-key O(1) lookup via `store.get(key)`.
 *
 * Used for `findUnique` on `@id` fields.
 */
export interface IdbKeyGetPlan extends ExecutionPlan {
  readonly kind: "key-get";
  readonly storeName: string;
  readonly key: IDBValidKey;
}

/**
 * Index-based range lookup.
 *
 * Used for `findUnique` on `@@unique` fields and index-accelerated
 * `findMany` on `@@index` fields.
 */
export interface IdbIndexGetPlan extends ExecutionPlan {
  readonly kind: "index-get";
  readonly storeName: string;
  readonly indexName: string;
  readonly range: IDBKeyRange;
}

/**
 * Insert a single record via `store.add(record[, key])`.
 *
 * Used for Prisma `create` semantics. IndexedDB rejects `add()` when the
 * primary key already exists, which preserves the "create never overwrites"
 * contract expected by callers.
 *
 * `key` is only needed for out-of-line key stores (`keyPath: null`).
 */
export interface IdbAddPlan extends ExecutionPlan {
  readonly kind: "add";
  readonly storeName: string;
  readonly record: Record<string, unknown>;
  readonly key?: IDBValidKey;
}

/**
 * Upsert or replace a single record via `store.put(record[, key])`.
 *
 * Used for upsert paths where the full replacement record is already known.
 * The driver echoes `record` back as the result row — IDB does not have
 * RETURNING.
 *
 * `key` is only needed for out-of-line key stores (`keyPath: null`).
 */
export interface IdbPutPlan extends ExecutionPlan {
  readonly kind: "put";
  readonly storeName: string;
  readonly record: Record<string, unknown>;
  readonly key?: IDBValidKey;
}

/**
 * Atomic partial update: get → merge → put in a single readwrite transaction.
 *
 * Used for Prisma `update` where only a subset of fields change. The driver:
 *   1. Reads the current record via `store.get(key)`.
 *   2. Deep-merges `patch` onto the existing record with `{ ...existing, ...patch }`.
 *   3. Writes the merged record back via `store.put(merged)`.
 *   4. Echoes the merged record as the result row.
 *
 * This preserves fields not mentioned in `patch` — unlike `IdbPutPlan` which
 * does a full replacement. The get and put are issued inside the same
 * readwrite transaction so no other writer can interleave.
 *
 * If no record exists for `key`, the driver echoes `patch` as-is (insert semantics).
 */
export interface IdbUpdatePlan extends ExecutionPlan {
  readonly kind: "update";
  readonly storeName: string;
  readonly key: IDBValidKey;
  readonly patch: Record<string, unknown>;
}

/**
 * Delete one or more records by key or key range.
 *
 * Used for `delete` and `deleteMany`. The driver walks a cursor over
 * `key` (a single key or a range) and yields each deleted row, so callers
 * can echo them back and `execute()` can report an accurate affected-row
 * count — same convention as `add`/`put`/`update`.
 */
export interface IdbDeletePlan extends ExecutionPlan {
  readonly kind: "delete";
  readonly storeName: string;
  readonly key: IDBValidKey | IDBKeyRange;
}

/**
 * Cursor scan with in-place write for each matching row.
 *
 * Used for `update` (take:1), `updateAll`, `updateCount`, `deleteAll`,
 * `deleteCount`. Opens a readwrite cursor and applies `write` to each
 * row that passes `filter`:
 *
 * - `"put-merged"`: shallow-merges `patch` onto the row and calls
 *   `cursor.update(merged)`. Yields merged rows.
 * - `"delete"`: captures `cursor.value` then calls `cursor.delete()`.
 *   Yields the deleted rows (so callers can echo them back).
 *
 * With `take`, the cursor stops after the first `take` matches (no
 * `cursor.continue()` call after the limit is reached).
 */
export interface IdbScanWritePlan extends ExecutionPlan {
  readonly kind: "scan-write";
  readonly storeName: string;
  readonly filter?: IdbRowFilter;
  readonly take?: number;
  readonly write: "put-merged" | "delete";
  readonly patch?: Record<string, unknown>;
}

/**
 * All single-store atomic op types — valid both standalone and inside a batch.
 */
export type IdbAtomicPlan =
  | IdbCursorScanPlan
  | IdbKeyGetPlan
  | IdbIndexGetPlan
  | IdbAddPlan
  | IdbPutPlan
  | IdbUpdatePlan
  | IdbDeletePlan
  | IdbScanWritePlan;

/**
 * Multi-op atomic batch executed inside a single IDB transaction.
 *
 * Used whenever a Prisma operation must touch multiple stores atomically
 * (e.g. `create` with nested relations, `update` + cascade `delete`).
 *
 * The driver opens ONE readwrite transaction scoped to `storeNames`, runs
 * every op in `ops` sequentially, and collects rows from read ops. Write ops
 * (`put`/`delete`) echo their result inline (see `IdbPutPlan`).
 *
 * `storeNames` MUST include every store referenced by any op in `ops`.
 * IDB requires the full store scope to be declared when opening a transaction.
 */
export interface IdbBatchPlan extends ExecutionPlan {
  readonly kind: "batch";
  readonly storeNames: ReadonlyArray<string>;
  readonly ops: ReadonlyArray<IdbAtomicPlan>;
}

/**
 * The full union of plan shapes the adapter produces and the driver executes.
 */
export type IdbPlanBody = IdbAtomicPlan | IdbBatchPlan;
