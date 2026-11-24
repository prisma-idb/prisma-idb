import type { JsonValue } from "@prisma/orm-framework/contract/types";
import {
  floatToJson,
  INT32_RANGE,
  requireValueOf,
  type AnyCodecDescriptor,
  type Codec,
  type CodecInstanceContext,
  type CodecLookupWithDescriptors,
  type CodecTrait,
  type DataType,
} from "@prisma/orm-framework/components/codec";
import {
  idbBigint,
  idbBool,
  idbBytes,
  idbDate,
  idbDecimal,
  idbDouble,
  idbInt32,
  idbJson,
  idbString,
} from "./data-types";
import { binaryBytes } from "./key-compare";
import { encodeJsonValue } from "./json-value";
import type { ValidationCodecLookup } from "./validate-record";

/**
 * IDB codec descriptors — the registry of type→IDB mapping metadata.
 *
 * Each descriptor declares its `codecId`, `dataType`, `traits`, and a
 * `factory` that returns a `Codec` instance. This is consumed by the
 * emitter to generate `contract.d.ts` type maps, and by the adapter at
 * runtime to resolve encode/decode per field.
 */
/**
 * Builds an IDB codec. IndexedDB stores structured-clone values, so the wire
 * value is the application value itself; `check` refuses an application value
 * the column cannot hold before it is written. `toJson` and `fromJson` convert
 * between the application value and the JSON form the data type stores.
 */
function idbCodec<T>(config: {
  readonly id: string;
  readonly dataType: DataType;
  readonly toJson: (value: T) => JsonValue;
  readonly fromJson: (json: JsonValue) => T;
  readonly check?: (value: T) => void;
}): Codec<string, readonly CodecTrait[], T, T> {
  const { id, dataType, toJson, fromJson, check } = config;
  return {
    id,
    dataType,
    toDataTypeValue: (value) => dataType.valueFrom(toJson(value), {}),
    fromDataTypeValue: (value) => fromJson(requireValueOf(dataType.id, value, `Codec ${id}`).value),
    toWire: async (value) => {
      check?.(value);
      return value;
    },
    fromWire: async (wire) => wire,
  };
}

function descriptor<T>(config: {
  readonly codecId: string;
  readonly dataType: DataType;
  readonly traits: readonly CodecTrait[];
  readonly toJson: (value: T) => JsonValue;
  readonly fromJson: (json: JsonValue) => T;
  readonly check?: (value: T) => void;
  readonly renderValueLiteral?: AnyCodecDescriptor["renderValueLiteral"];
}): AnyCodecDescriptor {
  const { codecId, dataType, traits, renderValueLiteral, ...codecConfig } = config;
  const codec = idbCodec({ id: codecId, dataType, ...codecConfig });
  return {
    codecId,
    dataType: dataType.id,
    traits,
    ...(renderValueLiteral === undefined ? {} : { renderValueLiteral }),
    paramsSchema: undefined,
    isParameterized: false,
    factory: () => () => codec,
  };
}

const asJson = (value: JsonValue): JsonValue => value;

/**
 * IDB codec descriptors — the registry of type→IDB mapping metadata.
 *
 * Each descriptor declares its `codecId`, `dataType`, `traits`, and a
 * `factory` that returns a `Codec` instance. This is consumed by the
 * emitter to generate `contract.d.ts` type maps, and by the adapter at
 * runtime to read and write values per field.
 */
export const codecDescriptors: readonly AnyCodecDescriptor[] = [
  descriptor<string>({
    codecId: "idb/string@1",
    dataType: idbString,
    traits: ["equality", "textual"],
    renderValueLiteral: (value) => (typeof value === "string" ? JSON.stringify(value) : undefined),
    toJson: asJson,
    fromJson: (json) => json as string,
  }),
  descriptor<number>({
    codecId: "idb/double@1",
    dataType: idbDouble,
    traits: ["equality", "numeric", "order"],
    toJson: floatToJson,
    fromJson: (json) => Number(json),
  }),
  descriptor<number>({
    codecId: "idb/int32@1",
    dataType: idbInt32,
    traits: ["equality", "numeric", "order"],
    toJson: asJson,
    fromJson: (json) => json as number,
    check: (value) => {
      if (!Number.isInteger(value)) {
        throw new Error(`Value ${value} is not an integer and cannot be encoded as int32.`);
      }
      if (value < INT32_RANGE.min || value > INT32_RANGE.max) {
        throw new Error(`Value ${value} is out of range for int32 and cannot be encoded.`);
      }
    },
  }),
  descriptor<boolean>({
    codecId: "idb/bool@1",
    dataType: idbBool,
    traits: ["equality", "boolean"],
    toJson: asJson,
    fromJson: (json) => json as boolean,
  }),
  descriptor<Date>({
    codecId: "idb/date@1",
    dataType: idbDate,
    traits: ["equality", "order"],
    toJson: (value) => value.toISOString(),
    fromJson: (json) => new Date(json as string),
  }),
  descriptor<bigint>({
    codecId: "idb/bigint@1",
    dataType: idbBigint,
    traits: ["equality", "numeric", "order"],
    toJson: (value) => value.toString(),
    fromJson: (json) => BigInt(json as string),
  }),
  descriptor<string>({
    codecId: "idb/decimal@1",
    dataType: idbDecimal,
    traits: ["equality", "numeric"],
    toJson: asJson,
    fromJson: (json) => json as string,
  }),
  descriptor<JsonValue>({
    codecId: "idb/json@1",
    dataType: idbJson,
    traits: ["equality"],
    toJson: encodeJsonValue,
    fromJson: asJson,
  }),
  descriptor<Uint8Array>({
    codecId: "idb/bytes@1",
    dataType: idbBytes,
    traits: ["equality"],
    toJson: bytesToBase64,
    fromJson: (json) => base64ToBytes(json as string),
  }),
];

