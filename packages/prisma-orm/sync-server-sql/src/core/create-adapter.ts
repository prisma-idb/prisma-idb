import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import { resolveAuthorizationPaths, resolveParentReferenceChecks } from "@prisma-idb/sync-server";
import { assertNoParentDefaults } from "./authorization";
import type { GetKeyField, OwnershipCheck, PushCheck, SyncServer, SyncServerContract } from "@prisma-idb/sync-server";
import type { ApplyPushInput, ApplyPushOutcome } from "./apply-push";
import type { PullInput, PullOutcome } from "./pull";
import type { SqlPushEvent, SqlPushResult } from "./push";
import type { ContractFingerprintCheck } from "./contract-fingerprint-gate";
import { findContractMismatch } from "./contract-fingerprint-gate";
import { sqlGetKeyField } from "./get-key-field";
import { applyPushEvent as applyPushEventImpl, toSyncPushPayload } from "./push";
import { resolvePullRecord as resolvePullRecordImpl } from "./resolve-pull-record";
import { applyPush as applyPushImpl } from "./apply-push";
import { pull as pullImpl } from "./pull";

export interface CreateSqlSyncAdapterOptions {
  readonly contract: SyncServerContract;
  /** @default sqlGetKeyField */
  readonly getKeyField?: GetKeyField;
  /**
   * The `createSyncServer` result for the same contract. Required by the
   * one-call `applyPush` / `pull` helpers, which run its ownership checks;
   * the lower-level methods work without it.
   */
  readonly syncServer?: SyncServer;
  /**
   * Whether `applyPush` and `pull` require the client's contract fingerprint
   * to match the server's (ADR 015). Pass `"off"` only if your deploys already
   * keep clients and server on the same contract.
   * @default "required"
   */
  readonly contractFingerprintCheck?: ContractFingerprintCheck;
}

export interface SqlSyncAdapter {
  getKeyField(model: string): string;
  toSyncPushPayload(operation: string, payload: unknown, keyField: string): Record<string, unknown>;
  applyPushEvent(
    db: unknown,
    event: SqlPushEvent,
    model: string,
    check: PushCheck,
    scopeKey: string
  ): Promise<SqlPushResult>;
  resolvePullRecord(
    db: unknown,
    model: string,
    check: OwnershipCheck,
    keyPath: unknown,
    operation: "create" | "update" | "delete"
  ): Promise<Record<string, unknown> | null>;
  /**
   * The whole push route in one call: validates ownership, applies every
   * event in order, and returns one result per event. Requires `syncServer`.
   */
  applyPush(db: unknown, input: ApplyPushInput): Promise<ApplyPushOutcome>;
  /**
   * The whole pull route in one call: the next page of `scopeKey`'s
   * changelog after `lastChangelogId`, each row re-authorized and resolved
   * to its current record. Requires `syncServer`.
   */
  pull(db: unknown, input: PullInput): Promise<PullOutcome>;
}

/**
 * Ties the pieces in this package together against one contract, the same
 * shape `createSyncServer` (`@prisma-idb/sync-server`) already uses —
 * built once per app, not per request.
 */
export function createSqlSyncAdapter(options: CreateSqlSyncAdapterOptions): SqlSyncAdapter {
  const { contract, getKeyField = sqlGetKeyField, syncServer, contractFingerprintCheck = "required" } = options;
  if (syncServer) {
    for (const model of Object.keys(domainModelsAtDefaultNamespace(contract.domain))) {
      const paths = resolveAuthorizationPaths(contract, syncServer.rootModel, model);
      assertNoParentDefaults(contract, model, resolveParentReferenceChecks(contract, getKeyField, model, paths));
    }
  }
  const requireSyncServer = (method: string): SyncServer => {
    if (!syncServer) throw new Error(`createSqlSyncAdapter: ${method} needs the \`syncServer\` option.`);
    return syncServer;
  };

  return {
    getKeyField: (model) => getKeyField(contract, model),
    toSyncPushPayload,
    applyPushEvent: (db, event, model, check, scopeKey) =>
      applyPushEventImpl(db, contract, getKeyField, event, model, check, scopeKey),
    resolvePullRecord: (db, model, check, keyPath, operation) =>
      resolvePullRecordImpl(db, contract, getKeyField, model, check, keyPath, operation),
    applyPush: async (db, input) => {
      const server = requireSyncServer("applyPush");
      const mismatch = await findContractMismatch(server, contractFingerprintCheck, input.clientContractFingerprint);
      return mismatch ?? applyPushImpl(db, server, contract, getKeyField, input);
    },
    pull: async (db, input) => {
      const server = requireSyncServer("pull");
      const mismatch = await findContractMismatch(server, contractFingerprintCheck, input.clientContractFingerprint);
      return mismatch ?? pullImpl(db, server, contract, getKeyField, input);
    },
  };
}
