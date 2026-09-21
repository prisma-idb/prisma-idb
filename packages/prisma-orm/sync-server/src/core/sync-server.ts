import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import { resolveAuthorizationPaths } from "./authorization-paths";
import { buildOwnershipDag } from "./ownership-dag";
import type { OwnershipDag, SyncServerContract } from "./ownership-dag";

/** An outbox event pending push, transport-agnostic (no browser types). */
export interface SyncPushEvent {
  readonly id: string;
  readonly model: string;
  readonly operation: "create" | "update" | "delete";
  readonly payload: Record<string, unknown>;
}

/**
 * A changelog row pending pull; `key` is the row's own primary-key value.
 *
 * Expected to already be pre-filtered to the caller — e.g. by a `scopeKey`
 * column the caller stamped on the changelog row at push time (reusing the
 * `scopeKey` that authorized it) and queried flatly (`WHERE scopeKey = ?`).
 * `buildPullQueries` doesn't repeat that filter; it re-derives ownership
 * live, since the stamped value is a push-time snapshot and can go stale if
 * the record's ownership chain changes afterward (e.g. a `Board` handed to
 * a different owner after a `Todo` under it was already pushed).
 */
export interface SyncPullLogEntry {
  readonly changelogId: string;
  readonly model: string;
  readonly key: unknown;
}

/**
 * What the caller must check to authorize a record. Never a query result —
 * `sync-server` never touches a database (ADR 014's transport-agnostic
 * boundary). The caller executes the check against whatever storage it uses.
 */
export type OwnershipCheck =
  | { readonly kind: "unknown-model" }
  | {
      readonly kind: "root";
      readonly keyField: string;
      readonly key: unknown;
      readonly scopeKey: string;
      /** The row *is* the root — no query needed, this is already decided. */
      readonly authorized: boolean;
    }
  | {
      readonly kind: "scoped";
      readonly keyField: string;
      readonly key: unknown;
      readonly rootKeyField: string;
      readonly scopeKey: string;
      /**
       * Every relation-name chain from this model to `rootModel`. The
       * caller is authorized via *any one* resolving to `scopeKey`
       * (ADR 014) — e.g. `findFirst` with an `OR` across paths.
       */
      readonly paths: readonly (readonly string[])[];
    };

export interface PushValidationResult {
  readonly eventId: string;
  readonly model: string;
  readonly check: OwnershipCheck;
}

export interface PullScopeResult {
  readonly changelogId: string;
  readonly model: string;
  readonly check: OwnershipCheck;
}

/**
 * Resolves a model's primary-key field name from the contract. Storage
 * shape is the one thing that genuinely varies by family (IDB: a flat
 * `model.storage.keyPath` string; SQL: a possibly-compound
 * `contract.storage.namespaces[ns].entries.table[table].primaryKey.columns`
 * array; Mongo, whatever Mongo does) — so this is the sole extension point
 * `createSyncServer` exposes (`CreateSyncServerOptions.getKeyField`) rather
 * than something the DAG tries to introspect generically.
 */
export type GetKeyField = (contract: SyncServerContract, modelName: string) => string;

/**
 * Default resolver: duck-types `model.storage.keyPath` as a string. This
 * happens to be exactly IDB's storage shape, but nothing here imports an
 * IDB type to know that — a family whose storage shape doesn't expose a
 * flat `keyPath` (SQL's compound-capable `primaryKey.columns`, for one)
 * simply won't match, and `createSyncServer` throws asking for an explicit
 * `getKeyField` instead of silently misresolving.
 */
export const defaultGetKeyField: GetKeyField = (contract, modelName) => {
  const model = domainModelsAtDefaultNamespace(contract.domain)[modelName];
  const keyPath = (model?.storage as { readonly keyPath?: unknown } | undefined)?.keyPath;
  if (typeof keyPath !== "string") {
    throw new Error(
      `Model "${modelName}" has no string storage.keyPath in the contract. ` +
        `This contract's storage shape isn't IDB's — pass a getKeyField option to createSyncServer.`
    );
  }
  return keyPath;
};

