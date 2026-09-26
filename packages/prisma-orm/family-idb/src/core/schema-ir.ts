/**
 * IndexedDB schema IR — the in-memory representation of the object store
 * structure used by introspect(), schemaVerify(), and the manifest format.
 *
 * Mirrors the contract types in `@prisma-idb/target-idb/pack` but
 * is independent of any versioned contract hash so it can be used as a
 * stable internal representation.
 */

/**
 * A store or index `keyPath`: a single field name, or (for a compound
 * primary key / compound secondary index) an ordered list of field names.
 * Mirrors `IdbKeyPath` from `@prisma-idb/target-idb/pack` — duplicated
 * rather than imported, matching this file's existing independence from any
 * versioned contract type (see the module doc comment above).
 */
export type IdbKeyPathIR = string | readonly string[];

export type IdbIndexIR = {
  readonly keyPath: IdbKeyPathIR;
  readonly unique: boolean;
  readonly multiEntry?: boolean;
};

export type IdbStoreIR = {
  readonly keyPath: IdbKeyPathIR;
  readonly autoIncrement?: boolean;
  readonly indexes?: Record<string, IdbIndexIR>;
};

export type IdbSchemaIR = {
  readonly stores: Record<string, IdbStoreIR>;
};
