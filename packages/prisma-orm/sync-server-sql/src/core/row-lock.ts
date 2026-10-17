import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import type { GetKeyField, SyncServerContract } from "@prisma-idb/sync-server";
import { plainRowReader } from "./authorization";
import type { RowReader } from "./authorization";

/** The written row needs an exclusive lock; ownership parents can share locks. */
type LockStrength = "update" | "share";

/** The raw SQL lane only decodes a presence marker, never the model row. */
interface RawSqlBuilder {
  returnsRow(spec: Record<string, string>): { build(): unknown };
}

/** The storage metadata needed to lock a row without decoding it. */
interface SqlTable {
  primaryKey: { columns: string[] };
  columns: Record<string, { dataType: string; typeParams?: Record<string, unknown> }>;
}

/** Contract namespaces hold physical table and primary-key column names. */
interface SqlStorage {
  namespaces: Record<string, { entries: { table: Record<string, SqlTable> } }>;
}

/**
 * Names the Postgres type a key column is cast to, from the data type its
 * contract column stores. Returns `undefined` for a type this package does
 * not know, such as a user-defined enum.
 *
 * The Postgres target loads on demand: it is an optional peer, and SQLite
 * servers never reach this code.
 */
async function castTypeOf(column: { dataType: string; typeParams?: Record<string, unknown> }) {
  const { createPostgresBuiltinDataTypeLookup } = await import("@prisma/orm-postgres/target/data-types");
  const { dataTypeParams, isSqlDataType, sqlBaseName } = await import("@prisma/orm-postgres/family-contract/data-type");
  const type = createPostgresBuiltinDataTypeLookup().get(column.dataType);
  return type !== undefined && isSqlDataType(type)
    ? sqlBaseName(type, dataTypeParams(type, column.typeParams))
    : undefined;
}

/** Quotes contract identifiers, including names with embedded double quotes. */
function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Locks a single-column primary key on the transaction's connection. Read
 * the row through the ORM afterward: READ COMMITTED gives that statement a
 * fresh snapshot after any lock wait, and the lock keeps the row stable.
 * Returns false if the row disappeared while waiting.
 *
 * SQLite needs no additional lock. It returns true here so callers still
 * read through the ORM; its single writer or SQLITE_BUSY prevents stale writes.
 */
export async function lockRow(
  db: unknown,
  tx: unknown,
  contract: SyncServerContract,
  model: string,
  key: unknown,
  strength: LockStrength
): Promise<boolean> {
  if (contract.target !== "postgres") return true;
  const storage = domainModelsAtDefaultNamespace(contract.domain)[model]?.storage as
    { namespaceId: string; table: string } | undefined;
  const sqlStorage = contract.storage as unknown as SqlStorage;
  const table = storage && sqlStorage.namespaces[storage.namespaceId]?.entries.table[storage.table];
  const columns = table?.primaryKey.columns;
  const column = columns?.length === 1 ? columns[0] : undefined;
  const columnSpec = column && table?.columns[column];
  const castType = columnSpec && (await castTypeOf(columnSpec));
  if (!storage || !column || !castType) {
    throw new Error(`Model "${model}" has no single-column SQL primary key with a known data type.`);
  }

  // Only trusted contract names and types enter the SQL text. The native key
  // stays a bound parameter, including UUIDs inferred as text by the raw lane.
  const parts = [
    `SELECT 1 AS present FROM ${quoteIdentifier(storage.namespaceId)}.${quoteIdentifier(storage.table)} WHERE ${quoteIdentifier(column)} = `,
    `::${castType} FOR ${strength === "update" ? "UPDATE" : "SHARE"}`,
  ];
  const strings = Object.assign(parts, { raw: [...parts] }) as TemplateStringsArray;
  const { sql } = (db as { raw: { sql(strings: TemplateStringsArray, ...values: unknown[]): RawSqlBuilder } }).raw;
  const plan = sql(strings, key).returnsRow({ present: "pg/int4@1" }).build();
  const rows = await (tx as { query(plan: never): Promise<unknown[]> }).query(plan as never);
  return rows.length > 0;
}

/** Locks each ownership parent before its ORM read, keeping decoding in the ORM. */
export function lockingRowReader(
  db: unknown,
  tx: unknown,
  contract: SyncServerContract,
  getKeyField: GetKeyField
): RowReader {
  const readRow = plainRowReader(tx, contract, getKeyField);
  return async (model, key) => {
    if (!(await lockRow(db, tx, contract, model, key, "share"))) return null;
    return readRow(model, key);
  };
}
