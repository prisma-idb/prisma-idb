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

/** Middleware already warned about an async `beforeEncode` inside a transaction, so each is warned once. */
const warnedAsync = new WeakSet<IdbMiddleware>();

/** Plan kinds that only read. Every other kind reports affected rows. */
const READ_KINDS = new Set(["cursor-scan", "key-get", "get-all", "count", "keys"]);

/**
 * Calls a middleware hook without awaiting it. An IndexedDB transaction commits as soon as no
 * request is pending, so awaiting a hook that does real async work would end it early. A hook's
 * error, thrown or rejected, is logged instead of failing the statement.
 */
function observe(ctx: ActivityContext, call: () => unknown): void {
  try {
    const result = call();
    if (result !== null && typeof result === "object" && "then" in result) {
      (result as PromiseLike<unknown>).then(undefined, (error: unknown) => ctx.log.error(error));
    }
  } catch (error) {
    ctx.log.error(error);
  }
}

/**
 * Wraps a driver transaction scope so middleware observes it the way upstream runtimes report a
 * transaction. The transaction's own activity starts before the IndexedDB transaction opens, so
 * its `activityStarted` hooks are awaited. Each statement inside it is a child activity whose
 * `activityStarted`, `beforeEncode`, `onRow` and `activityEnded` hooks are called and not awaited,
 * so only their synchronous part runs before the next request; an async `beforeEncode` gets a
 * warning, since a change it makes after an `await` misses the statement. Intercepts are not
 * consulted, as upstream's cache skips transactions too.
 *
 * When the IndexedDB transaction completes or aborts, the transaction ends: its `activityEnded`
 * hooks, then `activityFinalized` for every statement and for the transaction, with the outcome
 * `committed`, `rolled-back`, or `unknown` when it aborted after `commit()` was called. `commit()`
 * resolves after those hooks, so a cache is invalidated before the caller reads again.
 */
export async function observeTransaction(
  open: () => Promise<IdbTransactionScope>,
  middleware: readonly IdbMiddleware[],
  fields: ActivityContextFields
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

  let commitCalled = false;
  // Once the transaction has ended, or commit() or rollback() was called, the activity takes no
  // more statements. A later statement goes straight to the driver, so the caller gets the
  // driver's TRANSACTION_INACTIVE error, which is how an early auto-commit is detected.
  let closed = false;
  // `commit()` only waits for completion, so subscribing here also ends a transaction that
  // commits on its own because nothing more was sent.
  const ended = scope.commit().then(
    () => {
      closed = true;
      return run.end({ by: "commit", outcome: "succeeded" });
    },
    () => {
      closed = true;
      return run.end({ by: "rollback", outcome: "succeeded", commitAttempted: commitCalled });
    }
  );
  ended.catch((error: unknown) => run.ctx.log.error(error));

  return {
    execute(plan: IdbAtomicPlan) {
      if (closed) return scope.execute(plan);
      try {
        return executeObserved(plan);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    async commit() {
      commitCalled = true;
      closed = true;
      run.stopAcceptingChildren();
      await scope.commit();
      await ended;
    },
    rollback() {
      closed = true;
      run.stopAcceptingChildren();
      scope.rollback();
    },
  };

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
            ctx.log.error(error);
          }
        }
      },
    };
    const slot = run.adopt(child);
    for (const mw of middleware) {
      if (mw.activityStarted) observe(ctx, () => mw.activityStarted!(activity, ctx));
    }
    for (const mw of middleware) {
      if (!mw.beforeEncode) continue;
      // The synchronous part of the hook runs before the statement; anything it awaits runs after.
      observe(ctx, () => {
        const result: unknown = mw.beforeEncode!(activity.plan, ctx);
        if (result !== null && typeof result === "object" && "then" in result && !warnedAsync.has(mw)) {
          warnedAsync.add(mw);
          ctx.log.warn({
            code: "IDB.MIDDLEWARE_ASYNC_IN_TRANSACTION",
            message: `Middleware "${mw.name}" returned a promise from beforeEncode inside a transaction. It is not awaited there, because IndexedDB commits a transaction that waits, so only its synchronous part runs before the statement.`,
          });
        }
        return result;
      });
    }
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
        if (mw.activityEnded) observe(ctx, () => mw.activityEnded!(activity, result, ctx));
      }
      if (outcome === "failed") slot.statementFailed();
      observe(ctx, () => slot.ended({ outcome: outcome === "failed" ? "rolled-back" : "committed" }));
    };
    return scope.execute(plan).then(
      (rows) => {
        for (const row of rows) {
          for (const mw of middleware) {
            if (mw.onRow) observe(ctx, () => mw.onRow!(row as Record<string, unknown>, activity.plan, ctx));
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
