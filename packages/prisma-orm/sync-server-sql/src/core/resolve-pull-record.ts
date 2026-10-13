import type { GetKeyField, OwnershipCheck, SyncServer, SyncServerContract } from "@prisma-idb/sync-server";
import { reviveWireKey } from "./wire-values";
import { ormRootFor } from "./orm-root";
import { checkAuthorization, plainRowReader } from "./authorization";

/**
 * Authorizes a pulled changelog row, then returns the record's *current*
 * state projected to client-contract fields if allowed. Returns `null` for
 * unauthorized or deleted records; `applyPull` treats it as a local delete.
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
  syncServer: SyncServer,
  contract: SyncServerContract,
  getKeyField: GetKeyField,
  model: string,
  check: OwnershipCheck,
  keyPath: unknown,
  operation: "create" | "update" | "delete"
): Promise<Record<string, unknown> | null> {
  if (check.kind === "unknown-model") return null;

  const keyField = getKeyField(contract, model);
  const nativeKey = (key: unknown) => reviveWireKey(contract, model, keyField, key);
  const startRow =
    check.kind === "scoped" ? await ormRootFor(db, model).first({ [keyField]: nativeKey(check.key) }) : null;

  const authorized = await checkAuthorization(
    plainRowReader(db, contract, getKeyField),
    contract,
    model,
    check,
    startRow
  );
  if (!authorized || operation === "delete") return null;

  // Authorization needs the full row, including server-only ownership fields.
  const row =
    startRow && check.key === keyPath
      ? startRow
      : await ormRootFor(db, model).first({ [keyField]: nativeKey(keyPath) });
  return row === null ? null : syncServer.projectRecord(model, row);
}
