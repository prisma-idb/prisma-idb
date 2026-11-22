/**
 * `applyPull` — apply server changelog entries to the local IDB.
 *
 * Applied server changes use raw driver plans (not the tracked ORM), so they
 * do NOT generate outbox events — tracking them would create a push loop.
 *
 * A page is applied in order and stops at the first row that cannot be
 * applied yet (see "Halting" below), so a failed row never lets a later row
 * land ahead of it — a later row may depend on an earlier one. Rows that are
 * `invalid` are the exception: they are consumed without being written.
 *
 * Guards per log entry, in this order:
 * 1. **Staleness**: the row counts as already applied if
 *    `lastAppliedChangeId >= log.changelogId` (ids are UUID v7, so string
 *    order is time order). This is what makes replaying a page safe, for
 *    example after a crash between applying it and saving the cursor.
 * 2. **Pending push**: halt if `localChangePending === true` (local mutation
 *    not yet confirmed synced — let it win to avoid last-write-wins races).
 *
 * Halting: a transaction failure (for example a full disk or a `restrict`
 * referential action) or a pending local change stops the page at that row.
 * The rows after it are not applied and `lastChangelogId` stays before it,
 * so the next pull starts at the halted row.
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
 * Decoded records and keys are checked against the client contract. Corrupt
 * rows are counted separately and consumed by the cursor, since no retry can
 * fix them; they never open a write transaction. Server `validationError`
 * markers are consumed the same way, without decoding or deleting. Nullable
 * records still signal a revoked ownership delete.
 *
 * A `create`/`update` log with `record: null` means the server re-checked
 * ownership (ADR 014's `buildPullQueries` live re-check) and this client is
 * no longer authorized to see the record's current state — e.g. its
 * ownership chain was reassigned to someone else since it was last synced.
 * That's applied as a local delete, same as an explicit `delete` op: an
 * unauthorized record has to stop existing locally, not just stop updating.
 */

import type { IdbTransactionScope } from "@prisma-idb/driver-idb/runtime";
import type { IdbContract } from "@prisma-idb/client-idb/orm";
import { getStoreName, getKeyPath, extractKeyFromRow } from "@prisma-idb/client-idb/orm";
import { collectDeleteStoreNames, applyReferentialActionsForRow } from "@prisma-idb/client-idb/internal";
import { decodeJsonRecord, validateRecord, validateKeyPath } from "@prisma-idb/target-idb/runtime";
import type { SyncIdbClient } from "./sync-client";
import { deleteRecord, putRecord, scanStore } from "./raw-store";
import { OUTBOX_STORE } from "./outbox-store";
import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import { VERSION_META_STORE, versionMetaKey, resolveVersionMeta, nativeVersionMetaKey } from "./version-meta";
import {
  decimalKeysEqual,
  hasDecimalPrimaryKey,
  preserveDecimalKeySpelling,
  resolveDecimalKey,
  IdbDecimalIdentityConflictError,
} from "@prisma-idb/client-idb/internal";
import type { LogWithRecord, ApplyPullResult, OutboxEvent, PullChange, VersionMetaRecord } from "../types";

/**
 * A committed change, an already-consumed entry, or a halt. The cursor can
 * move past everything except `halt`, which stops the page for a retry.
 */
type LogOutcome = PullChange | "already-applied" | "invalid" | "unknown-model" | "halt";

/** Applies a changelog page in order and returns the cursor position safe to persist. */
export async function applyPull<TContract extends IdbContract>(
  syncClient: SyncIdbClient<TContract>,
  logs: LogWithRecord[]
): Promise<ApplyPullResult> {
  let applied = 0;
  const changes: PullChange[] = [];
  let skipped = 0;
  let validationFailed = 0;
  let halted = false;
  let lastChangelogId: string | null = null;
  const contract = syncClient.contract;

  const rawOrm = syncClient.rawClient.orm as unknown as Record<string, unknown>;

  for (const log of logs) {
    // The ORM's accessors are keyed by store name (contract.roots keys), not
    // model name — `log.model` ("User") needs converting via getStoreName()
    // to `"users"` before it's a valid lookup key here. Comparing against
    // `log.model` directly always missed (store name almost never equals
    // model name), so every log was silently treated as "unknown model".
    //
    // A model the client contract doesn't have, such as one a migration removed,
    // can never be applied, so its log is consumed like an already-applied one.
    // Leaving the cursor behind it would request the same page forever.
    const outcome = rawOrm[getStoreName(contract, log.model)]
      ? await applyLog(syncClient, contract, log)
      : "unknown-model";

    if (outcome === "halt") {
      skipped++;
      halted = true;
      break;
    }
    if (typeof outcome === "object") {
      applied++;
      changes.push(outcome);
    } else skipped++;
    if (outcome === "invalid") validationFailed++;

    if (lastChangelogId === null || log.changelogId > lastChangelogId) lastChangelogId = log.changelogId;
  }

  return { applied, changes, skipped, validationFailed, halted, lastChangelogId };
}

