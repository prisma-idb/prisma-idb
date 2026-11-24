import type { MigrationOperationClass, MigrationPlanOperation } from "@prisma/orm-framework/components/control";
import { errorUnfilledPlaceholder } from "@prisma/orm-framework/errors/migration";
import type { IdbIndexDefinition, IdbStoreDefinition } from "./idb-contract-types";

// ── Marker store ─────────────────────────────────────────────────────────────

/**
 * Name of the internal marker store. Must match `MARKER_STORE_NAME` in driver-idb.
 * The client-idb marker compatibility test checks the migration writer and runtime reader.
 */
export const IDB_MARKER_STORE = "_prisma_next_marker";

/** Markers are keyed by contract space, including the app and each extension. */
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

/** DDL operation that drops a secondary index from an object store. Always `widening`: the index holds no data of its own. */
export type DropIndexOp = MigrationPlanOperation & {
  readonly kind: "dropIndex";
  readonly storeName: string;
  readonly indexName: string;
};

/** Scalar constants and the empty-list default serialized in a migration package. */
export type IdbJsonLiteral = string | number | boolean | null | readonly [];

/** Declarative steps applied to one field's value. */
export type IdbValueTransform =
  | { readonly kind: "placeholder"; readonly slot: string }
  | { readonly kind: "coerce"; readonly to: "int" | "string" | "boolean" | "isoDateString" }
  | { readonly kind: "defaultIfMissing"; readonly value: IdbJsonLiteral }
  | { readonly kind: "setLiteral"; readonly value: IdbJsonLiteral }
  | { readonly kind: "pipe"; readonly steps: readonly IdbValueTransform[] };

/** Rewrites records in one store. Always `data`. */
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

/** Builds an additive object-store operation for a migration. */
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

/** Builds a destructive operation that removes a store and all its records. */
export function dropObjectStoreOp(storeName: string): DropObjectStoreOp {
  return {
    kind: "dropObjectStore",
    id: `object-store.${storeName}.drop`,
    label: `Drop object store "${storeName}"`,
    operationClass: "destructive" as MigrationOperationClass,
    storeName,
  };
}

/** Builds an additive index operation with the supplied native index options. */
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

/** Builds a widening operation that removes an index without deleting records. */
export function dropIndexOp(storeName: string, indexName: string): DropIndexOp {
  return {
    kind: "dropIndex",
    id: `index.${storeName}.${indexName}.drop`,
    label: `Drop index "${indexName}" on "${storeName}"`,
    operationClass: "widening" as MigrationOperationClass,
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
 * The warning to show when a migration drops stores or removes fields.
 * Returns `undefined` when it deletes no data. The browser applies every planned op without asking,
 * so planning or re-emitting a migration is where the developer hears that
 * it deletes data. Dropping an index loses nothing that can't be rebuilt, so
 * indexes aren't listed.
 */
export function deletedDataWarning(ops: readonly unknown[]): string | undefined {
  const droppedStores = ops
    .filter((op): op is DropObjectStoreOp => (op as { kind?: unknown }).kind === "dropObjectStore")
    .map((op) => op.storeName);
  const removedFields = ops
    .filter((op): op is TransformRecordsOp => (op as { kind?: unknown }).kind === "transformRecords")
    .flatMap((op) => (op.removeFields ?? []).map((field) => `${op.storeName}.${field}`));
  if (droppedStores.length === 0 && removedFields.length === 0) return undefined;
  return (
    "\nWarning: this migration deletes data.\n" +
    (droppedStores.length > 0
      ? "When it runs in a user's browser, every record in these stores is deleted:\n" +
        droppedStores.map((store) => `  - ${store}\n`).join("")
      : "") +
    (removedFields.length > 0
      ? "These fields are removed from every record:\n" +
        removedFields.map((field) => `  - ${field}\n`).join("") +
        "For a field rename, use --rename Model.old:Model.new when planning to preserve the values.\n"
      : "") +
    "Check that this is intended before shipping it.\n"
  );
}

/** Create a record rewrite. The planner emits field renames, defaults, removals, and unfilled slots. */
export function transformRecordsOp(
  storeName: string,
  options: Pick<TransformRecordsOp, "fields" | "renameFields" | "removeFields">
): TransformRecordsOp {
  const op: TransformRecordsOp = {
    kind: "transformRecords",
    id: `object-store.${storeName}.transform-records`,
    label: `Transform records in "${storeName}"`,
    operationClass: "data",
    storeName,
    ...options,
  };
  assertFiniteTransformLiterals(op);
  return op;
}

/** Capture transform values before validation, row writes, and migration hooks. */
export function snapshotRecordTransform(op: TransformRecordsOp): TransformRecordsOp {
  function snapshotValue(transform: IdbValueTransform): IdbValueTransform {
    const kind = transform.kind;
    switch (kind) {
      case "defaultIfMissing":
      case "setLiteral":
        return { kind, value: structuredClone(transform.value) };
      case "pipe":
        return { kind: "pipe", steps: transform.steps.map(snapshotValue) };
      case "coerce":
        return { kind: "coerce", to: transform.to };
      case "placeholder":
        return { kind: "placeholder", slot: transform.slot };
    }
  }
  // Copy every property, including ones this type doesn't name, so a re-emit keeps the operation's metadata and
  // its hash. Only the nested values that a later change could reach are replaced.
  const { fields, renameFields, removeFields } = op;
  return {
    ...op,
    ...(fields && {
      fields: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, snapshotValue(value)])),
    }),
    ...(renameFields && { renameFields: { ...renameFields } }),
    ...(removeFields && { removeFields: [...removeFields] }),
  };
}

