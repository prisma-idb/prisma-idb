import type { GetKeyField, SyncServer, SyncServerContract } from "@prisma-idb/sync-server";
import { ormRootFor } from "./orm-root";
import { resolvePullRecord } from "./pull";

export const DEFAULT_PULL_LIMIT = 50;

export interface PullInput {
  /** The authenticated caller's scope (e.g. the session's user id) — never taken from the request. */
  readonly scopeKey: string;
  /**
   * Exclusive cursor: only changelog rows with a greater id are returned.
   * The changelog id is an integer autoincrement; a numeric string (a query
   * param, or the wire's string `changelogId`) is accepted too. `null` /
   * `undefined` pulls from the start.
   */
  readonly lastChangelogId?: number | string | null;
  /** @default DEFAULT_PULL_LIMIT */
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

export type PullOutcome =
  | { readonly ok: true; readonly logs: readonly SqlPullLog[] }
  | { readonly ok: false; readonly reason: "invalid-cursor" };

interface ChangelogRow {
  readonly id: number;
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

/** The changelog id is a Postgres `Int` (int4); a larger cursor would make the query itself fail. */
const MAX_CHANGELOG_ID = 2_147_483_647;

function parseCursor(value: PullInput["lastChangelogId"]): number | null | undefined {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "string" ? (value.trim() === "" ? NaN : Number(value)) : value;
  return Number.isInteger(parsed) && Math.abs(parsed as number) <= MAX_CHANGELOG_ID ? (parsed as number) : undefined;
}

/**
 * Pulls the next page of changes for `scopeKey`: a cheap changelog pre-filter
 * (`scopeKey`, id cursor, oldest first), then a live ownership re-check of
 * every row via `buildPullQueries` and a re-fetch of its current state.
 *
 * Rows come back in changelog-id order; the client's next cursor is the last
 * `changelogId`. An empty page means the client is caught up.
 */
export async function pull(
  db: unknown,
  syncServer: SyncServer,
  contract: SyncServerContract,
  getKeyField: GetKeyField,
  input: PullInput
): Promise<PullOutcome> {
  const { scopeKey, limit = DEFAULT_PULL_LIMIT } = input;
  const cursor = parseCursor(input.lastChangelogId);
  if (cursor === undefined) return { ok: false, reason: "invalid-cursor" };

  const ordered = (ormRootFor(db, "Changelog") as unknown as ChangelogQuery)
    .where({ scopeKey })
    .select("id", "model", "keyPath", "operation")
    .orderBy((row) => row.id.asc());
  const rows = await (cursor !== null ? ordered.cursor({ id: cursor }) : ordered).limit(limit).all();

  const checks = syncServer.buildPullQueries(
    rows.map((row) => ({ changelogId: String(row.id), model: row.model, key: row.keyPath })),
    { scopeKey }
  );

  const logs = await Promise.all(
    checks.map(async ({ changelogId, model, check }, index) => {
      const { keyPath, operation } = rows[index]!;
      const op = operation as SqlPullLog["operation"];
      const record = await resolvePullRecord(db, contract, getKeyField, model, check, keyPath, op);
      return { changelogId, model, operation: op, keyPath, record };
    })
  );

  return { ok: true, logs };
}
