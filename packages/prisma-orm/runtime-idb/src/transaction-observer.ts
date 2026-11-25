import {
  createContextBeneath,
  startTransactionActivity,
  type ActivityChild,
  type ActivityContext,
  type ActivityContextFields,
  type ActivityFinalizedResult,
  type StatementActivity,
  type TransactionActivityRun,
} from "@prisma/orm-framework/components/runtime";
import type { IdbAtomicPlan, IdbTransactionScope } from "@prisma-idb/driver-idb/runtime";
import type { IdbLoweredPlan } from "@prisma-idb/adapter-idb/runtime";
import type { IdbMiddleware } from "./idb-middleware";

/** Plans the observer runs straight on the driver scope, without middleware. */
const unobservedPlans = new WeakSet<IdbAtomicPlan>();

/**
 * Marks a plan to run inside an observed transaction without middleware seeing it, for a statement
 * the client sends for its own bookkeeping, such as a check that the transaction is still active.
 */
export function withoutMiddleware<P extends IdbAtomicPlan>(plan: P): P {
  unobservedPlans.add(plan);
  return plan;
}

/** Plan kinds that only read. Every other kind reports affected rows. */
const READ_KINDS = new Set(["cursor-scan", "key-get", "get-all", "count", "keys"]);

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null && typeof value === "object" && "then" in value;
}

/** Logs a hook's error with the event and middleware it came from. */
function logHookError(ctx: ActivityContext, event: string, mw: IdbMiddleware | undefined, error: unknown): void {
  ctx.log.error({ event, ...(mw !== undefined ? { middleware: mw.name } : {}), error });
}

/** Logs a rejection of a hook's promise, which is never awaited. */
function settle(ctx: ActivityContext, event: string, mw: IdbMiddleware, result: unknown): void {
  if (isThenable(result)) result.then(undefined, (error: unknown) => logHookError(ctx, event, mw, error));
}

/**
 * Calls a middleware hook without awaiting it. An IndexedDB transaction commits as soon as no
 * request is pending, so awaiting a hook that does real async work would end it early. A hook's
 * error, thrown or rejected, is logged instead of failing the statement.
 */
function observe(ctx: ActivityContext, event: string, mw: IdbMiddleware | undefined, call: () => unknown): void {
  try {
    const result = call();
    if (mw !== undefined) settle(ctx, event, mw, result);
  } catch (error) {
    logHookError(ctx, event, mw, error);
  }
}

/**
 * Wraps a driver transaction scope so middleware observes it the way upstream runtimes report a
 * transaction. The transaction's own activity starts before the IndexedDB transaction opens, so
 * its `activityStarted` hooks are awaited. Each statement inside it is a child activity whose
 * `activityStarted`, `beforeEncode`, `onRow` and `activityEnded` hooks are called and not awaited,
 * so only their synchronous part runs before the next request. A synchronous throw from
 * `activityStarted` or `beforeEncode` blocks the statement, as upstream's does; a rejected promise
 * from them is only logged. An async `beforeEncode` gets a warning, once per middleware in
 * `warnedAsync`, since a change it makes after an `await` misses the statement. `onRow` runs for
 * statements that return rows. Intercepts are not consulted, as upstream's cache skips
 * transactions too.
 *
 * When the IndexedDB transaction completes or aborts, the transaction ends: its `activityEnded`
 * hooks, then `activityFinalized` for every statement and for the transaction, with the outcome
 * `committed`, `rolled-back`, or `unknown` when it aborted after `commit()` was called before any `rollback()`. `commit()`
 * resolves after those hooks, so a cache is invalidated before the caller reads again. A hook that
 * fails at that point is logged and does not fail `commit()`, because IndexedDB has already
 * completed the transaction. Errors and warnings go to `ctx.log`, with the event and middleware
 * they came from. A plan marked with {@link withoutMiddleware} runs without any hook.
 */
