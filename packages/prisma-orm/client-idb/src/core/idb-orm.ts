import type { Contract } from "@prisma/orm-framework/contract/types";
import type { IdbContract, IdbStorage } from "./types";
import type { IdbQueryExecutor } from "./executor";
import { type IdbStoreAccessor, IdbStoreAccessorImpl } from "./store-accessor";

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * The ORM client object returned by {@link idbOrm}.
 *
 * Keys are the root keys from `contract.roots` (e.g. `"users"`, `"posts"`).
 * Each value is an {@link IdbStoreAccessor} targeting the corresponding model.
 *
 * @example
 * ```ts
 * const db = idbOrm({ contract, executor: runtime });
 * const users = await db.users.all(); // IdbStoreAccessor<..., "User">
 * ```
 */
export type IdbOrmClient<TContract extends Contract<IdbStorage>> = {
  // v0.12.0: `roots` values are CrossReference `{ namespace, model }`, so the
  // target model name is `roots[K].model` (was a bare model-name string).
  readonly [K in string & keyof TContract["roots"]]: TContract["roots"][K] extends {
    model: infer ModelName extends string;
  }
    ? IdbStoreAccessor<TContract, ModelName>
    : never;
};

/**
 * Options for {@link idbOrm}.
 */
export interface IdbOrmOptions<TContract extends IdbContract> {
  /** The resolved IDB contract (with or without attached type maps). */
  readonly contract: TContract;
  /**
   * The query executor.
   *
   * Any object with a compatible `query()` signature satisfies this —
   * most commonly an `IdbRuntime` created via `createIdbRuntime()`.
   */
  readonly executor: IdbQueryExecutor;
}

// ── Factory function ──────────────────────────────────────────────────────────

/**
 * Create a typed IDB ORM client from a contract and executor.
 *
 * The client exposes one `IdbStoreAccessor` per entry in `contract.roots`.
 * Only roots-declared stores are accessible at the top level — other stores
 * can be reached via `.include()` on any accessor.
 *
 * @example
 * ```ts
 * import { idbOrm } from "@prisma-idb/client-idb/orm";
 * import { createIdbRuntime } from "@prisma-idb/runtime-idb/runtime";
 * import contract from "./prisma/idb-contract";
 *
 * const runtime = createIdbRuntime({ adapter, driver });
 * const db = idbOrm({ contract, executor: runtime });
 *
 * // Typed query builder:
 * const alice = await db.users.where({ email: "alice@example.com" }).first();
 * const postsWithAuthor = await db.posts.include("author").all();
 * ```
 */
export function idbOrm<TContract extends IdbContract>(options: IdbOrmOptions<TContract>): IdbOrmClient<TContract> {
  const { contract, executor } = options;

  // One counter per idbOrm() call — two clients in the same realm get
  // independent key sequences and can't interleave (ADR 160).
  let _key = 0;
  const newGroupingKey = () => `idb-op-${++_key}`;

  const client: Record<string, IdbStoreAccessor<TContract, string>> = {};
  for (const [rootKey, ref] of Object.entries(contract.roots)) {
    // v0.12.0: `roots` values are CrossReference `{ namespace, model }`.
    client[rootKey] = new IdbStoreAccessorImpl(contract, ref.model, executor, undefined, newGroupingKey);
  }

  return client as unknown as IdbOrmClient<TContract>;
}
