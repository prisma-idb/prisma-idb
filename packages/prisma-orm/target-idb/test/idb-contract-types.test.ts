import { expect, it } from "vitest";
import { keyPathEquals, keyPathFields } from "../src/exports/pack";

it("normalizes scalar key paths while preserving compound declaration order", () => {
  expect(keyPathFields("id")).toEqual(["id"]);
  expect(keyPathFields(["b", "a"])).toEqual(["b", "a"]);
});

it.each([
  { name: "equal scalar paths", left: "id", right: "id", equal: true },
  { name: "different scalar paths", left: "id", right: "uuid", equal: false },
  { name: "equal compound paths", left: ["orgId", "userId"], right: ["orgId", "userId"], equal: true },
  { name: "different compound order", left: ["orgId", "userId"], right: ["userId", "orgId"], equal: false },
  { name: "different compound length", left: ["orgId", "userId"], right: ["orgId"], equal: false },
  { name: "scalar versus array", left: "id", right: ["id"], equal: false },
  { name: "array versus scalar", left: ["id"], right: "id", equal: false },
])("compares $name by value", ({ left, right, equal }) => {
  expect(keyPathEquals(left, right)).toBe(equal);
});
