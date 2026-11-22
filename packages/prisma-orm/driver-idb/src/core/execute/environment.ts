/**
 * The IndexedDB implementation a database was opened with. A driver given its
 * own factory, such as fake-indexeddb's in a realm without a global
 * `indexedDB`, must compare keys and build key ranges with that same
 * implementation, not with whatever the global scope holds.
 */
export interface IdbEnvironment {
  readonly cmp: (a: unknown, b: unknown) => number;
  /** `undefined` when neither the driver options nor the global scope provide one. */
  readonly keyRange: typeof IDBKeyRange | undefined;
}

const environments = new WeakMap<IDBDatabase, IdbEnvironment>();

/** Records the implementation `db` was opened with, for the ops that run on it. */
export function registerEnvironment(db: IDBDatabase, environment: IdbEnvironment): void {
  environments.set(db, environment);
}

/** The implementation the store's database was opened with, or the global one. */
export function environmentOf(store: IDBObjectStore): IdbEnvironment {
  return (
    // A store from an open transaction always has one; the guard keeps stand-in stores working.
    (store.transaction?.db === undefined ? undefined : environments.get(store.transaction.db)) ?? {
      cmp: (a, b) => indexedDB.cmp(a, b),
      keyRange: globalThis.IDBKeyRange,
    }
  );
}
