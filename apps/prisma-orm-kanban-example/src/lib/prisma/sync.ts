import type { LogWithRecord, OutboxEvent, PushResult } from "@prisma-idb/sync-extension-idb/client";

/** Push tracked writes using the session cookie. The server resolves ownership from that session. */
export async function pushHandler(events: OutboxEvent[], signal: AbortSignal): Promise<PushResult[]> {
  const res = await fetch("/api/sync/push", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events }),
    signal,
  });
  if (!res.ok) throw new Error(`Push failed: ${res.status}`);
  return res.json();
}

/** Pull changes after an opaque changelog cursor, forwarding worker cancellation to the request. */
export async function pullHandler(fromChangelogId: string | null, signal: AbortSignal): Promise<LogWithRecord[]> {
  const params = new URLSearchParams();
  if (fromChangelogId) params.set("since", fromChangelogId);
  const res = await fetch(`/api/sync/pull?${params}`, { signal });
  if (!res.ok) throw new Error(`Pull failed: ${res.status}`);
  return res.json();
}
