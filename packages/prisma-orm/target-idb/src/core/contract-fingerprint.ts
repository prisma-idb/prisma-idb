import type { ContractWithDomain } from "@prisma/orm-framework/contract/types";

/**
 * Hash of everything that decides whether a record decodes: each model's
 * fields, value objects and enums. Storage layout (stores, indexes) is
 * excluded, so an index change does not count as skew.
 *
 * `storage.storageHash` is no substitute: for IDB it covers only stores and
 * indexes, so adding a non-indexed field or an enum member leaves it unchanged.
 *
 * Client and server compare these digests (ADR 015): the server refuses any
 * request whose digest differs from its own.
 */
export async function contractFingerprint(contract: ContractWithDomain): Promise<string> {
  const decodableShape = Object.fromEntries(
    Object.entries(contract.domain.namespaces).map(([namespaceId, namespace]) => [
      namespaceId,
      {
        models: Object.fromEntries(Object.entries(namespace.models).map(([name, model]) => [name, model.fields])),
        valueObjects: namespace.valueObjects,
        enum: namespace.enum,
      },
    ])
  );
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(decodableShape)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** JSON with object keys sorted, so the same contract always serializes to the same text. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) =>
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : nested
  );
}
