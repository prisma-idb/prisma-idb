import type { Codec, CodecCallContext } from "@prisma/orm-framework/components/codec";
import { describe, expect, it } from "vitest";
import {
  codecDescriptors,
  codecValueFromJson as fromJson,
  codecValueToJson as toJson,
  idbCodecLookup,
} from "../src/core/codecs";
import { idbTargetDescriptorMeta } from "../src/core/descriptor-meta";

// Instantiate a codec from its descriptor's factory.
function getCodec(codecId: string): Codec {
  const desc = codecDescriptors.find((d) => d.codecId === codecId);
  if (!desc) throw new Error(`Codec descriptor "${codecId}" not found`);
  const factory = desc.factory(undefined as never) as (ctx: unknown) => Codec;
  return factory({ name: "test" });
}

// Minimal context — IDB codecs don't use signal or any family-specific context.
const ctx: CodecCallContext = {};

// ── idb/string@1 ─────────────────────────────────────────────────────────────

describe("idb/string@1", () => {
  const codec = getCodec("idb/string@1");

  it("round-trips a string", async () => {
    expect(await codec.toWire("hello", ctx)).toBe("hello");
    expect(await codec.fromWire("hello", ctx)).toBe("hello");
  });

  it("the JSON form is the string itself", () => {
    expect(toJson(codec, "world")).toBe("world");
    expect(fromJson(codec, "world")).toBe("world");
  });
});

// ── idb/int32@1 ──────────────────────────────────────────────────────────────

describe("idb/int32@1", () => {
  const codec = getCodec("idb/int32@1");

  it("round-trips a valid int32", async () => {
    expect(await codec.toWire(42, ctx)).toBe(42);
    expect(await codec.fromWire(42, ctx)).toBe(42);
  });

  it("throws for non-integer input", async () => {
    await expect(codec.toWire(3.14, ctx)).rejects.toThrow("not an integer");
  });

  it("throws for values outside int32 range", async () => {
    await expect(codec.toWire(2 ** 31, ctx)).rejects.toThrow("out of range");
    await expect(codec.toWire(-(2 ** 31) - 1, ctx)).rejects.toThrow("out of range");
  });

  it("accepts boundary values", async () => {
    expect(await codec.toWire(2 ** 31 - 1, ctx)).toBe(2 ** 31 - 1);
    expect(await codec.toWire(-(2 ** 31), ctx)).toBe(-(2 ** 31));
  });
});

// ── idb/double@1 ─────────────────────────────────────────────────────────────

describe("idb/double@1", () => {
  const codec = getCodec("idb/double@1");

  it("round-trips a float", async () => {
    expect(await codec.toWire(3.14, ctx)).toBe(3.14);
    expect(await codec.fromWire(3.14, ctx)).toBe(3.14);
  });
});

describe("idb/double@1 JSON form", () => {
  const codec = getCodec("idb/double@1");

  it("stores NaN and the infinities as text", () => {
    expect(toJson(codec, Number.NaN)).toBe("NaN");
    expect(toJson(codec, Number.POSITIVE_INFINITY)).toBe("Infinity");
    expect(fromJson(codec, "-Infinity")).toBe(Number.NEGATIVE_INFINITY);
  });
});

// ── idb/bool@1 ───────────────────────────────────────────────────────────────

describe("idb/bool@1", () => {
  const codec = getCodec("idb/bool@1");

  it("round-trips true and false", async () => {
    expect(await codec.toWire(true, ctx)).toBe(true);
    expect(await codec.toWire(false, ctx)).toBe(false);
  });
});

// ── idb/date@1 ───────────────────────────────────────────────────────────────

describe("idb/date@1", () => {
  const codec = getCodec("idb/date@1");
  const date = new Date("2024-06-15T12:00:00.000Z");

  it("toWire/fromWire are identity (Date → Date)", async () => {
    expect(await codec.toWire(date, ctx)).toBe(date);
    expect(await codec.fromWire(date, ctx)).toBe(date);
  });

  it("the JSON form produces an ISO string", () => {
    expect(toJson(codec, date)).toBe("2024-06-15T12:00:00.000Z");
  });

  it("reading the JSON form reconstructs the Date from ISO string", () => {
    const decoded = fromJson(codec, "2024-06-15T12:00:00.000Z") as Date;
    expect(decoded).toBeInstanceOf(Date);
    expect(decoded.toISOString()).toBe("2024-06-15T12:00:00.000Z");
  });

  it("JSON round-trip preserves millisecond precision", () => {
    const precise = new Date("2024-01-01T00:00:00.123Z");
    const decoded = fromJson(codec, toJson(codec, precise) as string) as Date;
    expect(decoded.getTime()).toBe(precise.getTime());
  });
});

