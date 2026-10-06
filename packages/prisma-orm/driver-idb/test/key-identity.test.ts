/// <reference types="node" />
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { keyIdentity } from "../src/core/execute/key-identity";

describe("keyIdentity", () => {
  it("is equal for keys IndexedDB treats as equal", () => {
    expect(keyIdentity(["a", 1])).toBe(keyIdentity(["a", 1]));
    expect(keyIdentity(new Date(5))).toBe(keyIdentity(new Date(5)));
    expect(keyIdentity(new Uint8Array([1, 2]))).toBe(keyIdentity(new Uint8Array([1, 2]).buffer));
    expect(keyIdentity(-0)).toBe(keyIdentity(0));
  });

  it("differs for keys of different type or value", () => {
    expect(keyIdentity("1")).not.toBe(keyIdentity(1));
    expect(keyIdentity(new Date(1))).not.toBe(keyIdentity(1));
    expect(keyIdentity(["a", "b"])).not.toBe(keyIdentity(['a,s:"b']));
    expect(keyIdentity([["a"], "b"])).not.toBe(keyIdentity(["a", ["b"]]));
    expect(keyIdentity(new Uint8Array([1, 2]))).not.toBe(keyIdentity(new Uint8Array([2, 1])));
  });

  it("identifies a binary key whose Symbol.toStringTag is overridden", () => {
    const buffer = new Uint8Array([1, 2]).buffer;
    Object.defineProperty(buffer, Symbol.toStringTag, { value: "Custom" });
    expect(keyIdentity(buffer)).toBe(keyIdentity(new Uint8Array([1, 2])));
  });

  describe("keys from another realm", () => {
    const foreign = (source: string) => runInNewContext(source) as IDBValidKey;

    it("tells dates apart by time", () => {
      expect(keyIdentity(foreign("new Date(1)"))).not.toBe(keyIdentity(foreign("new Date(2)")));
      expect(keyIdentity(foreign("new Date(5)"))).toBe(keyIdentity(new Date(5)));
    });

    it("tells binary keys apart by content", () => {
      expect(keyIdentity(foreign("new Uint8Array([1, 2]).buffer"))).toBe(keyIdentity(new Uint8Array([1, 2])));
      expect(keyIdentity(foreign("new Uint8Array([1, 2]).buffer"))).not.toBe(
        keyIdentity(foreign("new Uint8Array([2, 1]).buffer"))
      );
      expect(keyIdentity(foreign("new Uint8Array([1, 2])"))).toBe(keyIdentity(new Uint8Array([1, 2])));
    });

    it("keeps the offset and length of a typed view", () => {
      const view = foreign("new Uint8Array(new Uint8Array([9, 1, 2, 9]).buffer, 1, 2)");
      expect(keyIdentity(view)).toBe(keyIdentity(new Uint8Array([1, 2])));
    });

    it("tells arrays holding foreign keys apart", () => {
      expect(keyIdentity(foreign("['a', new Date(1)]"))).not.toBe(keyIdentity(foreign("['a', new Date(2)]")));
      expect(keyIdentity(foreign("[new Uint8Array([1]).buffer]"))).not.toBe(
        keyIdentity(foreign("[new Uint8Array([2]).buffer]"))
      );
    });
  });
});
