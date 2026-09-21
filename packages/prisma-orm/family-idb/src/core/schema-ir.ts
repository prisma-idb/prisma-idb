/**
 * IndexedDB schema IR — the in-memory representation of the object store
 * structure used by introspect(), schemaVerify(), and the manifest format.
 *
 * Mirrors the contract types in `@prisma-idb/target-idb/pack` but
 * is independent of any versioned contract hash so it can be used as a
 * stable internal representation.
 */

export type IdbIndexIR = {
  readonly keyPath: string;
  readonly unique: boolean;
  readonly multiEntry?: boolean;
};

export type IdbStoreIR = {
  readonly keyPath: string;
  readonly autoIncrement?: boolean;
  readonly indexes?: Record<string, IdbIndexIR>;
};

export type IdbSchemaIR = {
  readonly stores: Record<string, IdbStoreIR>;
};
