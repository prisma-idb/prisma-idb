import { describe, expect, it } from "vitest";
import { transformRecord } from "../src/exports/runtime";
import {
  coerce,
  defaultIfMissing,
  pipe,
  setLiteral,
  transformRecordsOp,
  type IdbValueTransform,
} from "../src/exports/migration";

const conversions: readonly [IdbValueTransform, unknown, unknown][] = [
  [coerce("int"), true, 1],
  [coerce("int"), false, 0],
  [coerce("int"), 1.5, 1.5],
  [coerce("int"), "42", 42],
  [coerce("int"), "", 0],
  [coerce("string"), true, "true"],
  [coerce("string"), false, "false"],
  [coerce("string"), 42, "42"],
  [coerce("string"), "text", "text"],
  [coerce("boolean"), true, true],
  [coerce("boolean"), false, false],
  [coerce("boolean"), 0, false],
  [coerce("boolean"), -2, true],
  [coerce("boolean"), "true", true],
  [coerce("boolean"), "false", false],
  [coerce("isoDateString"), 0, "1970-01-01T00:00:00.000Z"],
  [coerce("isoDateString"), "2026-01-02", "2026-01-02"],
];

const invalid: readonly [IdbValueTransform, unknown, string][] = [
  [coerce("int"), "abc", "cannot coerce abc to int"],
  [coerce("boolean"), "yes", "cannot coerce yes to boolean"],
  [coerce("boolean"), "TRUE", "cannot coerce TRUE to boolean"],
  [coerce("isoDateString"), true, "cannot coerce true to isoDateString"],
  [coerce("isoDateString"), false, "cannot coerce false to isoDateString"],
  [coerce("isoDateString"), "not a date", "cannot coerce not a date to isoDateString"],
  [coerce("isoDateString"), Infinity, "Invalid time value"],
  [coerce("isoDateString"), NaN, "Invalid time value"],
  [coerce("isoDateString"), 8_640_000_000_000_001, "Invalid time value"],
];

describe.each(["full", "patch"] as const)("transformRecord in %s mode", (mode) => {
  it.each(conversions)("converts %j applied to %j", (transform, value, expected) => {
    const input = Object.freeze({ field: value, untouched: "keep" });
    expect(transformRecord(transformRecordsOp("users", { fields: { field: transform } }), input, mode)).toEqual({
      field: expected,
      untouched: "keep",
    });
    expect(input.field).toEqual(value);
  });

  it.each(invalid)("rejects invalid input to %j: %j", (transform, value, message) => {
    expect(() =>
      transformRecord(transformRecordsOp("users", { fields: { field: transform } }), { field: value }, mode)
    ).toThrow(message);
  });

  it.each(["int", "string", "boolean", "isoDateString"] as const)("passes null and undefined through %s", (to) => {
    const op = transformRecordsOp("users", { fields: { field: coerce(to) } });
    expect(transformRecord(op, { field: null }, mode)).toEqual({ field: null });
    expect(transformRecord(op, { field: undefined }, mode)).toEqual({ field: undefined });
    expect(transformRecord(op, {}, mode)).toStrictEqual({});
  });

  it("keeps absent fields absent through an empty pipe", () => {
    const op = transformRecordsOp("users", { fields: { field: pipe() } });
    expect(transformRecord(op, {}, mode)).toStrictEqual({});
    expect(transformRecord(op, { field: undefined }, mode)).toStrictEqual({ field: undefined });
  });

  it("renames, transforms the new name, then removes fields", () => {
    const input = Object.freeze({ old: true, obsolete: 1 });
    const op = transformRecordsOp("users", {
      renameFields: { renamed: "old" },
      fields: { renamed: coerce("int"), obsolete: setLiteral(0) },
      removeFields: ["obsolete"],
    });
    expect(transformRecord(op, input, mode)).toEqual({ renamed: 1 });
    expect(input).toEqual({ old: true, obsolete: 1 });
  });

  it.each([
    { renameFields: { a: "b", b: "a" }, expected: { a: "y", b: "x" } },
    { renameFields: { c: "b", b: "a" }, expected: { c: "y", b: "x" } },
    { renameFields: { b: "a", c: "b" }, expected: { b: "x", c: "y" } },
  ])("reads overlapping renames from the original record: %j", ({ renameFields, expected }) => {
    const input = Object.freeze({ a: "x", b: "y" });
    const op = transformRecordsOp("users", { renameFields });
    expect(transformRecord(op, input, mode)).toStrictEqual(expected);
    expect(input).toStrictEqual({ a: "x", b: "y" });
  });

  it("keeps absent rename sources absent and permits a self-rename", () => {
    const op = transformRecordsOp("users", { renameFields: { added: "missing", field: "field" } });
    expect(transformRecord(op, { field: 1 }, mode)).toEqual({ field: 1 });
  });

  it("only backfills undefined in full mode", () => {
    const op = transformRecordsOp("users", { fields: { role: defaultIfMissing("member") } });
    expect(transformRecord(op, { role: "admin" }, mode)).toEqual({ role: "admin" });
    expect(transformRecord(op, { role: null }, mode)).toEqual({ role: null });
    expect(transformRecord(op, { role: undefined }, mode)).toEqual({ role: mode === "full" ? "member" : undefined });
    expect(transformRecord(op, {}, mode)).toEqual(mode === "full" ? { role: "member" } : {});
  });

  it("only sets literals in full mode", () => {
    const op = transformRecordsOp("users", { fields: { count: setLiteral(0) } });
    expect(transformRecord(op, { count: 9 }, mode)).toEqual({ count: mode === "full" ? 0 : 9 });
    expect(transformRecord(op, {}, mode)).toEqual(mode === "full" ? { count: 0 } : {});
  });

  it("applies nested pipes in order, skipping defaults and literals in patches", () => {
    const op = transformRecordsOp("users", {
      fields: { count: pipe(defaultIfMissing("8"), pipe(setLiteral("12"), coerce("int")), coerce("string")) },
    });
    expect(transformRecord(op, { count: "7" }, mode)).toEqual({ count: mode === "full" ? "12" : "7" });
    expect(transformRecord(op, { count: undefined }, mode)).toEqual({ count: mode === "full" ? "12" : undefined });
    expect(transformRecord(op, {}, mode)).toEqual(mode === "full" ? { count: "12" } : {});
  });

  it("treats prototype property names as ordinary fields", () => {
    const op = transformRecordsOp("users", {
      renameFields: JSON.parse('{"__proto__":"old"}'),
      fields: { constructor: defaultIfMissing("value") },
    });
    const result = transformRecord(op, { old: 1 }, mode);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(result["__proto__"]).toBe(1);
    expect(Object.hasOwn(result, "constructor")).toBe(mode === "full");
  });
});
