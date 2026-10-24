import { error } from "@sveltejs/kit";
import { auth } from "$lib/server/auth";
import { getPostgres } from "$lib/server/db";
import { createSqlSync } from "@prisma-idb/sync-server-sql";
import type { Contract as ClientContract } from "../prisma/contract";
import type { Contract as ServerContract } from "../prisma/schema.postgres.generated.d";
import clientContractJson from "../prisma/contract.json" with { type: "json" };
import serverContractJson from "../prisma/schema.postgres.generated.json" with { type: "json" };

const serverContract = serverContractJson as unknown as ServerContract;

/** Shared sync endpoints; the session determines the trusted scope on each request. */
export const syncHandlers = createSqlSync({
  contract: serverContract,
  clientContract: clientContractJson as unknown as ClientContract,
  rootModel: "User",
  db: getPostgres,
  scopeKey: async (request) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user.id) error(401, "Unauthorized");
    return session.user.id;
  },
});
