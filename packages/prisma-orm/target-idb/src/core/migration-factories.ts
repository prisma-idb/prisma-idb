import type { MigrationOperationClass, MigrationPlanOperation } from "@prisma/orm-framework/components/control";
import type { IdbIndexDefinition, IdbStoreDefinition } from "./idb-contract-types";

// ── Marker store ─────────────────────────────────────────────────────────────

/** Name of the internal marker store. Must match {@link MARKER_STORE_NAME} in driver-idb. */
export const IDB_MARKER_STORE = "_prisma_next_marker";

/**
 * Default keyPath for the marker store.
 *
 * Keyed by `space` (per-contract-space, defaulting to `"app"`) rather than
 * the legacy `"id"`/`"default"` shape so the storage layout doesn't need to
 * be migrated later if IDB grows extension support. See ADR 021 +
 * feedback issue #5.
 */
const MARKER_KEYPATH = "space";

// ── Op kinds ──────────────────────────────────────────────────────────────────

/** DDL operation that creates a new object store. Always `additive`. */
export type CreateObjectStoreOp = MigrationPlanOperation & {
  readonly kind: "createObjectStore";
  readonly storeName: string;
  readonly def: IdbStoreDefinition;
};

/** DDL operation that drops an existing object store and all its indexes. Always `destructive`. */
export type DropObjectStoreOp = MigrationPlanOperation & {
  readonly kind: "dropObjectStore";
  readonly storeName: string;
};

/** DDL operation that creates a secondary index on an object store. Always `additive`. */
export type CreateIndexOp = MigrationPlanOperation & {
  readonly kind: "createIndex";
  readonly storeName: string;
  readonly indexName: string;
  readonly def: IdbIndexDefinition;
};

/** DDL operation that drops a secondary index from an object store. Always `destructive`. */
export type DropIndexOp = MigrationPlanOperation & {
  readonly kind: "dropIndex";
  readonly storeName: string;
  readonly indexName: string;
};

/** Union of all IDB DDL plan operations. */
export type IdbDdlOp = CreateObjectStoreOp | DropObjectStoreOp | CreateIndexOp | DropIndexOp;

// ── Type guard ────────────────────────────────────────────────────────────────

/** Returns `true` if `op` is one of the four IDB DDL op kinds. */
export function isIdbDdlOp(op: MigrationPlanOperation): op is IdbDdlOp {
  return (
    "kind" in op &&
    (op.kind === "createObjectStore" ||
      op.kind === "dropObjectStore" ||
      op.kind === "createIndex" ||
      op.kind === "dropIndex")
  );
}

// ── Factories ─────────────────────────────────────────────────────────────────

export function createObjectStoreOp(storeName: string, def: IdbStoreDefinition): CreateObjectStoreOp {
  return {
    kind: "createObjectStore",
    id: `object-store.${storeName}.create`,
    label: `Create object store "${storeName}"`,
    operationClass: "additive" as MigrationOperationClass,
    storeName,
    def,
  };
}

export function dropObjectStoreOp(storeName: string): DropObjectStoreOp {
  return {
    kind: "dropObjectStore",
    id: `object-store.${storeName}.drop`,
    label: `Drop object store "${storeName}"`,
    operationClass: "destructive" as MigrationOperationClass,
    storeName,
  };
}

export function createIndexOp(storeName: string, indexName: string, def: IdbIndexDefinition): CreateIndexOp {
  return {
    kind: "createIndex",
    id: `index.${storeName}.${indexName}.create`,
    label: `Create index "${indexName}" on "${storeName}"`,
    operationClass: "additive" as MigrationOperationClass,
    storeName,
    indexName,
    def,
  };
}

export function dropIndexOp(storeName: string, indexName: string): DropIndexOp {
  return {
    kind: "dropIndex",
    id: `index.${storeName}.${indexName}.drop`,
    label: `Drop index "${indexName}" on "${storeName}"`,
    operationClass: "destructive" as MigrationOperationClass,
    storeName,
    indexName,
  };
}

/**
 * Create the internal `_prisma_next_marker` object store.
 *
 * This store holds the contract marker (`storageHash` + `profileHash`) that
 * the runtime verifies before executing queries. It is always additive and
 * should be the first op in any migration plan.
 */
export function createMarkerStoreOp(): CreateObjectStoreOp {
  return {
    kind: "createObjectStore",
    id: `object-store.${IDB_MARKER_STORE}.create`,
    label: `Create internal marker store "${IDB_MARKER_STORE}"`,
    operationClass: "additive" as MigrationOperationClass,
    storeName: IDB_MARKER_STORE,
    def: { keyPath: MARKER_KEYPATH },
  };
}
