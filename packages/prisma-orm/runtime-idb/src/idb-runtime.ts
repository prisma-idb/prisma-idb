import type { CodecCallContext } from "@prisma/orm-framework/components/codec";
import {
  AsyncIterableResult,
  checkMiddlewareCompatibility,
  RuntimeCore,
  type ExecutionPlan,
  type RuntimeExecuteOptions,
  type RuntimeMiddlewareContext,
  type RuntimeStatementStats,
} from "@prisma/orm-framework/components/runtime";
import { canonicalStringify } from "@prisma/orm-framework/utils/canonical-stringify";
import { hashContent } from "@prisma/orm-framework/utils/hash-content";
import type { IdbLowererContext, IdbQueryPlan, IdbRuntimeAdapterInstance } from "@prisma-idb/adapter-idb/runtime";
import type { IdbPlanBody, IdbRuntimeDriverInstance, IdbTransactionScope } from "@prisma-idb/driver-idb/runtime";
import type { IdbMiddleware } from "./idb-middleware";

/**
 * Options for creating an IDB runtime instance.
 */
export interface IdbRuntimeOptions {
  /** Instantiated IDB adapter — provides `lower()`. */
  readonly adapter: IdbRuntimeAdapterInstance;
  /** Instantiated IDB driver — provides `execute()` and `close()`. */
  readonly driver: IdbRuntimeDriverInstance;
  /**
   * The resolved IDB contract.
   *
   * Threaded through to the adapter's `lower()` as part of
   * {@link IdbLowererContext} so per-field codec encoding can
   * resolve field→codec mappings from the storage schema. Also used
   * to build the real {@link RuntimeMiddlewareContext} so middleware
   * can inspect contract data.
   */
  readonly contract: Record<string, unknown>;
  /** Optional middleware chain. */
  readonly middleware?: readonly IdbMiddleware[];
  /**
   * Middleware execution context.
   *
   * When omitted, a real context is derived from `contract`.
   */
  readonly ctx?: RuntimeMiddlewareContext;
}

/**
 * Public IDB runtime interface.
 *
 * `query()` accepts an {@link IdbQueryPlan} and returns an
 * `AsyncIterableResult<Row>` — an async iterable that also fulfils as a
 * `Row[]` when awaited. `execute()` runs the same plan for its side effects
 * and resolves a {@link RuntimeStatementStats} (`{ affectedRows }`) instead
 * of rows — mirrors the upstream `RuntimeCore` query()/execute() split
 * (rc.4).
 */
