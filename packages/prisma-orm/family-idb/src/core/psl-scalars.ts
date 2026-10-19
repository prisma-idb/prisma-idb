import type {
  AuthoringTypeConstructorDescriptor,
  AuthoringTypeNamespace,
} from "@prisma/orm-framework/components/authoring";

function scalar(codecId: string, documentation: string): AuthoringTypeConstructorDescriptor {
  return { kind: "typeConstructor", args: [], documentation, output: { codecId } };
}

/** Scalar names shared by PSL interpretation and editor type resolution. */
export const idbScalarTypes = {
  String: scalar("idb/string@1", "A string value, represented as a JavaScript string."),
  Int: scalar("idb/int32@1", "A signed 32-bit integer, represented as a JavaScript number."),
  Float: scalar("idb/double@1", "A 64-bit floating-point value, represented as a JavaScript number."),
  Boolean: scalar("idb/bool@1", "A boolean value. Cannot be used in an IndexedDB key or index."),
  DateTime: scalar("idb/date@1", "A date and time, stored as a JavaScript Date and compared by time."),
  BigInt: scalar("idb/bigint@1", "A JavaScript bigint. Cannot be used in an IndexedDB key or index."),
  Decimal: scalar("idb/decimal@1", "An exact decimal value, stored as a string and compared numerically."),
  Json: scalar("idb/json@1", "A JSON value. Cannot be used in an IndexedDB key or index."),
  Bytes: scalar("idb/bytes@1", "Binary data, stored as a Uint8Array and compared byte by byte."),
} satisfies AuthoringTypeNamespace;

/** The interpreter uses the same codec IDs that editor tooling discovers. */
export const SCALAR_TO_CODEC_ID: Record<string, string> = Object.fromEntries(
  Object.entries(idbScalarTypes).map(([name, descriptor]) => [name, descriptor.output.codecId])
);
