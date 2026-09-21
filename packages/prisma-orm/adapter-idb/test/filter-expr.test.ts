/**
 * Filter expression AST + evaluator unit tests.
 *
 * Covers:
 *   - All operators (eq, neq, gt, lt, gte, lte, in, notIn, contains,
 *     startsWith, endsWith)
 *   - and / or / not combinators (including degenerate empty arrays)
 *   - null-check (treats null and undefined as equivalent)
 *   - Shorthand → expression lift, including the null-as-null-check rule
 *   - Freezing on factory-built nodes
 */
import { describe, expect, it } from "vitest";
import {
  andExpr,
  fieldFilter,
  nullCheckExpr,
  notExpr,
  orExpr,
  shorthandToFilterExpr,
} from "../src/core/idb-filter-expr";
import { evaluateFilter } from "../src/core/filter-eval";

const ALICE = { id: "u1", name: "Alice", email: "alice@example.com", score: 100, active: true, bio: null };
const BOB = { id: "u2", name: "Bob", email: "bob@example.com", score: 50, active: false, bio: "Bob's bio" };
const CAROL = { id: "u3", name: "Carol", email: "carol@example.com", score: 75, active: true };
// CAROL has no `bio` field (i.e. stored as undefined by structured clone).

describe("idb-filter-expr — factories", () => {
  it("freezes the produced nodes", () => {
    const f = fieldFilter("name", "eq", "Alice");
    expect(Object.isFrozen(f)).toBe(true);
  });

  it("freezes the inner exprs array of andExpr / orExpr", () => {
    const e = andExpr([fieldFilter("name", "eq", "Alice")]);
    expect(Object.isFrozen(e.exprs)).toBe(true);
  });
});

describe("evaluateFilter — field operators", () => {
  it("eq matches the exact value", () => {
    expect(evaluateFilter(fieldFilter("name", "eq", "Alice"), ALICE)).toBe(true);
    expect(evaluateFilter(fieldFilter("name", "eq", "Bob"), ALICE)).toBe(false);
  });

  it("neq is the inverse of eq, with null/undefined parity", () => {
    expect(evaluateFilter(fieldFilter("name", "neq", "Alice"), ALICE)).toBe(false);
    expect(evaluateFilter(fieldFilter("name", "neq", "Bob"), ALICE)).toBe(true);
    // `neq null` is true only when the field has a real value.
    expect(evaluateFilter(fieldFilter("bio", "neq", null), ALICE)).toBe(false); // bio === null
    expect(evaluateFilter(fieldFilter("bio", "neq", null), CAROL)).toBe(false); // bio === undefined
    expect(evaluateFilter(fieldFilter("bio", "neq", null), BOB)).toBe(true);
  });

  it("gt / lt / gte / lte work on numeric and string fields", () => {
    expect(evaluateFilter(fieldFilter("score", "gt", 75), ALICE)).toBe(true);
    expect(evaluateFilter(fieldFilter("score", "lt", 75), ALICE)).toBe(false);
    expect(evaluateFilter(fieldFilter("score", "gte", 100), ALICE)).toBe(true);
    expect(evaluateFilter(fieldFilter("score", "lte", 99), ALICE)).toBe(false);
    expect(evaluateFilter(fieldFilter("name", "gt", "Aaron"), ALICE)).toBe(true);
  });

  it("gt / lt / etc. return false when the cell is null or undefined", () => {
    expect(evaluateFilter(fieldFilter("score", "gt", 0), { id: "x" } as Record<string, unknown>)).toBe(false);
    expect(evaluateFilter(fieldFilter("bio", "gt", "x"), ALICE)).toBe(false); // bio === null
  });

  it("in / notIn use strict equality per element", () => {
    expect(evaluateFilter(fieldFilter("name", "in", ["Alice", "Bob"]), ALICE)).toBe(true);
    expect(evaluateFilter(fieldFilter("name", "in", ["Bob", "Carol"]), ALICE)).toBe(false);
    expect(evaluateFilter(fieldFilter("name", "notIn", ["Bob", "Carol"]), ALICE)).toBe(true);
    expect(evaluateFilter(fieldFilter("name", "notIn", ["Alice"]), ALICE)).toBe(false);
  });

  it("contains / startsWith / endsWith coerce both sides to strings", () => {
    expect(evaluateFilter(fieldFilter("email", "contains", "@example"), ALICE)).toBe(true);
    expect(evaluateFilter(fieldFilter("email", "startsWith", "alice"), ALICE)).toBe(true);
    expect(evaluateFilter(fieldFilter("email", "endsWith", ".com"), ALICE)).toBe(true);
    expect(evaluateFilter(fieldFilter("score", "contains", "10"), ALICE)).toBe(true); // String(100).includes("10")
  });
});

