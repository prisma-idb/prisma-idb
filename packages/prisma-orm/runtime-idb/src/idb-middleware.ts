import type { RuntimeMiddleware } from "@prisma/orm-framework/components/runtime";
import type { IdbLoweredPlan } from "@prisma-idb/adapter-idb/runtime";

/**
 * IDB-family middleware.
 *
 * Extends the generic `RuntimeMiddleware<IdbLoweredPlan>` marker. `familyId` is
 * optional so generic cross-family middleware (e.g. telemetry) — which carry
 * no `familyId` — remain assignable. When present, it must be `'idb'`; the
 * runtime can reject mismatches at construction time via
 * `checkMiddlewareCompatibility`.
 *
 * Mirrors the vendor `MongoMiddleware` / `SqlMiddleware` pattern.
 *
 * ## `onRow` backpressure limitation
 *
 * Unlike SQL/Mongo drivers, the IDB driver uses collect-then-yield: all rows
 * are materialized inside the IDB transaction before any are delivered to the
 * middleware pipeline (see ADR 006). This means:
 *
 * - `onRow` fires after the full cursor scan has completed and all rows are in
 *   memory. Throwing or aborting inside `onRow` does NOT reduce the number of
 *   rows read from the object store.
 * - Use `take(n)` on the query builder to bound materialization, not early
 *   exit from `onRow`.
 * - Observation-only hooks (telemetry, cache population, logging) work
 *   correctly — they just receive rows from an already-complete scan.
 *
 * ## Which statements middleware sees
 *
 * Only top-level `query()` and `execute()` calls run as activities.
 * `IdbTransactionScope.execute()` bypasses middleware, so `activityStarted`,
 * `beforeEncode` and `activityEnded` never fire for statements inside a
 * transaction, and `ctx.scope` is always `"runtime"`.
 */
export interface IdbMiddleware extends RuntimeMiddleware<IdbLoweredPlan> {
  readonly familyId?: "idb";
}
