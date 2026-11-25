/**
 * Runs `fn` in one read transaction whose reads all see the same committed
 * state. A pull reads a row and then each ownership hop in separate
 * statements; without one snapshot, a write committed between them could
 * pair a row with an ownership graph that never existed together.
 *
 * Postgres needs REPEATABLE READ for that: its default, READ COMMITTED, takes
 * a new snapshot per statement. A SQLite transaction already reads one
 * snapshot, so it keeps its default.
 */
export async function inReadSnapshot<T>(db: unknown, target: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> {
  const transactional = db as {
    transaction<R>(fn: (tx: unknown) => Promise<R>, options?: { isolationLevel?: string }): Promise<R>;
  };
  return target === "postgres"
    ? transactional.transaction(fn, { isolationLevel: "RepeatableRead" })
    : transactional.transaction(fn);
}