/**
 * Decodes a pulled log's key and record to native values and validates them
 * against the client contract, all before any transaction opens. `null`
 * means the log is corrupt, including any decode failure (for example an
 * invalid bigint wire value). A delete or revoked-ownership log has no
 * record to validate, so its `record` is `null`.
 */
export function decodePullLog<TContract extends IdbContract>(
  contract: TContract,
  log: LogWithRecord,
  isDelete: boolean
): { key: IDBValidKey; record: Record<string, unknown> | null } | null {
  try {
    const keyPath = getKeyPath(contract, log.model);
    const fields = typeof keyPath === "string" ? [keyPath] : keyPath;
    // A compound key arrives as an array, one wire value per key field.
    const wireValues = typeof keyPath === "string" ? [log.keyPath] : log.keyPath;
    if (!Array.isArray(wireValues) || wireValues.length !== fields.length) return null;

    const keyRecord = decodeJsonRecord(
      contract,
      log.model,
      Object.fromEntries(fields.map((name, i) => [name, wireValues[i]]))
    );
    const key = extractKeyFromRow(keyRecord, keyPath);
    if (!validateKeyPath(contract, log.model, key).ok) return null;
    if (isDelete) return { key, record: null };

    const record = decodeJsonRecord(contract, log.model, log.record!);
    if (!validateRecord(contract, log.model, record).ok) return null;
    if (!decimalKeysEqual(contract, log.model, key, extractKeyFromRow(record, keyPath))) return null;
    return { key, record };
  } catch {
    return null;
  }
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
): Promise<LogOutcome> {
  if (log.validationError === "KEYPATH_VALIDATION_FAILURE") return "invalid";

  const storeName = getStoreName(contract, log.model);
  const isDelete = log.operation === "delete" || log.record === null;
  // A delete may cascade to rows with unsent edits, whose outbox events it then discards.
  const storeNames = isDelete ? [...collectDeleteStoreNames(contract, log.model), OUTBOX_STORE] : [storeName];
  const decoded = decodePullLog(contract, log, isDelete);
  if (!decoded) return "invalid";
  const { key, record } = decoded;

  try {
    return await syncClient.withTransaction([VERSION_META_STORE, ...storeNames], async (scope): Promise<LogOutcome> => {
      const meta = await resolveVersionMeta(scope, contract, log.model, key, log.keyPath);

      if (meta) {
        if (meta.lastAppliedChangeId !== null && meta.lastAppliedChangeId >= log.changelogId) return "already-applied";
        if (meta.localChangePending) return "halt";
      }

      const identity = await resolvePullIdentity(scope, contract, log, key, record, meta);
      if (isDelete) {
        if (identity.row) {
          const cascaded = recordDeletes(scope);
          await applyReferentialActionsForRow(cascaded.scope, contract, log.model, identity.row);
          await deleteRecord(scope, storeName, identity.key);
          await discardPendingEdits(scope, contract, cascaded.deleted);
        }
      } else {
        await putRecord(scope, storeName, identity.record!);
      }

      await putRecord(scope, VERSION_META_STORE, {
        id: identity.metaId,
        model: log.model,
        key: identity.metaKey,
        lastAppliedChangeId: log.changelogId,
        localChangePending: false,
      } satisfies VersionMetaRecord);

      return { model: log.model, key: identity.key, op: isDelete ? "delete" : log.operation };
    });
  } catch (error) {
    // e.g. a `restrict` referential action or a write failure mid-transaction:
    // halt the page, so the next pull retries this row before any later one.
    if (error instanceof IdbDecimalIdentityConflictError) throw error;
    return "halt";
  }
}

