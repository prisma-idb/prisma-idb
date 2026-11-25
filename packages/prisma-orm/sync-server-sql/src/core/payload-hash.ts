import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import type { SyncServerContract } from "@prisma-idb/sync-server";
import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";

type CanonicalValue = null | boolean | number | string | CanonicalValue[];

/** Encode containers and native values with distinct tags so ordinary JSON cannot impersonate a native value. */
function canonicalValue(value: unknown): CanonicalValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : ["number", String(value)];
  if (typeof value === "bigint") return ["bigint", value.toString()];
  if (value === undefined) return ["undefined"];
  if (value instanceof Date) return ["date", value.toISOString()];
  if (value instanceof Uint8Array) return ["bytes", Buffer.from(value).toString("base64")];
  if (Array.isArray(value)) return ["array", Array.from(value, canonicalValue)];
  if (typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const record = value as Record<string, unknown>;
    return [
      "object",
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalValue(record[key])]),
    ];
  }
  throw new TypeError("Unsupported sync payload value");
}

function canonicalCreate(
  contract: SyncServerContract,
  modelName: string,
  payload: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  const model = domainModelsAtDefaultNamespace(contract.domain)[modelName];
  const storage = model?.storage as
    { namespaceId?: string; table?: string; fields?: Record<string, { column: string }> } | undefined;
  if (!storage?.namespaceId || !storage.table) return payload;
  const { namespaceId, table } = storage;
  const sql = contract.storage as unknown as {
    namespaces?: Record<
      string,
      { entries: { table: Record<string, { columns: Record<string, { default?: unknown }> }> } }
    >;
  };
  const columns = sql.namespaces?.[namespaceId]?.entries.table[table]?.columns;
  if (!columns) return payload;
  const generated = new Set(
    contract.execution?.mutations.defaults
      .filter(({ ref, onCreate }) => ref.namespace === namespaceId && ref.entry === table && onCreate)
      .map(({ ref }) => ref.field)
  );
  return Object.fromEntries(
    Object.entries(payload).filter(([name, value]) => {
      if (value !== null || !model?.fields[name]?.nullable) return true;
      const column = storage.fields?.[name]?.column ?? name;
      return !Object.hasOwn(columns, column) || columns[column]?.default !== undefined || generated.has(column);
    })
  );
}

/** This format is persisted in the changelog. Keep its representation stable across releases. */
export function hashPushPayload(
  contract: SyncServerContract,
  model: string,
  operation: string,
  payload: Readonly<Record<string, unknown>>
): string {
  const record = operation === "create" ? canonicalCreate(contract, model, payload) : payload;
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(record)))
    .digest("hex");
}
