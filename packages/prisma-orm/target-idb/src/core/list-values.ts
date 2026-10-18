import { canonicalStringify } from "@prisma/orm-framework/utils/canonical-stringify";
import { compareDecimalValues } from "./decimal-compare";
import { compareFieldValues, fieldValuesEqual } from "./key-compare";

/** Compare decoded list elements using their scalar codec's identity and order. */
export function compareListElement(codecId: string | undefined, a: unknown, b: unknown): number {
  if (codecId === "idb/decimal@1") return compareDecimalValues(a, b);
  if (codecId === "idb/json@1") return compareFieldValues(canonicalStringify(a), canonicalStringify(b));
  if (fieldValuesEqual(a, b)) return 0;
  return compareFieldValues(a, b);
}

/** Compare arrays lexicographically, preserving element order and duplicate values. */
export function compareListValues(codecId: string | undefined, a: readonly unknown[], b: readonly unknown[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const compared = compareListElement(codecId, a[index], b[index]);
    if (compared !== 0) return compared;
  }
  return a.length - b.length;
}
