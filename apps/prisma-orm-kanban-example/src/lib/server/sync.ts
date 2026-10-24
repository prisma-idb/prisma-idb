import { error } from "@sveltejs/kit";
import { auth } from "$lib/server/auth";
import { getPostgres } from "$lib/server/db";
import { createSqlSync } from "@prisma-idb/sync-server-sql";
import clientContract from "../prisma/contract.runtime";
import serverContract from "../prisma/schema.postgres.generated.runtime";

/** Shared sync endpoints; the session determines the trusted scope on each request. */
export const syncHandlers = createSqlSync({
  contract: serverContract,
  clientContract,
  rootModel: "User",
  db: getPostgres,
  scopeKey: async (request) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user.id) error(401, "Unauthorized");
    return session.user.id;
  },
});
