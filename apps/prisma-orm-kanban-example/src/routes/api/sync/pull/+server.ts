import type { RequestHandler } from "./$types";
import { syncHandlers } from "$lib/server/sync";

/** Resolves the authenticated scope through the shared sync configuration. */
export const GET: RequestHandler = ({ request }) => syncHandlers.pull(request);
