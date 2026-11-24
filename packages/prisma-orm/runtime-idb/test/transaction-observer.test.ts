/**
 * `observeTransaction` against a controllable transaction scope: what happens to a middleware
 * hook's error, when each hook runs relative to the IndexedDB transaction, and how a transaction
 * that fails to start or is rolled back with a statement in flight is reported.
 */
import type { ActivityContextFields } from "@prisma/orm-framework/components/runtime";
import type { IdbAtomicPlan, IdbTransactionScope } from "@prisma-idb/driver-idb/runtime";
import { describe, expect, it, vi } from "vitest";
import type { IdbMiddleware } from "../src/idb-middleware";
import { observeTransaction as observeWith, withoutMiddleware } from "../src/transaction-observer";

/** Observes with a fresh set of warned middleware, as a new runtime would. */
function observeTransaction(
  open: () => Promise<IdbTransactionScope>,
  middleware: readonly IdbMiddleware[],
  fields: ActivityContextFields,
  warnedAsync = new WeakSet<IdbMiddleware>()
) {
  return observeWith(open, middleware, fields, warnedAsync);
}

const plan = { kind: "get-all", storeName: "users" } as unknown as IdbAtomicPlan;

function makeFields() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const fields = {
    contract: {},
    mode: "permissive",
    now: () => Date.now(),
    log,
    scope: "runtime",
    contentHash: async () => "hash",
  } as unknown as ActivityContextFields;
  return { fields, log };
}

/** A scope whose completion the test controls, standing in for the IndexedDB transaction. */
function makeScope(execute: (plan: IdbAtomicPlan) => Promise<unknown> = async () => [{ id: "1" }]) {
  let complete!: () => void;
  let abort!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    complete = resolve;
    abort = reject;
  });
  const scope = {
    execute: vi.fn(execute),
    commit: vi.fn(() => done),
    rollback: vi.fn(() => abort(new Error("aborted"))),
  } as unknown as IdbTransactionScope;
  return { scope, complete, abort };
}

/** Hooks are loosely typed so a test can use a synchronous hook, which the runtime must also accept. */
type LooseHooks = {
  [K in keyof IdbMiddleware]?: IdbMiddleware[K] extends ((...args: infer A) => unknown) | undefined
    ? (...args: A) => unknown
    : IdbMiddleware[K];
};
function mw(hooks: LooseHooks): IdbMiddleware {
  return { name: "test", familyId: "idb", ...hooks } as unknown as IdbMiddleware;
}

