/**
 * Reads and writes of the synthetic `Changelog` table.
 *
 * Writer and reader share one invariant: within a scope, rows become visible
 * in id order. `appendChangelogRow` establishes it (the scope lock of
 * `scope-lock.ts` plus the id derivation of `changelog-id.ts`), and
 * `readChangelogPage`'s exclusive id cursor depends on it.
 */

import type { SyncServerContract } from "@prisma-idb/sync-server";
import { ormRootFor } from "./orm-root";
import { lockScope } from "./scope-lock";
import { nextChangelogId } from "./changelog-id";

/** A changelog row as `pull` reads it. */
export interface ChangelogRow {
  readonly id: string;
  readonly model: string;
  readonly keyPath: unknown;
  readonly operation: string;
}

/** What `appendChangelogRow` stamps with a scope and an id. */
export interface NewChangelogRow {
  readonly model: string;
  readonly keyPath: unknown;
  readonly operation: "create" | "update" | "delete";
  readonly outboxEventId: string;
}

interface ChangelogQuery {
  where(clause: Record<string, unknown>): ChangelogQuery;
  select(...fields: string[]): ChangelogQuery;
  orderBy(fn: (row: { id: { asc(): unknown; desc(): unknown } }) => unknown): ChangelogQuery;
  cursor(cursor: Record<string, unknown>): ChangelogQuery;
  limit(n: number): ChangelogQuery;
  all(): Promise<ChangelogRow[]>;
}

/** Whether the push event with this outbox id already wrote its changelog row (pushes are idempotent on it). */
export async function isEventApplied(tx: unknown, outboxEventId: string): Promise<boolean> {
  return Boolean(await ormRootFor(tx, "Changelog").first({ outboxEventId }));
}

/** The highest changelog id `scopeKey` has, or `null` for an empty scope (an index seek on `(scopeKey, id)`). */
async function maxChangelogId(tx: unknown, scopeKey: string): Promise<string | null> {
  const [latest] = await (ormRootFor(tx, "Changelog") as unknown as ChangelogQuery)
    .where({ scopeKey })
    .select("id")
    .orderBy((row) => row.id.desc())
    .limit(1)
    .all();
  return latest?.id ?? null;
}

/**
 * Appends a row to `scopeKey`'s changelog inside the push transaction `tx`.
 *
 * The lock is what makes commit order match the order ids are drawn in;
 * drawing each id above the scope's current max (read under the lock, so it
 * includes every earlier push's committed row) makes that order match id
 * order too — whatever process or clock the push ran on.
 */
export async function appendChangelogRow(
  db: unknown,
  tx: unknown,
  contract: SyncServerContract,
  scopeKey: string,
  row: NewChangelogRow
): Promise<void> {
  await lockScope(db, tx, contract.target, scopeKey);
  await ormRootFor(tx, "Changelog")
    .select("id")
    .create({ id: nextChangelogId(await maxChangelogId(tx, scopeKey), Date.now()), scopeKey, ...row });
}

const CHANGELOG_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A malformed cursor must be a clean `invalid-cursor`, not a query error.
 * Ids are generated lowercase and compared as text, so the cursor is
 * lowercased to match. `undefined` for a malformed cursor, `null` for none.
 */
export function parseChangelogCursor(value: string | null | undefined): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && CHANGELOG_ID_PATTERN.test(value) ? value.toLowerCase() : undefined;
}

/** Up to `limit` rows of `scopeKey`'s changelog after the exclusive id `cursor` (`null` = from the start), oldest first. */
export async function readChangelogPage(
  db: unknown,
  scopeKey: string,
  cursor: string | null,
  limit: number
): Promise<ChangelogRow[]> {
  const ordered = (ormRootFor(db, "Changelog") as unknown as ChangelogQuery)
    .where({ scopeKey })
    .select("id", "model", "keyPath", "operation")
    .orderBy((row) => row.id.asc());
  return (cursor !== null ? ordered.cursor({ id: cursor }) : ordered).limit(limit).all();
}
