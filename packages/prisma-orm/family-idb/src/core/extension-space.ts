import type { ContractSpace } from "@prisma/orm-framework/components/control";

/**
 * A named contract space contributed by an IDB extension (e.g. the sync
 * extension). Passed to {@link createAutoMigratingIdbClient} so the browser
 * migration runner can walk each extension's migration graph independently of
 * the application's `'app'` space.
 *
 * Each space writes its own row to the `_prisma_next_marker` store, keyed by
 * `spaceId`, so extension migrations and application migrations version
 * independently.
 *
 * @example
 * ```ts
 * import { idbSyncExtension } from '@prisma-idb/sync-extension-idb/control';
 *
 * const db = await createAutoMigratingIdbClient({
 *   contractSpace,
 *   dbName: 'my-app',
 *   extensions: [idbSyncExtension],
 * });
 * ```
 */
export interface IdbExtensionSpace {
  /** Unique identifier for this contract space — e.g. `'idb-sync'`. */
  readonly spaceId: string;
  /** The extension's bundled contract + migration graph. */
  readonly contractSpace: ContractSpace;
}
