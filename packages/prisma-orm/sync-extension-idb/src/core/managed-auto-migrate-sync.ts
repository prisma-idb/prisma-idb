/**
 * `createManagedAutoSyncIdbClient` — `createManagedIdbClient` pre-wired to
 * `createAutoMigratingSyncIdbClient`. Same rationale as client-idb's
 * `createManagedAutoIdbClient`: composing the two by hand means writing
 * `dbName` twice into option bags with nothing tying them together, so a
 * drift between them makes `reset()` silently delete the wrong database.
 * This reads `dbName` (and a `factory` override, if set) once and threads
 * it to both layers.
 */

import { createManagedIdbClient } from "@prisma-idb/client-idb/client";
import type { ManagedIdbClient } from "@prisma-idb/client-idb/client";
import type { IdbContract } from "@prisma-idb/client-idb/orm";
import { createAutoMigratingSyncIdbClient } from "./auto-migrate-sync";
import type { AutoMigratingSyncIdbClientOptions } from "./auto-migrate-sync";
import type { SyncIdbClient } from "./sync-client";

/**
 * @example
 * ```ts
 * import { idbSyncExtension } from '@prisma-idb/sync-extension-idb/control';
 * import { createManagedAutoSyncIdbClient } from '@prisma-idb/sync-extension-idb/client';
 *
 * const db = createManagedAutoSyncIdbClient({
 *   contractSpace,
 *   dbName: 'my-app',
 *   extensions: [idbSyncExtension],
 * });
 *
 * const client = await db.get();
 * // ... on logout:
 * await db.reset();
 * ```
 */
export function createManagedAutoSyncIdbClient<TContract extends IdbContract>(
  options: AutoMigratingSyncIdbClientOptions<TContract>
): ManagedIdbClient<SyncIdbClient<TContract>> {
  return createManagedIdbClient(() => createAutoMigratingSyncIdbClient(options), {
    dbName: options.dbName,
    ...(options.factory !== undefined ? { idbFactory: options.factory } : {}),
  });
}