function buildOwnershipCheck(
  dag: OwnershipDag,
  contract: SyncServerContract,
  getKeyField: GetKeyField,
  modelName: string,
  keyField: string,
  key: unknown,
  scopeKey: string
): OwnershipCheck {
  if (modelName === dag.rootModel) {
    return { kind: "root", keyField, key, scopeKey, authorized: key === scopeKey };
  }
  return {
    kind: "scoped",
    keyField,
    key,
    rootKeyField: getKeyField(contract, dag.rootModel),
    scopeKey,
    paths: resolveAuthorizationPaths(contract, dag.rootModel, modelName),
  };
}

export function validatePush(
  dag: OwnershipDag,
  contract: SyncServerContract,
  getKeyField: GetKeyField,
  events: readonly SyncPushEvent[],
  options: { readonly scopeKey: string }
): readonly PushValidationResult[] {
  const models = domainModelsAtDefaultNamespace(contract.domain);

  return events.map((event) => {
    if (!dag.clientModels.has(event.model) || !models[event.model]) {
      return { eventId: event.id, model: event.model, check: { kind: "unknown-model" } };
    }
    const keyField = getKeyField(contract, event.model);
    const check = buildOwnershipCheck(
      dag,
      contract,
      getKeyField,
      event.model,
      keyField,
      event.payload[keyField],
      options.scopeKey
    );
    return { eventId: event.id, model: event.model, check };
  });
}

export function buildPullQueries(
  dag: OwnershipDag,
  contract: SyncServerContract,
  getKeyField: GetKeyField,
  logs: readonly SyncPullLogEntry[],
  options: { readonly scopeKey: string }
): readonly PullScopeResult[] {
  const models = domainModelsAtDefaultNamespace(contract.domain);

  return logs.map((log) => {
    if (!dag.clientModels.has(log.model) || !models[log.model]) {
      return { changelogId: log.changelogId, model: log.model, check: { kind: "unknown-model" } };
    }
    const keyField = getKeyField(contract, log.model);
    const check = buildOwnershipCheck(dag, contract, getKeyField, log.model, keyField, log.key, options.scopeKey);
    return { changelogId: log.changelogId, model: log.model, check };
  });
}

export interface CreateSyncServerOptions {
  /** The full server-side contract (ADR 012) — includes client-excluded models. Any family. */
  readonly contract: SyncServerContract;
  /** The client-projected contract (ADR 012) — defines which models are ever synced. Any family. */
  readonly clientContract: SyncServerContract;
  readonly rootModel: string;
  /** @default defaultGetKeyField (IDB-shaped storage.keyPath) */
  readonly getKeyField?: GetKeyField;
}

export interface SyncServer {
  readonly rootModel: string;
  /** Resolve every event's ownership check. Pure — never touches a database. */
  validatePush(
    events: readonly SyncPushEvent[],
    options: { readonly scopeKey: string }
  ): readonly PushValidationResult[];
  /** Resolve every changelog row's pull-scope check. Pure — never touches a database. */
  buildPullQueries(
    logs: readonly SyncPullLogEntry[],
    options: { readonly scopeKey: string }
  ): readonly PullScopeResult[];
}

/**
 * Builds the ownership DAG once (throws on a broken schema — see
 * `buildOwnershipDag`) and returns a `SyncServer` bound to it.
 */
export function createSyncServer(options: CreateSyncServerOptions): SyncServer {
  const dag = buildOwnershipDag(options.contract, options.clientContract, options.rootModel);
  const getKeyField = options.getKeyField ?? defaultGetKeyField;

  return {
    rootModel: dag.rootModel,
    validatePush: (events, pushOptions) => validatePush(dag, options.contract, getKeyField, events, pushOptions),
    buildPullQueries: (logs, pullOptions) => buildPullQueries(dag, options.contract, getKeyField, logs, pullOptions),
  };
}
