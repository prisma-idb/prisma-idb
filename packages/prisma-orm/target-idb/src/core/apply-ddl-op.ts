import type { ContractMarkerRecord } from "@prisma/orm-framework/contract/types";
import { IDB_MARKER_STORE, type IdbDdlOp } from "./migration-factories";

/**
 * Execute a single DDL operation against an open `upgradeneeded` transaction.
 *
 * All IndexedDB DDL (createObjectStore, deleteObjectStore, createIndex,
 * deleteIndex) MUST happen inside the version-change transaction that fires
 * in `upgradeneeded`. The `db` and `tx` references are valid only for the
 * duration of that callback.
 *
 * Shared by the runner (target-idb), the browser auto-migrate path
 * (client-idb), and the preflight CLI (family-idb) so all three apply paths
 * use a single, byte-identical implementation.
 *
 * **Idempotency.** Each op is guarded by an existence check so re-applying an
 * already-applied op is a no-op rather than a throw. This is the load-bearing
 * guarantee behind the two-phase marker write (ADR 002): if a tab is killed in
 * the window between the version-change transaction committing and the marker
 * `put` landing, the schema is advanced but the marker still points at the old
 * hash. On the next open, the chain walk re-collects the already-applied ops
 * and replays them here. Without the guards, `createObjectStore` /
 * `createIndex` throw `ConstraintError` on the existing store/index, the
 * version-change transaction aborts, and the database is permanently wedged
 * (every subsequent open repeats the failed upgrade). Contrary to a common
 * assumption, IndexedDB itself offers **no** "already exists" tolerance — these
 * guards are what make replay safe. (Was PLAN Issue #25.)
 */
export function applyOneDdlOp(db: IDBDatabase, tx: IDBTransaction, op: IdbDdlOp): void {
  switch (op.kind) {
    case "createObjectStore": {
      if (db.objectStoreNames.contains(op.storeName)) return;
      db.createObjectStore(op.storeName, {
        keyPath: op.def.keyPath,
        ...(op.def.autoIncrement !== undefined && { autoIncrement: op.def.autoIncrement }),
      });
      return;
    }
    case "dropObjectStore": {
      if (!db.objectStoreNames.contains(op.storeName)) return;
      db.deleteObjectStore(op.storeName);
      return;
    }
    case "createIndex": {
      const store = tx.objectStore(op.storeName);
      if (store.indexNames.contains(op.indexName)) return;
      store.createIndex(op.indexName, op.def.keyPath, {
        unique: op.def.unique,
        ...(op.def.multiEntry !== undefined && { multiEntry: op.def.multiEntry }),
      });
      return;
    }
    case "dropIndex": {
      const store = tx.objectStore(op.storeName);
      if (!store.indexNames.contains(op.indexName)) return;
      store.deleteIndex(op.indexName);
      return;
    }
  }
}

/**
 * Marker write input. The `space` field is the contract-space identifier
 * (`"app"` for the single app space; per-extension callers pass their own
 * space id when extensions land on IDB). All other fields mirror
 * {@link ContractMarkerRecord} exactly so the in-DB record has full parity
 * with the framework's canonical marker shape.
 */
export interface MarkerWriteInput {
  readonly space: string;
  readonly storageHash: string;
  readonly profileHash?: string;
  readonly invariants?: readonly string[];
  readonly contractJson?: unknown;
  readonly canonicalVersion?: number | null;
  readonly appTag?: string | null;
  readonly meta?: Record<string, unknown>;
}

/**
 * In-DB marker record shape stored in `_prisma_next_marker`.
 *
 * Identical to {@link ContractMarkerRecord} plus the keying `space` field;
 * `updatedAt` is a `Date` (not an ISO string) because IndexedDB serialises
 * Dates natively via structured-clone.
 */
export type IdbMarkerRecord = ContractMarkerRecord & { readonly space: string };

/**
 * Write one or more contract markers into the `_prisma_next_marker` store
 * using a single `readwrite` transaction. The marker store is created inside
 * the version-change transaction during the migration's first run (see
 * `createMarkerStoreOp`); subsequent runs reuse it.
 *
 * All markers are written in the same transaction so a multi-space apply
 * (app + N extensions) commits or fails as one unit — writing them via N
 * separate transactions would reintroduce the partial-apply window this
 * batching is meant to close (see ADR 010 in `packages/prisma-orm/docs/adrs/`).
 *
 * Keyed by `space` (defaulting to `"app"` at the caller layer) so the
 * storage layout doesn't have to be migrated when IDB eventually grows
 * extension support (see ADR 021 + feedback issue #5).
 */
