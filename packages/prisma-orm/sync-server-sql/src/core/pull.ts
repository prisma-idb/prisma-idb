import type { GetKeyField, OwnershipCheck, SyncServerContract } from "@prisma-idb/sync-server";
import { ormRootFor } from "./orm-root";
import { checkAuthorization } from "./authorization";

/**
 * Authorizes a pulled changelog row, then returns the record's *current*
 * state if allowed. `null` for unauthorized/deleted — sync-extension-idb's
 * `applyPull` treats a null record as a local delete.
 *
 * A `"scoped"` check already fetches the row (`startRow`) to walk its
 * ownership path — that row is reused as the result instead of re-querying,
 * as long as `check.key` and `keyPath` agree on which row that is (true for
 * every caller today, since both trace back to the same changelog row's
 * `keyPath`; a hypothetical caller passing a different `keyPath` falls back
 * to a fresh fetch).
 */
export async function resolvePullRecord(
  db: unknown,
  contract: SyncServerContract,
  getKeyField: GetKeyField,
  model: string,
  check: OwnershipCheck,
  keyPath: unknown,
  operation: "create" | "update" | "delete"
): Promise<Record<string, unknown> | null> {
  if (check.kind === "unknown-model") return null;

  const startRow =
    check.kind === "scoped" ? await ormRootFor(db, model).first({ [getKeyField(contract, model)]: check.key }) : null;

  const authorized = await checkAuthorization(db, contract, getKeyField, model, check, startRow);
  if (!authorized || operation === "delete") return null;

  if (startRow && check.key === keyPath) return startRow;
  return ormRootFor(db, model).first({ [getKeyField(contract, model)]: keyPath });
}
