/**
 * `observeTransaction` against a controllable transaction scope: what happens to a middleware
 * hook's error, when each hook runs relative to the IndexedDB transaction, and how a transaction
 * that fails to start or is rolled back with a statement in flight is reported.
 */
import type { ActivityContextFields } from "@prisma/orm-framework/components/runtime";
import type { IdbAtomicPlan, IdbTransactionScope } from "@prisma-idb/driver-idb/runtime";
import { describe, expect, it, vi } from "vitest";
import type { IdbMiddleware } from "../src/idb-middleware";
import { observeTransaction } from "../src/transaction-observer";

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
    expect(log.error).toHaveBeenCalledWith(failure);
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
    expect(log.error).toHaveBeenCalledWith(failure);
  });

  it("logs the error of a statement hook that throws or rejects and still runs the statement", async () => {
    const { fields, log } = makeFields();
    const { scope } = makeScope();
    const errors = {
      started: new Error("started"),
      before: new Error("before"),
      row: new Error("row"),
      ended: new Error("ended"),
    };
    const tx = await observeTransaction(
      async () => scope,
      [
        mw({
          activityStarted(activity) {
            if (activity.kind === "statement") throw errors.started;
          },
          beforeEncode() {
            return Promise.reject(errors.before);
          },
          onRow() {
            throw errors.row;
          },
          activityEnded(activity) {
            return activity.kind === "statement" ? Promise.reject(errors.ended) : undefined;
          },
        }),
      ],
      fields
    );
    await expect(tx.execute(plan)).resolves.toEqual([{ id: "1" }]);
    await vi.waitFor(() => {
      for (const error of Object.values(errors)) expect(log.error).toHaveBeenCalledWith(error);
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
