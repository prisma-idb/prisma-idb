import { and, not, or } from "@prisma-idb/client-idb/orm";

/**
 * Evaluates an expression with the ORM, filter operators, and transaction in
 * scope. Awaits promises and drains query results before formatting them as
 * JSON. Evaluation and serialization errors propagate to the caller.
 */
export async function runQuery(query: string, orm: unknown, transaction: unknown): Promise<string> {
  const body = `return (async () => {\n  return (${query});\n})();`;
  const fn = new Function("orm", "and", "or", "not", "transaction", body) as (
    ormArg: unknown,
    andFn: unknown,
    orFn: unknown,
    notFn: unknown,
    transactionFn: unknown
  ) => Promise<unknown>;
  let raw = await fn(orm, and, or, not, transaction);

  // Query results expose toArray(); drain them so the output contains rows.
  if (raw && typeof (raw as Record<string, unknown>)["toArray"] === "function") {
    raw = await (raw as { toArray(): Promise<unknown[]> }).toArray();
  }

  // Void expressions must render as valid JSON for callers of the output panel.
  return JSON.stringify(raw === undefined ? null : raw, null, 2);
}
