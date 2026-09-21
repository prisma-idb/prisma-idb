import type { CodecCallContext } from "@prisma/orm-framework/components/codec";
import type { RuntimeAdapterInstance } from "@prisma/orm-framework/components/execution";
import type { IdbPlanBody } from "@prisma-idb/driver-idb/runtime";
import type { IdbQueryPlan } from "./idb-query-plan";

/**
 * Lowering context passed to the adapter's `lower()` method.
 *
 * Extends the framework's {@link CodecCallContext} (which carries an optional
 * `AbortSignal` for cooperative cancellation) with the resolved IDB contract.
 * The contract provides the per-store field→codec schema for per-field
 * codec encoding (e.g. resolving which codec to use for a `DateTime` field).
 *
 * Upstream equivalent: `LowererContext<TContract>` from
 * Prisma ORM's SQL relational query AST.
 */
export interface IdbLowererContext<TContract = unknown> extends CodecCallContext {
  /** The resolved IDB contract carrying the full storage schema. */
  readonly contract: TContract;
}

/**
 * Runtime adapter instance for IndexedDB.
 *
 * Extends the generic `RuntimeAdapterInstance` marker with the IDB-specific
 * `lower()` method. `lower()` is the core of the adapter: it translates an
 * {@link IdbQueryPlan} (IDB execution plan + meta) into an {@link IdbPlanBody}
 * (one of the strongly-typed IDB operation plans) that the driver can execute
 * directly against `window.indexedDB`.
 *
 * The concrete implementation is {@link import('./idb-adapter').IdbAdapter}.
 * This interface exists so `runtime-idb` has a stable contract to depend on
 * when building `IdbRuntimeImpl`.
 */
export interface IdbRuntimeAdapterInstance extends RuntimeAdapterInstance<"idb", "idb"> {
  /**
   * Lower an IDB query plan to an IDB execution plan.
   *
   * @param plan - The pre-lowering query plan from a Prisma lane. Carries the
   *   execution-ready `IdbPlanBody` plus plan metadata.
   * @param ctx  - Lowering context with the resolved contract (for per-field
   *   codec resolution via the contract's storage schema) and an optional
   *   `AbortSignal` for cooperative cancellation.
   * @returns The IDB plan body describing the exact IDB operation(s) to run.
   */
  lower(plan: IdbQueryPlan, ctx: IdbLowererContext): Promise<IdbPlanBody>;
}
