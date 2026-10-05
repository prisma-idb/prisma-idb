import { expect, it } from "vitest";
import { fieldFilter } from "@prisma-idb/adapter-idb/runtime";
import { explain } from "../../src/core/planner/explain";
import { planQuery } from "../../src/core/planner/plan";
import { catalog, source } from "./fixtures";

it("describes dates, bytes, arrays, and infinite endpoints without losing key identity", () => {
  const c = catalog([source("a", "a")]);
  expect(
    explain(planQuery(c, { where: fieldFilter("a", "in", [new Date(0), new Uint8Array([1, 2]), ["x"], Infinity]) }))
  ).toBe(
    '{"access":"index","index":"a","keyPath":"a","ranges":[{"kind":"only","key":{"number":"Infinity"}},{"kind":"only","key":{"date":"1970-01-01T00:00:00.000Z"}},{"kind":"only","key":{"bytes":[1,2]}},{"kind":"only","key":["x"]}],"exact":true}'
  );
});
it("produces the same descriptor for equivalent membership orders", () => {
  const c = catalog([source("a", "a")]);
  const first = planQuery(c, { where: fieldFilter("a", "in", ["z", "a", "z"]) });
  const second = planQuery(c, { where: fieldFilter("a", "in", ["a", "z"]) });
  expect(explain(first)).toBe(explain(second));
  expect(explain(first)).toBe(explain(first));
});
