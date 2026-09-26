import { describe, expect, it } from "vitest";
import { keyPathEquals, keyPathFields } from "../src/core/idb-contract-types";

describe("keyPathFields", () => {
  it("wraps a single string field into a 1-element array", () => {
    expect(keyPathFields("id")).toEqual(["id"]);
  });

  it("passes an array keyPath through unchanged (same field order)", () => {
    expect(keyPathFields(["orgId", "userId"])).toEqual(["orgId", "userId"]);
  });

  it("preserves declaration order (does not sort)", () => {
    expect(keyPathFields(["b", "a"])).toEqual(["b", "a"]);
  });
});

describe("keyPathEquals", () => {
  it("returns true for identical single-field strings", () => {
    expect(keyPathEquals("id", "id")).toBe(true);
  });

  it("returns false for different single-field strings", () => {
    expect(keyPathEquals("id", "uuid")).toBe(false);
  });

  it("returns true for identical compound arrays in the same order", () => {
    expect(keyPathEquals(["orgId", "userId"], ["orgId", "userId"])).toBe(true);
  });

  it("returns false when compound array field order differs (order-sensitive)", () => {
    expect(keyPathEquals(["orgId", "userId"], ["userId", "orgId"])).toBe(false);
  });

  it("returns false when compound arrays have different lengths", () => {
    expect(keyPathEquals(["orgId", "userId"], ["orgId"])).toBe(false);
  });

  it("returns false for two freshly-constructed arrays with identical content (not reference equality)", () => {
    const a = ["orgId", "userId"];
    const b = ["orgId", "userId"];
    expect(a).not.toBe(b); // sanity: genuinely different array instances
    expect(keyPathEquals(a, b)).toBe(true);
  });

  it("returns false for a bare string vs. a 1-element array with the same field name — genuinely different native IDB configurations", () => {
    expect(keyPathEquals("id", ["id"])).toBe(false);
    expect(keyPathEquals(["id"], "id")).toBe(false);
  });
});
