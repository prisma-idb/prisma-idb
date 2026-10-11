import type { SyncServer } from "@prisma-idb/sync-server";

/**
 * `"required"` (the default) refuses any request whose storage hash
 * is missing or differs from the server's. `"off"` skips the check, for apps
 * that order their deploys so that clients never run ahead of or behind the
 * server contract.
 */
export type ContractCheck = "required" | "off";

/**
 * The server refused the request before reading or writing anything, because
 * the client's contract is not the one the server emits (ADR 015). Answer
 * with HTTP 409; `expected` is the server's storage hash.
 */
export interface ContractMismatchOutcome {
  readonly ok: false;
  readonly reason: "contract-mismatch";
  readonly expected: string;
}

/** Returns the refusal for a request that is out of step with `syncServer`, or `null` to proceed. */
export function findContractMismatch(
  syncServer: SyncServer,
  check: ContractCheck,
  clientStorageHash: string | null | undefined
): ContractMismatchOutcome | null {
  if (check === "off") return null;
  const expected = syncServer.clientStorageHash;
  return clientStorageHash === expected ? null : { ok: false, reason: "contract-mismatch", expected };
}
