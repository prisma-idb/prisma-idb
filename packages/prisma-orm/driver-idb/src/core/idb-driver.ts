import type { RuntimeDriverInstance } from "@prisma/orm-framework/components/execution";
import { executeIdbPlan } from "./execute";
import { MARKER_STORE_NAME, type IdbMarkerRecord, type IdbPlanBody } from "./plan-body";
import { createTransactionScope, type IdbTransactionScope } from "./transaction-scope";

export class IdbRuntimeDriverInstance implements RuntimeDriverInstance<"idb", "idb"> {
  readonly familyId = "idb" as const;
  readonly targetId = "idb" as const;
  /**
   * The live IDBDatabase connection. Resolves once `upgradeneeded` (if any)
   * completes and the database is ready for use.
   *
   * The adapter awaits this inside `runDriver()` before opening transactions.
   * The Promise is shared — all concurrent callers get the same database object.
   */
  readonly db: Promise<IDBDatabase>;

  constructor(dbName: string, version?: number, factory?: IDBFactory) {
    this.db = openIdbDatabase(dbName, version, factory);
  }

  async close(): Promise<void> {
    (await this.db).close();
  }

  /**
   * Read the contract marker from the `_prisma_next_marker` store.
   *
   * Returns `null` when the marker store does not exist (fresh database
   * that hasn't been initialised yet) or when no marker record is present.
   *
   * Called by `IdbRuntimeImpl` at init time to verify that the live IDB
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

      tx.oncomplete = () => {
        /* resolve already called */
      };
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
    const dbPromise = this.db;
    return {
      [Symbol.asyncIterator]() {
        return (async function* () {
          const db = await dbPromise;
          const rows = await executeIdbPlan(db, plan);
          yield* rows;
        })();
      },
    };
  }
}

/**
 * Opens an IDB database and resolves once it is ready for use.
 *
 * Wraps the IDB event-based open API in a Promise. The `upgradeneeded`
 * handler is a no-op at this level — migrations are orchestrated by
 * `IdbMigrationRunner` (target-idb) which opens the database at a specific
 * version and runs DDL inside the version-change transaction.
 *
 * When version is omitted the IDB spec opens the database at its current version
 * (or version 1 for a brand-new database). This is the correct runtime behaviour
 * per ADR 001: the migration runner owns version bumping; the runtime just connects
 * to whatever schema is already in place.
 */
function openIdbDatabase(dbName: string, version?: number, factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(dbName, version);

    req.onerror = () => {
      reject(req.error);
    };

    req.onblocked = () => {
      reject(new Error(`IDB open blocked for "${dbName}": another connection is open with an older version.`));
    };

    // Migration runner hooks here to create / drop object stores during
    // version-change transactions. At the driver level this is a no-op
    // because the driver does not own schema — migrations are the
    // responsibility of `IdbMigrationRunner` in target-idb.
    req.onupgradeneeded = handleUpgradeNeeded;

    req.onsuccess = () => {
      const db = req.result;
      // Multi-tab safety: when another tab opens this database at a higher
      // version, the IDB spec fires `versionchange` on every other open
      // connection. If we don't close, the new tab's open request hangs
      // indefinitely on `blocked`. Closing here releases the lock; the
      // application layer can listen for `db.onclose` to surface a
      // "please reload" toast if it cares.
      db.onversionchange = () => {
        db.close();
      };
      resolve(db);
    };
  });
}

/**
 * No-op upgrade handler.
 *
 * The driver does not own schema. Object stores and indexes are created
 * by `IdbMigrationRunner` (target-idb) when it opens the database at a
 * bumped version number with a migration plan.
 */
function handleUpgradeNeeded(_event: IDBVersionChangeEvent): void {
  // No-op — DDL is handled by IdbMigrationRunner.
}