describe("idb/date@1 data type", () => {
  const codec = getCodec("idb/date@1");

  it("stores any instant Date parses in toISOString form", () => {
    expect(codec.dataType.toContract(codec.dataType.valueFrom("2024-01-01T02:00:00+02:00", {}))).toBe(
      "2024-01-01T00:00:00.000Z"
    );
  });

  it("refuses text that names no instant", () => {
    expect(() => fromJson(codec, "not a date")).toThrow(/idb\/date JSON value must be/);
  });

  it("refuses a stored value that is not in toISOString form", () => {
    expect(() => codec.dataType.fromContract("2024-01-01T00:00:00Z", {})).toThrow(/2024-01-01T00:00:00.000Z/);
  });
});

// ── idb/bigint@1 ─────────────────────────────────────────────────────────────

describe("idb/bigint@1", () => {
  const codec = getCodec("idb/bigint@1");

  it("toWire/fromWire are identity", async () => {
    expect(await codec.toWire(9007199254740993n, ctx)).toBe(9007199254740993n);
  });

  it("the JSON form converts to string", () => {
    expect(toJson(codec, 9007199254740993n)).toBe("9007199254740993");
  });

  it("reading the JSON form reconstructs bigint", () => {
    expect(fromJson(codec, "9007199254740993")).toBe(9007199254740993n);
  });

  it("JSON round-trip preserves precision beyond Number.MAX_SAFE_INTEGER", () => {
    const big = 99999999999999999999n;
    expect(fromJson(codec, toJson(codec, big) as string)).toBe(big);
  });
});

// ── idb/decimal@1 ────────────────────────────────────────────────────────────

describe("idb/decimal@1", () => {
  const codec = getCodec("idb/decimal@1");

  it("stores and retrieves as string (no precision loss)", async () => {
    const d = "123456789.987654321";
    expect(await codec.toWire(d, ctx)).toBe(d);
    expect(await codec.fromWire(d, ctx)).toBe(d);
  });

  it("JSON round-trip is identity", () => {
    const d = "0.1";
    expect(fromJson(codec, toJson(codec, d) as string)).toBe(d);
  });

  it("does not coerce to Number (would lose precision)", () => {
    // 0.1 + 0.2 in floating point != "0.3"
    const d = "0.30000000000000004";
    expect(toJson(codec, d)).toBe("0.30000000000000004");
  });
});

// ── idb/json@1 ───────────────────────────────────────────────────────────────

describe("idb/json@1", () => {
  const codec = getCodec("idb/json@1");

  it("toWire/fromWire pass through any value", async () => {
    const obj = { a: 1, b: [true, null] };
    expect(await codec.toWire(obj, ctx)).toBe(obj);
    expect(await codec.fromWire(obj, ctx)).toBe(obj);
  });

  it("the JSON form does NOT double-stringify", () => {
    const obj = { x: 1 };
    const encoded = toJson(codec, obj);
    // Must be the object itself, not a JSON string of it
    expect(typeof encoded).not.toBe("string");
    expect(encoded).toEqual({ x: 1 });
  });

  it("encodes negative zero as zero without changing the input", () => {
    const input = { meta: { score: -0 }, items: [-0, 1] };
    expect(toJson(codec, input)).toStrictEqual({ meta: { score: 0 }, items: [0, 1] });
    expect(input.meta.score).toBe(-0);
    expect(input.items[0]).toBe(-0);
  });

  it("refuses undefined object members and array elements", () => {
    for (const value of [{ note: undefined }, [undefined], { items: [1, undefined] }]) {
      expect(() => toJson(codec, value)).toThrow(/cannot be represented as JSON/);
    }
  });

  it("keeps a shared JSON subtree shared in the encoding", () => {
    let tree: unknown = { score: -0 };
    for (let depth = 0; depth < 10; depth++) tree = [tree, tree];

    const encoded = toJson(codec, tree);
    expect(Array.isArray(encoded)).toBe(true);
    if (Array.isArray(encoded)) expect(encoded[0]).toBe(encoded[1]);
  });

  it("reading the JSON form is identity", () => {
    const val = [1, 2, 3];
    expect(fromJson(codec, val)).toBe(val);
  });
});

