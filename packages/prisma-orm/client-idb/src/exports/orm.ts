// ── IDB ORM client ────────────────────────────────────────────────────────────

// Factory + client type
export { idbOrm } from "../core/idb-orm";
export type { IdbOrmClient, IdbOrmOptions } from "../core/idb-orm";

// Accessor interface (useful for annotating function parameters / return types)
export type { IdbStoreAccessor, WhereCallback, IdbIncludeRefinementAccessor } from "../core/store-accessor";

// Grouped-aggregate accessor returned by `accessor.groupBy(...)`
export type { IdbGroupedAccessor, GroupedResultRow } from "../core/grouped-accessor";

// Executor interface (needed to type the executor passed to idbOrm)
export type { IdbQueryExecutor } from "../core/executor";

// Public row / filter / key types
export type {
  IdbContract,
  DefaultModelRow,
  WhereFilter,
  KeyType,
  ModelKeyPath,
  ModelKeyPathOrdered,
  IdbKeyPath,
  CreateInput,
  MutationCreateInput,
  PatchInput,
  MutationUpdateInput,
  ReferenceRelKeys,
  RelatedModelOf,
  IncludeSpec,
  IncludeMarker,
  IncludeFields,
  NoIncludes,
  IncludedRow,
  SelectedRow,
  OrderBySpec,
  SortDirection,
  AggregateFn,
  NumericFieldNames,
  IdbAggregateSelector,
  IdbAggregateSpec,
  IdbAggregateResult,
  IdbAggregateBuilder,
  IdbRelationMutator,
  IdbRelationMutation,
  RelationMutationCreate,
  RelationMutationConnect,
  RelationMutationDisconnect,
} from "../core/types";

// Include-scalar marker (returned by a refinement `count()`)
export type { IdbIncludeScalar } from "../core/store-state";

// Store name and key path helpers
export { getStoreName, getKeyPath, extractKeyFromRow, keyEquals, keyToken } from "../core/types";

// Filter operator combinators
export { and, or, not } from "../core/filters";
export type { IdbFieldAccessor, IdbModelAccessor } from "../core/model-accessor";
// AST + factory re-exports so middleware authors don't need to reach into
// `@prisma-idb/adapter-idb/runtime` for the filter shape.
export type {
  IdbFilterExpr,
  IdbFieldFilter,
  IdbAndExpr,
  IdbOrExpr,
  IdbNotExpr,
  IdbNullCheckExpr,
  IdbFilterOp,
} from "@prisma-idb/adapter-idb/runtime";

// Multi-store transaction scope API
export { withMutationScope } from "../core/mutation-scope";
export type { IdbQueryExecutorWithTransaction } from "../core/mutation-scope";

// Nested relation write helpers
export {
  createRelationMutator,
  isRelationMutationDescriptor,
  isRelationMutationCallback,
} from "../core/relation-mutator";
export {
  hasNestedMutationCallbacks,
  collectDeleteStoreNames,
  applyReferentialActionsForRow,
} from "../core/mutation-executor";
