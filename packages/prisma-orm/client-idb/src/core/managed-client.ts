/**
 * `createManagedIdbClient` — a singleton, race-safe wrapper around any IDB
 * client factory (`createIdbClient`, `createAutoMigratingIdbClient`, or a
 * sync-extension factory like `createAutoMigratingSyncIdbClient` — anything
 * returning a `close(): Promise<void>`-shaped client).
 *
 * Every consumer of this package that wants a module-level singleton client
 * plus a "wipe local data" reset (e.g. on logout) needs the same race-safety:
 * `reset()` must never call `indexedDB.deleteDatabase` while a `get()` open
 * is still in flight, since a still-opening connection would block (or worse,
 * leave a stale handle once that open resolves after the delete). This was
 * previously hand-rolled per app with diverging correctness; see ADR-less
 * discussion in the kanban example's `db.ts` history.
 */

export interface ManagedIdbClientOptions {
  /** IDB database name — passed to `indexedDB.deleteDatabase` on `reset()`. */
  readonly dbName: string;
  /** IDB factory override — primarily for tests. Defaults to `indexedDB`. */
  readonly idbFactory?: IDBFactory;
}

export interface ManagedIdbClient<TClient> {
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
 *
 * @example
 * ```ts
 * import { createManagedIdbClient } from '@prisma-idb/client-idb/client';
 *
 * const db = createManagedIdbClient(
 *   () => createAutoMigratingIdbClient({ contractSpace, dbName: 'my-app' }),
 *   { dbName: 'my-app' }
 * );
 *
 * const client = await db.get();
 * // ... on logout:
 * await db.reset();
 * ```
 */
export function createManagedIdbClient<TClient extends { close(): Promise<void> }>(
  open: () => Promise<TClient>,
  options: ManagedIdbClientOptions
): ManagedIdbClient<TClient> {
  const { dbName, idbFactory = indexedDB } = options;

  let client: TClient | null = null;
  let clientPromise: Promise<TClient> | null = null;
  // Gate between get() and reset() — set synchronously (no `await` before
  // either reads/writes it) so the two never interleave: see module doc comment.
  let resetPromise: Promise<void> | null = null;

  async function get(): Promise<TClient> {
    if (resetPromise) await resetPromise;
    if (client) return client;
    clientPromise ??= open().catch((err: unknown) => {
      // Clear on rejection so a later get() call retries instead of
      // re-awaiting the same rejected promise forever.
      clientPromise = null;
      throw err;
    });

    const fresh = await clientPromise;
    client = fresh;
    return fresh;
  }

  async function close(): Promise<void> {
    if (!client) return;
    await client.close();
    client = null;
    clientPromise = null;
  }

  async function reset(): Promise<void> {
    if (resetPromise) return resetPromise;
    resetPromise = (async () => {
      if (clientPromise) await clientPromise.catch(() => {});
      await close();
      await new Promise<void>((resolve, reject) => {
        const req = idbFactory.deleteDatabase(dbName);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error as Error);
        // Deliberately no-op: `onblocked` only means the request is waiting
        // on another open connection, not that it failed — `onsuccess` (or
        // `onerror`) still fires later once that connection closes. Settling
        // here either way would misreport the outcome; see the `reset()`
        // doc comment above.
        req.onblocked = () => {};
      });
    })();
    try {
      await resetPromise;
    } finally {
      resetPromise = null;
    }
  }

  return { get, close, reset };
}
