/**
 * IndexedDB schema IR — the in-memory representation of the object store
 * structure used by offline replay and schema verification.
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

/** The key path and flags read from an IndexedDB index. */
export type IdbIndexIR = {
  readonly keyPath: IdbKeyPathIR;
  readonly unique: boolean;
  readonly multiEntry?: boolean;
};

/** The primary-key layout and indexes read from an object store. */
export type IdbStoreIR = {
  readonly keyPath: IdbKeyPathIR;
  readonly autoIncrement?: boolean;
  readonly indexes?: Record<string, IdbIndexIR>;
};

/** Object-store metadata used for offline schema verification. */
export type IdbSchemaIR = {
  readonly stores: Record<string, IdbStoreIR>;
};
