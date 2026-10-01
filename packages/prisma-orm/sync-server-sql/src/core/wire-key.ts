import { idbCodecLookup } from "@prisma-idb/target-idb/runtime";
import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import type { SyncServerContract } from "@prisma-idb/sync-server";

// These SQL codecs use the same JSON representation as the IDB client.
export const nativeJsonCodecs: Record<string, string> = {
  "pg/timestamptz-date@1": "idb/date@1",
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
