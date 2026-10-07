const SQLSTATE = /^[0-9A-Z]{5}$/;
const MAX_CAUSE_DEPTH = 5;

/**
 * The SQLSTATE of a database error, or `undefined` for any other error.
 * The driver's error carries it as `code`; Prisma 8 may wrap that error, so
 * this also looks through `cause`.
 */
export function sqlState(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === "string" && SQLSTATE.test(code)) return code;
    current = cause;
  }
  return undefined;
}

/**
 * Whether retrying the same write can never succeed: SQLSTATE class 22 (data
 * exception) and class 23 (integrity constraint violation). Everything else —
 * lost connections, timeouts, deadlocks, errors with no SQLSTATE — may clear
 * up, so the client should keep the event and retry.
 */
export function isDeterministicWriteFailure(error: unknown): boolean {
  const state = sqlState(error);
  return state !== undefined && (state.startsWith("22") || state.startsWith("23"));
}
