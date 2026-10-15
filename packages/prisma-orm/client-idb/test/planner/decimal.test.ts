import { describe, expect, it } from "vitest";
import { andExpr, fieldFilter as f } from "@prisma-idb/adapter-idb/runtime";
import { explain } from "../../src/core/planner/explain";
import { planQuery } from "../../src/core/planner/plan";
import { catalog, field, source } from "./fixtures";

const decimal = field("idb/decimal@1");
const c = catalog([source("a", "by-a"), source(["b", "a"], "by-ba"), source("b", "by-b")], { a: decimal });

describe("Decimal access safety", () => {
  it.each(["eq", "in", "gt", "gte", "lt", "lte"] as const)("keeps %s out of native string ranges", (op) => {
    const where = f("a", op, op === "in" ? ["1e1", "10.0"] : "10");
    expect(planQuery(c, { where })).toEqual({ access: { kind: "full" }, exact: false });
    const primary = { ...c, primaryKey: source("a", undefined, true), indexes: [] };
    expect(planQuery(primary, { where })).toEqual({ access: { kind: "full" }, exact: false });
  });
  it("does not mistake numerically compatible Decimal predicates for string contradictions", () => {
    const where = andExpr([f("a", "gte", "9"), f("a", "lte", "10"), f("a", "eq", "1e1")]);
    expect(planQuery(c, { where })).toEqual({ access: { kind: "full" }, exact: false });
  });
  it.each(["asc", "desc"] as const)("does not use native Decimal %s ordering", (order) => {
    const request = { orderBy: { a: order }, take: 1 };
    expect(planQuery(c, request).direction).toBeUndefined();
    expect(
      planQuery({ ...c, primaryKey: source("a", undefined, true), indexes: [] }, request).direction
    ).toBeUndefined();
    const where = andExpr([f("b", "eq", "group"), f("a", "gt", "9")]);
    const plan = planQuery(c, { ...request, where });
    expect(JSON.parse(explain(plan))).toMatchObject({ access: "index", index: "by-b", exact: false });
    expect(plan.direction).toBeUndefined();
  });
  it("retains a safe non-Decimal lookup and checks Decimal equality as a residual", () => {
    const plan = planQuery(c, { where: andExpr([f("b", "eq", "group"), f("a", "eq", "10.0")]) });
    expect(JSON.parse(explain(plan))).toMatchObject({ access: "index", index: "by-b", exact: false });
  });
  it("rejects invalid numeric operands before an empty plan can bypass evaluation", () => {
    expect(() => planQuery(c, { where: andExpr([f("b", "in", []), f("a", "gt", "NaN")]) })).toThrow(
      'Expected finite Decimal text for field "a"'
    );
  });
});
