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
 *
 * The scope's max id is read *after* the lock, which only sees the previous
 * holder's committed row if the transaction takes a fresh snapshot per
 * statement (READ COMMITTED, Postgres' default). Under REPEATABLE READ or
 * SERIALIZABLE the snapshot is fixed at the transaction's first statement —
 * before the lock — so that read could silently miss a row committed while
 * this push waited. `lockScope` refuses to run there instead.
 */

/** Namespaces this package's locks, so they can't collide with the app's own `pg_advisory_*` keys. */
const SCOPE_LOCK_CLASS = 0x70_69_64_62; // "pidb"

interface RawSqlBuilder {
  returnsRow(spec: Record<string, string>): { build(): unknown };
}

interface SqlScope {
  query(plan: never): Promise<unknown>;
}

/** Levels whose snapshot is fixed before the lock is taken (Postgres reports READ UNCOMMITTED as itself, but runs it as READ COMMITTED). */
const SNAPSHOT_ISOLATION_LEVELS = new Set(["repeatable read", "serializable"]);

/**
 * Takes the per-scope lock on `tx`'s connection, waiting if another open
 * transaction holds it. `db` is the client `tx` came from — the raw SQL lane
 * lives on the client, not on the transaction scope. No-op for non-Postgres
 * contracts (SQLite has a single writer, so pushes are already serialized).
 *
 * Throws if the transaction runs at REPEATABLE READ or SERIALIZABLE (see the
 * file comment). The isolation setting comes back with the lock query to
 * avoid an extra round trip; an unsupported transaction may wait for the
 * lock before being rejected.
 */
export async function lockScope(db: unknown, tx: unknown, target: unknown, scopeKey: string): Promise<void> {
  if (target !== "postgres") return;
  const { sql } = (db as { raw: { sql: (strings: TemplateStringsArray, ...values: unknown[]) => RawSqlBuilder } }).raw;
  const scope = tx as SqlScope;

  // Keep the max-id read in a separate statement after this query returns:
  // this statement's snapshot is taken before any wait for the lock.
  const lockPlan = sql`SELECT current_setting('transaction_isolation') AS level
    FROM pg_advisory_xact_lock(${SCOPE_LOCK_CLASS}::int4, hashtext(${scopeKey}))`
    .returnsRow({ level: "pg/text@1" })
    .build();
  const [row] = (await scope.query(lockPlan as never)) as { level: string }[];
  const level = row?.level;
  if (level === undefined || SNAPSHOT_ISOLATION_LEVELS.has(level)) {
    throw new Error(
      `Pushes require the READ COMMITTED transaction isolation level, but this transaction runs at ${
        level ?? "an unknown level"
      }: the changelog id is ordered against the scope's highest id, which a snapshot taken before the scope lock can miss.`
    );
  }
}
