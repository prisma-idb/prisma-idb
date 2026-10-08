import type { SyncServer } from "@prisma-idb/sync-server";

/**
 * `"required"` (the default) refuses any request whose contract fingerprint
 * is missing or differs from the server's. `"off"` skips the check, for apps
 * that order their deploys so that clients never run ahead of or behind the
 * server contract.
 */
export type ContractFingerprintCheck = "required" | "off";

/**
 * The server refused the request before reading or writing anything, because
 * the client's contract is not the one the server emits (ADR 015). Answer
 * with HTTP 409; `expected` is the server's fingerprint.
 */
export interface ContractMismatchOutcome {
  readonly ok: false;
  readonly reason: "contract-mismatch";
  readonly expected: string;
}

/** Returns the refusal for a request that is out of step with `syncServer`, or `null` to proceed. */
export async function findContractMismatch(
  syncServer: SyncServer,
  check: ContractFingerprintCheck,
  clientFingerprint: string | null | undefined
): Promise<ContractMismatchOutcome | null> {
  if (check === "off") return null;
  const expected = await syncServer.contractFingerprint();
  return clientFingerprint === expected ? null : { ok: false, reason: "contract-mismatch", expected };
}
