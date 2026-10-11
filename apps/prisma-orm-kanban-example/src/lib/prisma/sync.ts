import { ContractMismatchError } from "@prisma-idb/sync-extension-idb/client";
import type { LogWithRecord, OutboxEvent, PushResult, SyncRequestContext } from "@prisma-idb/sync-extension-idb/client";

/** The routes read the client's storage hash from this header and refuse a request whose storage hash differs from the server's. */
export const STORAGE_HASH_HEADER = "x-storage-hash";

/** Push tracked writes using the session cookie. The server resolves ownership from that session. */
export async function pushHandler(
  events: OutboxEvent[],
  signal: AbortSignal,
  context: SyncRequestContext
): Promise<PushResult[]> {
  const res = await fetch("/api/sync/push", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [STORAGE_HASH_HEADER]: context.storageHash,
    },
    body: JSON.stringify({ events }),
    signal,
  });
  if (res.status === 409) throw new ContractMismatchError();
  if (!res.ok) throw new Error(`Push failed: ${res.status}`);
  return res.json();
}

/** Pull changes after an opaque changelog cursor, forwarding worker cancellation to the request. */
export async function pullHandler(
  fromChangelogId: string | null,
  signal: AbortSignal,
  context: SyncRequestContext
): Promise<LogWithRecord[]> {
  const params = new URLSearchParams();
  if (fromChangelogId) params.set("since", fromChangelogId);
  const res = await fetch(`/api/sync/pull?${params}`, {
    headers: { [STORAGE_HASH_HEADER]: context.storageHash },
    signal,
  });
  if (res.status === 409) throw new ContractMismatchError();
  if (!res.ok) throw new Error(`Pull failed: ${res.status}`);
  return res.json();
}
