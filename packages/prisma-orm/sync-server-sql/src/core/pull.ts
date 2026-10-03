import type { GetKeyField, SyncServer, SyncServerContract } from "@prisma-idb/sync-server";
import type { LogWithRecordBody } from "@prisma-idb/sync-extension-idb/schemas";
import { parseChangelogCursor, readChangelogPage } from "./changelog";
import { resolvePullRecord } from "./resolve-pull-record";
import { WireValidationError } from "./wire-values";

export const DEFAULT_PULL_LIMIT = 50;

export interface PullInput {
  /** The authenticated caller's scope (e.g. the session's user id) — never taken from the request. */
  readonly scopeKey: string;
  /**
   * Exclusive cursor: only changelog rows with a greater id are returned.
   * The changelog id is a UUID v7 string, so pass back the last
   * `changelogId` the client received, unchanged (a query param works as
   * is). `null` / `undefined` pulls from the start.
   */
  readonly lastChangelogId?: string | null;
  /** Positive, finite integer. Invalid values throw `RangeError`. @default DEFAULT_PULL_LIMIT */
  readonly limit?: number;
}

/**
 * One pulled change — the wire shape `applyPull` (sync-extension-idb)
 * consumes. `record` is the row's *current* state, or `null` when it was
 * deleted or is no longer the caller's, which the client applies as a local
 * delete. Malformed keys instead carry `validationError` and omit `record`.
 */
export type SqlPullLog = Readonly<LogWithRecordBody>;

/** The `reason` union may gain new values in future releases; handle each known reason explicitly. */
export type PullOutcome =
  | { readonly ok: true; readonly logs: readonly SqlPullLog[] }
  | { readonly ok: false; readonly reason: "invalid-cursor" };

/**
 * Pulls the next page of changes for `scopeKey`: a cheap changelog pre-filter
 * (`scopeKey`, id cursor, oldest first), then a live ownership re-check of
 * every row via `buildPullQueries` and a re-fetch of its current state.
 *
 * Rows come back in changelog-id order; the client's next cursor is the last
 * `changelogId`. An empty page means the client is caught up.
 * @throws {RangeError} If `limit` is not a positive, finite integer.
 */
export async function pull(
  db: unknown,
  syncServer: SyncServer,
  contract: SyncServerContract,
  getKeyField: GetKeyField,
  input: PullInput
): Promise<PullOutcome> {
  const { scopeKey, limit = DEFAULT_PULL_LIMIT } = input;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError("limit must be a positive, finite integer");
  }
  const cursor = parseChangelogCursor(input.lastChangelogId);
  if (cursor === undefined) return { ok: false, reason: "invalid-cursor" };

  const rows = await readChangelogPage(db, scopeKey, cursor, limit);

  const checksById = new Map(
    syncServer
      .buildPullQueries(
        rows.map((row) => ({ changelogId: row.id, model: row.model, key: row.keyPath })),
        { scopeKey }
      )
      .map((result) => [result.changelogId, result])
  );

  const logs = await Promise.all(
    rows.map(async ({ id: changelogId, keyPath, operation }): Promise<SqlPullLog> => {
      const { model, check } = checksById.get(changelogId)!;
      const op = operation as SqlPullLog["operation"];
      let record: Record<string, unknown> | null;
      try {
        record = await resolvePullRecord(db, contract, getKeyField, model, check, keyPath, op);
      } catch (error) {
        if (!(error instanceof WireValidationError) || error.code !== "KEYPATH_VALIDATION_FAILURE") throw error;
        // Preserve identity/cursor, but never signal a revoked-ownership delete.
        return { changelogId, model, operation: op, keyPath, validationError: error.code };
      }
      return { changelogId, model, operation: op, keyPath, record };
    })
  );

  return { ok: true, logs };
}
