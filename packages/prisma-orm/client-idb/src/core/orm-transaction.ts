/**
 * Typed ORM transactions: `db.transaction(["users", "posts"], async (tx) => ...)`.
 *
 * The callback gets ORM accessors for the listed models only. All of them run
 * in one IDB readwrite transaction that commits when the callback resolves and
 * rolls back when it throws. See ADR 007.
 */
import type { IdbContract } from "./types";
import { idbOrm } from "./idb-orm";
import type { IdbOrmClient } from "./idb-orm";
import { collectDeleteStoreNames, collectRelatedStoreNames, makePlanMeta } from "./mutation-executor";
import { OpenTransaction } from "./open-transaction";
import type { IdbQueryExecutorWithTransaction } from "./mutation-scope";

/** The ORM accessors available inside `db.transaction()`: only the listed root keys. */
export type IdbOrmTransaction<TContract extends IdbContract, TRootKey extends string & keyof TContract["roots"]> = Pick<
  IdbOrmClient<TContract>,
  TRootKey
>;

/**
 * Thrown when IndexedDB finished the transaction before the callback did, so
 * writes made before that point were committed and could not be rolled back.
 *
 * IndexedDB commits a transaction as soon as it has no pending request. That
 * happens when the callback awaits something other than a `tx` operation, such
 * as a timer or a network call (ADR 005). `cause` holds the original error.
 */
export class IdbTransactionCommittedEarlyError extends Error {
  constructor(cause: unknown) {
    super(
      "The transaction was committed before the db.transaction() callback finished, " +
        "so writes made earlier in the callback were saved and not rolled back. " +
        "Await only `tx` operations inside the callback; do not await timers or network calls.",
      { cause }
    );
    this.name = "IdbTransactionCommittedEarlyError";
  }
}

/**
 * Run `fn` inside one readwrite transaction over the models behind `rootKeys`.
 *
 * Besides the listed models, the transaction opens the stores their operations
 * need: parents for foreign-key checks, children for referential actions, and
 * related models for `include`. An operation that needs any other store fails
 * with an error that names it.
 */
export async function runOrmTransaction<
  TContract extends IdbContract,
  TRootKey extends string & keyof TContract["roots"],
  T,
>(
  options: { readonly contract: TContract; readonly executor: IdbQueryExecutorWithTransaction },
  rootKeys: readonly TRootKey[],
  fn: (tx: IdbOrmTransaction<TContract, TRootKey>) => Promise<T>
): Promise<T> {
  const { contract, executor } = options;
  if (rootKeys.length === 0) {
    throw new Error("db.transaction() needs at least one model to open the transaction on.");
  }
  const modelNames = rootKeys.map((key) => {
    const root = contract.roots[key];
    if (root === undefined) throw new Error(`db.transaction(): "${key}" is not a root of the contract.`);
    return root.model;
  });

  const storeNames = [...new Set(modelNames.flatMap((model) => storeNamesNeededBy(contract, model)))];
  const scope = await executor.transaction(storeNames, "readwrite");
  const open = new OpenTransaction(scope, storeNames, makePlanMeta(contract));

  let result: T;
  try {
    result = await fn(pickRoots(idbOrm({ contract, executor: open }), rootKeys));
  } catch (error) {
    open.end();
    const committedEarly = await open.hasAutoCommitted();
    scope.rollback();
    throw committedEarly ? new IdbTransactionCommittedEarlyError(error) : error;
  }
  open.end();
  await scope.commit();
  if (open.autoCommitCause !== undefined) throw new IdbTransactionCommittedEarlyError(open.autoCommitCause);
  return result;
}

function storeNamesNeededBy(contract: IdbContract, modelName: string): string[] {
  return [...collectRelatedStoreNames(contract, modelName), ...collectDeleteStoreNames(contract, modelName)];
}

function pickRoots<TContract extends IdbContract, TRootKey extends string & keyof TContract["roots"]>(
  orm: IdbOrmClient<TContract>,
  rootKeys: readonly TRootKey[]
): IdbOrmTransaction<TContract, TRootKey> {
  const picked = {} as IdbOrmTransaction<TContract, TRootKey>;
  for (const key of rootKeys) picked[key] = orm[key];
  return picked;
}
