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
});
