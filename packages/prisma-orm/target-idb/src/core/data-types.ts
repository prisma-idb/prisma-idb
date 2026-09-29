import { dataType } from "@prisma/orm-framework/components/codec";

/**
 * IDB data types, the storage-level types each codec is one representation of.
 *
 * The framework requires every codec descriptor to name a `dataType`, and every
 * named data type to be registered by some component in the assembled stack
 * (ADR 254). The IDB target registers these through `idbTargetDescriptorMeta.dataTypes`.
 *
 * No casts are declared yet: IDB migrations never rewrite stored values from
 * one type to another, so there is nothing to convert.
 */
export const idbString = dataType("idb/string", {});
export const idbDouble = dataType("idb/double", {});
export const idbInt32 = dataType("idb/int32", {});
export const idbBool = dataType("idb/bool", {});
export const idbDate = dataType("idb/date", {});
export const idbBigint = dataType("idb/bigint", {});
export const idbDecimal = dataType("idb/decimal", {});
export const idbJson = dataType("idb/json", {});
export const idbBytes = dataType("idb/bytes", {});

/** Every data type the IDB target registers. */
export const idbDataTypes = [
  idbString,
  idbDouble,
  idbInt32,
  idbBool,
  idbDate,
  idbBigint,
  idbDecimal,
  idbJson,
  idbBytes,
] as const;
