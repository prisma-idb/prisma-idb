import type { RuntimeDriverInstance } from "@prisma/orm-framework/components/execution";
import { executeIdbPlan } from "./execute";
import { registerEnvironment } from "./execute/environment";
import { MARKER_STORE_NAME, type IdbMarkerRecord, type IdbPlanBody } from "./plan-body";
import { createTransactionScope, type IdbTransactionScope } from "./transaction-scope";

/** The connection a driver instance holds. Kept off the class so its type stays structural. */
interface ConnectionState {
  db: Promise<IDBDatabase> | undefined;
  generation: number;
  closed: boolean;
  readonly open: () => Promise<IDBDatabase>;
}

const connections = new WeakMap<IdbRuntimeDriverInstance, ConnectionState>();

/** Own the database connection and execute driver plans after it opens. */
export class IdbRuntimeDriverInstance implements RuntimeDriverInstance<"idb", "idb"> {
  readonly familyId = "idb" as const;
  readonly targetId = "idb" as const;

  constructor(dbName: string, version?: number, factory?: IDBFactory, keyRange?: typeof IDBKeyRange) {
    const state: ConnectionState = {
      db: undefined,
      generation: 0,
      closed: false,
      open: () => {
        const opened = openIdbDatabase(dbName, version, factory, keyRange, () => {
          // Only forget the connection that closed, not one opened after it.
          if (state.db === opened && !state.closed) {
            state.db = undefined;
            state.generation++;
          }
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
   * the upgrade can run, and the next read of `db` opens a new connection at
   * the upgraded version.
   */
  get db(): Promise<IDBDatabase> {
    const state = connections.get(this)!;
    state.db ??= state.open();
    return state.db;
  }

  /**
   * Changes each time a newer version closes this driver's connection. The
   * runtime compares it to decide when to check the contract marker again,
   * since the upgrade may have moved the database to another contract.
   */
  get connectionGeneration(): number {
    return connections.get(this)!.generation;
  }

  async close(): Promise<void> {
    const state = connections.get(this)!;
    state.closed = true;
    if (state.db !== undefined) (await state.db).close();
  }

  /**
   * Read the contract marker from the `_prisma_next_marker` store.
   *
   * Reads the `"app"` marker, the one for the contract the client was built from.
   * Extension spaces, such as the sync stores, keep their own marker rows, and
   * the runtime has no contract for them to compare against, so they are not read.
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
  onVersionChangeClose: () => void
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(dbName, version);

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
        db.close();
        if (event.newVersion !== null) onVersionChangeClose();
      };
      resolve(db);
    };
  });
}
