import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { auth } from "$lib/server/auth";
import { getPostgres } from "$lib/server/db";
import { syncServer, sqlSyncAdapter } from "$lib/server/sync";

/**
 * ADR 014's pull endpoint — two steps, per sync-server's README (execution
 * lives in `@prisma-idb/sync-server-sql`'s `sqlSyncAdapter`, built once
 * in `sync.ts` — this file is just the HTTP boundary):
 *
 * 1. Cheap pre-filter on Changelog, scoped by `scopeKey` (stamped at push
 *    time, see push/+server.ts) and a cursor (`.cursor({ id: since })`).
 *    This is the caller's own storage; sync-server has no opinion on it.
 * 2. Live re-check via `buildPullQueries`, then re-fetch each authorized
 *    row's *current* state from the real model table — not from anything
 *    cached on the changelog row itself. An unauthorized/deleted row comes
 *    back as `record: null`, which `applyPull` (sync-extension-idb) treats
 *    as a local delete.
 *
 * `scopeKey` is the authenticated session's user id (`auth.api.getSession`),
 * same as push — never a query param a client could set to another user's id.
 */

export const GET: RequestHandler = async ({ url, request }) => {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user.id) return json({ error: "Unauthorized" }, { status: 401 });
  const scopeKey = session.user.id;

  const since = url.searchParams.get("since");
  let sinceId: number | null = null;
  if (since !== null) {
    sinceId = Number(since);
    if (!Number.isInteger(sinceId)) return json({ error: "since must be an integer" }, { status: 400 });
  }

  const db = await getPostgres();

  const ordered = db.orm.public.Changelog.where({ scopeKey })
    .select("id", "model", "keyPath", "operation")
    .orderBy((c) => c.id.asc());
  const rows = await (sinceId !== null ? ordered.cursor({ id: sinceId }) : ordered).take(50).all();

  const pullLogs = rows.map((row) => ({ changelogId: String(row.id), model: row.model, key: row.keyPath }));
  const checks = syncServer.buildPullQueries(pullLogs, { scopeKey });

  const logs = await Promise.all(
    checks.map(async ({ changelogId, model, check }) => {
      const sourceRow = rows.find((r) => String(r.id) === changelogId)!;
      const operation = sourceRow.operation as "create" | "update" | "delete";
      const keyPath = sourceRow.keyPath;
      const record = await sqlSyncAdapter.resolvePullRecord(db, model, check, keyPath, operation);
      return { changelogId, model, operation, keyPath, record };
    })
  );

  return json(logs);
};