export interface IdbRuntime {
  query<Row>(plan: IdbQueryPlan & { readonly _row?: Row }, options?: RuntimeExecuteOptions): AsyncIterableResult<Row>;
  execute(plan: IdbQueryPlan, options?: RuntimeExecuteOptions): Promise<RuntimeStatementStats>;
  /**
   * Open a multi-store IDB transaction and return an `IdbTransactionScope`.
   *
   * The scope's `execute(plan)` runs `IdbAtomicPlan`s directly inside the
   * transaction — middleware is bypassed (Issue #6 fix: cache middleware
   * never fires for reads inside a transaction). `commit()` resolves on
   * `tx.oncomplete`; `rollback()` calls `tx.abort()`.
   *
   * Used by `withMutationScope()` in `client-idb`.
   */
  transaction(storeNames: string[], mode?: IDBTransactionMode): Promise<IdbTransactionScope>;
  /**
   * Verify that the live IDB database's contract marker matches the
   * contract this runtime was created with.
   *
   * Reads the `_prisma_next_marker` store and compares the stored
   * `storageHash` against the contract's `storage.storageHash`.
   * Returns `true` when the marker exists and matches, `false` when
   * the marker is absent or mismatched.
   *
   * Call this after construction and before executing queries to
   * detect schema drift. A missing marker means the database was
   * never initialised (run `db migrate` first). A mismatched marker
   * means the database schema has diverged from the contract.
   */
  verifyMarker(): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Build a real {@link RuntimeMiddlewareContext} from the contract
 * so middleware can inspect contract data (plan meta hashes, model
 * names, storage layout) and compute content hashes for cache keys.
 *
 * `contentHash` mirrors the vendor SQL/Mongo runtimes: it
 * canonicalizes the execution plan's structural identity fields
 * and SHA-512 hashes them via WebCrypto. The resulting digest is
 * a bounded, opaque cache key suitable for middleware like
 * a cross-family cache middleware.
 *
 * Non-serializable fields (in-memory filter functions, comparators,
 * `IDBKeyRange` objects) are reduced to their deterministic shape
 * so that two semantically identical plans produce the same hash.
 */
function buildMiddlewareContext(contract: Record<string, unknown>): RuntimeMiddlewareContext {
  return {
    contract,
    mode: "permissive",
    // v0.12.0: per-execute correlation id required on the middleware context.
    // The default ctx is built once per runtime; consumers needing per-execute
    // ids should supply their own `ctx`.
    planExecutionId: crypto.randomUUID(),
    now: () => Date.now(),
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    // Always "runtime": IdbTransactionScope.execute() bypasses the middleware
    // chain entirely, so middleware is only ever invoked from the top-level
    // query()/execute() paths, which is exactly the "runtime" scope. There is
    // no IDB connection pool, so "connection" is not applicable either.
    scope: "runtime",
    contentHash: async (exec: ExecutionPlan) => {
      // Reduce the plan to its structural identity for hashing.
      // Exclude functions (IdbRowFilter, IdbRowComparator) and
      // collapse IDBKeyRange to its bounds so deterministic
      // comparisons work.
      const plan = exec as unknown as Record<string, unknown>;
      const hashable: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(plan)) {
        if (key === "meta") {
          // meta.storageHash is the primary identity field
          const meta = value as Record<string, unknown> | undefined;
          hashable["meta"] = { storageHash: meta?.["storageHash"] };
        } else if (typeof value === "function") {
          // Skip in-memory filters/comparators — not hashable
          continue;
        } else if ((typeof IDBKeyRange !== "undefined" && value instanceof IDBKeyRange) || isIdbKeyRange(value)) {
          // Collapse IDBKeyRange to its bounds
          hashable[key] = keyRangeIdentity(value as IDBKeyRange);
        } else {
          hashable[key] = value;
        }
      }
      return hashContent(canonicalStringify(hashable));
    },
  };
}

/** Check for IDBKeyRange-like objects (e.g. from fake-indexeddb). */
function isIdbKeyRange(value: unknown): value is IDBKeyRange {
  return (
    typeof value === "object" &&
    value !== null &&
    "lower" in value &&
    "upper" in value &&
    "lowerOpen" in value &&
    "upperOpen" in value
  );
}

/** Extract a deterministic identity from an IDBKeyRange. */
function keyRangeIdentity(range: IDBKeyRange): Record<string, unknown> {
  return {
    lower: range.lower,
    upper: range.upper,
    lowerOpen: range.lowerOpen,
    upperOpen: range.upperOpen,
  };
}

/**
 * IDB runtime — the `RuntimeCore` subclass for IndexedDB.
 *
 * Wires together:
 * - `lower(plan, ctx)` — delegates to `adapter.lower()` with the contract
 *   threaded via {@link IdbLowererContext}, producing an `IdbPlanBody`
 * - `runDriver(exec)` — delegates to `driver.execute()` to run the plan against IDB
 * - `query()` — the concrete row-returning template method from `RuntimeCore`,
 *   backed by `runDriver()`
 * - `runExecute(exec)` — drains `runDriver()` and counts rows into a
 *   `RuntimeStatementStats`; backs `execute()`, the concrete
 *   statement-terminal template method from `RuntimeCore`
 * - `close()` — closes the IDB connection via `driver.close()`
 */
class IdbRuntimeImpl extends RuntimeCore<IdbQueryPlan, IdbPlanBody, IdbMiddleware> implements IdbRuntime {
  readonly #adapter: IdbRuntimeAdapterInstance;
  readonly #driver: IdbRuntimeDriverInstance;
  readonly #contract: Record<string, unknown>;

