import type { QueryPlan } from "@prisma/orm-framework/components/runtime";
import type { IdbPlanBody } from "@prisma-idb/driver-idb/runtime";
import type { IdbQueryAst } from "./idb-query-ast";

// Unique symbol for row phantom-type brand (mirrors MongoQueryPlan's pattern).
declare const __idbQueryPlanRow: unique symbol;

/**
 * IDB pre-lowering query plan produced by lanes before lowering.
 *
 * Extends the framework-level {@link QueryPlan}<Row> marker (`meta + _row`) and
 * adds the IDB execution plan as `idbPlan`. Because IDB has no query language
 * of its own, the plan already carries the execution-ready {@link IdbPlanBody}
 * — there is no AST compilation step as in SQL. The adapter's `lower()` step
 * preserves that body and adds semantic identities for structured row closures.
 *
 * The optional `ast` field carries a lightweight {@link IdbQueryAst} describing
 * the query intent. It is populated by the ORM lane (`client-idb`) so middleware
 * can derive cache identity without inspecting closure source code. This mirrors
 * the upstream pattern where {@link SqlQueryPlan} carries an `ast: AnyQueryAst`.
 *
 * @template Row - The TypeScript row shape inferred from the lane builder.
 *   Phantom-typed: never read at runtime, but constrains the return type of
 *   `runtime.query()`.
 */
export interface IdbQueryPlan<Row = unknown> extends QueryPlan<Row> {
  /** The execution-ready IDB plan produced by the lane builder. */
  readonly idbPlan: IdbPlanBody;
  /**
   * Optional lightweight AST describing the query intent.
   *
   * The adapter uses this to populate `queryIdentity` on the lowered plan.
   * Middleware receives that lowered plan, rather than this AST. Absent for
   * plans constructed outside the ORM lane. The AST must describe the
   * filter and comparator closures in `idbPlan`.
   */
  readonly ast?: IdbQueryAst;
  /** Phantom row brand — matches the `_row` slot on the base QueryPlan. */
  readonly [__idbQueryPlanRow]?: Row;
}

/**
 * Execution-ready plan with canonical identities for structured row closures.
 *
 * The driver ignores this metadata. Middleware can use it to distinguish
 * captured filter values and comparator field priority and directions.
 * For range-split batches, the identity also describes each child scan's
 * closures. Missing identities mean those closures must be treated as opaque.
 */
export type IdbLoweredPlan = IdbPlanBody & {
  readonly queryIdentity?: {
    readonly filter?: string;
    readonly comparator?: string;
  };
};
