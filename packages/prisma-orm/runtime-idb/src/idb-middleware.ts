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
 * ## Statements inside a transaction
 *
 * Top-level `query()` and `execute()` calls run the full middleware chain.
 * Statements inside a transaction (`db.transaction()`, and the scoped reads and
 * writes of nested and foreign-key-checked mutations) are observed instead:
 *
 * - The transaction is an activity with `ctx.scope === "transaction"`. Its
 *   `activityStarted` hooks are awaited before IndexedDB opens it.
 * - Each statement's `activityStarted`, `beforeEncode`, `onRow` and
 *   `activityEnded` hooks are called but not awaited, because IndexedDB commits
 *   a transaction that waits. Only their synchronous part runs before the next
 *   request. An async `beforeEncode` is warned about once.
 * - `intercept` hooks are not consulted, so a cache never serves a read inside
 *   a transaction.
 * - When the transaction completes or aborts, every statement and then the
 *   transaction get `activityFinalized` with `committed`, `rolled-back`, or
 *   `unknown`. `commit()` resolves after those hooks.
 */
export interface IdbMiddleware extends RuntimeMiddleware<IdbLoweredPlan> {
  readonly familyId?: "idb";
}
