import { createSyncServer } from "@prisma-idb/sync-server";
import { createSqlSyncAdapter, sqlGetKeyField } from "@prisma-idb/sync-server-sql";
import type { Contract as ClientContract } from "../prisma/contract";
import type { Contract as ServerContract } from "../prisma/schema.postgres.generated.d";
import clientContractJson from "../prisma/contract.json" with { type: "json" };
import serverContractJson from "../prisma/schema.postgres.generated.json" with { type: "json" };

export const serverContract = serverContractJson as unknown as ServerContract;

export const syncServer = createSyncServer({
  contract: serverContract, // real Postgres contract (src/lib/server/db.ts) — no IDB-shaped stand-in
  clientContract: clientContractJson as unknown as ClientContract,
  rootModel: "User",
  // sqlGetKeyField (@prisma-idb/sync-server-sql): every model this app
  // syncs uses a single-field key, so its "compound keys aren't supported"
  // limitation is a real one, not a silently-ignored one — nothing in
  // push/+server.ts or pull/+server.ts handles a composite `key`.
  getKeyField: sqlGetKeyField,
});

export const sqlSyncAdapter = createSqlSyncAdapter({ contract: serverContract });
