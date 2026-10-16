import { describe, expect, it } from "vitest";
import { evaluateFilter, assertValidDecimalFilter } from "../src/core/filter-eval";
import { andExpr, orExpr, notExpr, fieldFilter as f } from "../src/core/idb-filter-expr";

const fields = { price: { codecId: "idb/decimal@1", collection: false } };

describe("contract-derived Decimal filter evaluation", () => {
  it("uses numeric equality through nested boolean expressions", () => {
    const expr = andExpr([orExpr([f("price", "eq", "1e1"), f("price", "eq", "2")]), notExpr(f("price", "lt", "9"))]);
    expect(evaluateFilter(expr, { price: "10.00" }, fields)).toBe(true);
    expect(evaluateFilter(expr, { price: "2" }, fields)).toBe(false);
  });
  it("leaves strings and collection equality unchanged", () => {
    expect(evaluateFilter(f("label", "eq", "10"), { label: "1e1" }, fields)).toBe(false);
    expect(evaluateFilter(f("label", "gt", "9"), { label: "10" }, fields)).toBe(false);
    expect(
      evaluateFilter(f("price", "eq", ["10"]), { price: ["10"] }, { price: { ...fields.price, collection: true } })
    ).toBe(true);
  });
  it("retains null comparison and membership behavior", () => {
    expect(evaluateFilter(f("price", "eq", null), {}, fields)).toBe(true);
    expect(evaluateFilter(f("price", "in", [null, "1e1"]), { price: "10.00" }, fields)).toBe(true);
    expect(evaluateFilter(f("price", "gte", "0"), { price: null }, fields)).toBe(false);
  });
  it("validates operands in every boolean branch without treating text operators as numeric", () => {
    expect(() =>
      assertValidDecimalFilter(orExpr([f("price", "eq", "1"), notExpr(f("price", "in", ["NaN"]))]), fields)
    ).toThrow("Expected finite Decimal text");
    expect(() => assertValidDecimalFilter(f("price", "startsWith", "-"), fields)).not.toThrow();
    expect(evaluateFilter(f("price", "startsWith", "-"), { price: "-10.0" }, fields)).toBe(true);
  });
});
