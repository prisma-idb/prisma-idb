/**
 * `applyPull` — apply server changelog entries to the local IDB.
 *
 * Applied server changes use raw driver plans (not the tracked ORM), so they
 * do NOT generate outbox events — tracking them would create a push loop.
 *
 * Guards per log entry:
 * 1. **Staleness**: skip if `lastAppliedChangeId >= log.changelogId` (already newer).
 * 2. **Pending push**: skip if `localChangePending === true` (local mutation
 *    not yet confirmed synced — let it win to avoid last-write-wins races).
 *
 * The meta check, the record write (including any cascading referential
 * actions for `delete`), and the meta update all run inside ONE
 * `withTransaction` call spanning every store involved — closing the TOCTOU
 * window between the meta read and the write. `delete` reuses the ORM's own
 * `collectDeleteStoreNames`/`applyReferentialActionsForRow` helpers, which
 * are plain functions over an `IdbTransactionScope` parameter (not tied to a
 * transaction of their own), so cascade/setNull/restrict enforcement folds
 * into the same scope instead of needing a separate transaction.
 *
 * `log.record` arrives as wire JSON (an HTTP pull payload sourced from a SQL
 * remote), so it's run through `decodeJsonRecord` (ISO string → `Date`,
 * digit string → `bigint`, base64 → `Uint8Array`, ...) before being written —
 * IDB stores native JS values, not their JSON-safe wire forms.
 *
 * A `create`/`update` log with `record: null` means the server re-checked
 * ownership (ADR 014's `buildPullQueries` live re-check) and this client is
 * no longer authorized to see the record's current state — e.g. its
 * ownership chain was reassigned to someone else since it was last synced.
 * That's applied as a local delete, same as an explicit `delete` op: an
 * unauthorized record has to stop existing locally, not just stop updating.
 */

import type { IdbAtomicPlan } from "@prisma-idb/driver-idb/runtime";
import type { IdbContract } from "@prisma-idb/client-idb/orm";
import { getStoreName, collectDeleteStoreNames, applyReferentialActionsForRow } from "@prisma-idb/client-idb/orm";
import { decodeJsonRecord } from "@prisma-idb/target-idb/runtime";
import type { SyncIdbClient } from "./sync-client";
import type { LogWithRecord, ApplyPullResult, VersionMetaRecord } from "../types";

const VERSION_META = "_idb_sync_version_meta";

function versionMetaKey(model: string, key: unknown): string {
  return `${model}::${JSON.stringify(key)}`;
}

export async function applyPull<TContract extends IdbContract>(
  syncClient: SyncIdbClient<TContract>,
  logs: LogWithRecord[]
): Promise<ApplyPullResult> {
  let applied = 0;
  let skipped = 0;
  let lastChangelogId: string | null = null;
  const contract = syncClient.contract;

  const rawOrmAny = syncClient.rawClient.orm as unknown as Record<string, unknown>;

  for (const log of logs) {
    // The ORM's accessors are keyed by store name (contract.roots keys), not
    // model name — `log.model` ("User") needs converting via getStoreName()
    // to `"users"` before it's a valid lookup key here. Comparing against
    // `log.model` directly always missed (store name almost never equals
    // model name), so every log was silently treated as "unknown model".
    if (!rawOrmAny[getStoreName(contract, log.model)]) {
      skipped++;
      continue;
    }

    const wasApplied = await applyLog(syncClient, contract, log);

    if (wasApplied) {
      applied++;
      if (lastChangelogId === null || log.changelogId > lastChangelogId) {
        lastChangelogId = log.changelogId;
      }
    } else {
      skipped++;
    }
  }

  return { applied, skipped, lastChangelogId };
}

/**
 * Meta check + record write + meta update in a single multi-store
 * `withTransaction` call. A `delete` op or a null-record `create`/`update`
 * (revoked ownership, see file header) additionally spans every store
 * touched by an enforceable child relation (see `collectDeleteStoreNames`);
 * for models with no such relations that list is just `[storeName]`, so
 * this is the same single-store shape as a normal `create`/`update` with no
 * special-casing.
 */
async function applyLog<TContract extends IdbContract>(
  syncClient: SyncIdbClient<TContract>,
  contract: TContract,
  log: LogWithRecord
): Promise<boolean> {
  const metaId = versionMetaKey(log.model, log.keyPath);
  const storeName = getStoreName(contract, log.model);
  const isDelete = log.operation === "delete" || log.record === null;
  const storeNames = isDelete ? collectDeleteStoreNames(contract, log.model) : [storeName];
  const decodedRecord = log.record !== null ? decodeJsonRecord(contract.domain, log.model, log.record) : null;

  try {
    return await syncClient.withTransaction([VERSION_META, ...storeNames], async (scope) => {
      const metaRows = await scope.execute({
        kind: "key-get",
        storeName: VERSION_META,
        key: metaId,
      } as unknown as IdbAtomicPlan);
      const meta = metaRows[0] as VersionMetaRecord | undefined;

      if (meta) {
        if (meta.localChangePending) return false;
        if (meta.lastAppliedChangeId !== null && meta.lastAppliedChangeId >= log.changelogId) return false;
      }

      if (isDelete) {
        const rows = await scope.execute({
          kind: "key-get",
          storeName,
          key: log.keyPath as IDBValidKey,
        } as unknown as IdbAtomicPlan);
        const row = rows[0];
        if (row) {
          await applyReferentialActionsForRow(scope, contract, log.model, row);
          await scope.execute({
            kind: "delete",
            storeName,
            key: log.keyPath as IDBValidKey,
          } as unknown as IdbAtomicPlan);
        }
      } else {
        await scope.execute({
          kind: "put",
          storeName,
          record: decodedRecord!,
        } as unknown as IdbAtomicPlan);
      }

      await scope.execute({
        kind: "put",
        storeName: VERSION_META,
        record: {
          id: metaId,
          model: log.model,
          key: log.keyPath,
          lastAppliedChangeId: log.changelogId,
          localChangePending: false,
        } satisfies VersionMetaRecord,
      } as unknown as IdbAtomicPlan);

      return true;
    });
  } catch {
    // e.g. a `restrict` referential action or a write failure mid-transaction —
    // skip silently, retry next pull.
    return false;
  }
}
