import { describe, expect, it } from "vitest";
import { compareDecimalValues, isDecimalString } from "../src/core/decimal-compare";

describe("exact Decimal comparison", () => {
  it.each([
    ["9", "10", -1],
    ["-10", "-9", -1],
    ["-0", "0.000e999", 0],
    ["0", ".0001", -1],
    ["-0.0001", "0", -1],
    ["+001.2300", "123e-2", 0],
    ["1.", "1e0", 0],
    [".5", "5E-1", 0],
    ["1.01", "1.001", 1],
    ["9007199254740992", "9007199254740993", -1],
    ["1.000000000000000000001", "1.000000000000000000002", -1],
    ["1e400", "9e399", 1],
    ["1e-400", "9e-401", 1],
    ["-1e400", "-9e399", -1],
    ["-1e-400", "-9e-401", -1],
    ["1e999999999999999999999", "9e999999999999999999998", 1],
    ["1e-999999999999999999999", "9e-1000000000000000000000", 1],
  ])("compares %s and %s", (a, b, expected) => {
    expect(compareDecimalValues(a, b)).toBe(expected);
    expect(compareDecimalValues(b, a)).toBe(expected === 0 ? 0 : -expected);
  });

  it.each(["", " ", " 1", "1\n", "NaN", "Infinity", "-Infinity", "0x10", ".", "1e", "1e+", "1_000", "1.2.3", 1, null])(
    "rejects invalid Decimal text %j",
    (value) => {
      expect(isDecimalString(value)).toBe(false);
      expect(() => compareDecimalValues(value, "0")).toThrow("Expected finite Decimal text");
      expect(() => compareDecimalValues("0", value)).toThrow("Expected finite Decimal text");
    }
  );
});
