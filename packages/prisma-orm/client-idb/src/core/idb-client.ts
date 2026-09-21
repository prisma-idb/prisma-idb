import { IdbAdapter } from "@prisma-idb/adapter-idb/runtime";
import { createIDBRuntimeDriver } from "@prisma-idb/driver-idb/runtime";
import type { IdbTransactionScope } from "@prisma-idb/driver-idb/runtime";
import type { IdbMiddleware } from "@prisma-idb/runtime-idb/runtime";
import { createIdbRuntime } from "@prisma-idb/runtime-idb/runtime";
import { idbCodecLookup } from "@prisma-idb/target-idb/runtime";
import { withMutationScope } from "./mutation-scope";
import { idbOrm } from "./idb-orm";
import type { IdbOrmClient } from "./idb-orm";
import type { IdbContract } from "./types";

export interface IdbClientOptions<TContract extends IdbContract> {
  readonly contract: TContract;
  readonly dbName: string;
  // No version — the migration runner owns the IDB version integer (ADR 001).
  /** IDB factory override — primarily for tests and custom browser realms. */
  readonly factory?: IDBFactory;
  readonly middleware?: readonly IdbMiddleware[];
}

export interface IdbClient<TContract extends IdbContract> {
  readonly orm: IdbOrmClient<TContract>;
  /**
   * Run `fn` inside a single multi-store readwrite IDB transaction.
   *
   * Opens the transaction, passes an `IdbTransactionScope` to `fn`, then
   * commits on success or rolls back on error. Equivalent to calling
   * `withMutationScope(runtime, storeNames, fn)`.
   *
   * Useful from test harnesses and from any caller that has an `IdbClient`
   * but not the raw runtime reference.
   */
  withTransaction<T>(storeNames: string[], fn: (scope: IdbTransactionScope) => Promise<T>): Promise<T>;
  verifyMarker(): Promise<boolean>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Creates a typed IDB client from a contract and a database name.
 *
 * Assembles the full runtime stack (driver → adapter → runtime → ORM) internally.
 * Equivalent to `postgres({ contract, url })` in `@prisma/orm-postgres/runtime`.
 *
 * The IDB database version is not exposed — it is managed by the migration runner
 * per ADR 001. The driver opens at the current database version, which is correct
 * for a runtime that only reads/writes (no DDL).
 *
 * @example
 * ```ts
 * import { createIdbClient } from '@prisma-idb/client-idb/client';
 * import contract from './contract';
 *
 * export const db = createIdbClient({ contract, dbName: 'my-app' });
 *
 * // Later:
 * const users = await db.orm.users.all().toArray();
 * ```
 */
export function createIdbClient<TContract extends IdbContract>(
  options: IdbClientOptions<TContract>
): IdbClient<TContract> {
  const driver = createIDBRuntimeDriver(
    options.dbName,
    undefined,
    options.factory !== undefined ? { factory: options.factory } : undefined
  ).create();
  const adapter = new IdbAdapter(idbCodecLookup);
  const runtime = createIdbRuntime({
    adapter,
    driver,
    contract: options.contract as Record<string, unknown>,
    ...(options.middleware !== undefined && options.middleware.length > 0 ? { middleware: options.middleware } : {}),
  });
  const orm = idbOrm({ contract: options.contract, executor: runtime });

  return {
    orm,
    withTransaction: <T>(storeNames: string[], fn: (scope: IdbTransactionScope) => Promise<T>) =>
      withMutationScope(runtime, storeNames, fn),
    verifyMarker: () => runtime.verifyMarker(),
    async close() {
      await runtime.close();
    },
    [Symbol.asyncDispose]() {
      return this.close();
    },
  };
}
