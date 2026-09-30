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
  affectedCount(): { build(): unknown };
  returnsRow(spec: Record<string, string>): { build(): unknown };
}

interface SqlScope {
  execute(plan: never): Promise<unknown>;
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
 * file comment); checked before waiting for the lock, so it fails fast.
 */
export async function lockScope(db: unknown, tx: unknown, target: unknown, scopeKey: string): Promise<void> {
  if (target !== "postgres") return;
  const { sql } = (db as { raw: { sql: (strings: TemplateStringsArray, ...values: unknown[]) => RawSqlBuilder } }).raw;
  const scope = tx as SqlScope;

  const levelPlan = sql`SELECT current_setting('transaction_isolation') AS level`
    .returnsRow({ level: "pg/text@1" })
    .build();
  const [row] = (await scope.query(levelPlan as never)) as { level: string }[];
  const level = row?.level;
  if (level === undefined || SNAPSHOT_ISOLATION_LEVELS.has(level)) {
    throw new Error(
      `Pushes require the READ COMMITTED transaction isolation level, but this transaction runs at ${
        level ?? "an unknown level"
      }: the changelog id is ordered against the scope's highest id, which a snapshot taken before the scope lock can miss.`
    );
  }

  const lockPlan = sql`SELECT pg_advisory_xact_lock(${SCOPE_LOCK_CLASS}::int4, hashtext(${scopeKey}))`
    .affectedCount()
    .build();
  await scope.execute(lockPlan as never);
}
