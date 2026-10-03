/**
 * The sync worker's pull cursor: the id of the newest changelog entry it has
 * consumed, handed to `pullHandler` so each pull resumes after it.
 *
 * It only moves forward — changelog ids are UUID v7 strings, so string order
 * is time order — and is optionally persisted through the worker's
 * `getCursor` / `setCursor` options so a reload resumes where the last session
 * stopped.
 */

import type { IdbContract } from "@prisma-idb/client-idb/orm";
import type { SyncWorkerOptions } from "./sync-worker";

/**
 * A forward-only pull cursor with optional persistence. `load`, `advance` and
 * `save` are called by the worker around each pull; see the module comment for
 * the ordering guarantee.
 */
export interface PullCursor {
  /** The last consumed changelog id, or `null` before the first pull. */
  readonly value: string | null;
  /** Reads the persisted cursor on first use; later calls do nothing. A `getCursor` failure leaves it unloaded, so the next call retries. */
  load(): Promise<void>;
  /** Moves the cursor to `changelogId` if that is newer; `null` or an older id is ignored. */
  advance(changelogId: string | null): void;
  /** Writes the cursor through `setCursor` if it moved since the last write. A `setCursor` failure leaves it unwritten, so the next call retries. */
  save(): Promise<void>;
}

/**
 * Creates a cursor that starts unset and is loaded from `getCursor` on first
 * `load()`. Without `getCursor` it starts as `null` and counts as loaded;
 * without `setCursor`, `save()` does nothing.
 */
export function createPullCursor({
  getCursor,
  setCursor,
}: Pick<SyncWorkerOptions<IdbContract>, "getCursor" | "setCursor">): PullCursor {
  let value: string | null = null;
  let persisted: string | null = null;
  let loaded = getCursor === undefined;

  return {
    get value() {
      return value;
    },
    async load() {
      if (loaded) return;
      value = (await getCursor!()) ?? null;
      persisted = value;
      loaded = true;
    },
    advance(changelogId) {
      if (changelogId !== null && (value === null || changelogId > value)) value = changelogId;
    },
    async save() {
      if (!setCursor || value === null || value === persisted) return;
      await setCursor(value);
      persisted = value;
    },
  };
}