/** A row a pulled delete removed through a cascade. */
interface DeletedRow {
  readonly storeName: string;
  readonly key: IDBValidKey;
}

/** Wrap `scope` so the keyed deletes issued through it, which is how a cascade removes rows, are recorded. */
function recordDeletes(scope: IdbTransactionScope): { scope: IdbTransactionScope; deleted: DeletedRow[] } {
  const deleted: DeletedRow[] = [];
  const recording: IdbTransactionScope = {
    execute: (plan) => {
      if (plan.kind === "delete" && !(plan.key instanceof IDBKeyRange)) {
        deleted.push({ storeName: plan.storeName, key: plan.key });
      }
      return scope.execute(plan);
    },
    commit: () => scope.commit(),
    rollback: () => scope.rollback(),
  };
  return { scope: recording, deleted };
}

/** What a discarded event records as its last error. */
export const DISCARDED_BY_PULL = "Discarded: a change pulled from the server deleted this row";

/**
 * The server wins over unsent edits of rows a pulled delete cascaded to: the
 * server removed those rows too, so their queued events can no longer apply.
 * Each one is marked non-retryable, and its row's pending flag is cleared, in
 * the pull's transaction, so the local rows and the queue agree.
 */
async function discardPendingEdits(
  scope: IdbTransactionScope,
  contract: IdbContract,
  deleted: readonly DeletedRow[]
): Promise<void> {
  const pendingMetaIds = new Set<string>();
  // A Decimal key is matched numerically against every metadata row, so read them once, not per row.
  let snapshot: Map<string, VersionMetaRecord> | undefined;
  for (const { storeName, key } of deleted) {
    const model = modelForStore(contract, storeName);
    if (model === undefined) continue;
    if (snapshot === undefined && hasDecimalPrimaryKey(contract, model)) {
      const rows = await scanStore<VersionMetaRecord>(scope, VERSION_META_STORE);
      snapshot = new Map(rows.map((row) => [row.id, row]));
    }
    const meta = await resolveVersionMeta(scope, contract, model, key, key, snapshot);
    if (!meta?.localChangePending) continue;
    pendingMetaIds.add(meta.id);
    const cleared = { ...meta, localChangePending: false } satisfies VersionMetaRecord;
    await putRecord(scope, VERSION_META_STORE, cleared);
    snapshot?.set(cleared.id, cleared);
  }
  if (pendingMetaIds.size === 0) return;
  for (const event of await scanStore<OutboxEvent>(scope, OUTBOX_STORE)) {
    if (event.synced || !event.retryable || event.versionMetaId === null) continue;
    if (!pendingMetaIds.has(event.versionMetaId)) continue;
    await putRecord(scope, OUTBOX_STORE, { ...event, retryable: false, lastError: DISCARDED_BY_PULL });
  }
}

/** The model stored in `storeName`, or `undefined` for a store no model uses. */
function modelForStore(contract: IdbContract, storeName: string): string | undefined {
  return Object.entries(domainModelsAtDefaultNamespace(contract.domain)).find(
    ([, model]) => (model as { storage?: { storeName?: string } }).storage?.storeName === storeName
  )?.[0];
}

/** Keep application and metadata aliases on their existing spelling after the pending-change guard. */
async function resolvePullIdentity(
  scope: IdbTransactionScope,
  contract: IdbContract,
  log: LogWithRecord,
  key: IDBValidKey,
  record: Record<string, unknown> | null,
  meta: VersionMetaRecord | undefined
) {
  const keyPath = getKeyPath(contract, log.model);
  const row = await resolveDecimalKey(scope, contract, log.model, key);
  // Pull metadata can retain wire-form key parts after the application row is deleted.
  const storedKey = row
    ? extractKeyFromRow(row, keyPath)
    : meta
      ? nativeVersionMetaKey(contract, log.model, meta.key)
      : key;
  const effectiveRecord = record && preserveDecimalKeySpelling(contract, log.model, record, storedKey);
  let identityKey: unknown = log.keyPath;
  if (hasDecimalPrimaryKey(contract, log.model))
    identityKey = effectiveRecord ? extractKeyFromRow(effectiveRecord, keyPath) : storedKey;
  return {
    row,
    key: storedKey as IDBValidKey,
    record: effectiveRecord,
    metaId: meta?.id ?? versionMetaKey(log.model, identityKey),
    metaKey: meta?.key ?? identityKey,
  };
}