/** Convert a primitive value using ADR 016's conversion rules. */
export function coerce(to: Extract<IdbValueTransform, { kind: "coerce" }>["to"]): IdbValueTransform {
  return { kind: "coerce", to };
}

/** Migration artifacts store literals as JSON numbers, which must be finite. */
export function assertFiniteLiteral(value: IdbJsonLiteral): void {
  assertFiniteTree(value, new Set());
}

/** Walks a hand-written literal to any depth, because JSON parsing can nest arrays the type doesn't allow. */
function assertFiniteTree(value: unknown, seen: Set<object>): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`A migration literal is stored as JSON. Use a finite number in place of ${value}.`);
    }
    return;
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  for (const member of Object.values(value)) assertFiniteTree(member, seen);
}

/** Checks literals throughout an operation, including inside nested pipes. */
export function assertFiniteTransformLiterals(op: TransformRecordsOp): void {
  function check(field: string, transform: IdbValueTransform): void {
    if (transform.kind === "defaultIfMissing" || transform.kind === "setLiteral") {
      try {
        assertFiniteLiteral(transform.value);
      } catch (cause) {
        if (!(cause instanceof Error)) throw cause;
        throw new Error(
          `The ${transform.kind} transform for "${op.storeName}.${field}" in ${op.kind} has an invalid literal. ${cause.message}`,
          { cause }
        );
      }
    } else if (transform.kind === "pipe") {
      for (const step of transform.steps) check(field, step);
    }
  }
  for (const [field, transform] of Object.entries(op.fields ?? {})) check(field, transform);
}

/** Backfill an undefined field without replacing null or an existing value. */
export function defaultIfMissing(value: IdbJsonLiteral): IdbValueTransform {
  assertFiniteLiteral(value);
  return { kind: "defaultIfMissing", value };
}

/** Replace a field with a constant. */
export function setLiteral(value: IdbJsonLiteral): IdbValueTransform {
  assertFiniteLiteral(value);
  return { kind: "setLiteral", value };
}

/** Apply field transforms in the supplied order. */
export function pipe(...steps: readonly IdbValueTransform[]): IdbValueTransform {
  return { kind: "pipe", steps };
}

/** Mark a scaffolded field transform that the migration author must fill before emitting. */
export function placeholder(slot: string): IdbValueTransform {
  return { kind: "placeholder", slot };
}

/** Reject all unfilled slots, including those nested in pipes, before emitting or applying ops. */
export function assertNoMigrationPlaceholders(ops: readonly IdbDdlOp[]): void {
  const slots = new Set<string>();
  /** Collect each distinct slot, including placeholders nested in pipes. */
  function collect(transform: IdbValueTransform): void {
    if (transform.kind === "placeholder") slots.add(transform.slot);
    if (transform.kind === "pipe") transform.steps.forEach(collect);
  }
  for (const op of ops) {
    if (op.kind === "transformRecords") Object.values(op.fields ?? {}).forEach(collect);
  }
  if (slots.size > 0) {
    throw errorUnfilledPlaceholder([...slots].join(", "));
  }
}
