/**
 * `createManagedIdbClient` — a singleton, race-safe wrapper around any IDB
 * client factory (`createIdbClient`, `createAutoMigratingIdbClient`, or a
 * sync-extension factory like `createAutoMigratingSyncIdbClient` — anything
 * returning a client with `enums` and `close(): Promise<void>`).
 *
 * Every consumer of this package that wants a module-level singleton client
 * plus a "wipe local data" reset (e.g. on logout) needs the same race-safety:
 * `reset()` must never call `indexedDB.deleteDatabase` while a `get()` open
 * is still in flight, since a still-opening connection would block (or worse,
 * leave a stale handle once that open resolves after the delete). This was
 * previously hand-rolled per app with diverging correctness; see ADR-less
 * discussion in the kanban example's `db.ts` history.
 */

/** Configures the enum accessors and database lifecycle for a managed client. */
export interface ManagedIdbClientOptions<TEnums = unknown> {
  /** Enum accessors derived from the same contract used by the client factory. */
  readonly enums: TEnums;
  /** IDB database name — passed to `indexedDB.deleteDatabase` on `reset()`. */
  readonly dbName: string;
  /** IDB factory override — primarily for tests. Defaults to `indexedDB` when opening or resetting the database. */
  readonly idbFactory?: IDBFactory;
}

/** A shared client handle with coordinated opening and database reset. */
export interface ManagedIdbClient<TClient extends { readonly enums: unknown }> {
  /** Contract-derived enum accessors, available without opening IndexedDB. */
  readonly enums: TClient["enums"];
  /** Opens the client on first call and caches it; concurrent calls share one open. */
  get(): Promise<TClient>;
  /** Closes the cached client, if any. Safe to call when nothing is open. */
  close(): Promise<void>;
  /**
   * Closes and deletes the database — waits out any `get()` open already in
   * flight first. `onblocked` (another tab still has the DB open) is NOT
   * terminal — per spec, the delete request stays pending, and still fires
   * `onsuccess` once every blocking connection closes — so this promise
   * stays pending through it too, settling only once `deleteDatabase`
   * actually reaches `onsuccess` or `onerror`. Neither resolving early
   * (claims success before the old data is actually gone) nor rejecting
   * early (reports failure on a delete that may still succeed) would be
   * accurate.
   */
  reset(): Promise<void>;
}

/**
 * Wraps `open` (a client factory, e.g. `() => createAutoMigratingIdbClient({...})`)
 * with a module-scoped singleton: `get()` opens once and caches the result,
 * `close()` releases it, `reset()` closes and wipes the underlying database.
 * Creating the wrapper does not access IndexedDB, so it is safe during server rendering.
 *
 * @example
 * ```ts
 * import { createManagedIdbClient } from '@prisma-idb/client-idb/client';
 * import { createIdbEnums } from '@prisma-idb/client-idb/internal';
 *
 * const db = createManagedIdbClient(
 *   () => createAutoMigratingIdbClient({ contractSpace, dbName: 'my-app' }),
 *   { enums: createIdbEnums(contractSpace.contractJson), dbName: 'my-app' }
 * );
 *
 * const client = await db.get();
 * // ... on logout:
 * await db.reset();
 * ```
 */
export function createManagedIdbClient<TClient extends { readonly enums: unknown; close(): Promise<void> }>(
  open: () => Promise<TClient>,
  options: ManagedIdbClientOptions<TClient["enums"]>
): ManagedIdbClient<TClient> {
  const { dbName, idbFactory } = options;

  let client: TClient | null = null;
  let clientPromise: Promise<TClient> | null = null;
  let capturedFactory: IDBFactory | undefined;
  // Gate between get() and reset() — set synchronously (no `await` before
  // either reads/writes it) so the two never interleave: see module doc comment.
  let resetPromise: Promise<void> | null = null;

  /** Wait for a reset before sharing or opening the singleton client. */
  async function get(): Promise<TClient> {
    if (resetPromise) await resetPromise;
    if (client) return client;
    if (!clientPromise) {
      capturedFactory = idbFactory ?? indexedDB;
      clientPromise = open().catch((err: unknown) => {
        // Clear on rejection so a later get() call retries instead of
        // re-awaiting the same rejected promise forever.
        clientPromise = null;
        throw err;
      });
    }

    const fresh = await clientPromise;
    client = fresh;
    return fresh;
  }

  /** Release the cached connection so a later get can open it again. */
  async function close(): Promise<void> {
    if (!client) return;
    await client.close();
    client = null;
    clientPromise = null;
  }

  /** Wait for an in-flight open, then close and delete the database before allowing new opens. */
  async function reset(): Promise<void> {
    if (resetPromise) return resetPromise;
    resetPromise = (async () => {
      if (clientPromise) await clientPromise.catch(() => {});
      await close();
      await new Promise<void>((resolve, reject) => {
        const req = (capturedFactory ?? idbFactory ?? indexedDB).deleteDatabase(dbName);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error as Error);
        // Deliberately no-op: `onblocked` only means the request is waiting
        // on another open connection, not that it failed — `onsuccess` (or
        // `onerror`) still fires later once that connection closes. Settling
        // here either way would misreport the outcome; see the `reset()`
        // doc comment above.
        req.onblocked = () => {};
      });
      capturedFactory = undefined;
    })();
    try {
      await resetPromise;
    } finally {
      resetPromise = null;
    }
  }

  return { enums: options.enums, get, close, reset };
}
