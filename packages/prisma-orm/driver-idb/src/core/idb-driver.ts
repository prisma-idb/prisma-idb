import type { RuntimeDriverInstance } from "@prisma/orm-framework/components/execution";
import { executeIdbPlan } from "./execute";
import { registerEnvironment } from "./execute/environment";
import { MARKER_STORE_NAME, type IdbMarkerRecord, type IdbPlanBody } from "./plan-body";
import { createTransactionScope, type IdbTransactionScope } from "./transaction-scope";

/** The connection a driver instance holds. Kept off the class so its type stays structural. */
interface ConnectionState {
  db: Promise<IDBDatabase> | undefined;
  closed: boolean;
  markers: Promise<ReadonlyMap<string, string> | null> | undefined;
  readonly open: (markers?: ConnectionState["markers"]) => Promise<IDBDatabase>;
}

const connections = new WeakMap<IdbRuntimeDriverInstance, ConnectionState>();

/** Own the database connection and execute driver plans after it opens. */
export class IdbRuntimeDriverInstance implements RuntimeDriverInstance<"idb", "idb"> {
  readonly familyId = "idb" as const;
  readonly targetId = "idb" as const;

  constructor(dbName: string, version?: number, factory?: IDBFactory, keyRange?: typeof IDBKeyRange) {
    const state: ConnectionState = {
      db: undefined,
      closed: false,
      markers: undefined,
      open: (markers) => {
        let verified = false;
        const opened = openIdbDatabase(
          dbName,
          markers === undefined ? version : undefined,
          factory,
          keyRange,
          markers !== undefined,
          (db, newVersion) => {
            if (state.db !== opened || state.closed || newVersion === null) return;
            // Start the marker read before closing. This transaction can finish
            // against the old schema while the waiting upgrade is still blocked.
            if (verified) state.markers = readContractHashes(db);
            state.db = undefined;
          }
        ).then(async (db) => {
          if (markers !== undefined) {
            const [before, after] = await Promise.all([markers, readContractHashes(db)]);
            if (
              !before ||
              !after ||
              before.get("app") !== after.get("app") ||
              [...before].some(([space, hash]) => after.get(space) !== hash)
            ) {
              db.close();
              throw new Error(`IDB: "${dbName}" contract markers changed. Create a client with the current contract.`);
            }
          }
          verified = true;
          return db;
        });
        return opened;
      },
    };
    state.db = state.open();
    connections.set(this, state);
  }

  /**
   * The live IDBDatabase connection. Resolves once the database is open and
   * ready for use.
   *
   * `execute()` and `transaction()` await this before opening a transaction.
   * The Promise is shared, so concurrent callers get the same database object.
   * When another connection upgrades the database, this connection closes so
   * the upgrade can run. The next read may reconnect if the existing contract
   * spaces still have their previous hashes.
   */
  get db(): Promise<IDBDatabase> {
    const state = connections.get(this)!;
    if (state.closed) return Promise.reject(new Error("IDB: driver is closed"));
    state.db ??= state.open(state.markers);
    return state.db;
  }

  async close(): Promise<void> {
    const state = connections.get(this)!;
    state.closed = true;
    const db = await state.db?.catch(() => undefined);
    db?.close();
  }

