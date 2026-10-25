import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import { resolveAuthorizationPaths, resolveParentReferenceChecks } from "@prisma-idb/sync-server";
import { assertNoParentDefaults } from "./authorization";
import type { GetKeyField, OwnershipCheck, PushCheck, SyncServer, SyncServerContract } from "@prisma-idb/sync-server";
import type { ApplyPushInput, ApplyPushOutcome } from "./apply-push";
import type { PullInput, PullOutcome } from "./pull";
import type { SqlPushEvent, SqlPushResult } from "./push";
import type { ContractCheck } from "./contract-check-gate";
import { findContractMismatch } from "./contract-check-gate";
import { sqlGetKeyField } from "./get-key-field";
import { applyPushEvent as applyPushEventImpl, toSyncPushPayload } from "./push";
import { resolvePullRecord as resolvePullRecordImpl } from "./resolve-pull-record";
import { applyPush as applyPushImpl } from "./apply-push";
import { pull as pullImpl } from "./pull";
import type { ModelWritePolicies } from "./write-policy";
import { violatesWritePolicy } from "./write-policy";

/** Binds SQL execution to its contract, ownership server, and contract-check policy. */
export interface CreateSqlSyncAdapterOptions {
  readonly contract: SyncServerContract;
  /** @default sqlGetKeyField */
  readonly getKeyField?: GetKeyField;
  /**
   * The `createSyncServer` result for the same contract. Required by the
   * `applyPush`, `pull` and `resolvePullRecord` methods, which authorize
   * records and project returned rows to client-contract fields.
   */
  readonly syncServer?: SyncServer;
  /**
   * Whether `applyPush` and `pull` require the client's storage hash
   * to match the server's (ADR 015). Pass `"off"` only if your deploys already
   * keep clients and server on the same contract.
   * @default "required"
   */
  readonly contractCheck?: ContractCheck;
  /** Rejects a whole push batch if any event violates its model's policy. */
  readonly writePolicies?: ModelWritePolicies;
}

/** SQL push and pull operations bound to one contract and ownership configuration. */
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
  /** Returns the authorized row with only client-contract fields. Requires `syncServer`. */
  resolvePullRecord(
    db: unknown,
    model: string,
    check: OwnershipCheck,
    keyPath: unknown,
    operation: "create" | "update" | "delete"
  ): Promise<Record<string, unknown> | null>;
  /**
   * The whole push route: preflights write policies, validates ownership,
   * and applies events in order. Requires `syncServer`.
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
  const {
    contract,
    getKeyField = sqlGetKeyField,
    syncServer,
    contractCheck = "required",
    writePolicies = {},
  } = options;
  if (syncServer) {
    for (const model of Object.keys(domainModelsAtDefaultNamespace(contract.domain))) {
      const paths = resolveAuthorizationPaths(contract, syncServer.rootModel, model);
      assertNoParentDefaults(contract, model, resolveParentReferenceChecks(contract, getKeyField, model, paths));
    }
  }
  /** Rejects methods that need ownership validation when no server was configured. */
  const requireSyncServer = (method: string): SyncServer => {
    if (!syncServer) throw new Error(`createSqlSyncAdapter: ${method} needs the \`syncServer\` option.`);
    return syncServer;
  };

  return {
    getKeyField: (model) => getKeyField(contract, model),
    toSyncPushPayload,
    applyPushEvent: async (db, event, model, check, scopeKey) => {
      if (violatesWritePolicy(writePolicies, model, event)) {
        return { id: event.id, success: false, error: "WRITE_POLICY_VIOLATION", retryable: false };
      }
      return applyPushEventImpl(db, contract, getKeyField, event, model, check, scopeKey);
    },
    resolvePullRecord: async (db, model, check, keyPath, operation) =>
      resolvePullRecordImpl(
        db,
        requireSyncServer("resolvePullRecord"),
        contract,
        getKeyField,
        model,
        check,
        keyPath,
        operation
      ),
    applyPush: async (db, input) => {
      const server = requireSyncServer("applyPush");
      const mismatch = findContractMismatch(server, contractCheck, input.clientStorageHash);
      return mismatch ?? applyPushImpl(db, server, contract, getKeyField, input, writePolicies);
    },
    pull: async (db, input) => {
      const server = requireSyncServer("pull");
      const mismatch = findContractMismatch(server, contractCheck, input.clientStorageHash);
      return mismatch ?? pullImpl(db, server, contract, getKeyField, input);
    },
  };
}