export async function observeTransaction(
  open: () => Promise<IdbTransactionScope>,
  middleware: readonly IdbMiddleware[],
  fields: ActivityContextFields,
  warnedAsync: WeakSet<IdbMiddleware>
): Promise<IdbTransactionScope> {
  const context: ActivityContextFields = { ...fields, scope: "transaction" };
  const run: TransactionActivityRun = await startTransactionActivity({
    middleware,
    context,
    parent: undefined,
    holdFinishedChildren: middleware.some((mw) => typeof mw.activityFinalized === "function"),
  });

  let scope: IdbTransactionScope;
  try {
    scope = await open();
  } catch (error) {
    await run.end({ by: "rollback", outcome: "failed", commitAttempted: false });
    throw error;
  }

  // A commit() after rollback() only waits for the outcome, so it is not a commit attempt.
  let commitCalled = false;
  let rolledBack = false;
  // Once the transaction has ended, or commit() or rollback() was called, the activity takes no
  // more statements. A later statement goes straight to the driver, so the caller gets the
  // driver's TRANSACTION_INACTIVE error, which is how an early auto-commit is detected.
  let closed = false;
  // `commit()` only waits for completion, so subscribing here also ends a transaction that
  // commits on its own because nothing more was sent.
  // The framework rethrows the first error of a transaction's `activityEnded` hooks after it has
  // finalized everything. IndexedDB has already committed or aborted by then, so the error is
  // logged here instead of failing `commit()` for data that is saved.
  const end = async (settlement: Parameters<TransactionActivityRun["end"]>[0]): Promise<void> => {
    try {
      await run.end(settlement);
    } catch (error) {
      logHookError(run.ctx, "activityEnded", undefined, error);
    }
  };
  const ended = scope.commit().then(
    () => {
      closed = true;
      return end({ by: "commit", outcome: "succeeded" });
    },
    () => {
      closed = true;
      return end({ by: "rollback", outcome: "succeeded", commitAttempted: commitCalled });
    }
  );

  return {
    execute(plan: IdbAtomicPlan) {
      if (closed || unobservedPlans.has(plan)) return scope.execute(plan);
      try {
        return executeObserved(plan);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    async commit() {
      if (!rolledBack) commitCalled = true;
      closed = true;
      run.stopAcceptingChildren();
      try {
        await scope.commit();
      } finally {
        // Finalization runs whether the commit completed or aborted, before commit() settles.
        await ended;
      }
    },
    rollback,
  };

  function rollback(): void {
    rolledBack = true;
    closed = true;
    run.stopAcceptingChildren();
    scope.rollback();
  }

  /** Runs one statement as a child activity of the transaction. */
  function executeObserved(plan: IdbAtomicPlan): Promise<Awaited<ReturnType<IdbTransactionScope["execute"]>>> {
    const ctx = createContextBeneath(context, run);
    const activity: StatementActivity<IdbLoweredPlan> = {
      id: crypto.randomUUID(),
      kind: "statement",
      returns: READ_KINDS.has(plan.kind) ? "rows" : "stats",
      plan: plan as IdbLoweredPlan,
      annotations: new Map(),
    };
    const child: ActivityChild = {
      // Runs after the transaction ended, so the hooks are awaited: `commit()` resolves after them.
      async finalize(result: ActivityFinalizedResult) {
        for (const mw of middleware) {
          if (!mw.activityFinalized) continue;
          try {
            await mw.activityFinalized(activity, result, ctx);
          } catch (error) {
            logHookError(ctx, "activityFinalized", mw, error);
          }
        }
      },
    };
    const slot = run.adopt(child);
    const started = ctx.now();
    const finish = (outcome: "succeeded" | "failed", rows: readonly Record<string, unknown>[]): void => {
      const latencyMs = ctx.now() - started;
      const result =
        activity.returns === "rows"
          ? ({
              kind: "statement",
              outcome,
              latencyMs,
              source: "driver",
              returns: "rows",
              rowCount: rows.length,
            } as const)
          : ({
              kind: "statement",
              outcome,
              latencyMs,
              source: "driver",
              returns: "stats",
              stats: { affectedRows: rows.length },
            } as const);
      for (const mw of middleware) {
        if (mw.activityEnded) observe(ctx, "activityEnded", mw, () => mw.activityEnded!(activity, result, ctx));
      }
      if (outcome === "failed") observe(ctx, "statementFailed", undefined, () => slot.statementFailed());
      observe(ctx, "statementEnded", undefined, () =>
        slot.ended({ outcome: outcome === "failed" ? "rolled-back" : "committed" })
      );
    };
    try {
      // The synchronous part of these hooks runs before the statement, and a synchronous throw blocks
      // it, as upstream's does. Anything they await runs after the statement, so a rejection is logged.
      for (const mw of middleware) {
        if (mw.activityStarted) settle(ctx, "activityStarted", mw, mw.activityStarted(activity, ctx));
      }
      for (const mw of middleware) {
        if (!mw.beforeEncode) continue;
        const result: unknown = mw.beforeEncode(activity.plan, ctx);
        if (isThenable(result) && !warnedAsync.has(mw)) {
          warnedAsync.add(mw);
          ctx.log.warn({
            code: "IDB.MIDDLEWARE_ASYNC_IN_TRANSACTION",
            message: `Middleware "${mw.name}" returned a promise from beforeEncode inside a transaction. It is not awaited there, because IndexedDB commits a transaction that waits, so only its synchronous part runs before the statement.`,
          });
        }
        settle(ctx, "beforeEncode", mw, result);
      }
    } catch (error) {
      finish("failed", []);
      // A failed execute() aborts the transaction, so a hook that blocks the statement does too.
      // Otherwise a caller that catches the error could still commit the transaction's other writes.
      rollback();
      throw error;
    }
    return scope.execute(plan).then(
      (rows) => {
        // Writes echo the rows they touched, but report them as stats, so only reads reach `onRow`.
        if (activity.returns === "rows") {
          for (const row of rows) {
            for (const mw of middleware) {
              if (mw.onRow)
                observe(ctx, "onRow", mw, () => mw.onRow!(row as Record<string, unknown>, activity.plan, ctx));
            }
          }
        }
        finish("succeeded", rows as readonly Record<string, unknown>[]);
        return rows;
      },
      (error: unknown) => {
        finish("failed", []);
        throw error;
      }
    );
  }
}