  /**
   * Read the contract marker from the `_prisma_next_marker` store.
   *
   * Returns `null` when the marker store does not exist (fresh database
   * that hasn't been initialised yet) or when no marker record is present.
   *
   * Called by `IdbRuntimeImpl.verifyMarker()` to check that the live IDB
   * schema matches the contract.
   */
  async readMarker(): Promise<IdbMarkerRecord | null> {
    const db = await this.db;
    if (!db.objectStoreNames.contains(MARKER_STORE_NAME)) {
      return null;
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MARKER_STORE_NAME, "readonly");
      const store = tx.objectStore(MARKER_STORE_NAME);

      const appReq = store.get("app");
      appReq.onsuccess = () => {
        const result = appReq.result as IdbMarkerRecord | undefined;
        resolve(result ?? null);
      };
      appReq.onerror = () => reject(appReq.error);

      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Open a multi-store readwrite transaction and wrap it in an
   * {@link IdbTransactionScope}.
   *
   * Awaits the live `IDBDatabase` connection before opening the transaction.
   * Used by `withMutationScope()` in `client-idb` to run cross-store writes
   * atomically.
   */
  async transaction(storeNames: string[], mode: IDBTransactionMode = "readwrite"): Promise<IdbTransactionScope> {
    const db = await this.db;
    return createTransactionScope(db, storeNames, mode);
  }

  /**
   * Execute an IDB plan body and yield rows as an async iterable.
   *
   * Opens a new IDB transaction for each call, collects all rows inside the
   * transaction (collect-then-yield; see execute/index.ts for rationale),
   * and yields them after the transaction commits.
   *
   * Called by `IdbRuntimeImpl.runDriver()` in `@prisma-idb/runtime-idb`.
   */
  execute(plan: IdbPlanBody): AsyncIterable<Record<string, unknown>> {
    const connection = () => this.db;
    return {
      /** Wait for commit before exposing materialized rows to the runtime. */
      [Symbol.asyncIterator]() {
        return (async function* () {
          const db = await connection();
          const rows = await executeIdbPlan(db, plan);
          yield* rows;
        })();
      },
    };
  }
}

/** Read the markers from one connection without keeping the version change blocked. */
function readContractHashes(db: IDBDatabase): Promise<ReadonlyMap<string, string> | null> {
  if (!db.objectStoreNames.contains(MARKER_STORE_NAME)) return Promise.resolve(new Map());
  return new Promise((resolve) => {
    try {
      const request = db.transaction(MARKER_STORE_NAME).objectStore(MARKER_STORE_NAME).getAll();
      request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const hashes = new Map<string, string>();
        for (const marker of request.result as IdbMarkerRecord[]) {
          if (typeof marker?.space !== "string" || typeof marker.storageHash !== "string") {
            resolve(null);
            return;
          }
          hashes.set(marker.space, marker.storageHash);
        }
        resolve(hashes);
      };
    } catch {
      resolve(null);
    }
  });
}

/**
 * Opens an IDB database and resolves once it is ready for use.
 *
 * Wraps the IDB event-based open API in a Promise. There is no `upgradeneeded`
 * handler: the driver does not own schema. Migrations are applied by
 * `openAndUpgrade` (target-idb), which opens the database at a specific
 * version and runs DDL inside the version-change transaction.
 *
 * When version is omitted the IDB spec opens the database at its current version
 * (or version 1 for a brand-new database). This is the correct runtime behaviour
 * per ADR 001: the migration runner owns version bumping; the runtime just connects
 * to whatever schema is already in place.
 */
function openIdbDatabase(
  dbName: string,
  version: number | undefined,
  factory: IDBFactory = indexedDB,
  keyRange: typeof IDBKeyRange | undefined = globalThis.IDBKeyRange,
  reopening: boolean,
  onVersionChange: (db: IDBDatabase, newVersion: number | null) => void
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(dbName, version);

    if (reopening) {
      req.onupgradeneeded = () => {
        req.transaction!.abort();
        reject(new Error(`IDB: "${dbName}" was deleted while the driver was disconnected.`));
      };
    }

    req.onerror = () => {
      reject(req.error);
    };

    req.onblocked = () => {
      reject(new Error(`IDB open blocked for "${dbName}": another connection is open with an older version.`));
    };

    req.onsuccess = () => {
      const db = req.result;
      // Ops on this connection compare keys and build ranges with the factory it came from.
      registerEnvironment(db, { cmp: (a, b) => factory.cmp(a, b), keyRange });
      // Multi-tab safety: when another connection, in this tab or another one,
      // opens this database at a higher version, the IDB spec fires
      // `versionchange` on every other open connection. If we don't close, that
      // open request waits on `blocked` until we do. Closing here releases the
      // lock. After an upgrade, the driver opens a new connection on its next
      // use. After a deletion (`newVersion` is null) it doesn't, so it never
      // recreates an empty database.
      db.onversionchange = (event) => {
        onVersionChange(db, event.newVersion);
        db.close();
      };
      resolve(db);
    };
  });
}
