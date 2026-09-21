/**
 * `createAutoMigratingSyncIdbClient` — migrate, then open a sync-tracked
 * client, in one call.
 *
 * `createSyncIdbClient` requires an already-migrated DB (it only assembles
 * the sync-interceptor-wrapped ORM against whatever stores already exist);
 * `createAutoMigratingIdbClient` (client-idb) migrates but hands back a
 * plain, untracked `IdbClient`. Neither does both, so every consumer of
 * this package was hand-rolling "migrate with one client, close it, open a
 * second sync-tracked client" — this composes that, once, here.
 */

import { createAutoMigratingIdbClient } from "@prisma-idb/client-idb/client-auto";
import type { AutoMigrateClientOptions } from "@prisma-idb/client-idb/client-auto";
import type { IdbContract } from "@prisma-idb/client-idb/orm";
import { createSyncIdbClient } from "./sync-client";
import type { SyncIdbClient, SyncIdbClientOptions } from "./sync-client";

export type AutoMigratingSyncIdbClientOptions<TContract extends IdbContract> = AutoMigrateClientOptions<TContract> &
  Pick<SyncIdbClientOptions<TContract>, "trackedModels">;

/**
 * Migrates `dbName` against `contractSpace` (same as
 * `createAutoMigratingIdbClient`), then opens a sync-tracked client against
 * the now-migrated database.
 *
 * @example
 * ```ts
 * import { idbSyncExtension } from '@prisma-idb/sync-extension-idb/control';
 * import { createAutoMigratingSyncIdbClient } from '@prisma-idb/sync-extension-idb/client';
 *
 * const db = await createAutoMigratingSyncIdbClient({
 *   contractSpace,
 *   dbName: 'my-app',
 *   extensions: [idbSyncExtension],
 * });
 *
 * await db.orm.users.create({ id: crypto.randomUUID(), name: 'Alice' });
 * // ↑ atomically: writes `users` record + outbox event in one IDB tx
 * ```
 */
export async function createAutoMigratingSyncIdbClient<TContract extends IdbContract>(
  options: AutoMigratingSyncIdbClientOptions<TContract>
): Promise<SyncIdbClient<TContract>> {
  const migrating = await createAutoMigratingIdbClient(options);
  await migrating.close();

  return createSyncIdbClient<TContract>({
    contract: options.contractSpace.contractJson,
    dbName: options.dbName,
    ...(options.factory !== undefined ? { factory: options.factory } : {}),
    ...(options.trackedModels !== undefined ? { trackedModels: options.trackedModels } : {}),
  });
}
