import type { RuntimeAdapterDescriptor, ExecutionStack } from "@prisma/orm-framework/components/execution";
import { idbCodecLookup } from "@prisma-idb/target-idb/runtime";
import { idbAdapterDescriptorMeta } from "../core/descriptor-meta";
import { IdbAdapter } from "../core/idb-adapter";
import type { IdbRuntimeAdapterInstance } from "../core/runtime-adapter-instance";

export type { IdbRuntimeAdapterInstance, IdbLowererContext } from "../core/runtime-adapter-instance";
export type { IdbQueryPlan } from "../core/idb-query-plan";
export type {
  IdbQueryAst,
  IdbFindManyAst,
  IdbFindUniqueAst,
  IdbCreateAst,
  IdbDeleteAst,
  IdbUpdateAst,
  IdbUpdateAllAst,
  IdbUpdateCountAst,
  IdbCreateAllAst,
  IdbCreateCountAst,
  IdbDeleteAllAst,
  IdbDeleteCountAst,
  IdbCountAst,
  IdbAggregateAst,
  IdbGroupByAst,
  IdbAggregateRequest,
} from "../core/idb-query-ast";
export type {
  IdbFilterExpr,
  IdbFieldFilter,
  IdbAndExpr,
  IdbOrExpr,
  IdbNotExpr,
  IdbNullCheckExpr,
  IdbFilterOp,
} from "../core/idb-filter-expr";
export { fieldFilter, andExpr, orExpr, notExpr, nullCheckExpr, shorthandToFilterExpr } from "../core/idb-filter-expr";
export { evaluateFilter } from "../core/filter-eval";
export { IdbAdapter } from "../core/idb-adapter";

const idbRuntimeAdapterDescriptor: RuntimeAdapterDescriptor<"idb", "idb", IdbRuntimeAdapterInstance> = {
  ...idbAdapterDescriptorMeta,
  create(_stack: ExecutionStack<"idb", "idb">): IdbRuntimeAdapterInstance {
    // Construct the adapter with the real IDB codec lookup so per-field
    // encoding works when non-identity codecs are added. The current set
    // is all-identity, so output behavior is unchanged; this wiring makes
    // the descriptor-built adapter match the hand-constructed one in
    // `createIdbClient`.
    return new IdbAdapter(idbCodecLookup);
  },
};

export default idbRuntimeAdapterDescriptor;
