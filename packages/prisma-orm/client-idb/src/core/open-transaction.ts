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
 * The executor also records how the transaction ended, so the runner can tell
 * a rolled-back transaction from one that IndexedDB auto-committed early
 * (ADR 005).
 */
import { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import type { PlanMeta } from "@prisma/orm-framework/contract/types";
import type { IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import { IdbExecuteError } from "@prisma-idb/driver-idb/runtime";
import type { IdbAtomicPlan, IdbTransactionScope } from "@prisma-idb/driver-idb/runtime";
import type { IdbQueryExecutorWithTransaction } from "./mutation-scope";
import { executeMutationPlan } from "./mutation-executor";

type Row = Record<string, unknown>;

/** `open` until an operation fails (`aborted`) or finds the transaction already finished (`auto-committed`). */
type State = "open" | "aborted" | "auto-committed";

function isTransactionInactive(error: unknown): boolean {
  return error instanceof IdbExecuteError && error.code === "TRANSACTION_INACTIVE";
}

export class OpenTransaction implements IdbQueryExecutorWithTransaction, IdbTransactionScope {
  readonly #scope: IdbTransactionScope;
  readonly #storeNames: ReadonlySet<string>;
  readonly #meta: PlanMeta;
  #state: State = "open";
  #autoCommitCause: unknown;
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

  /** The error of the first operation that found the transaction already finished, if any. */
  get autoCommitCause(): unknown {
    return this.#autoCommitCause;
  }

  /**
   * Whether IndexedDB has already finished this transaction on its own, so a
   * rollback can no longer undo its writes. Probes the transaction when no
   * operation has failed yet, and records the probe error as the cause, so call
   * it before rolling back or committing.
   */
  async hasAutoCommitted(): Promise<boolean> {
    if (this.#state !== "open") return this.#state === "auto-committed";
    const [storeName] = this.#storeNames;
    try {
      await this.#scope.execute({ meta: this.#meta, kind: "key-get", storeName: storeName!, key: "" });
      return false;
    } catch (error) {
      if (!isTransactionInactive(error)) return false;
      this.#state = "auto-committed";
      this.#autoCommitCause = error;
      return true;
    }
  }

  query<R>(plan: IdbQueryPlan<R>): AsyncIterableResult<R> {
    const run = executeMutationPlan.bind(null, this);
    return new AsyncIterableResult(
      (async function* (): AsyncGenerator<R, void, unknown> {
        for (const row of await run(plan.idbPlan)) yield row as R;
      })()
    );
  }

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
    if (this.#state !== "open") return;
    if (isTransactionInactive(error)) {
      this.#state = "auto-committed";
      this.#autoCommitCause = error;
      return;
    }
    this.#state = "aborted";
    this.#scope.rollback();
  }
}