// ── idb/bytes@1 ──────────────────────────────────────────────────────────────

describe("idb/bytes@1", () => {
  const codec = getCodec("idb/bytes@1");

  it("toWire/fromWire are identity", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await codec.toWire(bytes, ctx)).toBe(bytes);
    expect(await codec.fromWire(bytes, ctx)).toBe(bytes);
  });

  it("the JSON form produces a base64 string", () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    expect(typeof toJson(codec, bytes)).toBe("string");
  });

  it("reading the JSON form reconstructs the Uint8Array", () => {
    const original = new Uint8Array([72, 101, 108, 108, 111]);
    const encoded = toJson(codec, original) as string;
    const decoded = fromJson(codec, encoded) as Uint8Array;
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect(decoded).toEqual(original);
  });

  it("JSON round-trip handles empty array", () => {
    const empty = new Uint8Array([]);
    const decoded = fromJson(codec, toJson(codec, empty) as string) as Uint8Array;
    expect(decoded).toEqual(empty);
  });

  it("JSON round-trip handles non-multiple-of-3 lengths (padding)", () => {
    const one = new Uint8Array([255]);
    const two = new Uint8Array([255, 128]);
    expect(fromJson(codec, toJson(codec, one) as string)).toEqual(one);
    expect(fromJson(codec, toJson(codec, two) as string)).toEqual(two);
  });

  // RFC 4648 section 10 test vectors: every padding length, in both directions.
  it.each([
    ["", ""],
    ["f", "Zg=="],
    ["fo", "Zm8="],
    ["foo", "Zm9v"],
    ["foob", "Zm9vYg=="],
    ["fooba", "Zm9vYmE="],
    ["foobar", "Zm9vYmFy"],
  ])("encodes %j as %j in standard padded base64", (text, base64) => {
    const bytes = new TextEncoder().encode(text);
    expect(toJson(codec, bytes)).toBe(base64);
    expect(fromJson(codec, base64)).toEqual(bytes);
  });

  it("round-trips every byte value through the same base64 as Node's Buffer", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(toJson(codec, all)).toBe(Buffer.from(all).toString("base64"));
    expect(fromJson(codec, toJson(codec, all) as string)).toEqual(all);
  });
});

// ── Codec registry completeness ───────────────────────────────────────────────

describe("codec registry", () => {
  const expectedIds = [
    "idb/string@1",
    "idb/int32@1",
    "idb/double@1",
    "idb/bool@1",
    "idb/date@1",
    "idb/bigint@1",
    "idb/decimal@1",
    "idb/json@1",
    "idb/bytes@1",
  ];

  it("contains all 9 expected codec IDs", () => {
    const ids = codecDescriptors.map((d) => d.codecId);
    for (const id of expectedIds) {
      expect(ids).toContain(id);
    }
  });

  it("has no duplicate IDs", () => {
    const ids = codecDescriptors.map((d) => d.codecId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every descriptor has traits and application types", () => {
    for (const desc of codecDescriptors) {
      expect(desc.traits.length).toBeGreaterThan(0);
      expect(idbCodecLookup.targetTypesFor(desc.codecId)?.length).toBeGreaterThan(0);
    }
  });

  // The framework refuses to assemble a stack whose codecs name an unregistered
  // data type (CONTRACT.DATA_TYPE_UNREGISTERED), so the target must register
  // every type its codecs use.
  it("every descriptor names a data type the target registers", () => {
    const registered = new Set(idbTargetDescriptorMeta.dataTypes.map((t) => t.id));
    for (const desc of codecDescriptors) {
      expect(desc.dataType, desc.codecId).toBeDefined();
      expect(registered.has(desc.dataType), `${desc.codecId} → ${desc.dataType}`).toBe(true);
    }
  });

  it("maps each codec to the data type of the same name", () => {
    for (const desc of codecDescriptors) {
      expect(desc.dataType).toBe(desc.codecId.replace(/@\d+$/, ""));
    }
  });
});
