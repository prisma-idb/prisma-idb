import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { keyEquals, keyToken } from "../src/core/types";

describe("keyEquals", () => {
  it("compares Dates by timestamp, alone and inside compound keys", () => {
    expect(keyEquals(new Date(5), new Date(5))).toBe(true);
    expect(keyEquals(new Date(5), new Date(6))).toBe(false);
    expect(keyEquals(["a", new Date(5)], ["a", new Date(5)])).toBe(true);
    expect(keyEquals(["a", new Date(5)], ["a", new Date(6)])).toBe(false);
  });

  it("compares binary keys by content", () => {
    expect(keyEquals(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(keyEquals(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
  });
});

describe("keyToken", () => {
  it("keeps String() for string/number keys", () => {
    expect(keyToken("u1")).toBe("u1");
    expect(keyToken(7)).toBe("7");
  });

  it("matches equal Dates and equal bytes, distinguishes different ones", () => {
    expect(keyToken(new Date(5))).toBe(keyToken(new Date(5)));
    expect(keyToken(new Date(5))).not.toBe(keyToken(new Date(6)));
    expect(keyToken(new Uint8Array([1, 2]))).toBe(keyToken(new Uint8Array([1, 2])));
    expect(keyToken(new Uint8Array([1, 2]))).not.toBe(keyToken(new Uint8Array([1, 3])));
  });

  it("distinguishes 1 from '1' inside compound keys", () => {
    expect(keyToken([1, "a"])).not.toBe(keyToken(["1", "a"]));
    expect(keyToken([new Date(5), "a"])).toBe(keyToken([new Date(5), "a"]));
  });
});
