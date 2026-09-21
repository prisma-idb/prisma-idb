import type { Codec, CodecCallContext } from "@prisma/orm-framework/components/codec";
import { describe, expect, it } from "vitest";
import { codecDescriptors } from "../src/core/codecs";

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
    expect(await codec.encode("hello", ctx)).toBe("hello");
    expect(await codec.decode("hello", ctx)).toBe("hello");
  });

  it("encodeJson / decodeJson are identity", () => {
    expect(codec.encodeJson("world")).toBe("world");
    expect(codec.decodeJson("world")).toBe("world");
  });
});

// ── idb/int32@1 ──────────────────────────────────────────────────────────────

describe("idb/int32@1", () => {
  const codec = getCodec("idb/int32@1");

  it("round-trips a valid int32", async () => {
    expect(await codec.encode(42, ctx)).toBe(42);
    expect(await codec.decode(42, ctx)).toBe(42);
  });

  it("throws for non-integer input", async () => {
    await expect(codec.encode(3.14, ctx)).rejects.toThrow("not an integer");
  });

  it("throws for values outside int32 range", async () => {
    await expect(codec.encode(2 ** 31, ctx)).rejects.toThrow("out of range");
    await expect(codec.encode(-(2 ** 31) - 1, ctx)).rejects.toThrow("out of range");
  });

  it("accepts boundary values", async () => {
    expect(await codec.encode(2 ** 31 - 1, ctx)).toBe(2 ** 31 - 1);
    expect(await codec.encode(-(2 ** 31), ctx)).toBe(-(2 ** 31));
  });
});

// ── idb/double@1 ─────────────────────────────────────────────────────────────

describe("idb/double@1", () => {
  const codec = getCodec("idb/double@1");

  it("round-trips a float", async () => {
    expect(await codec.encode(3.14, ctx)).toBe(3.14);
    expect(await codec.decode(3.14, ctx)).toBe(3.14);
  });
});

// ── idb/bool@1 ───────────────────────────────────────────────────────────────

describe("idb/bool@1", () => {
  const codec = getCodec("idb/bool@1");

  it("round-trips true and false", async () => {
    expect(await codec.encode(true, ctx)).toBe(true);
    expect(await codec.encode(false, ctx)).toBe(false);
  });
});

// ── idb/date@1 ───────────────────────────────────────────────────────────────

describe("idb/date@1", () => {
  const codec = getCodec("idb/date@1");
  const date = new Date("2024-06-15T12:00:00.000Z");

  it("encode/decode are identity (Date → Date)", async () => {
    expect(await codec.encode(date, ctx)).toBe(date);
    expect(await codec.decode(date, ctx)).toBe(date);
  });

  it("encodeJson produces an ISO string", () => {
    expect(codec.encodeJson(date)).toBe("2024-06-15T12:00:00.000Z");
  });

  it("decodeJson reconstructs the Date from ISO string", () => {
    const decoded = codec.decodeJson("2024-06-15T12:00:00.000Z") as Date;
    expect(decoded).toBeInstanceOf(Date);
    expect(decoded.toISOString()).toBe("2024-06-15T12:00:00.000Z");
  });

  it("JSON round-trip preserves millisecond precision", () => {
    const precise = new Date("2024-01-01T00:00:00.123Z");
    const decoded = codec.decodeJson(codec.encodeJson(precise) as string) as Date;
    expect(decoded.getTime()).toBe(precise.getTime());
  });
});

// ── idb/bigint@1 ─────────────────────────────────────────────────────────────

describe("idb/bigint@1", () => {
  const codec = getCodec("idb/bigint@1");

  it("encode/decode are identity", async () => {
    expect(await codec.encode(9007199254740993n, ctx)).toBe(9007199254740993n);
  });

  it("encodeJson converts to string", () => {
    expect(codec.encodeJson(9007199254740993n)).toBe("9007199254740993");
  });

  it("decodeJson reconstructs bigint", () => {
    expect(codec.decodeJson("9007199254740993")).toBe(9007199254740993n);
  });

  it("JSON round-trip preserves precision beyond Number.MAX_SAFE_INTEGER", () => {
    const big = 99999999999999999999n;
    expect(codec.decodeJson(codec.encodeJson(big) as string)).toBe(big);
  });
});

// ── idb/decimal@1 ────────────────────────────────────────────────────────────

describe("idb/decimal@1", () => {
  const codec = getCodec("idb/decimal@1");

  it("stores and retrieves as string (no precision loss)", async () => {
    const d = "123456789.987654321";
    expect(await codec.encode(d, ctx)).toBe(d);
    expect(await codec.decode(d, ctx)).toBe(d);
  });

  it("JSON round-trip is identity", () => {
    const d = "0.1";
    expect(codec.decodeJson(codec.encodeJson(d) as string)).toBe(d);
  });

  it("does not coerce to Number (would lose precision)", () => {
    // 0.1 + 0.2 in floating point != "0.3"
    const d = "0.30000000000000004";
    expect(codec.encodeJson(d)).toBe("0.30000000000000004");
  });
});

// ── idb/json@1 ───────────────────────────────────────────────────────────────

describe("idb/json@1", () => {
  const codec = getCodec("idb/json@1");

  it("encode/decode pass through any value", async () => {
    const obj = { a: 1, b: [true, null] };
    expect(await codec.encode(obj, ctx)).toBe(obj);
    expect(await codec.decode(obj, ctx)).toBe(obj);
  });

  it("encodeJson does NOT double-stringify", () => {
    const obj = { x: 1 };
    const encoded = codec.encodeJson(obj);
    // Must be the object itself, not a JSON string of it
    expect(typeof encoded).not.toBe("string");
    expect(encoded).toEqual({ x: 1 });
  });

  it("decodeJson is identity", () => {
    const val = [1, 2, 3];
    expect(codec.decodeJson(val)).toBe(val);
  });
});

// ── idb/bytes@1 ──────────────────────────────────────────────────────────────

describe("idb/bytes@1", () => {
  const codec = getCodec("idb/bytes@1");

  it("encode/decode are identity", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await codec.encode(bytes, ctx)).toBe(bytes);
    expect(await codec.decode(bytes, ctx)).toBe(bytes);
  });

  it("encodeJson produces a base64 string", () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    expect(typeof codec.encodeJson(bytes)).toBe("string");
  });

  it("decodeJson reconstructs the Uint8Array", () => {
    const original = new Uint8Array([72, 101, 108, 108, 111]);
    const encoded = codec.encodeJson(original) as string;
    const decoded = codec.decodeJson(encoded) as Uint8Array;
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect(decoded).toEqual(original);
  });

  it("JSON round-trip handles empty array", () => {
    const empty = new Uint8Array([]);
    const decoded = codec.decodeJson(codec.encodeJson(empty) as string) as Uint8Array;
    expect(decoded).toEqual(empty);
  });

  it("JSON round-trip handles non-multiple-of-3 lengths (padding)", () => {
    const one = new Uint8Array([255]);
    const two = new Uint8Array([255, 128]);
    expect(codec.decodeJson(codec.encodeJson(one) as string)).toEqual(one);
    expect(codec.decodeJson(codec.encodeJson(two) as string)).toEqual(two);
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

  it("every descriptor has traits and targetTypes", () => {
    for (const desc of codecDescriptors) {
      expect(desc.traits.length).toBeGreaterThan(0);
      expect(desc.targetTypes.length).toBeGreaterThan(0);
    }
  });
});
