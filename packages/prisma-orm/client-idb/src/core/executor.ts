import type { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import type { IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";

/**
 * Thin executor interface for the IDB ORM client.
 *
 * Any object with a compatible `query()` method satisfies this interface,
 * including `IdbRuntime` from `@prisma-idb/runtime-idb`. The separation
 * avoids a direct dependency on `runtime-idb`, keeping `client-idb` composable
 * and independently testable.
 *
 * Named `query` (not `execute`) to match the row-returning half of upstream's
 * `RuntimeCore` query()/execute() split (rc.4) — `IdbRuntime.execute()` now
 * resolves a statement-stats object, not rows, so it no longer structurally
 * satisfies this interface.
 *
 * @example
 * ```ts
 * import { createIdbRuntime } from "@prisma-idb/runtime-idb/runtime";
 * const runtime = createIdbRuntime({ adapter, driver });
 * const client = idbOrm({ contract, executor: runtime }); // runtime satisfies IdbQueryExecutor
 * ```
 */
export interface IdbQueryExecutor {
  query<Row>(plan: IdbQueryPlan<Row>): AsyncIterableResult<Row>;
}