describe("observeTransaction", () => {
  it("resolves commit() and logs the error when a transaction's activityEnded hook throws", async () => {
    const { fields, log } = makeFields();
    const { scope, complete } = makeScope();
    const failure = new Error("ended hook failed");
    const finalized: string[] = [];
    const tx = await observeTransaction(
      async () => scope,
      [
        mw({
          async activityEnded(activity) {
            if (activity.kind === "transaction") throw failure;
          },
          async activityFinalized(activity, result) {
            finalized.push(`${activity.kind}:${result.outcome}`);
          },
        }),
      ],
      fields
    );
    await tx.execute(plan);
    const committed = tx.commit();
    complete();
    await expect(committed).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith({ event: "activityEnded", error: failure });
    // The framework still finalizes the statement and the transaction before rethrowing.
    expect(finalized).toEqual(["statement:committed", "transaction:committed"]);
  });

  it("resolves commit() when a transaction's activityFinalized hook throws, and logs it", async () => {
    const { fields, log } = makeFields();
    const { scope, complete } = makeScope();
    const failure = new Error("finalized hook failed");
    const tx = await observeTransaction(
      async () => scope,
      [
        mw({
          async activityFinalized(activity) {
            if (activity.kind === "transaction") throw failure;
          },
        }),
      ],
      fields
    );
    const committed = tx.commit();
    complete();
    await expect(committed).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ error: failure }));
  });

  it("logs a throwing statement activityFinalized hook and still resolves commit()", async () => {
    const { fields, log } = makeFields();
    const { scope, complete } = makeScope();
    const failure = new Error("statement finalize failed");
    const tx = await observeTransaction(
      async () => scope,
      [
        mw({
          async activityFinalized(activity) {
            if (activity.kind === "statement") throw failure;
          },
        }),
      ],
      fields
    );
    await tx.execute(plan);
    const committed = tx.commit();
    complete();
    await expect(committed).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith({ event: "activityFinalized", middleware: "test", error: failure });
  });

  it("logs a hook's rejection or a throwing onRow or activityEnded, with its event and middleware, and still runs the statement", async () => {
    const { fields, log } = makeFields();
    const { scope } = makeScope();
    const errors = {
      activityStarted: new Error("started"),
      beforeEncode: new Error("before"),
      onRow: new Error("row"),
      activityEnded: new Error("ended"),
    };
    const tx = await observeTransaction(
      async () => scope,
      [
        mw({
          activityStarted(activity) {
            return activity.kind === "statement" ? Promise.reject(errors.activityStarted) : undefined;
          },
          beforeEncode() {
            return Promise.reject(errors.beforeEncode);
          },
          onRow() {
            throw errors.onRow;
          },
          activityEnded(activity) {
            if (activity.kind === "statement") throw errors.activityEnded;
          },
        }),
      ],
      fields
    );
    await expect(tx.execute(plan)).resolves.toEqual([{ id: "1" }]);
    await vi.waitFor(() => {
      for (const [event, error] of Object.entries(errors)) {
        expect(log.error).toHaveBeenCalledWith({ event, middleware: "test", error });
      }
    });
    expect(scope.execute).toHaveBeenCalledTimes(1);
  });

  it("warns once per middleware about an async beforeEncode, and does not wait for it", async () => {
    const { fields, log } = makeFields();
    const { scope } = makeScope();
    let resumed = false;
    const resumedWhenStatementEnded: boolean[] = [];
    // Never settles until the test ends: a hook that was awaited would hold the statement forever.
    const never = new Promise<void>(() => undefined);
    const tx = await observeTransaction(
      async () => scope,
      [
        mw({
          name: "slow",
          async beforeEncode() {
            await never;
            resumed = true;
          },
          activityEnded(activity) {
            if (activity.kind === "statement") resumedWhenStatementEnded.push(resumed);
          },
        }),
      ],
      fields
    );
    await tx.execute(plan);
    await tx.execute(plan);
    expect(resumedWhenStatementEnded).toEqual([false, false]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ code: "IDB.MIDDLEWARE_ASYNC_IN_TRANSACTION" }));
  });

  it("warns once per runtime: a second transaction of the same runtime stays quiet, another runtime warns again", async () => {
    const { fields, log } = makeFields();
    const slow = mw({ name: "slow", beforeEncode: async () => undefined });
    const runtimeWarnings = new WeakSet<IdbMiddleware>();
    for (const warned of [runtimeWarnings, runtimeWarnings, new WeakSet<IdbMiddleware>()]) {
      const tx = await observeTransaction(async () => makeScope().scope, [slow], fields, warned);
      await tx.execute(plan);
    }
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it.each(["beforeEncode", "activityStarted"] as const)(
    "blocks the statement when %s throws synchronously, and reports it as failed",
    async (hook) => {
      const { fields, log } = makeFields();
      const { scope } = makeScope();
      const refused = new Error("refused");
      const ended: string[] = [];
      const tx = await observeTransaction(
        async () => scope,
        [
          mw({
            [hook]: (first: { kind?: string }) => {
              if (hook === "beforeEncode" || first.kind === "statement") throw refused;
            },
            activityEnded(activity: { kind: string }, result: { outcome: string }) {
              if (activity.kind === "statement") ended.push(result.outcome);
            },
          }),
        ],
        fields
      );
      await expect(tx.execute(plan)).rejects.toBe(refused);
      expect(scope.execute).not.toHaveBeenCalled();
      expect(ended).toEqual(["failed"]);
      expect(log.error).not.toHaveBeenCalled();
    }
  );

  it("calls onRow for statements that return rows, not for writes", async () => {
    const { fields } = makeFields();
    const { scope } = makeScope();
    const rows: unknown[] = [];
    const tx = await observeTransaction(async () => scope, [mw({ onRow: (row) => void rows.push(row) })], fields);
    await tx.execute({ kind: "put", storeName: "users", record: { id: "1" } } as unknown as IdbAtomicPlan);
    expect(rows).toEqual([]);
    await tx.execute(plan);
    expect(rows).toEqual([{ id: "1" }]);
  });

  it("runs a plan marked withoutMiddleware with no hook", async () => {
    const { fields } = makeFields();
    const { scope, complete } = makeScope();
    const events: string[] = [];
    const tx = await observeTransaction(
      async () => scope,
      [
        mw({
          activityStarted: (activity) => void events.push(`started:${activity.kind}`),
          beforeEncode: () => void events.push("beforeEncode"),
          onRow: () => void events.push("onRow"),
          activityFinalized: (activity) => void events.push(`finalized:${activity.kind}`),
        }),
      ],
      fields
    );
    await expect(tx.execute(withoutMiddleware({ ...plan }))).resolves.toEqual([{ id: "1" }]);
    expect(scope.execute).toHaveBeenCalledTimes(1);
    const committed = tx.commit();
    complete();
    await committed;
    expect(events).toEqual(["started:transaction", "finalized:transaction"]);
  });

  it("finalizes as rolled back when commit() follows rollback() only to wait for the outcome", async () => {
    const { fields } = makeFields();
    const { scope } = makeScope();
    const finalized: string[] = [];
    const tx = await observeTransaction(
      async () => scope,
      [mw({ activityFinalized: (activity, result) => void finalized.push(`${activity.kind}:${result.outcome}`) })],
      fields
    );
    await tx.execute(plan);
    tx.rollback();
    await expect(tx.commit()).rejects.toThrow("aborted");
    expect(finalized).toEqual(["statement:rolled-back", "transaction:rolled-back"]);
  });

  it.each(["rollback()", "an abort"] as const)(
    "finalizes with the outcome unknown before commit() rejects, when commit() is followed by %s",
    async (then) => {
      const { fields } = makeFields();
      const { scope, abort } = makeScope();
      const finalized: string[] = [];
      const tx = await observeTransaction(
        async () => scope,
        [
          mw({
            async activityFinalized(activity, result) {
              // Takes a task, so a commit() that did not wait for finalization would settle first.
              await new Promise((resolve) => setTimeout(resolve, 5));
              finalized.push(`${activity.kind}:${result.outcome}`);
            },
          }),
        ],
        fields
      );
      await tx.execute(plan);
      const committed = tx.commit();
      if (then === "rollback()") tx.rollback();
      else abort(new Error("aborted"));
      await expect(committed).rejects.toThrow("aborted");
      expect(finalized).toEqual(["statement:unknown", "transaction:unknown"]);
    }
  );

  it("rejects without opening the transaction when a transaction activityStarted hook throws", async () => {
    const { fields } = makeFields();
    const open = vi.fn(async () => makeScope().scope);
    const failure = new Error("start refused");
    await expect(
      observeTransaction(
        open,
        [
          mw({
            activityStarted(activity) {
              if (activity.kind === "transaction") throw failure;
            },
          }),
        ],
        fields
      )
    ).rejects.toBe(failure);
    expect(open).not.toHaveBeenCalled();
  });

  it("keeps the driver's error when a transaction is rolled back with a statement in flight", async () => {
    const { fields } = makeFields();
    const driverError = new Error("transaction aborted");
    let fail!: () => void;
    const { scope } = makeScope(
      () =>
        new Promise((_resolve, reject) => {
          fail = () => reject(driverError);
        })
    );
    const failed: string[] = [];
    const tx = await observeTransaction(
      async () => scope,
      [
        mw({
          activityEnded(activity, result) {
            if (activity.kind === "statement") failed.push(result.outcome);
          },
        }),
      ],
      fields
    );
    const inFlight = tx.execute(plan);
    tx.rollback();
    fail();
    await expect(inFlight).rejects.toBe(driverError);
    expect(failed).toEqual(["failed"]);
  });
});
