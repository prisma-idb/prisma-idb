import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { pushRequestBodySchema } from "@prisma-idb/sync-extension-idb/schemas";
import type { PushResultBody } from "@prisma-idb/sync-extension-idb/schemas";
import { auth } from "$lib/server/auth";
import { getPostgres } from "$lib/server/db";
import { sqlSyncAdapter } from "$lib/server/sync";

/**
 * ADR 014's push endpoint: `sqlSyncAdapter.applyPush` (built once in
 * `sync.ts` from `@prisma-idb/sync-server` + `@prisma-idb/sync-server-sql`)
 * validates ownership and applies authorized writes to the real Postgres
 * tables — this file is just the HTTP boundary. `scopeKey` is the
 * authenticated session's user id, resolved server-side from the request's
 * session cookie (`auth.api.getSession`) — never trusted from the request
 * body, so a client can't claim to push as a different user.
 */

// The real client only ever pushes `SyncWorkerOptions.batchSize` events at a
// time (default 20, see sync-worker.ts) — generous headroom over that, not a
// tuned limit, just a bound so a crafted request can't force an unbounded
// number of sequential per-event transactions.
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

  const outcome = await sqlSyncAdapter.applyPush(await getPostgres(), {
    events: parsed.data.events,
    scopeKey,
    maxBatchSize: MAX_PUSH_BATCH_SIZE,
  });
  if (!outcome.ok) {
    return json(
      {
        error:
          outcome.reason === "batch-too-large"
            ? `events exceeds max batch size of ${outcome.maxBatchSize}`
            : "Duplicate event id in push batch",
      },
      { status: 400 }
    );
  }
  return json(outcome.results satisfies readonly PushResultBody[]);
};
