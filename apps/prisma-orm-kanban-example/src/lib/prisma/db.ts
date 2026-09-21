import { idbSyncExtension } from "@prisma-idb/sync-extension-idb/control";
import { createManagedAutoSyncIdbClient } from "@prisma-idb/sync-extension-idb/client";
import type { SyncIdbClient } from "@prisma-idb/sync-extension-idb/client";
import type { Contract } from "./contract";
import { contractSpace } from "./contract-space.generated";

const DB_NAME = "prisma-idb-kanban-example";

type DbClient = SyncIdbClient<Contract>;

const managedDb = createManagedAutoSyncIdbClient<Contract>({
  contractSpace,
  dbName: DB_NAME,
  extensions: [idbSyncExtension],
});

/** Migrate + open a sync-tracked client in one call — `db.orm.*` mutations atomically write outbox events alongside the model write. */
export const getDb = (): Promise<DbClient> => managedDb.get();

export const closeDb = (): Promise<void> => managedDb.close();

/**
 * Closes and wipes the local database — used on logout so a different
 * account signing in on the same browser never sees a previous session's
 * boards/todos.
 */
export const resetDb = (): Promise<void> => managedDb.reset();
