import type { CodecCallContext } from "@prisma/orm-framework/components/codec";
import {
  AsyncIterableResult,
  checkMiddlewareCompatibility,
  RuntimeCore,
  type ActivityContextFields,
  type ExecutionPlan,
  type RuntimeExecuteOptions,
  type RuntimeStatementStats,
} from "@prisma/orm-framework/components/runtime";
import { canonicalStringify } from "@prisma/orm-framework/utils/canonical-stringify";
import { hashContent } from "@prisma/orm-framework/utils/hash-content";
import type {
  IdbLoweredPlan,
  IdbLowererContext,
  IdbQueryPlan,
  IdbRuntimeAdapterInstance,
} from "@prisma-idb/adapter-idb/runtime";
import type { IdbPlanBody, IdbRuntimeDriverInstance, IdbTransactionScope } from "@prisma-idb/driver-idb/runtime";
import type { IdbMiddleware } from "./idb-middleware";
import { observeTransaction } from "./transaction-observer";

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
   * to build the real {@link ActivityContextFields} so middleware
   * can inspect contract data.
   */
  readonly contract: Record<string, unknown>;
  /** Optional middleware chain. */
  readonly middleware?: readonly IdbMiddleware[];
  /**
   * Middleware execution context.
   *
   * When omitted, a real context is derived from `contract`. Its `log` writes `warn` and `error`
   * to the console and drops `info`. Supply `ctx.log` to route middleware errors and runtime
   * warnings elsewhere.
   */
  readonly ctx?: ActivityContextFields;
  /**
   * When to compare the database's contract marker with `contract`, as Prisma 8's
   * SQL runtime does. `"onFirstUse"`, the default, reads the marker before
   * the first query or transaction, and again after a newer version reopened the connection, and warns with `CONTRACT.MARKER_MISSING` or
   * `CONTRACT.MARKER_MISMATCH`, or `CONTRACT.MARKER_UNREADABLE` when the read fails. The check never
   * blocks the query. `false` skips it. The marker compared is the one for the contract's own
   * space (`"app"`); the marker rows of extension spaces are not read.
   */
  readonly verifyMarker?: "onFirstUse" | false;
}

/**
 * Public IDB runtime interface.
 *
 * `query()` accepts an {@link IdbQueryPlan} and returns an
 * `AsyncIterableResult<Row>` — an async iterable that also fulfils as a
 * `Row[]` when awaited. `execute()` runs the same plan for its side effects
 * and resolves a {@link RuntimeStatementStats} (`{ affectedRows }`) instead
 * of rows, matching the upstream `RuntimeCore` query()/execute() split.
 */