  constructor(options: IdbRuntimeOptions) {
    const ctx = options.ctx ?? buildMiddlewareContext(options.contract);
    const middleware = [...(options.middleware ?? [])];
    for (const mw of middleware) {
      checkMiddlewareCompatibility(mw, "idb", "idb");
    }
    super({ middleware, ctx });
    this.#adapter = options.adapter;
    this.#driver = options.driver;
    this.#contract = options.contract;
  }

  /**
   * Lower an IDB query plan to an IDB plan body via the adapter.
   *
   * Threads the contract through {@link IdbLowererContext} so per-field
   * codec encoding can resolve field→codec mappings from the contract's
   * storage schema.
   */
  protected override lower(plan: IdbQueryPlan, ctx: CodecCallContext): Promise<IdbPlanBody> {
    const lowererCtx: IdbLowererContext = {
      ...ctx,
      contract: this.#contract,
    };
    return this.#adapter.lower(plan, lowererCtx);
  }

  /**
   * Execute a lowered IDB plan body via the driver.
   *
   * Backs `query()` (inherited concretely from `RuntimeCore`) — rows are
   * yielded as-is from the driver (identity pass-through). All current
   * `idb/*` codecs are identity transforms — no per-field decoding is
   * needed. When per-field codec decoding is added (e.g. decoding
   * `idb/date@1` stored values back to `Date` instances, or custom codec
   * output types), it wires up here.
   */
  protected override runDriver(exec: IdbPlanBody): AsyncIterable<Record<string, unknown>> {
    return this.#driver.execute(exec);
  }

  /**
   * Backs `execute()` (inherited concretely from `RuntimeCore`) — IDB has no
   * native "affected-row count without returning rows" concept, so this
   * drains `runDriver()`'s row stream and counts. The driver already
   * materializes every op's touched rows in memory before yielding (see
   * `IdbRuntimeDriverInstance.execute()`'s collect-then-yield strategy), so
   * draining here has no extra cost beyond what a `query()` call over the
   * same plan would already pay.
   *
   * This counts *rows the driver yields*, which correctly equals "ops
   * applied" for every atomic plan kind: `add`/`put`/`update` each echo the
   * one row they touched, `scan-write` echoes every matched row, and
   * `delete` (`execute/ops.ts`'s `execDelete`) walks a cursor over its
   * key/range and echoes each row it deletes — so a delete matching zero
   * keys correctly resolves `{ affectedRows: 0 }` and one matching N keys
   * (a range delete) resolves `{ affectedRows: N }`. For a `batch` plan,
   * `affectedRows` is the sum of rows every op in the batch yields,
   * *including read ops* (`key-get`/`index-get`/`cursor-scan`) if the batch
   * happens to contain any — it's a row count across the whole plan, not a
   * write-only count.
   */
  protected override async runExecute(exec: IdbPlanBody): Promise<RuntimeStatementStats> {
    let affectedRows = 0;
    for await (const _row of this.runDriver(exec)) {
      affectedRows++;
    }
    return { affectedRows };
  }

  async transaction(storeNames: string[], mode: IDBTransactionMode = "readwrite"): Promise<IdbTransactionScope> {
    return this.#driver.transaction(storeNames, mode);
  }

  override async close(): Promise<void> {
    await this.#driver.close();
  }

  /**
   * Verify that the live IDB marker matches the contract.
   *
   * Compares the stored `storageHash` against `contract.storage.storageHash`.
   * A fresh database (no marker store) returns `false` — the caller should
   * ensure migrations have been applied before running queries.
   */
  async verifyMarker(): Promise<boolean> {
    const marker = await this.#driver.readMarker();
    if (marker === null) return false;
    const contractStorage = this.#contract["storage"] as Record<string, unknown> | undefined;
    const contractHash = contractStorage?.["storageHash"];
    return typeof contractHash === "string" && marker.storageHash === contractHash;
  }
}

/**
 * Create an IDB runtime instance.
 *
 * @example
 * ```ts
 * const driver = createIDBRuntimeDriver("my-app").create();
 * const runtime = createIdbRuntime({ adapter, driver, contract });
 * await runtime.query(plan)
 * await runtime.close();
 * ```
 */
export function createIdbRuntime(options: IdbRuntimeOptions): IdbRuntime {
  return new IdbRuntimeImpl(options);
}
