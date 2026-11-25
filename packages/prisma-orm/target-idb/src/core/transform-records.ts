import { INT32_RANGE, isIntegerIn } from "@prisma/orm-framework/components/codec";
import { errorUnfilledPlaceholder } from "@prisma/orm-framework/errors/migration";
import type { IdbValueTransform, TransformRecordsOp } from "./migration-factories";

/** Full records permit backfills; patches only change fields already present. */
export type RecordTransformMode = "full" | "patch";

/**
 * Return a rewritten copy, applying renames, value transforms, then removals.
 * Patch mode skips literal writes and defaults, even within a pipe, so an
 * update never gains fields that the caller did not supply.
 */
export function transformRecord(
  op: TransformRecordsOp,
  value: Readonly<Record<string, unknown>>,
  mode: RecordTransformMode
): Record<string, unknown> {
  const result = { ...value };
  const renames = Object.entries(op.renameFields ?? {}).filter(([, oldName]) => Object.hasOwn(value, oldName));
  // Remove sources before writing destinations so swaps and chains keep every original value.
  for (const [, oldName] of renames) delete result[oldName];
  // Define own properties so names such as __proto__ stay data.
  for (const [newName, oldName] of renames) {
    Object.defineProperty(result, newName, {
      value: value[oldName],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  for (const [field, transform] of Object.entries(op.fields ?? {})) {
    const present = Object.hasOwn(result, field);
    if (mode === "patch" && !present) continue;
    const transformed = transformValue(transform, present ? result[field] : undefined, mode);
    if (!present && transformed === undefined) continue;
    Object.defineProperty(result, field, {
      value: transformed,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  for (const field of op.removeFields ?? []) delete result[field];
  return result;
}

/**
 * Decimal text `coerce("int")` reads, such as `"42"`, `" -7 "` or `"3.0"`.
 * `Number()` alone would also read `"0x10"`, `"0b11"` and `"1e3"`, which a
 * stored `Int` written as text never looks like.
 */
const DECIMAL_TEXT = /^[+-]?\d+(\.\d+)?$/;

/** Applies one value transform; an unfilled placeholder throws, wherever it sits in a pipe. */
function transformValue(transform: IdbValueTransform, value: unknown, mode: RecordTransformMode): unknown {
  switch (transform.kind) {
    case "placeholder":
      throw errorUnfilledPlaceholder(transform.slot);
    case "defaultIfMissing":
      return mode === "full" && value === undefined ? structuredClone(transform.value) : value;
    case "setLiteral":
      return mode === "full" ? structuredClone(transform.value) : value;
    case "pipe":
      return transform.steps.reduce((current, step) => transformValue(step, current, mode), value);
    case "coerce": {
      if (value === null || value === undefined) return value;
      switch (transform.to) {
        case "int": {
          // The result is stored as an `Int`, so it must pass the int32 check every write applies.
          const n =
            typeof value === "number"
              ? value
              : typeof value === "boolean"
                ? Number(value)
                : typeof value === "string" && DECIMAL_TEXT.test(value.trim())
                  ? Number(value)
                  : Number.NaN;
          if (isIntegerIn(n, INT32_RANGE)) return n;
          break;
        }
        case "string":
          if (["string", "number", "boolean"].includes(typeof value)) return String(value);
          break;
        case "boolean":
          if (typeof value === "boolean") return value;
          if (typeof value === "number") return value !== 0;
          if (value === "true") return true;
          if (value === "false") return false;
          break;
        case "isoDateString":
          if (typeof value === "number") return new Date(value).toISOString();
          if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return value;
          break;
      }
      throw new Error(`IDB: cannot coerce ${String(value)} to ${transform.to}`);
    }
  }
}
