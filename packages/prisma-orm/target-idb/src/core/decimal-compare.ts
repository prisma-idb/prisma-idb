/** Finite base-ten decimal text; whitespace and non-finite values are invalid. */
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Check Decimal storage and query inputs without rounding through a number. */
export function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && DECIMAL.test(value) && value.trim() === value;
}

/** Significant digits and their decimal position, independent of input scale. */
interface DecimalParts {
  readonly negative: boolean;
  readonly digits: string;
  readonly position: bigint;
}

/** Parse finite decimal text without expanding exponents or losing significant digits. */
function decimalParts(value: unknown): DecimalParts {
  if (!isDecimalString(value)) throw new TypeError("Expected finite Decimal text");
  const [coefficient, exponent = "0"] = value.toLowerCase().split("e");
  const unsigned = coefficient!.replace(/^[+-]/, "");
  const point = unsigned.indexOf(".");
  const fractionLength = point < 0 ? 0 : unsigned.length - point - 1;
  const significant = unsigned.replace(".", "").replace(/^0+/, "");
  return {
    negative: value.startsWith("-") && significant.length > 0,
    digits: significant.replace(/0+$/, ""),
    position: significant.length === 0 ? 0n : BigInt(exponent) - BigInt(fractionLength) + BigInt(significant.length),
  };
}

/** Compare finite Decimal strings exactly; signed zero and different scales can tie. */
export function compareDecimalValues(a: unknown, b: unknown): number {
  const left = decimalParts(a);
  const right = decimalParts(b);
  if (left.negative !== right.negative) return left.negative ? -1 : 1;
  let comparison: number;
  if (left.digits.length === 0 || right.digits.length === 0) {
    comparison = left.digits.length === right.digits.length ? 0 : left.digits.length === 0 ? -1 : 1;
  } else if (left.position !== right.position) {
    comparison = left.position < right.position ? -1 : 1;
  } else {
    const length = Math.max(left.digits.length, right.digits.length);
    const l = left.digits.padEnd(length, "0");
    const r = right.digits.padEnd(length, "0");
    comparison = l === r ? 0 : l < r ? -1 : 1;
  }
  return comparison === 0 ? 0 : left.negative ? -comparison : comparison;
}
