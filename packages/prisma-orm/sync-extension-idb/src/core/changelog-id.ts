/**
 * Orders two changelog ids. The wire type is `string`, but the server's ids
 * are stringified integers (an autoincrement column), and `"10" < "9"` under
 * plain string comparison — which would let a cursor move backwards or a
 * newer log be dropped as stale. Ids that are both plain digit strings compare
 * numerically (BigInt, so ids past 2^53 stay exact); anything else falls back
 * to string order, so opaque non-numeric ids keep working.
 */
const DIGITS = /^\d+$/;

export function compareChangelogIds(a: string, b: string): number {
  if (DIGITS.test(a) && DIGITS.test(b)) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