describe("evaluateFilter — null-check", () => {
  it("isNull: true matches null and undefined", () => {
    expect(evaluateFilter(nullCheckExpr("bio", true), ALICE)).toBe(true); // null
    expect(evaluateFilter(nullCheckExpr("bio", true), CAROL)).toBe(true); // undefined
    expect(evaluateFilter(nullCheckExpr("bio", true), BOB)).toBe(false); // string
  });

  it("isNull: false matches any non-null/undefined value", () => {
    expect(evaluateFilter(nullCheckExpr("bio", false), BOB)).toBe(true);
    expect(evaluateFilter(nullCheckExpr("bio", false), ALICE)).toBe(false);
  });
});

describe("evaluateFilter — combinators", () => {
  it("and is short-circuiting and treats empty as true", () => {
    expect(evaluateFilter(andExpr([]), ALICE)).toBe(true);
    expect(evaluateFilter(andExpr([fieldFilter("name", "eq", "Alice"), fieldFilter("score", "gt", 50)]), ALICE)).toBe(
      true
    );
    expect(evaluateFilter(andExpr([fieldFilter("name", "eq", "Alice"), fieldFilter("score", "lt", 50)]), ALICE)).toBe(
      false
    );
  });

  it("or is short-circuiting and treats empty as false", () => {
    expect(evaluateFilter(orExpr([]), ALICE)).toBe(false);
    expect(evaluateFilter(orExpr([fieldFilter("name", "eq", "Nobody"), fieldFilter("score", "gte", 100)]), ALICE)).toBe(
      true
    );
    expect(evaluateFilter(orExpr([fieldFilter("name", "eq", "Nobody"), fieldFilter("score", "lt", 50)]), ALICE)).toBe(
      false
    );
  });

  it("not negates the inner expression", () => {
    expect(evaluateFilter(notExpr(fieldFilter("name", "eq", "Alice")), ALICE)).toBe(false);
    expect(evaluateFilter(notExpr(fieldFilter("name", "eq", "Bob")), ALICE)).toBe(true);
  });
});

describe("shorthandToFilterExpr", () => {
  it("returns undefined for an empty shorthand", () => {
    expect(shorthandToFilterExpr({})).toBeUndefined();
  });

  it("returns the bare field filter for a single non-null entry", () => {
    const e = shorthandToFilterExpr({ name: "Alice" });
    expect(e).toEqual({ kind: "field", field: "name", op: "eq", value: "Alice" });
  });

  it("wraps multi-key shorthands in an and-expression", () => {
    const e = shorthandToFilterExpr({ name: "Alice", active: true });
    expect(e?.kind).toBe("and");
    if (e?.kind === "and") expect(e.exprs).toHaveLength(2);
  });

  it("lifts null values to null-check expressions, not literal-null equalities", () => {
    const e = shorthandToFilterExpr({ bio: null });
    expect(e).toEqual({ kind: "null-check", field: "bio", isNull: true });
  });

  it("drops undefined entries entirely", () => {
    const e = shorthandToFilterExpr({ name: "Alice", bio: undefined });
    expect(e).toEqual({ kind: "field", field: "name", op: "eq", value: "Alice" });
  });
});
