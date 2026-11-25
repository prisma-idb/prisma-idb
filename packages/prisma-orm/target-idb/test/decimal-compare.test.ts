import { describe, expect, it } from "vitest";
import { compareDecimalValues, decimalIdentityToken, isDecimalString } from "../src/core/decimal-compare";

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

describe("compareDecimalValues on long inputs", () => {
  it("handles a long run of zeros between significant digits in linear time", () => {
    const value = `1${"0".repeat(100_000)}1`;
    const start = performance.now();
    expect(compareDecimalValues(value, `${value}.000`)).toBe(0);
    expect(compareDecimalValues(value, `1${"0".repeat(100_000)}2`)).toBe(-1);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("handles a long run of trailing zeros", () => {
    const start = performance.now();
    expect(compareDecimalValues(`1${"0".repeat(100_000)}`, "1e100000")).toBe(0);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("decimalIdentityToken", () => {
  const classes: readonly (readonly string[])[] = [
    ["0", "-0", "0.0", "-0.000", "0e5", "+0", ".0", "0.", "-0e-7", "0.000e999"],
    ["1", "1.0", "1.00", "1e0", "+1", "01", "1.", "10e-1", "1E0", ".1e1", "0001.000"],
    ["-1", "-1.0", "-1e0", "-.1e1", "-01"],
    ["100", "1e2", "0.1e3", "100.00", "0100", "1.0e2"],
    ["0.001", "1e-3", ".001", "0.0010", "10e-4"],
    ["123.45", "12345e-2", "+0123.4500", "1.2345e2"],
    ["1e99999999999999999999", "10e99999999999999999998", "0.1e100000000000000000000"],
    ["1e-99999999999999999999", "10e-100000000000000000000"],
    [`${"1234567890".repeat(4)}`, `${"1234567890".repeat(4)}.000`, `${"1234567890".repeat(4)}.0e0`],
    [`${"1234567890".repeat(4)}1`, `${"1234567890".repeat(4)}1.00`],
  ];

  it.each(classes.map((members) => [members.join(" = "), members] as const))(
    "gives equal spellings one token: %s",
    (_label, members) => {
      const tokens = new Set(members.map(decimalIdentityToken));
      expect([...tokens]).toHaveLength(1);
    }
  );

  it("gives different values different tokens", () => {
    const tokens = classes.map((members) => decimalIdentityToken(members[0]));
    expect(new Set(tokens).size).toBe(classes.length);
  });

  it.each([
    ["1", "-1"],
    ["1", "10"],
    ["1", "0.1"],
    ["12", "21"],
    ["1e99999999999999999999", "1e99999999999999999998"],
    ["1e99999999999999999999", "1e-99999999999999999999"],
    [`${"1234567890".repeat(4)}`, `${"1234567890".repeat(4)}1`],
    ["0", "1e-99999999999999999999"],
  ])("keeps %s and %s apart", (a, b) => {
    expect(decimalIdentityToken(a)).not.toBe(decimalIdentityToken(b));
  });

  it("tells 40-digit values that differ only in trailing zeros from different values", () => {
    const base = "1234567890123456789012345678901234567890";
    expect(decimalIdentityToken(`${base}00`)).toBe(decimalIdentityToken(base + "00"));
    expect(decimalIdentityToken(`${base}.000`)).toBe(decimalIdentityToken(base));
    expect(decimalIdentityToken(`${base}.0001`)).not.toBe(decimalIdentityToken(base));
    expect(decimalIdentityToken(`${base}00`)).not.toBe(decimalIdentityToken(base));
  });

  it("agrees with compareDecimalValues: tokens are equal exactly when the values compare equal", () => {
    const spellings = [
      ...classes.flat(),
      "2",
      "-2",
      "2e0",
      "0.5",
      ".5e0",
      "5e-1",
      "-0.5",
      "1.5",
      "15e-1",
      "1e1",
      "10",
      "9007199254740993",
      "9007199254740992",
    ];
    for (const a of spellings) {
      for (const b of spellings) {
        expect(
          decimalIdentityToken(a) === decimalIdentityToken(b),
          `${a} vs ${b}: token equality must match compareDecimalValues`
        ).toBe(compareDecimalValues(a, b) === 0);
      }
    }
  });

  it("agrees with compareDecimalValues on generated values", () => {
    let seed = 12345;
    const next = (limit: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % limit;
    };
    const generate = (): string => {
      const sign = ["", "-", "+"][next(3)]!;
      const whole = ["", "0", "00", "1", "10", "100", "12"][next(7)]!;
      const fraction = ["", ".", ".0", ".00", ".5", ".50", ".05", ".12"][next(8)]!;
      const exponent = ["", "e0", "e1", "e-1", "E2", "e-2", "e+1"][next(7)]!;
      const text = `${sign}${whole}${fraction}${exponent}`;
      return isDecimalString(text) ? text : "0";
    };
    for (let i = 0; i < 2000; i++) {
      const a = generate();
      const b = generate();
      expect(decimalIdentityToken(a) === decimalIdentityToken(b), `${a} vs ${b}`).toBe(
        compareDecimalValues(a, b) === 0
      );
    }
  });

  it.each([
    ["not decimal text", "abc"],
    ["empty text", ""],
    ["padded text", " 1"],
    ["NaN text", "NaN"],
    ["Infinity text", "Infinity"],
    ["a number", 1],
    ["a bigint", 1n],
    ["null", null],
    ["undefined", undefined],
    ["an object", { value: "1" }],
  ])("passes %s through unchanged", (_label, value) => {
    expect(decimalIdentityToken(value)).toBe(value);
  });
});
