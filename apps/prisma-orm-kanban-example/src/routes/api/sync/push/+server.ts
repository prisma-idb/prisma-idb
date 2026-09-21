import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { pushRequestBodySchema } from "@prisma-idb/sync-extension-idb/schemas";
import type { PushResultBody } from "@prisma-idb/sync-extension-idb/schemas";
import { auth } from "$lib/server/auth";
import { getPostgres } from "$lib/server/db";
import { syncServer, sqlSyncAdapter } from "$lib/server/sync";

/**
 * ADR 014's push endpoint: validate ownership via `@prisma-idb/sync-server`,
 * then apply authorized writes to the real Postgres tables (execution lives
 * in `@prisma-idb/sync-server-sql`'s `sqlSyncAdapter`, built once in
 * `sync.ts` — this file is just the HTTP boundary). `scopeKey` is the
 * authenticated session's user id, resolved server-side from the request's
 * session cookie (`auth.api.getSession`) — never trusted from the request
 * body, so a client can't claim to push as a different user.
 */

// The real client only ever pushes `SyncWorkerOptions.batchSize` events at a
// time (default 20, see sync-worker.ts) — generous headroom over that, not a
// tuned limit, just a bound so a crafted request can't force an unbounded
// number of sequential per-event transactions (see the loop below's own
// comment on why these run sequentially, not concurrently).
const MAX_PUSH_BATCH_SIZE = 1000;

export const POST: RequestHandler = async ({ request }) => {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user.id) return json({ error: "Unauthorized" }, { status: 401 });
  const scopeKey = session.user.id;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = pushRequestBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return json({ error: "Malformed request body", details: parsed.error.issues }, { status: 400 });
  }
  if (parsed.data.events.length > MAX_PUSH_BATCH_SIZE) {
    return json({ error: `events exceeds max batch size of ${MAX_PUSH_BATCH_SIZE}` }, { status: 400 });
  }
  const { events } = parsed.data;

  // Reject outright rather than silently double-applying or dropping one:
  // the loop below re-matches each check back to its event by id
  // (`events.find`), which only holds up if ids are actually unique within
  // the batch. A legitimate client's own outbox ids are always unique
  // (crypto.randomUUID() per write) — this only ever fires on a malformed
  // or crafted request.
  const seenEventIds = new Set<string>();
  for (const event of events) {
    if (seenEventIds.has(event.id)) {
      return json({ error: "Duplicate event id in push batch" }, { status: 400 });
    }
    seenEventIds.add(event.id);
  }

  const db = await getPostgres();
  const results: PushResultBody[] = [];

  // Resolved per event, not per batch: an unknown entityType or unsupported
  // operation should fail only that event (non-retryable — resubmitting the
  // same event won't change the outcome), not crash the whole batch.
  const pushEvents: {
    id: string;
    model: string;
    operation: "create" | "update" | "delete";
    payload: Record<string, unknown>;
  }[] = [];
  for (const event of events) {
    try {
      pushEvents.push({
        id: event.id,
        model: event.entityType,
        operation: event.operation,
        payload: sqlSyncAdapter.toSyncPushPayload(
          event.operation,
          event.payload,
          sqlSyncAdapter.getKeyField(event.entityType)
        ),
      });
    } catch (err) {
      results.push({
        id: event.id,
        success: false,
        error: err instanceof Error ? err.message : "Unsupported event",
        retryable: false,
      });
    }
  }

  const checks = syncServer.validatePush(pushEvents, { scopeKey });

  // Sequential, not Promise.all: a batch can carry data dependencies (a
  // Todo created right after the Board it belongs to) — running checks
  // concurrently raced the Board's own not-yet-committed transaction,
  // making the Todo's ownership walk read a Board that didn't exist yet.
  // Matches the old generator's applyPush, which processed events in a
  // plain `for` loop for the same reason.
  for (const { eventId, model, check } of checks) {
    const event = events.find((e) => e.id === eventId)!;
    results.push(await sqlSyncAdapter.applyPushEvent(db, event, model, check, scopeKey));
  }

  return json(results);
};
