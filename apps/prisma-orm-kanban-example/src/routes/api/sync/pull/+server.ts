import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { auth } from "$lib/server/auth";
import { getPostgres } from "$lib/server/db";
import { syncHandlers } from "$lib/server/sync";

/** Authenticate before resolving the trusted sync scope from the session. */
export const GET: RequestHandler = async ({ request }) => {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user.id) return json({ error: "Unauthorized" }, { status: 401 });
  return syncHandlers.pull(request, { db: await getPostgres(), scopeKey: session.user.id });
};
