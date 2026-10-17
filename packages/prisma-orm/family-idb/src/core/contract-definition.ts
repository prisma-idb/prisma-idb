import type { IdbKeyPath, IdbMutationDefaultGeneratorId, IdbReferentialAction } from "@prisma-idb/target-idb/pack";

/**
 * The plain-data description of an IDB contract that authoring surfaces lower
 * into. Today the TypeScript `defineContract` DSL does; the PSL interpreter is
 * meant to follow. `buildIdbContractFromDefinition` is the only code in this
 * pipeline that turns a definition into a `Contract` and computes the contract
 * hashes.
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
  readonly fields: readonly IdbFieldNode[];
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
  readonly nullable: boolean;
  /** `true` for a list field. Only enum fields can be lists. */
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
  /** Fields on this model that the relation joins on. */
  readonly localFields: readonly string[];
  /** Fields on the related model that `localFields` match. */
  readonly targetFields: readonly string[];
  /** Whether the related record can be absent. Set on to-one relations only. */
  readonly nullable?: boolean;
  readonly onDelete?: IdbReferentialAction;
  readonly onUpdate?: IdbReferentialAction;
}