// ── Base64 (idb/bytes@1 JSON form) ────────────────────────────────────────────

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Character code → 6-bit value. Codes outside the alphabet decode as 0. */
const BASE64_VALUES = new Uint8Array(128);
for (let i = 0; i < BASE64_ALPHABET.length; i++) BASE64_VALUES[BASE64_ALPHABET.charCodeAt(i)] = i;

/** Standard padded base64 (RFC 4648). */
function bytesToBase64(value: Uint8Array): string {
  // IndexedDB returns binary key range bounds as ArrayBuffers.
  const bytes = binaryBytes(value);
  if (bytes === null) throw new TypeError("Expected binary data");
  let result = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    result +=
      BASE64_ALPHABET[a >> 2]! +
      BASE64_ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]! +
      (b === undefined ? "=" : BASE64_ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)]!) +
      (c === undefined ? "=" : BASE64_ALPHABET[c & 63]!);
  }
  return result;
}

/** Decodes the padded base64 representation used by the bytes JSON codec. */
function base64ToBytes(base64: string): Uint8Array {
  const stripped = base64.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((stripped.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < stripped.length; i += 4) {
    const a = BASE64_VALUES[stripped.charCodeAt(i)] ?? 0;
    const b = BASE64_VALUES[stripped.charCodeAt(i + 1)] ?? 0;
    const c = BASE64_VALUES[stripped.charCodeAt(i + 2)] ?? 0;
    const d = BASE64_VALUES[stripped.charCodeAt(i + 3)] ?? 0;
    out[o++] = (a << 2) | (b >> 4);
    if (i + 2 < stripped.length) out[o++] = ((b & 15) << 4) | (c >> 2);
    if (i + 3 < stripped.length) out[o++] = ((c & 3) << 6) | d;
  }
  return out;
}

// ── Codec lookup ──────────────────────────────────────────────────────────────

/**
 * JavaScript application types each IDB codec accepts, by codec id.
 *
 * Upstream codec descriptors no longer carry target type names, so prisma-idb
 * keeps its own table for record validation.
 */
const idbApplicationTypes: Readonly<Record<string, readonly string[]>> = {
  "idb/string@1": ["string"],
  "idb/double@1": ["number"],
  "idb/int32@1": ["number"],
  "idb/bool@1": ["boolean"],
  "idb/date@1": ["Date"],
  "idb/bigint@1": ["bigint"],
  "idb/decimal@1": ["string"],
  "idb/json@1": ["unknown"],
  "idb/bytes@1": ["Uint8Array"],
};

/**
 * Pre-built codec lookup for all IDB codecs.
 *
 * Native storage codecs preserve structured-clone values. JSON codecs convert
 * dates, bigint, and bytes to their wire representations. Both paths use the
 * same descriptor registry.
 */
export const idbCodecLookup: CodecLookupWithDescriptors & ValidationCodecLookup = (() => {
  const descriptorMap = new Map(codecDescriptors.map((desc) => [desc.codecId, desc] as const));
  const codecMap = new Map(
    codecDescriptors.map((desc) => {
      const ctx: CodecInstanceContext = { name: `<codec:${desc.codecId}>` };
      const codec = (desc as AnyCodecDescriptor).factory(undefined)(ctx);
      return [desc.codecId, codec] as const;
    })
  );
  const valueLiteralRenderers = new Map(
    codecDescriptors
      .filter((desc) => "renderValueLiteral" in desc)
      .map((desc) => [desc.codecId, desc.renderValueLiteral] as const)
  );
  return {
    get: (id) => codecMap.get(id),
    descriptorFor: (id) => descriptorMap.get(id),
    targetTypesFor: (id) => idbApplicationTypes[id],
    renderOutputTypeFor: () => undefined,
    renderValueLiteralFor: (id, value, side) => valueLiteralRenderers.get(id)?.(value, side),
  };
})();

/**
 * The JSON form of `value`, as the codec's data type stores it in
 * `contract.json` and on the sync wire.
 */
export function codecValueToJson(codec: Pick<Codec, "dataType" | "toDataTypeValue">, value: unknown): JsonValue {
  return codec.dataType.toContract(codec.toDataTypeValue(value));
}

/**
 * The application value for `json`, a value in any spelling the codec's data
 * type reads. Throws when the data type refuses `json`.
 */
export function codecValueFromJson(codec: Pick<Codec, "dataType" | "fromDataTypeValue">, json: JsonValue): unknown {
  return codec.fromDataTypeValue(codec.dataType.valueFrom(json, {}));
}
