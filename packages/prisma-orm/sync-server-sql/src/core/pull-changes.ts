import type { GetKeyField, SyncServer, SyncServerContract } from "@prisma-idb/sync-server";
import { ormRootFor } from "./orm-root";
import { resolvePullRecord } from "./pull";

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
 * delete.
 */
export interface SqlPullLog {
  readonly changelogId: string;
  readonly model: string;
  readonly operation: "create" | "update" | "delete";
  readonly keyPath: unknown;
  readonly record: Record<string, unknown> | null;
}

/** The `reason` union may gain new values in future releases; handle each known reason explicitly. */
export type PullOutcome =
  | { readonly ok: true; readonly logs: readonly SqlPullLog[] }
  | { readonly ok: false; readonly reason: "invalid-cursor" };

interface ChangelogRow {
  readonly id: string;
  readonly model: string;
  readonly keyPath: unknown;
  readonly operation: string;
}

interface ChangelogQuery {
  where(clause: Record<string, unknown>): ChangelogQuery;
  select(...fields: string[]): ChangelogQuery;
  orderBy(fn: (row: { id: { asc(): unknown } }) => unknown): ChangelogQuery;
  cursor(cursor: Record<string, unknown>): ChangelogQuery;
  limit(n: number): ChangelogQuery;
  all(): Promise<ChangelogRow[]>;
}

const CHANGELOG_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A malformed cursor must be a clean `invalid-cursor`, not a query error.
 * Ids are generated lowercase and compared as text, so the cursor is
 * lowercased to match.
 */
function parseCursor(value: PullInput["lastChangelogId"]): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && CHANGELOG_ID_PATTERN.test(value) ? value.toLowerCase() : undefined;
}

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
  const cursor = parseCursor(input.lastChangelogId);
  if (cursor === undefined) return { ok: false, reason: "invalid-cursor" };

  const ordered = (ormRootFor(db, "Changelog") as unknown as ChangelogQuery)
    .where({ scopeKey })
    .select("id", "model", "keyPath", "operation")
    .orderBy((row) => row.id.asc());
  const rows = await (cursor !== null ? ordered.cursor({ id: cursor }) : ordered).limit(limit).all();

  const checksById = new Map(
    syncServer
      .buildPullQueries(
        rows.map((row) => ({ changelogId: row.id, model: row.model, key: row.keyPath })),
        { scopeKey }
      )
      .map((result) => [result.changelogId, result])
  );

  const logs = await Promise.all(
    rows.map(async ({ id: changelogId, keyPath, operation }) => {
      const { model, check } = checksById.get(changelogId)!;
      const op = operation as SqlPullLog["operation"];
      const record = await resolvePullRecord(db, contract, getKeyField, model, check, keyPath, op);
      return { changelogId, model, operation: op, keyPath, record };
    })
  );

  return { ok: true, logs };
}
