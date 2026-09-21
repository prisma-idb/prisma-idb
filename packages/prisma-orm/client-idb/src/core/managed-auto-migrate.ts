/**
 * `createManagedAutoIdbClient` — `createManagedIdbClient` pre-wired to
 * `createAutoMigratingIdbClient`. Composing those two by hand means writing
 * `dbName` twice, into two independent option bags with nothing tying them
 * together — `createManagedIdbClient`'s `dbName` is used only by `reset()`'s
 * `deleteDatabase` call, so if it ever drifts from the factory's own
 * `dbName` (typo, copy-paste into a second app), `reset()` silently deletes
 * the wrong database (or nothing) while the real one keeps its data. This
 * reads `dbName` (and a `factory` override, if set) once and threads it to
 * both layers, so they can't diverge.
 */

import { createAutoMigratingIdbClient } from "./auto-migrate";
import type { AutoMigrateClientOptions } from "./auto-migrate";
import type { IdbClient } from "./idb-client";
import { createManagedIdbClient } from "./managed-client";
import type { ManagedIdbClient } from "./managed-client";
import type { IdbContract } from "./types";

/**
 * @example
 * ```ts
 * import { createManagedAutoIdbClient } from '@prisma-idb/client-idb/client-auto';
 *
 * const db = createManagedAutoIdbClient({ contractSpace, dbName: 'my-app' });
 *
 * const client = await db.get();
 * // ... on logout:
 * await db.reset();
 * ```
 */
export function createManagedAutoIdbClient<TContract extends IdbContract>(
  options: AutoMigrateClientOptions<TContract>
): ManagedIdbClient<IdbClient<TContract>> {
  return createManagedIdbClient(() => createAutoMigratingIdbClient(options), {
    dbName: options.dbName,
    ...(options.factory !== undefined ? { idbFactory: options.factory } : {}),
  });
}
