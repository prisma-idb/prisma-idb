import { JsonValue } from "@prisma/orm-framework/contract/types";
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
import type { AnyCodecDescriptor, CodecInstanceContext, CodecLookup } from "@prisma/orm-framework/components/codec";

/**
 * IDB codec descriptors — the registry of type→IDB mapping metadata.
 *
 * Each descriptor declares its `codecId`, `dataType`, `traits`, `targetTypes`, and a
 * `factory` that returns a `Codec` instance. This is consumed by the
 * emitter to generate `contract.d.ts` type maps, and by the adapter at
 * runtime to resolve encode/decode per field.
 */
export const codecDescriptors: readonly AnyCodecDescriptor[] = [
  {
    codecId: "idb/string@1",
    dataType: idbString.id,
    traits: ["equality", "textual"],
    targetTypes: ["string"],
    renderValueLiteral: (value) => (typeof value === "string" ? JSON.stringify(value) : undefined),
    paramsSchema: undefined as never,
    isParameterized: false,
    factory: () => () => ({
      id: "idb/string@1",
      encode: async (value: string) => value,
      decode: async (value: string) => value,
      encodeJson: (value: string) => value,
      decodeJson: (value: string) => value,
    }),
  },
  {
    codecId: "idb/double@1",
    dataType: idbDouble.id,
    traits: ["equality", "numeric", "order"],
    targetTypes: ["number"],
    paramsSchema: undefined as never,
    isParameterized: false,
    factory: () => () => ({
      id: "idb/double@1",
      encode: async (value: number) => value,
      decode: async (value: number) => value,
      encodeJson: (value: number) => value,
      decodeJson: (value: number) => value,
    }),
  },
  {
    codecId: "idb/int32@1",
    dataType: idbInt32.id,
    traits: ["equality", "numeric", "order"],
    targetTypes: ["number"],
    paramsSchema: undefined as never,
    isParameterized: false,
    factory: () => () => ({
      id: "idb/int32@1",
      encode: async (value: number) => {
        if (!Number.isInteger(value)) {
          throw new Error(`Value ${value} is not an integer and cannot be encoded as int32.`);
        }
        if (value < -Math.pow(2, 31) || value > Math.pow(2, 31) - 1) {
          throw new Error(`Value ${value} is out of range for int32 and cannot be encoded.`);
        }
        return value;
      },
      decode: async (value: number) => value,
      encodeJson: (value: number) => value,
      decodeJson: (value: number) => value,
    }),
  },
  {
    codecId: "idb/bool@1",
    dataType: idbBool.id,
    traits: ["equality", "boolean"],
    targetTypes: ["boolean"],
    paramsSchema: undefined as never,
    isParameterized: false,
    factory: () => () => ({
      id: "idb/bool@1",
      encode: async (value: boolean) => value,
      decode: async (value: boolean) => value,
      encodeJson: (value: boolean) => value,
      decodeJson: (value: boolean) => value,
    }),
  },
  {
    codecId: "idb/date@1",
    dataType: idbDate.id,
    traits: ["equality", "order"],
    targetTypes: ["Date"],
    paramsSchema: undefined as never,
    isParameterized: false,
    factory: () => () => ({
      id: "idb/date@1",
      encode: async (value: Date) => value,
      decode: async (value: Date) => value,
      encodeJson: (value: Date) => value.toISOString(),
      decodeJson: (value: string) => new Date(value),
    }),
  },
  {
    codecId: "idb/bigint@1",
    dataType: idbBigint.id,
    traits: ["equality", "numeric", "order"],
    targetTypes: ["bigint"],
    paramsSchema: undefined as never,
    isParameterized: false,
    factory: () => () => ({
      id: "idb/bigint@1",
      encode: async (value: bigint) => value,
      decode: async (value: bigint) => value,
      encodeJson: (value: bigint) => value.toString(),
      decodeJson: (value: string) => BigInt(value),
    }),
  },
  {
    codecId: "idb/decimal@1",
    dataType: idbDecimal.id,
    traits: ["equality", "numeric"],
    targetTypes: ["string"],
    paramsSchema: undefined as never,
    isParameterized: false,
    factory: () => () => ({
      id: "idb/decimal@1",
      encode: async (value: string) => value,
      decode: async (value: string) => value,
      encodeJson: (value: string) => value,
      decodeJson: (value: string) => value,
    }),
  },
  {
    codecId: "idb/json@1",
    dataType: idbJson.id,
    traits: ["equality"],
    targetTypes: ["unknown"],
    paramsSchema: undefined as never,
    isParameterized: false,
    factory: () => () => ({
      id: "idb/json@1",
      encode: async (value: unknown) => value,
      decode: async (value: unknown) => value,
      encodeJson: (value: JsonValue) => value as JsonValue,
      decodeJson: (value: JsonValue) => value,
    }),
  },
  {
    codecId: "idb/bytes@1",
    dataType: idbBytes.id,
    traits: ["equality"],
    targetTypes: ["Uint8Array"],
    paramsSchema: undefined as never,
    isParameterized: false,
    factory: () => () => ({
      id: "idb/bytes@1",
      encode: async (value: Uint8Array) => value,
      decode: async (value: Uint8Array) => value,
      encodeJson: bytesToBase64,
      decodeJson: base64ToBytes,
    }),
  },
] as const;

// ── Base64 (idb/bytes@1 JSON form) ────────────────────────────────────────────

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Character code → 6-bit value. Codes outside the alphabet decode as 0. */
const BASE64_VALUES = new Uint8Array(128);
for (let i = 0; i < BASE64_ALPHABET.length; i++) BASE64_VALUES[BASE64_ALPHABET.charCodeAt(i)] = i;

/** Standard padded base64 (RFC 4648). */
function bytesToBase64(bytes: Uint8Array): string {
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
 * Pre-built CodecLookup for all IDB codecs.
 *
 * All IDB codecs are currently identity transforms, but using the real lookup
 * ensures per-field encoding works automatically when non-identity codecs are
 * added (e.g. idb/date@1 already encodes/decodes Date objects).
 */
export const idbCodecLookup: CodecLookup = (() => {
  const codecMap = new Map(
    codecDescriptors.map((desc) => {
      const ctx: CodecInstanceContext = { name: `<codec:${desc.codecId}>` };
      const codec = (desc as AnyCodecDescriptor).factory(undefined)(ctx);
      return [desc.codecId, codec] as const;
    })
  );
  const targetTypesMap = new Map(codecDescriptors.map((desc) => [desc.codecId, desc.targetTypes]));
  const valueLiteralRenderers = new Map(
    codecDescriptors
      .filter((desc) => "renderValueLiteral" in desc)
      .map((desc) => [desc.codecId, desc.renderValueLiteral] as const)
  );
  return {
    get: (id) => codecMap.get(id),
    targetTypesFor: (id) => targetTypesMap.get(id),
    metaFor: () => undefined,
    renderOutputTypeFor: () => undefined,
    renderValueLiteralFor: (id, value, side) => valueLiteralRenderers.get(id)?.(value, side),
  };
})();
