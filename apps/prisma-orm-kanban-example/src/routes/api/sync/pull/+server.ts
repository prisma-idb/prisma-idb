import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { auth } from "$lib/server/auth";
import { getPostgres } from "$lib/server/db";
import { sqlSyncAdapter } from "$lib/server/sync";

/**
 * ADR 014's pull endpoint: `sqlSyncAdapter.pull` (built once in `sync.ts`)
 * pre-filters the Changelog by `scopeKey` (stamped at push time) and the
 * `since` cursor, re-checks each row's ownership live, and re-fetches its
 * *current* state from the real model table. An unauthorized/deleted row
 * comes back as `record: null`, which `applyPull` (sync-extension-idb)
 * treats as a local delete.
 *
 * `scopeKey` is the authenticated session's user id (`auth.api.getSession`),
 * same as push — never a query param a client could set to another user's id.
 */

export const GET: RequestHandler = async ({ url, request }) => {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user.id) return json({ error: "Unauthorized" }, { status: 401 });

  const outcome = await sqlSyncAdapter.pull(await getPostgres(), {
    scopeKey: session.user.id,
    lastChangelogId: url.searchParams.get("since") || null,
  });
  if (!outcome.ok) return json({ error: "since must be a changelog id" }, { status: 400 });
  return json(outcome.logs);
};
