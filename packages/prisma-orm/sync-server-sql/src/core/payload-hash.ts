import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

type CanonicalValue = null | boolean | number | string | CanonicalValue[];

/** Encode containers and native values with distinct tags so ordinary JSON cannot impersonate a native value. */
function canonicalValue(value: unknown): CanonicalValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : ["number", String(value)];
  if (typeof value === "bigint") return ["bigint", value.toString()];
  if (value === undefined) return ["undefined"];
  if (value instanceof Date) return ["date", value.toISOString()];
  if (value instanceof Uint8Array) return ["bytes", Buffer.from(value).toString("base64")];
  if (Array.isArray(value)) return ["array", Array.from(value, canonicalValue)];
  if (typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const record = value as Record<string, unknown>;
    return [
      "object",
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalValue(record[key])]),
    ];
  }
  throw new TypeError("Unsupported sync payload value");
}

/** This format is persisted in the changelog. Keep its representation stable across releases. */
export function hashPushPayload(operation: string, payload: Readonly<Record<string, unknown>>): string {
  const record =
    operation === "create"
      ? Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== null))
      : payload;
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(record)))
    .digest("hex");
}
