import { describe, expect, it } from "vitest";
import { IDBKeyRange as FakeIDBKeyRange } from "fake-indexeddb";
import { isKeyRange } from "../src/core/key-range";

/** Range-like properties that any value, including a valid key, can carry. */
const rangeLike = { lower: 1, upper: 2, lowerOpen: false, upperOpen: false };

describe("isKeyRange", () => {
  it("recognizes a range from an injected IndexedDB and a plain object with range bounds", () => {
    expect(isKeyRange(FakeIDBKeyRange.bound(1, 2))).toBe(true);
    expect(isKeyRange({ ...rangeLike })).toBe(true);
  });

  it.each([
    ["an array key", () => Object.assign(["t", "p"], rangeLike)],
    ["a date key", () => Object.assign(new Date(0), rangeLike)],
    ["an ArrayBuffer key", () => Object.assign(new ArrayBuffer(2), rangeLike)],
    ["a typed array key", () => Object.assign(new Uint8Array(2), rangeLike)],
    ["a DataView key", () => Object.assign(new DataView(new ArrayBuffer(2)), rangeLike)],
  ])("treats %s with range-like properties as a single key", (_, key) => {
    expect(isKeyRange(key())).toBe(false);
  });

  it.each([
    ["a string", "k"],
    ["a number", 1],
    ["null", null],
  ])("treats %s as not a range", (_, value) => {
    expect(isKeyRange(value)).toBe(false);
  });
});
