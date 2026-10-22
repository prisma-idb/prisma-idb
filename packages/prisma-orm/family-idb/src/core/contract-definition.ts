import type { IdbKeyPath, IdbMutationDefaultGeneratorId, IdbReferentialAction } from "@prisma-idb/target-idb/pack";

/**
 * The plain-data description of an IDB contract that authoring surfaces lower
 * into. Both the TypeScript `defineContract` DSL and the PSL interpreter use it.
 * `buildIdbContractFromDefinition` turns a definition into a `Contract` and
 * computes its hashes for both surfaces.
 *
 * Mirrors upstream's `ContractDefinition` in `@prisma/orm-family-sql/contract-ts`:
 * ordered arrays of named nodes, with everything already resolved. A node holds
 * what the author declared (after defaults are applied), never the contract's
 * own shape. Array order is the order of the resulting contract's keys.
 *
 * IndexedDB has no separate unique-constraint object. A unique constraint is an
 * index with `unique: true`, so `indexes` covers both.
 */
export interface IdbContractDefinition {
  readonly enums: readonly IdbEnumNode[];
  readonly models: readonly IdbModelNode[];
}

/**
 * A definition coordinate uses declaration names rather than array offsets so
 * projection and backrelation resolution cannot invalidate it. Attributes use
 * their names on fields and their declaration offsets on models, where an
 * attribute such as `@@index` can occur more than once.
 */
export type IdbDefinitionPath = readonly (string | number)[];

/** A named enum. IDB stores every enum member as a string. */
export interface IdbEnumNode {
  readonly name: string;
  readonly members: readonly IdbEnumMemberNode[];
}

/** One enum member: its name in code and the string stored in IndexedDB. */
export interface IdbEnumMemberNode {
  readonly name: string;
  readonly value: string;
}

/** One model and the object store it maps to. */
export interface IdbModelNode {
  readonly modelName: string;
  readonly storeName: string;
  /** The primary key field, or an ordered list of fields for a compound key. */
  readonly key: IdbKeyPath;
  /** `true` when the store generates its single-field key with IndexedDB's key generator. */
  readonly autoIncrement: boolean;
  /** Source fields requesting a storage key generator, retained until validation. */
  readonly autoIncrementFields?: readonly string[];
  readonly fields: readonly IdbFieldNode[];
  /** Source field names and exclusions retained to validate a client projection. */
  readonly exclusions?: {
    readonly fields: readonly string[];
    readonly declaredFields: readonly string[];
    readonly relationFields: readonly string[];
  };
  readonly indexes: readonly IdbIndexNode[];
  /** Relations in the order they appear on the model. */
  readonly relations: readonly IdbRelationNode[];
}

/** A generator that fills a field when a record is created or updated. */
export interface IdbGeneratorNode {
  readonly id: IdbMutationDefaultGeneratorId;
  readonly params?: Record<string, unknown>;
}

/** The generators that fill a field on create and on update. */
export interface IdbExecutionDefaultNode {
  readonly onCreate?: IdbGeneratorNode;
  readonly onUpdate?: IdbGeneratorNode;
}

/** One scalar or enum field of a model. */
export interface IdbFieldNode {
  readonly name: string;
  /** The stored codec. Enum fields use the string codec. */
  readonly codecId: string;
  /** An unresolved source type retained so validation can report it alongside other errors. */
  readonly unsupportedType?: string;
  readonly nullable: boolean;
  /** `true` for a list field. Scalar and enum fields can be lists. */
  readonly list: boolean;
  /** The enum this field is typed as. Absent for scalar fields. */
  readonly enumName?: string;
  /**
   * A literal default the `setDefault` referential action resets the field to.
   * It does not fill the field on `create()`; `executionDefault` does that.
   */
  readonly literalDefault?: string | number | boolean;
  /** The generators that fill the field on `create()` and `update()`. */
  readonly executionDefault?: IdbExecutionDefaultNode;
}

/** A secondary index on a model's store. */
export interface IdbIndexNode {
  readonly name: string;
  /** A single field name, or an ordered list of fields for a compound index. */
  readonly keyPath: IdbKeyPath;
  readonly unique: boolean;
  readonly multiEntry?: boolean;
}

/** A relation from one model to another, with its foreign-key fields and referential actions. */
export interface IdbRelationNode {
  readonly name: string;
  /** The related model's name. */
  readonly to: string;
  readonly cardinality: "1:1" | "1:N" | "N:1";
  /** No owning relation could supply this PSL backrelation's join fields. */
  readonly unresolvedBackrelation?: boolean;
  /** Fields on this model that the relation joins on. */
  readonly localFields: readonly string[];
  /** Fields on the related model that `localFields` match. */
  readonly targetFields: readonly string[];
  /** Whether the related record can be absent. Set on to-one relations only. */
  readonly nullable?: boolean;
  readonly onDelete?: IdbReferentialAction;
  readonly onUpdate?: IdbReferentialAction;
  /**
   * `false` stops the builder from indexing this relation's foreign-key fields.
   * Absent means it indexes them. A `1:N` relation is never indexed, because
   * its `localFields` are not foreign keys.
   */
  readonly index?: boolean;
}