export interface IdbRuntime {
  query<Row>(plan: IdbQueryPlan & { readonly _row?: Row }, options?: RuntimeExecuteOptions): AsyncIterableResult<Row>;
  execute(plan: IdbQueryPlan, options?: RuntimeExecuteOptions): Promise<RuntimeStatementStats>;
  /**
   * Open a multi-store IDB transaction and return an `IdbTransactionScope`.
   *
   * The scope's `execute(plan)` runs `IdbAtomicPlan`s directly inside the
   * transaction. Middleware observes each statement without being awaited and
   * cannot intercept it, so transaction reads reach the driver without a cached
   * result. `commit()` resolves on `tx.oncomplete`, after the transaction's
   * `activityFinalized` hooks; `rollback()` calls `tx.abort()`.
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
 * Build the {@link ActivityContextFields} every activity's context starts from, using the contract
 * so middleware can inspect contract data (plan meta hashes, model
 * names, storage layout) and compute content hashes for cache keys.
 *
 * `contentHash` mirrors the vendor SQL/Mongo runtimes: it
 * canonicalizes the execution plan's structural identity fields
 * and SHA-512 hashes them via WebCrypto. The resulting digest is
 * a bounded, opaque identity for the execution fields and the structured
 * closure identities carried through lowering. Key ranges use their bounds.
 * Opaque closures get a fresh nonce on every hash call: their captured state
 * may change even when the function reference stays the same.
 */
function buildMiddlewareContext(contract: Record<string, unknown>): ActivityContextFields {
  return {
    contract,
    mode: "permissive",
    now: () => Date.now(),
    // Warnings and errors reach the console when the caller supplies no logger, so a middleware
    // error inside a transaction, which cannot fail the statement, is not lost. Upstream's runtimes
    // default to no-op loggers, which would hide those errors in a browser app.
    log: {
      info: () => undefined,
      warn: (...args: unknown[]) => console.warn(...args),
      error: (...args: unknown[]) => console.error(...args),
    },
    // Top-level query()/execute() run in "runtime" scope. Statements inside a
    // transaction get "transaction" from the transaction observer. There is no
    // IDB connection pool, so "connection" is not applicable.
    scope: "runtime",
    contentHash: async (exec: ExecutionPlan) => hashContent(canonicalStringify(hashablePlan(exec))),
  };
}

/**
 * Reduce a plan to the fields that decide cache-key equality, so two
 * structured plans with the same identity hash the same.
 *
 * - `meta` keeps only `storageHash`, its identity field.
 * - Structured filters and comparators use their canonical query identities.
 * - Each opaque function gets a fresh nonce, preventing unsafe cache reuse.
 * - A key range collapses to its bounds. Only `delete`'s `key` can hold one; range descriptors are plain data and hash as they are.
 */
function hashablePlan(
  exec: ExecutionPlan,
  inheritedIdentity?: IdbLoweredPlan["queryIdentity"]
): Record<string, unknown> {
  const hashable: Record<string, unknown> = {};
  // Hash queryIdentity alongside per-function identity: key-get and get-all
  // plans can apply structured filters and ordering after driver execution.
  const identity = (exec as IdbLoweredPlan).queryIdentity ?? inheritedIdentity;
  for (const [key, value] of Object.entries(exec as unknown as Record<string, unknown>)) {
    if (key === "meta") {
      const meta = value as Record<string, unknown> | undefined;
      hashable["meta"] = { storageHash: meta?.["storageHash"] };
    } else if (typeof value === "function") {
      const semanticIdentity = key === "filter" || key === "comparator" ? identity?.[key] : undefined;
      // Function reference or source equality cannot account for mutable captures.
      hashable[key] = semanticIdentity === undefined ? { opaqueClosure: crypto.randomUUID() } : { semanticIdentity };
    } else if (key === "ops" && (exec as IdbPlanBody).kind === "batch") {
      // A range-split read applies the same structured predicate in each scan.
      hashable[key] = (value as readonly ExecutionPlan[]).map((op) => hashablePlan(op, identity));
    } else if (isIdbKeyRange(value)) {
      hashable[key] = keyRangeIdentity(value);
    } else {
      hashable[key] = value;
    }
  }
  return hashable;
}

/** Duck-typed so it also matches ranges from fake-indexeddb, where `instanceof IDBKeyRange` fails. */
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

function warnAboutMarker(...args: [message: string] | [message: string, cause: unknown]): void {
  try {
    console.warn(...args);
  } catch {
    // A warning handler must not block database use.
  }
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
  readonly #middleware: readonly IdbMiddleware[];
  readonly #ctxFields: ActivityContextFields;

  constructor(options: IdbRuntimeOptions) {
    const ctx = options.ctx ?? buildMiddlewareContext(options.contract);
    const middleware = [...(options.middleware ?? [])];
    for (const mw of middleware) {
      checkMiddlewareCompatibility(mw, "idb", "idb");
    }
    super({ middleware, ctx });
    this.#middleware = middleware;
    this.#ctxFields = ctx;
    this.#adapter = options.adapter;
    this.#driver = options.driver;
    this.#contract = options.contract;
    this.#verifyMarkerOption = options.verifyMarker ?? "onFirstUse";
  }

  readonly #verifyMarkerOption: "onFirstUse" | false;
  // Shared by concurrent first uses, so they read the marker and warn once. `#checkMarker` reports every
  // failure as a warning and never throws, so a failed read is not retried on the same connection.
  #markerCheck: Promise<void> | null = null;
  // The driver connection the marker was checked on. A newer version that closes the connection
  // may have migrated the database to another contract, so the next use checks again.
  #markerCheckedGeneration = 0;

  /** Reads the marker on first use of each connection and warns when it is missing or names another contract. */
  async #ensureMarkerChecked(): Promise<void> {
    if (this.#verifyMarkerOption === false) return;
    let generation: number;
    do {
      generation = this.#driver.connectionGeneration ?? 0;
      if (this.#markerCheck === null || this.#markerCheckedGeneration !== generation) {
        this.#markerCheckedGeneration = generation;
        this.#markerCheck = this.#checkMarker(generation);
      }
      await this.#markerCheck;
    } while (generation !== (this.#driver.connectionGeneration ?? 0));
  }

  async #checkMarker(generation: number): Promise<void> {
    try {
      const marker = await this.#driver.readMarker();
      if (generation !== (this.#driver.connectionGeneration ?? 0)) return;
      const expected = (this.#contract["storage"] as { storageHash?: unknown } | undefined)?.storageHash;
      const expectedHash = typeof expected === "string" ? expected : "unknown";
      if (marker === null) {
        warnAboutMarker(
          `[prisma-idb] CONTRACT.MARKER_MISSING: the database has no contract marker, so nothing says it matches the contract (storageHash ${expectedHash}). Open it with an auto-migrating client, or apply its migrations first.`
        );
      } else if (typeof marker.storageHash !== "string") {
        warnAboutMarker("[prisma-idb] CONTRACT.MARKER_UNREADABLE: the contract marker has no valid storageHash");
      } else if (marker.storageHash !== expected) {
        warnAboutMarker(
          `[prisma-idb] CONTRACT.MARKER_MISMATCH: the database was migrated to storageHash ${marker.storageHash}, but the client's contract has ${expectedHash}. Queries may read or write the wrong record shape.`
        );
      }
    } catch (error) {
      if (generation === (this.#driver.connectionGeneration ?? 0)) {
        warnAboutMarker("[prisma-idb] CONTRACT.MARKER_UNREADABLE: could not read the contract marker", error);
      }
    }
  }

  /**
   * Lower an IDB query plan to an IDB plan body via the adapter.
   *
   * Threads the contract through {@link IdbLowererContext} so per-field
   * codec encoding can resolve field→codec mappings from the contract's
   * storage schema.
   */
  protected override async lower(plan: IdbQueryPlan, ctx: CodecCallContext): Promise<IdbLoweredPlan> {
    // The marker check runs here rather than in `runDriver`, because lowering
    // comes before middleware `intercept`. A middleware that answers from its
    // own cache never reaches the driver, and would otherwise skip the check.
    // Lowering starts when the result is first iterated, so a plan that is
    // built and never run reads nothing.
    await this.#ensureMarkerChecked();
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
   * *including read ops* (`key-get`/`get-all`/`cursor-scan`) if the batch
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
    await this.#ensureMarkerChecked();
    if (this.#middleware.length === 0) return this.#driver.transaction(storeNames, mode);
    return observeTransaction(() => this.#driver.transaction(storeNames, mode), this.#middleware, this.#ctxFields);
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
