import type { SqlPushEvent } from "./push";

/** Limits client writes to a model's listed operations and fields. */
export interface ModelWritePolicy {
  readonly operations: readonly ("create" | "update" | "delete")[];
  /** Create payload fields and update patch fields. Delete keys are not writes. */
  readonly writableFields: readonly string[];
}

/** Policies keyed by contract model name. Omitted models retain ordinary write access. */
export type ModelWritePolicies = Readonly<Record<string, ModelWritePolicy | undefined>>;

/** Recognizes a field map without treating null or arrays as records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks raw fields before decoding can discard unknown or server-owned fields. */
export function violatesWritePolicy(policies: ModelWritePolicies, model: string, event: SqlPushEvent): boolean {
  const policy = Object.hasOwn(policies, model) ? policies[model] : undefined;
  if (!policy) return false;
  if (!policy.operations.includes(event.operation)) return true;
  if (event.operation === "delete") return false;
  // Leave malformed payloads to the adapter's ordinary validation responses.
  if (!isRecord(event.payload)) return false;
  const fields = event.operation === "update" ? event.payload["patch"] : event.payload;
  return isRecord(fields) && Object.keys(fields).some((field) => !policy.writableFields.includes(field));
}
