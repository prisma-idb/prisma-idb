import type { GetKeyField, OwnershipCheck, SyncServerContract } from "@prisma-idb/sync-server";
import type { SqlPushEvent, SqlPushResult } from "./push";
import { sqlGetKeyField } from "./get-key-field";
import { applyPushEvent as applyPushEventImpl, toSyncPushPayload } from "./push";
import { resolvePullRecord as resolvePullRecordImpl } from "./pull";

export interface CreateSqlSyncAdapterOptions {
  readonly contract: SyncServerContract;
  /** @default sqlGetKeyField */
  readonly getKeyField?: GetKeyField;
}

export interface SqlSyncAdapter {
  getKeyField(model: string): string;
  toSyncPushPayload(operation: string, payload: unknown, keyField: string): Record<string, unknown>;
  applyPushEvent(
    db: unknown,
    event: SqlPushEvent,
    model: string,
    check: OwnershipCheck,
    scopeKey: string
  ): Promise<SqlPushResult>;
  resolvePullRecord(
    db: unknown,
    model: string,
    check: OwnershipCheck,
    keyPath: unknown,
    operation: "create" | "update" | "delete"
  ): Promise<Record<string, unknown> | null>;
}

/**
 * Ties the pieces in this package together against one contract, the same
 * shape `createSyncServer` (`@prisma-idb/sync-server`) already uses —
 * built once per app, not per request.
 */
export function createSqlSyncAdapter(options: CreateSqlSyncAdapterOptions): SqlSyncAdapter {
  const { contract, getKeyField = sqlGetKeyField } = options;

  return {
    getKeyField: (model) => getKeyField(contract, model),
    toSyncPushPayload,
    applyPushEvent: (db, event, model, check, scopeKey) =>
      applyPushEventImpl(db, contract, getKeyField, event, model, check, scopeKey),
    resolvePullRecord: (db, model, check, keyPath, operation) =>
      resolvePullRecordImpl(db, contract, getKeyField, model, check, keyPath, operation),
  };
}
