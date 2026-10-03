import { idbCodecLookup } from "@prisma-idb/target-idb/runtime";
import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import type { SyncServerContract } from "@prisma-idb/sync-server";

// These SQL codecs use the same JSON representation as the IDB client.
export const nativeJsonCodecs: Record<string, string> = {
  "pg/date@1": "idb/date@1",
  "pg/timestamp@1": "idb/date@1",
  "pg/timestamptz@1": "idb/date@1",
  "pg/timestamptz-date@1": "idb/date@1",
  "sql/timestamp@1": "idb/date@1",
  "pg/int8@1": "idb/bigint@1",
  "pg/unboundedint@1": "idb/bigint@1",
  "pg/bytea@1": "idb/bytes@1",
};

/** Encode a native SQL key for comparison with a wire-form scope key. */
export function encodeWireKey(contract: SyncServerContract, model: string, keyField: string, key: unknown): unknown {
  const field = domainModelsAtDefaultNamespace(contract.domain)[model]?.fields[keyField];
  const codecId = field?.type.kind === "scalar" ? nativeJsonCodecs[field.type.codecId] : undefined;
  const codec = codecId ? idbCodecLookup.get(codecId) : undefined;
  return codec && key != null ? codec.encodeJson(key) : key;
}

/** A sync payload value or key that cannot be decoded or shaped; `code` is the stable wire error code, `message` keeps the diagnostic for direct callers. */
export class WireValidationError extends Error {
  constructor(
    readonly code: "RECORD_VALIDATION_FAILURE" | "KEYPATH_VALIDATION_FAILURE",
    message: string
  ) {
    super(message);
  }
}

/** Revive native sync scalar values before shape validation or ORM encoding. */
export function reviveWireValues(
  contract: SyncServerContract,
  model: string,
  data: Record<string, unknown>,
  keyField?: string
): Record<string, unknown> {
  const fields = domainModelsAtDefaultNamespace(contract.domain)[model]?.fields;
  if (!fields) return data;
  return Object.fromEntries(
    Object.entries(data).map(([name, value]) => {
      const field = fields[name];
      const codecId = field?.type.kind === "scalar" ? nativeJsonCodecs[field.type.codecId] : undefined;
      const codec = codecId ? idbCodecLookup.get(codecId) : undefined;
      if (!codec) return [name, value];
      const revive = (input: unknown): unknown => {
        if (typeof input !== "string") return input;
        try {
          return codec.decodeJson(input);
        } catch {
          throw new WireValidationError(
            name === keyField ? "KEYPATH_VALIDATION_FAILURE" : "RECORD_VALIDATION_FAILURE",
            "Unable to decode sync field"
          );
        }
      };
      if (field?.many && Array.isArray(value)) return [name, value.map(revive)];
      return [name, revive(value)];
    })
  );
}