export function writeMarkers(db: IDBDatabase, inputs: readonly MarkerWriteInput[]): Promise<void> {
  return new Promise((resolve, reject) => {
    if (inputs.length === 0) {
      resolve();
      return;
    }
    if (!db.objectStoreNames.contains(IDB_MARKER_STORE)) {
      // Marker store missing — should never happen because the planner emits
      // its creation as the first op. Non-fatal so the runner can still
      // report DDL success, but worth surfacing as a planner invariant bug.
      console.warn(
        "[prisma-idb] _prisma_next_marker store not found after DDL — this indicates a bug in the migration planner."
      );
      resolve();
      return;
    }
    const tx = db.transaction(IDB_MARKER_STORE, "readwrite");
    const store = tx.objectStore(IDB_MARKER_STORE);
    for (const input of inputs) {
      const record: IdbMarkerRecord = {
        space: input.space,
        storageHash: input.storageHash,
        profileHash: input.profileHash ?? "",
        updatedAt: new Date(),
        invariants: input.invariants ?? [],
        contractJson: input.contractJson ?? null,
        canonicalVersion: input.canonicalVersion ?? null,
        appTag: input.appTag ?? null,
        meta: input.meta ?? {},
      };
      store.put(record);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Convenience wrapper for the common single-marker case. See {@link writeMarkers}. */
export function writeMarker(db: IDBDatabase, input: MarkerWriteInput): Promise<void> {
  return writeMarkers(db, [input]);
}

/**
 * Read the marker record for a given space from the `_prisma_next_marker`
 * store. Returns `null` when the store doesn't exist (fresh DB) or the
 * record is absent.
 */
export function readMarker(db: IDBDatabase, space: string): Promise<IdbMarkerRecord | null> {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(IDB_MARKER_STORE)) {
      resolve(null);
      return;
    }
    const tx = db.transaction(IDB_MARKER_STORE, "readonly");
    const store = tx.objectStore(IDB_MARKER_STORE);
    const req = store.get(space);
    req.onsuccess = () => {
      const result = req.result as IdbMarkerRecord | undefined;
      resolve(result ?? null);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Open `dbName` at `targetVersion`, apply `ops` inside the `upgradeneeded`
 * callback, optionally write one or more contract markers (batched into a
 * single readwrite tx after `onsuccess`), then close the connection.
 *
 * Passing multiple `markers` is how a multi-space apply (app + extensions)
 * gets both DDL atomicity (all ops run in the one `upgradeneeded` transaction
 * this call triggers) and marker-write atomicity (all markers land in the one
 * batched transaction) — see ADR 010.
 *
 * Returns the number of ops applied. Throws on open-request error or DDL
 * application error.
 */
export function openAndUpgrade(input: {
  readonly factory: IDBFactory;
  readonly dbName: string;
  readonly targetVersion: number;
  readonly ops: readonly IdbDdlOp[];
  readonly markers?: readonly MarkerWriteInput[];
  readonly onOperationStart?: (op: IdbDdlOp) => void;
  readonly onOperationComplete?: (op: IdbDdlOp) => void;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = input.factory.open(input.dbName, input.targetVersion);

    // `onblocked` fires when another connection is open at an older version and
    // hasn't closed yet. The open request is still live — it will proceed once
    // the blocking connection closes. Rejecting here would abandon a request
    // that would have succeeded, so we just warn and let it resolve naturally.
    // A stale connection from a previous same-page navigation (e.g. the
    // openAndReadMarker call above us) closes within the same microtask flush;
    // another tab holding an open connection is the only scenario where this
    // would hang indefinitely, so we set a timeout as a last resort.
    let blockedTimer: ReturnType<typeof setTimeout> | undefined;
    const clearBlocked = () => {
      if (blockedTimer !== undefined) clearTimeout(blockedTimer);
    };

    request.onupgradeneeded = (event) => {
      const target = event.target as IDBOpenDBRequest;
      const db = target.result;
      const tx = target.transaction;
      if (tx === null) {
        reject(new Error("IDB: upgradeneeded fired with null version-change transaction"));
        return;
      }
      for (const op of input.ops) {
        input.onOperationStart?.(op);
        applyOneDdlOp(db, tx, op);
        input.onOperationComplete?.(op);
      }
    };

    request.onsuccess = async (event) => {
      clearBlocked();
      const db = (event.target as IDBOpenDBRequest).result;
      try {
        if (input.markers !== undefined && input.markers.length > 0) {
          await writeMarkers(db, input.markers);
        }
      } catch (err) {
        db.close();
        reject(err);
        return;
      }
      db.close();
      resolve(input.ops.length);
    };

    request.onerror = (event) => {
      clearBlocked();
      const err = (event.target as IDBOpenDBRequest).error;
      reject(err ?? new Error("IDB: migration open request failed without an error object"));
    };

    request.onblocked = () => {
      console.warn(
        `[prisma-idb] Migration of "${input.dbName}" is waiting for another connection to close. ` +
          "If you have the app open in another tab, close it to proceed."
      );
      blockedTimer = setTimeout(() => {
        reject(
          new Error(
            `IDB: migration of "${input.dbName}" is blocked — another connection is open at an older ` +
              "version and did not close within 30 s. Close other tabs/connections to this database and retry."
          )
        );
      }, 30_000);
    };
  });
}
