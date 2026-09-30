/**
 * Serializes changelog writes per scope.
 *
 * `pull` hands the client an exclusive id cursor, which is only safe if a
 * scope's changelog rows become visible in id order. Two concurrent pushes
 * for one scope otherwise can commit out of order — the later id first — and
 * a pull in between advances its cursor past the still-uncommitted earlier
 * row, which it then never sees.
 *
 * A transaction-scoped advisory lock taken *before* the changelog id is drawn
 * and released at commit/rollback makes commit order equal draw order within a
 * scope; drawing each id above the scope's max (see `nextChangelogId`) makes
 * draw order equal id order. Different scopes hash to different keys and
 * don't contend. `hashtext` is 32-bit, so two scopes can collide on a key,
 * which only costs a little needless serialization, never correctness.
 */

/** Namespaces this package's locks, so they can't collide with the app's own `pg_advisory_*` keys. */
const SCOPE_LOCK_CLASS = 0x70_69_64_62; // "pidb"

interface RawSqlBuilder {
  affectedCount(): { build(): unknown };
}

interface SqlScope {
  execute(plan: never): Promise<unknown>;
}

/**
 * Takes the per-scope lock on `tx`'s connection, waiting if another open
 * transaction holds it. `db` is the client `tx` came from — the raw SQL lane
 * lives on the client, not on the transaction scope. No-op for non-Postgres
 * contracts (SQLite has a single writer, so pushes are already serialized).
 */
export async function lockScope(db: unknown, tx: unknown, target: unknown, scopeKey: string): Promise<void> {
  if (target !== "postgres") return;
  const { sql } = (db as { raw: { sql: (strings: TemplateStringsArray, ...values: unknown[]) => RawSqlBuilder } }).raw;
  const plan = sql`SELECT pg_advisory_xact_lock(${SCOPE_LOCK_CLASS}::int4, hashtext(${scopeKey}))`
    .affectedCount()
    .build();
  await (tx as SqlScope).execute(plan as never);
}
