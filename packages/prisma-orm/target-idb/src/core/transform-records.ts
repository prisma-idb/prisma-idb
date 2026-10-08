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
  // Define own properties so names such as __proto__ stay data.
  for (const [newName, oldName] of Object.entries(op.renameFields ?? {})) {
    if (!Object.hasOwn(result, oldName) || newName === oldName) continue;
    Object.defineProperty(result, newName, {
      value: result[oldName],
      enumerable: true,
      configurable: true,
      writable: true,
    });
    delete result[oldName];
  }
  for (const [field, transform] of Object.entries(op.fields ?? {})) {
    if (mode === "patch" && !Object.hasOwn(result, field)) continue;
    Object.defineProperty(result, field, {
      value: transformValue(transform, Object.hasOwn(result, field) ? result[field] : undefined, mode),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  for (const field of op.removeFields ?? []) delete result[field];
  return result;
}

function transformValue(transform: IdbValueTransform, value: unknown, mode: RecordTransformMode): unknown {
  switch (transform.kind) {
    case "defaultIfMissing":
      return mode === "full" && value === undefined ? transform.value : value;
    case "setLiteral":
      return mode === "full" ? transform.value : value;
    case "pipe":
      return transform.steps.reduce((current, step) => transformValue(step, current, mode), value);
    case "coerce": {
      if (value === null || value === undefined) return value;
      switch (transform.to) {
        case "int":
          if (typeof value === "number") return value;
          if (typeof value === "boolean") return value ? 1 : 0;
          if (typeof value === "string" && !Number.isNaN(Number(value))) return Number(value);
          break;
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
