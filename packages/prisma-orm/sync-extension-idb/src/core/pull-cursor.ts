/**
 * The sync worker's pull cursor: the id of the newest changelog entry it has
 * consumed, handed to `pullHandler` so each pull resumes after it.
 *
 * It only moves forward — changelog ids are UUID v7 strings, so string order
 * is time order — and is persisted in the sync database so a reload resumes
 * where the last session stopped. Deleting the database also deletes the cursor.
 */

import type { IdbContract } from "@prisma-idb/client-idb/orm";
import type { SyncIdbClient } from "./sync-client";
import { getRecord, putRecord } from "./raw-store";

/** Database-wide sync state, cleared with application data by reset(). */
export const SYNC_META_STORE = "_idb_sync_meta";
const PULL_CURSOR_ID = "pull-cursor";

/**
 * A forward-only pull cursor persisted in IndexedDB. `load`, `advance` and
 * `save` are called by the worker around each pull; see the module comment for
 * the ordering guarantee.
 */
export interface PullCursor {
  /** The last consumed changelog id, or `null` before the first pull. */
  readonly value: string | null;
  /** Reads the persisted cursor on first use; later calls do nothing. A read failure leaves it unloaded, so the next call retries. */
  load(): Promise<void>;
  /** Moves the cursor to `changelogId` if that is newer; `null` or an older id is ignored. */
  advance(changelogId: string | null): void;
  /** Writes the cursor if it moved since the last write. A write failure leaves it unwritten, so the next call retries. */
  save(): Promise<void>;
}

/** Loads and saves the cursor through the same database as the synced records. */
export function createPullCursor(client: Pick<SyncIdbClient<IdbContract>, "withTransaction">): PullCursor {
  let value: string | null = null;
  let persisted: string | null = null;
  let loaded = false;

  return {
    get value() {
      return value;
    },
    async load() {
      if (loaded) return;
      const record = await client.withTransaction([SYNC_META_STORE], (scope) =>
        getRecord<{ id: string; value: string }>(scope, SYNC_META_STORE, PULL_CURSOR_ID)
      );
      value = record?.value ?? null;
      persisted = value;
      loaded = true;
    },
    advance(changelogId) {
      if (changelogId !== null && (value === null || changelogId > value)) value = changelogId;
    },
    async save() {
      if (value === null || value === persisted) return;
      await client.withTransaction([SYNC_META_STORE], (scope) =>
        putRecord(scope, SYNC_META_STORE, { id: PULL_CURSOR_ID, value })
      );
      persisted = value;
    },
  };
}
