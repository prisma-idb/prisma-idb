import type { ContractMarkerRecord } from "@prisma/orm-framework/contract/types";
import type { IdbKeyPath } from "./idb-contract-types";
import { IDB_MARKER_STORE, type IdbDdlOp } from "./migration-factories";

/**
 * `lib.dom.d.ts` types `IDBObjectStoreParameters.keyPath` / `createIndex`'s
 * key-path parameter as `string | string[]` — a *mutable* array, whereas
 * {@link IdbKeyPath} is `string | readonly string[]`. A readonly array isn't
 * structurally assignable to a mutable one, so this materializes a fresh
 * mutable copy for the DOM call; the native engine only ever reads it.
 */
function toDomKeyPath(keyPath: IdbKeyPath): string | string[] {
  return typeof keyPath === "string" ? keyPath : [...keyPath];
}

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
 * **Idempotency.** Each op checks whether its store or index already exists
 * (or is already gone) and does nothing if so. IndexedDB itself has no such
 * tolerance: `createObjectStore` and `createIndex` throw `ConstraintError` on
 * an existing target, which would abort the whole upgrade. Migrations and
 * their markers now commit together, so a normal run never replays an op.
 * The guards cover databases whose schema is ahead of their marker anyway,
 * for example ones left by an older build that wrote the marker in a
 * separate transaction and was closed in between.
 */
export function applyOneDdlOp(db: IDBDatabase, tx: IDBTransaction, op: IdbDdlOp): void {
  switch (op.kind) {
    case "createObjectStore": {
      if (db.objectStoreNames.contains(op.storeName)) return;
      db.createObjectStore(op.storeName, {
        keyPath: toDomKeyPath(op.def.keyPath),
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
      store.createIndex(op.indexName, toDomKeyPath(op.def.keyPath), {
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

function toMarkerRecord(input: MarkerWriteInput): IdbMarkerRecord {
  return {
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
}

/**
 * Write contract markers into `_prisma_next_marker` in one `readwrite`
 * transaction, so they all commit or none do.
 *
 * `openAndUpgrade` doesn't use this: it writes markers inside the upgrade
 * itself. This is for callers that need to write a marker outside a
 * migration.
 */
export function writeMarkers(db: IDBDatabase, inputs: readonly MarkerWriteInput[]): Promise<void> {
  return new Promise((resolve, reject) => {
    if (inputs.length === 0) {
      resolve();
      return;
    }
    if (!db.objectStoreNames.contains(IDB_MARKER_STORE)) {
      reject(new Error(`IDB: cannot write markers, the "${IDB_MARKER_STORE}" store does not exist.`));
      return;
    }
    const tx = db.transaction(IDB_MARKER_STORE, "readwrite");
    const store = tx.objectStore(IDB_MARKER_STORE);
    for (const input of inputs) {
      store.put(toMarkerRecord(input));
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
 * Open `dbName` at `targetVersion` and, inside `upgradeneeded`, apply `ops`
 * and then write `markers`. Then close the connection.
 *
 * Schema changes and markers share the one version-change transaction, so
 * they commit together or not at all. The database can never end up with a
 * new schema and an old marker. If anything throws, including a missing
 * marker store, IndexedDB rolls the whole upgrade back and the database
 * stays at its previous version.
 *
 * Markers are written after every op, so a marker store created by one of
 * the ops (on a fresh database) already exists when they're written.
 *
 * Returns the number of ops applied.
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

    // An error inside `upgradeneeded` aborts the upgrade, but the open request
    // then fails with a generic `AbortError`. Keep the original error so the
    // caller sees what actually went wrong: either one thrown while applying
    // the ops, or the transaction's own error when a request fails later,
    // such as a marker `put` hitting a quota or constraint error.
    let upgradeError: unknown;

    request.onupgradeneeded = (event) => {
      const target = event.target as IDBOpenDBRequest;
      const db = target.result;
      const tx = target.transaction;
      if (tx === null) {
        reject(new Error("IDB: upgradeneeded fired with null version-change transaction"));
        return;
      }
      tx.addEventListener("abort", () => {
        upgradeError ??= tx.error ?? undefined;
      });
      try {
        for (const op of input.ops) {
          input.onOperationStart?.(op);
          applyOneDdlOp(db, tx, op);
          input.onOperationComplete?.(op);
        }
        const markers = input.markers ?? [];
        if (markers.length === 0) return;
        if (!db.objectStoreNames.contains(IDB_MARKER_STORE)) {
          throw new Error(
            `IDB: the "${IDB_MARKER_STORE}" store does not exist after applying the migration, ` +
              "so its marker can't be written. The migration chain should create this store in its first migration."
          );
        }
        const markerStore = tx.objectStore(IDB_MARKER_STORE);
        for (const marker of markers) {
          markerStore.put(toMarkerRecord(marker));
        }
      } catch (err) {
        upgradeError = err;
        // Rolls back the schema changes and any markers already queued.
        tx.abort();
      }
    };

    request.onsuccess = (event) => {
      clearBlocked();
      const db = (event.target as IDBOpenDBRequest).result;
      db.close();
      resolve(input.ops.length);
    };

    request.onerror = (event) => {
      clearBlocked();
      const err = upgradeError ?? (event.target as IDBOpenDBRequest).error;
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
