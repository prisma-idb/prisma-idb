import type { MigrationOperationClass, MigrationPlanOperation } from "@prisma/orm-framework/components/control";
import type { IdbIndexDefinition, IdbStoreDefinition } from "./idb-contract-types";

// ── Marker store ─────────────────────────────────────────────────────────────

/**
 * Name of the internal marker store. Must match `MARKER_STORE_NAME` in driver-idb.
 * The client-idb marker compatibility test checks the migration writer and runtime reader.
 */
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

/** Primitive constants that can be serialized in a migration package. */
export type IdbJsonLiteral = string | number | boolean | null;

/** Declarative steps applied to one field's value. */
export type IdbValueTransform =
  | { readonly kind: "coerce"; readonly to: "int" | "string" | "boolean" | "isoDateString" }
  | { readonly kind: "defaultIfMissing"; readonly value: IdbJsonLiteral }
  | { readonly kind: "setLiteral"; readonly value: IdbJsonLiteral }
  | { readonly kind: "pipe"; readonly steps: readonly IdbValueTransform[] };

/** Rewrites records in one store. Always `data`; authored by hand. */
export type TransformRecordsOp = MigrationPlanOperation & {
  readonly kind: "transformRecords";
  readonly storeName: string;
  /** Per-field value transforms, keyed by field name. */
  readonly fields?: Readonly<Record<string, IdbValueTransform>>;
  /** `{ newName: oldName }`: moves a value to a new key. */
  readonly renameFields?: Readonly<Record<string, string>>;
  /** Fields to delete. */
  readonly removeFields?: readonly string[];
};

/** Union of all IDB migration plan operations. */
export type IdbDdlOp = CreateObjectStoreOp | DropObjectStoreOp | CreateIndexOp | DropIndexOp | TransformRecordsOp;

// ── Type guard ────────────────────────────────────────────────────────────────

/** Returns `true` if `op` is an IDB migration op kind. */
export function isIdbDdlOp(op: MigrationPlanOperation): op is IdbDdlOp {
  return (
    "kind" in op &&
    (op.kind === "createObjectStore" ||
      op.kind === "dropObjectStore" ||
      op.kind === "createIndex" ||
      op.kind === "dropIndex" ||
      op.kind === "transformRecords")
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

/**
 * The warning to show when a migration drops object stores, or `undefined`
 * when it drops none. The browser applies every planned op without asking,
 * so planning or re-emitting a migration is where the developer hears that
 * it deletes data. Dropping an index loses nothing that can't be rebuilt, so
 * indexes aren't listed.
 */
export function deletedDataWarning(ops: readonly unknown[]): string | undefined {
  const droppedStores = ops
    .filter((op): op is DropObjectStoreOp => (op as { kind?: unknown }).kind === "dropObjectStore")
    .map((op) => op.storeName);
  if (droppedStores.length === 0) return undefined;
  return (
    "\nWarning: this migration deletes data. When it runs in a user's browser, every record in these stores is deleted:\n" +
    droppedStores.map((store) => `  - ${store}\n`).join("") +
    "Check that this is intended before shipping it.\n"
  );
}

/** Create a record rewrite. The schema differ never emits this operation. */
export function transformRecordsOp(
  storeName: string,
  options: Pick<TransformRecordsOp, "fields" | "renameFields" | "removeFields">
): TransformRecordsOp {
  return {
    kind: "transformRecords",
    id: `object-store.${storeName}.transform-records`,
    label: `Transform records in "${storeName}"`,
    operationClass: "data",
    storeName,
    ...options,
  };
}

/** Convert a primitive value using ADR 016's conversion rules. */
export function coerce(to: Extract<IdbValueTransform, { kind: "coerce" }>["to"]): IdbValueTransform {
  return { kind: "coerce", to };
}

/** Backfill an undefined field without replacing null or an existing value. */
export function defaultIfMissing(value: IdbJsonLiteral): IdbValueTransform {
  return { kind: "defaultIfMissing", value };
}

/** Replace a field with a constant. */
export function setLiteral(value: IdbJsonLiteral): IdbValueTransform {
  return { kind: "setLiteral", value };
}

/** Apply field transforms in the supplied order. */
export function pipe(...steps: readonly IdbValueTransform[]): IdbValueTransform {
  return { kind: "pipe", steps };
}
