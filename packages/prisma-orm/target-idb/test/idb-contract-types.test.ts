import { expect, it } from "vitest";
import { keyPathEquals, keyPathFields } from "../src/exports/pack";
it("normalizes scalar key paths while preserving compound declaration order", () => {
  expect(keyPathFields("id")).toEqual(["id"]);
  expect(keyPathFields(["b", "a"])).toEqual(["b", "a"]);
});
it("compares key paths by value, preserving array order, length, and native string/array distinctions", () => {
  expect(keyPathEquals("id", "id")).toBe(true);
  expect(keyPathEquals("id", "uuid")).toBe(false);
  expect(keyPathEquals(["orgId", "userId"], ["orgId", "userId"])).toBe(true);
  expect(keyPathEquals(["orgId", "userId"], ["userId", "orgId"])).toBe(false);
  expect(keyPathEquals(["orgId", "userId"], ["orgId"])).toBe(false);
  expect(keyPathEquals("id", ["id"])).toBe(false);
  expect(keyPathEquals(["id"], "id")).toBe(false);
});
