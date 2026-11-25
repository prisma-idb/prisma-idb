/**
 * An executor bound to one already-open IDB transaction.
 *
 * `db.transaction()` hands its callback ORM accessors built on this executor.
 * Every query the accessors issue runs on the open transaction instead of
 * opening a new one. Operations that normally open their own mutation scope
 * (FK-checked writes, cascade deletes) get a view of the same transaction:
 * `commit()` on the view does nothing, so an inner operation cannot commit the
 * outer transaction, and `rollback()` aborts it.
 *
 * The executor records operation failures and requests a rollback. The runner
 * waits for IndexedDB to report the transaction's outcome.
 */
import { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import type { PlanMeta } from "@prisma/orm-framework/contract/types";
import type { IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import { IdbExecuteError } from "@prisma-idb/driver-idb/runtime";
import type { IdbAtomicPlan, IdbTransactionScope } from "@prisma-idb/driver-idb/runtime";
import { withoutMiddleware } from "@prisma-idb/runtime-idb/runtime";
import type { IdbQueryExecutorWithTransaction } from "./mutation-scope";
import { executeMutationPlan } from "./mutation-executor";

/** A record returned by an IDB operation. */
type Row = Record<string, unknown>;

/** Bind ORM operations to one scope and request a rollback on failure. */
export class OpenTransaction implements IdbQueryExecutorWithTransaction, IdbTransactionScope {
  readonly #scope: IdbTransactionScope;
  readonly #storeNames: ReadonlySet<string>;
  readonly #meta: PlanMeta;
  #failure: { cause: unknown } | undefined;
  #ended = false;

  constructor(scope: IdbTransactionScope, storeNames: readonly string[], meta: PlanMeta) {
    this.#scope = scope;
    this.#storeNames = new Set(storeNames);
    this.#meta = meta;
  }

  /** Stop accepting operations. Called once the callback has settled. */
  end(): void {
    this.#ended = true;
  }

  /** The operation failure or inactive probe that led to a rollback request. */
  get failure(): Readonly<{ cause: unknown }> | undefined {
    return this.#failure;
  }

  /** Check whether the scope still accepts requests after the callback returns. */
  async probeForEarlyCommit(): Promise<void> {
    if (this.#failure) return;
    const [storeName] = this.#storeNames;
    try {
      // Middleware does not see this probe: the caller never sent it.
      await this.#scope.execute(
        withoutMiddleware({ meta: this.#meta, kind: "key-get", storeName: storeName!, key: "" })
      );
    } catch (error) {
      // An inactive scope may still have pending work. The runner confirms
      // whether IndexedDB committed by waiting for the scope to settle.
      if (error instanceof IdbExecuteError && error.code === "TRANSACTION_INACTIVE") this.#recordFailure(error);
    }
  }

  /** Expose rows from the existing scope through the ORM query-result interface. */
  query<R>(plan: IdbQueryPlan<R>): AsyncIterableResult<R> {
    const run = executeMutationPlan.bind(null, this);
    return new AsyncIterableResult(
      (async function* (): AsyncGenerator<R, void, unknown> {
        for (const row of await run(plan.idbPlan)) yield row as R;
      })()
    );
  }

  /** Reuse the outer scope after verifying that the requested stores were declared. */
  async transaction(storeNames: string[]): Promise<IdbTransactionScope> {
    this.#assertNotEnded();
    try {
      this.#assertStoresListed(storeNames);
    } catch (error) {
      this.#recordFailure(error);
      throw error;
    }
    return this;
  }

  /** Run one operation in the scope and abort the transaction when it fails. */
  async execute(plan: IdbAtomicPlan): Promise<Row[]> {
    this.#assertNotEnded();
    try {
      this.#assertStoresListed([plan.storeName]);
      return await this.#scope.execute(plan);
    } catch (error) {
      this.#recordFailure(error);
      throw error;
    }
  }

  async commit(): Promise<void> {
    // Only the runner commits, once the callback resolves.
  }

  rollback(): void {
    this.#recordFailure(undefined);
  }

  /**
   * Wrap an ORM accessor so that any call that fails aborts the transaction.
   *
   * Some failures, such as enum validation, happen before an operation reaches
   * this executor. Without this wrapper the callback could catch them and
   * commit the writes made before. The wrapper covers errors thrown
   * synchronously, rejected promises, and rejections of a result that is
   * awaited directly (`AsyncIterableResult`). Objects the accessor returns,
   * such as `where()` builders, are wrapped too.
   */
  abortOnFailure<T extends object>(target: T): T {
    return new Proxy(target, {
      get: (object, property) => {
        const value: unknown = Reflect.get(object, property, object);
        if (typeof value !== "function") return value;
        if (property === "then") return this.#observeThen(object, value as (...args: unknown[]) => unknown);
        return (...args: unknown[]): unknown => {
          const result: unknown = this.#recordThrown(() => value.apply(object, args));
          if (result instanceof Promise) {
            result.catch((error: unknown) => this.#recordFailure(error));
            return result;
          }
          return typeof result === "object" && result !== null ? this.abortOnFailure(result) : result;
        };
      },
    });
  }

  /**
   * `await result` passes its own rejection handler to `then()`, which turns the
   * rejection into a fulfilled promise. Record the failure before that handler runs.
   */
  #observeThen(object: object, then: (...args: unknown[]) => unknown): unknown {
    return (onFulfilled: unknown, onRejected: unknown): unknown =>
      then.call(object, onFulfilled, (error: unknown) => {
        this.#recordFailure(error);
        if (typeof onRejected !== "function") throw error;
        return onRejected(error);
      });
  }

  /** Record synchronous accessor failures before propagating them to the callback. */
  #recordThrown<R>(call: () => R): R {
    try {
      return call();
    } catch (error) {
      this.#recordFailure(error);
      throw error;
    }
  }

  #assertNotEnded(): void {
    if (this.#ended) {
      throw new Error("This transaction has ended. Do not use `tx` after the db.transaction() callback finishes.");
    }
  }

  /** Reject undeclared stores before an operation can escape the transaction scope. */
  #assertStoresListed(storeNames: readonly string[]): void {
    const missing = storeNames.filter((name) => !this.#storeNames.has(name));
    if (missing.length > 0) {
      throw new Error(
        `Stores ${missing.map((name) => `"${name}"`).join(", ")} are not part of this transaction. ` +
          "List the models that own them in the first argument of db.transaction()."
      );
    }
  }

  /** Any failed operation aborts the whole transaction, even if the callback catches the error. */
  #recordFailure(error: unknown): void {
    if (this.#failure) {
      // A mutation scope can request rollback before the accessor reports why it failed.
      if (this.#failure.cause === undefined) this.#failure.cause = error;
      return;
    }
    this.#failure = { cause: error };
    this.#scope.rollback();
  }
}
