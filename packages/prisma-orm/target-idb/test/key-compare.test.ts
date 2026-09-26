import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { fieldValueToken, isValidIdbKey } from "../src/core/key-compare";

describe("isValidIdbKey", () => {
  it("accepts the key types IndexedDB accepts", () => {
    for (const key of [1, "a", new Date(0), new Uint8Array([1]), new ArrayBuffer(1), [1, "a", [new Date(0)]]]) {
      expect(isValidIdbKey(key)).toBe(true);
      expect(() => IDBKeyRange.only(key)).not.toThrow();
    }
  });

  it("rejects what IndexedDB rejects", () => {
    const cyclic: unknown[] = [1];
    cyclic.push(cyclic);
    const shared = [1];
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [1, , 3];
    for (const value of [
      NaN,
      true,
      1n,
      null,
      undefined,
      {},
      new Date(NaN),
      [1, true],
      sparse,
      cyclic,
      [shared, shared],
    ]) {
      expect(isValidIdbKey(value)).toBe(false);
      expect(() => IDBKeyRange.only(value)).toThrow();
    }
  });

  it("treats an index inherited from Array.prototype as a hole", () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [1, , 3];
    Object.defineProperty(Array.prototype, 1, { value: 2, configurable: true, writable: true });
    try {
      expect(sparse[1]).toBe(2);
      expect(isValidIdbKey(sparse)).toBe(false);
    } finally {
      delete (Array.prototype as unknown as Record<number, unknown>)[1];
    }
  });
});

describe("fieldValueToken", () => {
  it("gives equal Dates, bytes and arrays the same token", () => {
    expect(fieldValueToken(new Date(5))).toBe(fieldValueToken(new Date(5)));
    expect(fieldValueToken(new Uint8Array([1, 2]))).toBe(fieldValueToken(new Uint8Array([1, 2])));
    expect(fieldValueToken(["a", 1])).toBe(fieldValueToken(["a", 1]));
  });

  it("never gives a string the same token as an object key", () => {
    const dateToken = fieldValueToken(new Date(5));
    expect(typeof dateToken).toBe("string");
    expect(fieldValueToken(dateToken)).not.toBe(dateToken);
    expect(fieldValueToken(String(dateToken).slice(2))).not.toBe(dateToken);
  });

  it("keeps numbers and strings apart", () => {
    expect(fieldValueToken(1)).not.toBe(fieldValueToken("1"));
  });
});
