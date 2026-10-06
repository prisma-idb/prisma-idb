import type { LogicalPlan } from "./plan";

/** Stable, JSON-safe plan descriptor for tests and the plan-shape gate. */
export function explain(plan: LogicalPlan): string {
  const access = plan.access;
  if (access.kind !== "ranges") return JSON.stringify({ access: access.kind, exact: plan.exact });
  return JSON.stringify({
    access: access.source.indexName === undefined ? "primary-key" : "index",
    ...(access.source.indexName === undefined ? {} : { index: access.source.indexName }),
    keyPath: access.source.keyPath,
    ranges: access.ranges.map((range) => (range === undefined ? { kind: "all" } : describeValue(range))),
    ...(plan.direction === undefined ? {} : { direction: plan.direction }),
    exact: plan.exact,
  });
}

function describeValue(value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) return { number: String(value) };
  if (value instanceof Date) return { date: value.toISOString() };
  if (value instanceof ArrayBuffer) return { bytes: Array.from(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value))
    return { bytes: Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
  if (Array.isArray(value)) return value.map(describeValue);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, cell]) => [key, describeValue(cell)]));
  return value;
}
