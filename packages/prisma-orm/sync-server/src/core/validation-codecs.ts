import { idbCodecLookup } from "@prisma-idb/target-idb/runtime";
import type { ValidationCodecLookup } from "@prisma-idb/target-idb/runtime";

// SQL descriptors' targetTypes are database type names, unlike IDB's JS names.
// Map codec identities to their application representations, never storage types.
const sqlApplicationTypes: Record<string, readonly string[]> = {};
for (const name of ["text", "char", "varchar"]) sqlApplicationTypes[`sql/${name}@1`] = ["string"];
for (const name of ["int", "float"]) sqlApplicationTypes[`sql/${name}@1`] = ["number"];
for (const name of [
  "text",
  "enum",
  "char",
  "varchar",
  "uuid",
  "numeric",
  "inet",
  "bit",
  "varbit",
  "timetz",
  "date-string",
  "timestamp-string",
  "timestamptz-string",
  "time-string",
  "tsquery",
]) {
  sqlApplicationTypes[`pg/${name}@1`] = ["string"];
}
for (const name of ["int", "int2", "int4", "int8number", "float", "float4", "float8"]) {
  sqlApplicationTypes[`pg/${name}@1`] = ["number"];
}
for (const name of ["int8", "unboundedint"]) sqlApplicationTypes[`pg/${name}@1`] = ["bigint"];
sqlApplicationTypes["pg/bool@1"] = ["boolean"];
sqlApplicationTypes["pg/timestamptz-date@1"] = ["Date"];
sqlApplicationTypes["pg/bytea@1"] = ["Uint8Array"];
sqlApplicationTypes["pg/json@1"] = ["unknown"];
sqlApplicationTypes["pg/jsonb@1"] = ["unknown"];

export const defaultValidationCodecs: ValidationCodecLookup = {
  targetTypesFor: (id) => idbCodecLookup.targetTypesFor(id) ?? sqlApplicationTypes[id],
};
