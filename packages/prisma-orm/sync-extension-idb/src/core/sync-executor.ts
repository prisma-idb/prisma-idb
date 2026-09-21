/**
 * Sync-intercepting executor.
 *
 * Wraps any `IdbQueryExecutor` to atomically write outbox events and version
 * meta records alongside every tracked mutation. Interception happens at two
 * levels:
 *
 * 1. **Plan-level** (`query()`): for mutation plans with a statically-known
 *    key (a plain `create`/`delete`, where the caller always supplies the key
 *    up front) the `idbPlan` body is extended into an `IdbBatchPlan` spanning
 *    the model store + both sync stores. The IDB adapter is a passthrough
 *    (`lower()` returns `plan.idbPlan` as-is), so this extended batch plan
 *    reaches the driver unmodified and executes atomically in a single IDB
 *    transaction. Nothing else stays on this path: `update`/`updateAll`/
 *    `deleteAll` don't have a statically-known key/row-set (a filter matches
 *    whatever it matches when it actually runs) — `client-idb` routes all
 *    three, plus `upsert` (a find-then-branch, resolved only once it runs),
 *    through the transaction-scope path below unconditionally instead, never
 *    through here.
 * 2. **Transaction-level** (`transaction()`): `client-idb`'s mutation
 *    executor (`mutation-executor.ts`) requires `.transaction()` for any
 *    model with a relation — FK-existence validation on create, referential
 *    actions on delete — and operates on the returned `IdbTransactionScope`
 *    directly via raw `IdbAtomicPlan`s, bypassing `query()` entirely. See
 *    `SyncInterceptingTransactionScope` below.
 */

import { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import type { IdbQueryExecutor, IdbQueryExecutorWithTransaction } from "@prisma-idb/client-idb/orm";
import type { IdbContract } from "@prisma-idb/client-idb/orm";
import type { IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import type {
  IdbQueryAst,
  IdbCreateAst,
  IdbDeleteAst,
  IdbUpdateAst,
  IdbCreateAllAst,
  IdbDeleteAllAst,
  IdbUpdateAllAst,
} from "@prisma-idb/adapter-idb/runtime";
import type {
  IdbAtomicPlan,
  IdbAddPlan,
  IdbPutPlan,
  IdbBatchPlan,
  IdbPlanBody,
  IdbTransactionScope,
} from "@prisma-idb/driver-idb/runtime";
import { getKeyPath, getStoreName } from "@prisma-idb/client-idb/orm";
import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import type { OutboxEvent, OutboxWriteEntry } from "../types";

// ── Types ─────────────────────────────────────────────────────────────────────

const OUTBOX_STORE = "_idb_sync_outbox";
const VERSION_META_STORE = "_idb_sync_version_meta";

type MutationAst = IdbCreateAst | IdbDeleteAst | IdbUpdateAst | IdbCreateAllAst | IdbDeleteAllAst | IdbUpdateAllAst;

function isMutationAst(ast: IdbQueryAst): ast is MutationAst {
  return (
    ast.kind === "create" ||
    ast.kind === "delete" ||
    ast.kind === "update" ||
    ast.kind === "createAll" ||
    ast.kind === "deleteAll" ||
    ast.kind === "updateAll"
  );
}

// ── Outbox record builders ────────────────────────────────────────────────────

type OutboxRecord = OutboxEvent;

/**
 * `getNextBatch` sorts outbox events by `createdAt` ascending for FIFO push
 * order — load-bearing for cascades: `applyReferentialActionsForRow` writes
 * a child row's outbox event (e.g. a cascade-deleted Todo) before its
 * parent's (the Board being deleted), and the server-side ownership check
 * for that child's delete walks Todo→Board→User, which only resolves while
 * the Board row still exists. Pushed out of order, the child's delete would
 * fail authorization once the parent is already gone.
 *
 * Plain `new Date()` has millisecond resolution; every op in one cascade
 * (or one batch plan) runs synchronously and can easily land in the same
 * millisecond, making `createdAt` ties resolve by IndexedDB cursor order
 * (the store's `id` keyPath — a random UUID, unrelated to write order) —
 * not the guarantee the sort claims. Monotonically bumping ensures each
 * successive call this session gets a strictly later timestamp than the
 * last, regardless of wall-clock resolution.
 */
let lastOutboxTimestampMs = 0;
function nextOutboxTimestamp(): Date {
  const now = Date.now();
  lastOutboxTimestampMs = now > lastOutboxTimestampMs ? now : lastOutboxTimestampMs + 1;
  return new Date(lastOutboxTimestampMs);
}

function buildOutboxRecord(
  modelName: string,
  operation: string,
  payload: unknown,
  versionMetaId: string | null
): OutboxRecord {
  return {
    id: crypto.randomUUID(),
    entityType: modelName,
    operation,
    payload,
    createdAt: nextOutboxTimestamp(),
    synced: false,
    syncedAt: null,
    lastAttemptedAt: null,
    tries: 0,
    lastError: null,
    retryable: true,
    versionMetaId,
  };
}

function outboxAddOp(
  modelName: string,
  operation: string,
  payload: unknown,
  versionMetaId: string | null,
  meta: IdbQueryPlan<unknown>["meta"]
): IdbAddPlan {
  return {
    meta,
    kind: "add",
    storeName: OUTBOX_STORE,
    record: buildOutboxRecord(modelName, operation, payload, versionMetaId) as unknown as Record<string, unknown>,
  };
}

// ── VersionMeta record builders ──────────────────────────────────────────────

function versionMetaKey(modelName: string, key: unknown): string {
  return `${modelName}::${JSON.stringify(key)}`;
}

function versionMetaPutOp(modelName: string, key: unknown, meta: IdbQueryPlan<unknown>["meta"]): IdbPutPlan {
  const id = versionMetaKey(modelName, key);
  return {
    meta,
    kind: "put",
    storeName: VERSION_META_STORE,
    record: {
      id,
      model: modelName,
      key,
      localChangePending: true,
      lastAppliedChangeId: null,
    },
  };
}

// ── Store name → model name (reverse lookup, for the transaction-scope path) ──

const storeToModelCache = new WeakMap<IdbContract, ReadonlyMap<string, string>>();

/**
 * `IdbAtomicPlan`s (used inside a transaction scope) only carry a
 * `storeName`, not a model name — unlike `IdbQueryAst`, which carries
 * `modelName` directly. Cached per contract since it's static for a given
 * contract instance.
 */
function getModelNameForStore(contract: IdbContract, storeName: string): string | undefined {
  let map = storeToModelCache.get(contract);
  if (!map) {
    const built = new Map<string, string>();
    for (const [modelName, model] of Object.entries(domainModelsAtDefaultNamespace(contract.domain))) {
      const modelStoreName = (model as { storage?: { storeName?: string } }).storage?.storeName;
      if (modelStoreName) built.set(modelStoreName, modelName);
    }
    map = built;
    storeToModelCache.set(contract, map);
  }
  return map.get(storeName);
}

/** Synthetic `PlanMeta` for ops issued directly against a transaction scope (no originating `IdbQueryPlan` to borrow one from). */
function syncPlanMeta(contract: IdbContract): IdbQueryPlan<unknown>["meta"] {
  return {
    target: "idb",
    storageHash: contract.storage.storageHash,
    lane: "idb-sync-executor",
  };
}

// ── Plan body helpers ─────────────────────────────────────────────────────────

/** Flatten an IdbPlanBody to a list of atomic ops. */
function flattenToOps(body: IdbPlanBody): IdbAtomicPlan[] {
  if (body.kind === "batch") return [...body.ops];
  return [body];
}

/** Collect all store names referenced by a plan body. */
function storeNamesOf(body: IdbPlanBody): string[] {
  if (body.kind === "batch") return [...body.storeNames];
  return [body.storeName];
}

// ── Key extraction ────────────────────────────────────────────────────────────

/**
 * `IDBKeyRange` is not structured-clonable, so it can never be written as
 * (part of) a stored record's value — only used as a request argument. Any
 * `IDBValidKey | IDBKeyRange` heading into an outbox payload must go through
 * this first: a concrete key round-trips as-is (keys are always valid,
 * clonable values), a range is flattened to its plain, cloneable bounds.
 */
function serializableKey(key: IDBValidKey | IDBKeyRange): unknown {
  if (!(key instanceof IDBKeyRange)) return key;
  return { lower: key.lower, upper: key.upper, lowerOpen: key.lowerOpen, upperOpen: key.upperOpen };
}

/**
 * Try to extract the primary key of the affected record from the AST.
 * Returns `undefined` when the key cannot be determined statically (e.g.
 * scan-write operations that match by filter, not by key).
 */
function extractKey(ast: MutationAst, keyField: string): unknown {
  switch (ast.kind) {
    case "create":
      // Pull key from AST data — the codec hasn't run yet so the value is the raw JS type.
      return ast.data[keyField];
    case "delete":
      return ast.key;
    case "update":
    case "createAll":
    case "deleteAll":
    case "updateAll":
      // Practically unreachable through client-idb's own ORM surface — all
      // four are intercepted before reaching here, because none of them can
      // have a statically-known key/row-set the way `create`/`delete` do
      // (a filter matches whatever it matches when it actually runs, not
      // before). `createAll` is expanded into one per-record entry directly
      // in `#extendPlan` (each record's OWN key is supplied by the caller,
      // no inspection needed). The other three all unconditionally route
      // through the transaction scope instead — `update()`/`updateAll()`/
      // `deleteAll()` via `executeScalarUpdateWithFkValidation` /
      // `executeBulkUpdateWithFkValidation` / `executeDeleteAllWithReferentialActions`
      // — tracked by `SyncInterceptingTransactionScope#maybeTrack`'s
      // `add`/`update`/`scan-write` cases, keyed from the row the write
      // actually matched, not guessed at from the filter/args that led to
      // it. (An earlier version of `update()`'s plan-level fallback tried
      // exactly that kind of guess for its own case — recognizing only a
      // bare equality filter directly on the primary key — and quietly
      // failed to sync anything filtered by a different field.) `upsert()`
      // works the same way, via its own `withMutationScope` call directly in
      // store-accessor.ts — it has no AST node at all (see the note next to
      // `IdbQueryAst` in `idb-query-ast.ts`), so it isn't even a case here.
      // Kept here (returning `undefined`, same as any other
      // statically-unknowable case) only because `MutationAst` is a shared
      // type across every possible IDB plan, including ones a caller could
      // hand-construct outside the ORM's own accessors.
      return undefined;
    default: {
      const _exhaustive: never = ast;
      return _exhaustive;
    }
  }
}

/** Map mutation AST kind → outbox operation string. */
function outboxOperation(kind: MutationAst["kind"]): string {
  switch (kind) {
    case "create":
    case "createAll":
      return "create";
    case "delete":
    case "deleteAll":
      return "delete";
    case "update":
    case "updateAll":
      return "update";
    default: {
      const _exhaustive: never = kind;
      return String(_exhaustive);
    }
  }
}

/**
 * Extract the payload to store in the outbox from the AST. Never actually
 * called for "update"/"createAll"/"deleteAll"/"updateAll" — see the matching
 * cases in `extractKey` above for why each is unreachable through the ORM's
 * own accessors. Their bodies here exist only so this function stays
 * exhaustive over every `MutationAst` kind, in case a caller ever
 * hand-builds a plan bypassing the ORM entirely; they're never exercised by
 * real writes.
 */
function outboxPayload(ast: MutationAst): unknown {
  switch (ast.kind) {
    case "create":
      return ast.data;
    case "delete":
      return { key: ast.key };
    case "update":
      return { patch: ast.patch, where: ast.where };
    case "createAll":
      return { data: ast.data };
    case "deleteAll":
      return { where: ast.where };
    case "updateAll":
      return { patch: ast.patch, where: ast.where };
    default: {
      const _exhaustive: never = ast;
      return _exhaustive;
    }
  }
}

/**
 * Pulls rows through `result` (consuming it exactly once), firing `onWrite`
 * once the caller is done with it — including if the caller only pulls the
 * first row and stops early (a `for await` break/return calls the
 * generator's own `return()`, which resumes at the current `yield` and runs
 * `finally` without reaching code placed after the loop). Not fired if the
 * underlying iteration throws.
 */
async function* trackOutboxWrite<Row>(
  result: AsyncIterableResult<Row>,
  onWrite: () => void
): AsyncGenerator<Row, void, unknown> {
  let ok = true;
  try {
    for await (const row of result) yield row;
  } catch (err) {
    ok = false;
    throw err;
  } finally {
    if (ok) onWrite();
  }
}

// ── SyncInterceptorExecutor ───────────────────────────────────────────────────

export interface SyncInterceptorConfig {
  /** IDB contract — used to resolve store names and key paths. */
  readonly contract: IdbContract;
  /** Models to intercept. `'*'` intercepts all models. */
  readonly trackedModels: ReadonlyArray<string> | "*";
  /**
   * Fired once per tracked IDB write call, after its outbox event(s) have
   * committed, with every entry that call wrote (one entry for an ordinary
   * single-row mutation, several for a batched write — see
   * `OutboxWriteEntry`'s doc comment for exactly what "batched" covers).
   * Exposed publicly as `SyncIdbClient.on("outboxwrite", ...)` — a single
   * low-level callback here, fanned out to multiple subscribers there.
   */
  readonly onOutboxWrite?: (entries: readonly OutboxWriteEntry[]) => void;
}

function isTrackedModel(config: SyncInterceptorConfig, modelName: string): boolean {
  const { trackedModels } = config;
  if (trackedModels === "*") return true;
  const storeName = getStoreName(config.contract, modelName);
  return trackedModels.includes(modelName) || trackedModels.includes(storeName);
}

/**
 * Executor wrapper that atomically extends tracked mutation plans with outbox
 * and version-meta writes.
 *
 * The IDB adapter's `lower()` is a structural passthrough, so replacing
 * `plan.idbPlan` with an extended `IdbBatchPlan` causes the driver to open
 * ONE IDB transaction spanning all stores — guaranteeing atomicity.
 */
export class SyncInterceptorExecutor implements IdbQueryExecutorWithTransaction {
  readonly #inner: IdbQueryExecutor;
  readonly #config: SyncInterceptorConfig;

  constructor(inner: IdbQueryExecutor, config: SyncInterceptorConfig) {
    this.#inner = inner;
    this.#config = config;
  }

  query<Row>(plan: IdbQueryPlan<Row>): AsyncIterableResult<Row> {
    const ast = plan.ast;
    if (!ast || !isMutationAst(ast) || !isTrackedModel(this.#config, ast.modelName)) {
      return this.#inner.query(plan);
    }
    const { plan: extendedPlan, entries } = this.#extendPlan(plan, ast);
    const result = this.#inner.query(extendedPlan);
    const { onOutboxWrite } = this.#config;
    if (!onOutboxWrite) return result;
    // Can't `.then()`/iterate `result` here to observe completion — every
    // `AsyncIterableResult` is single-consumption (throws on a second
    // consumer), and the caller (client-idb's store accessor) still needs to
    // consume it. Instead, hand back a NEW `AsyncIterableResult` that itself
    // consumes `result` exactly once (pulling every row through, unchanged)
    // and fires `onOutboxWrite` only after that succeeds — a write that
    // throws mid-iteration never notifies.
    return new AsyncIterableResult<Row>(trackOutboxWrite(result, () => onOutboxWrite(entries)));
  }

  /**
   * `client-idb`'s mutation executor requires this for any model with a
   * relation (FK-existence validation on create, referential actions on
   * delete — `requireTransactionExecutor` in `mutation-executor.ts`) and
   * operates on the returned scope via raw `IdbAtomicPlan`s, not `query()`.
   * Delegates to the inner executor (the real `IdbRuntime`, which implements
   * this), wrapping the returned scope so ops issued against it are ALSO
   * tracked — see `SyncInterceptingTransactionScope`.
   */
  async transaction(storeNames: string[], mode?: IDBTransactionMode): Promise<IdbTransactionScope> {
    const inner = this.#inner as Partial<IdbQueryExecutorWithTransaction>;
    if (typeof inner.transaction !== "function") {
      throw new Error(
        "SyncInterceptorExecutor.transaction(): the wrapped executor does not support transactions. " +
          "Pass an IdbRuntime (createIdbRuntime), not a plain IdbQueryExecutor."
      );
    }
    const allStores = [...new Set([...storeNames, OUTBOX_STORE, VERSION_META_STORE])];
    const scope = await inner.transaction(allStores, mode);
    return new SyncInterceptingTransactionScope(scope, this.#config);
  }

  #extendPlan<Row>(
    plan: IdbQueryPlan<Row>,
    ast: MutationAst
  ): { plan: IdbQueryPlan<Row>; entries: readonly OutboxWriteEntry[] } {
    const { contract } = this.#config;
    const modelName = ast.modelName;
    const keyPath = getKeyPath(contract, modelName);

    if (ast.kind === "createAll") {
      // Unlike a scan-write bulk op, every record's key is already known
      // statically (the caller supplies it) — no need to fall back to a
      // single lumped event the way `updateAll`/`deleteAll` used to before
      // they moved to the transaction-scope path. One outbox event per
      // record here instead, each a normal "create" the server already
      // knows how to apply — not the unusable `{ data: [record, ...] }`
      // whole-array payload this used to produce via the generic
      // single-entry path below.
      const entries: OutboxWriteEntry[] = ast.data.map((record) => ({
        modelName,
        operation: "create",
        payload: record,
        key: record[keyPath],
      }));
      return { plan: this.#buildBatchPlan(plan, entries), entries };
    }

    // In practice only "create"/"delete" ever reach here — every other
    // MutationAst kind has its own dedicated handling that never falls
    // through to this generic path: `createAll` above, `update`/`updateAll`/
    // `deleteAll`/`upsert` via client-idb's transaction-scope routing (see
    // `extractKey`'s doc comment). Extract the primary key of the affected
    // record — used to key VersionMeta; always resolvable for "create"/
    // "delete" (the caller always supplies the key up front for both).
    const operation = outboxOperation(ast.kind);
    const key = extractKey(ast, keyPath);
    const payload = outboxPayload(ast);
    const entries: OutboxWriteEntry[] = [{ modelName, operation, payload, key }];
    return { plan: this.#buildBatchPlan(plan, entries), entries };
  }

  /**
   * Appends one outbox-add (+ VersionMeta-put, when its key is known) per
   * entry to the plan's batch, atomically alongside the original write(s).
   * A single-entry array covers every ordinary mutation; `createAll` is the
   * one caller passing more than one, since it's the one case where several
   * independently-keyed rows are known upfront in a single plan.
   */
  #buildBatchPlan<Row>(plan: IdbQueryPlan<Row>, entries: readonly OutboxWriteEntry[]): IdbQueryPlan<Row> {
    const { meta } = plan;
    const originalOps = flattenToOps(plan.idbPlan);
    const originalStores = storeNamesOf(plan.idbPlan);

    const extraOps: IdbAtomicPlan[] = [];
    let touchesVersionMeta = false;
    for (const { modelName, operation, payload, key } of entries) {
      const versionMetaId = key !== undefined ? versionMetaKey(modelName, key) : null;
      extraOps.push(outboxAddOp(modelName, operation, payload, versionMetaId, meta));
      if (key !== undefined) {
        extraOps.push(versionMetaPutOp(modelName, key, meta));
        touchesVersionMeta = true;
      }
    }

    const allStores = [...originalStores, OUTBOX_STORE, ...(touchesVersionMeta ? [VERSION_META_STORE] : [])];

    const batchPlan: IdbBatchPlan = {
      meta,
      kind: "batch",
      storeNames: [...new Set(allStores)],
      ops: [...originalOps, ...extraOps],
    };

    return { ...plan, idbPlan: batchPlan };
  }
}

// ── SyncInterceptingTransactionScope ──────────────────────────────────────────

/**
 * Wraps the real `IdbTransactionScope` `SyncInterceptorExecutor.transaction()`
 * opens, tracking every write `client-idb`'s mutation executor issues
 * directly against it (`add`, `update`, `delete`, `scan-write`) — this is
 * how `executeScalarCreateWithFkValidation`/`executeDeleteWithReferentialActions`/
 * `executeScalarUpdateWithFkValidation` (single-model writes gated by FK
 * validation or referential actions), `applyReferentialActionsForRow`
 * (cascade/setNull on children when a parent is deleted), and the nested
 * relation-mutation-callback writes (`rel.create(...)`, `rel.connect(...)`,
 * `rel.disconnect(...)` via `executeNestedCreateMutation`/
 * `executeNestedUpdateMutation`) all get covered — they all funnel through
 * this same wrapped scope, so there is nothing extra to wire up per call
 * site.
 *
 * `scan-write` (`put-merged` or `delete`) can touch 0..N rows in one
 * physical op (e.g. cascade-deleting every comment on a post). Its `filter`
 * is an opaque JS closure, not a serializable expression like the AST-level
 * `where` bulk ops (`deleteAll`/`updateAll`) get — so there is no way to
 * record "the operation" as a replayable intent. Instead, `execScanWrite`
 * (`driver-idb/src/core/execute/ops.ts`) already collects and returns every
 * row it actually touched (the merged row for `put-merged`, the pre-delete
 * snapshot for `delete`) as this op's resolved value; one outbox event +
 * one VersionMeta row is written per affected row, keyed by that row's own
 * primary key — the same shape as a normal single-row update/delete. All N
 * of those rows are still ONE `execute()` call on this scope, so they batch
 * into ONE `onOutboxWrite` firing (see `OutboxWriteEntry`'s doc comment) —
 * not N separate ones the way a naive per-row callback would.
 */
class SyncInterceptingTransactionScope implements IdbTransactionScope {
  readonly #inner: IdbTransactionScope;
  readonly #config: SyncInterceptorConfig;
  // Buffered, not fired immediately from #writeOutboxAndMeta: this scope can
  // see several execute() calls before the caller commits (e.g. a cascade
  // delete's per-row referential actions), and any of them can still fail
  // and roll back the whole transaction. Firing onOutboxWrite per-call let
  // subscribers (e.g. a pending-sync-count badge) react to writes that were
  // later rolled back and never actually persisted. One entry per
  // `#writeOutboxAndMeta` call (i.e. per `execute()`, preserving the
  // existing one-firing-per-call granularity — see that method's doc
  // comment), only actually emitted once `commit()`'s `tx.oncomplete`
  // confirms every write in the transaction is durable.
  #pendingBatches: OutboxWriteEntry[][] = [];

  constructor(inner: IdbTransactionScope, config: SyncInterceptorConfig) {
    this.#inner = inner;
    this.#config = config;
  }

  async execute(plan: IdbAtomicPlan): Promise<Record<string, unknown>[]> {
    const rows = await this.#inner.execute(plan);
    await this.#maybeTrack(plan, rows);
    return rows;
  }

  async commit(): Promise<void> {
    await this.#inner.commit();
    const batches = this.#pendingBatches;
    this.#pendingBatches = [];
    for (const entries of batches) this.#config.onOutboxWrite?.(entries);
  }

  rollback(): void {
    this.#pendingBatches = [];
    this.#inner.rollback();
  }

  async #maybeTrack(plan: IdbAtomicPlan, rows: Record<string, unknown>[]): Promise<void> {
    const { contract } = this.#config;
    const modelName = getModelNameForStore(contract, plan.storeName);
    if (!modelName || !isTrackedModel(this.#config, modelName)) return;
    const keyPath = getKeyPath(contract, modelName);

    switch (plan.kind) {
      case "add": {
        const record = plan.record;
        await this.#writeOutboxAndMeta([{ modelName, operation: "create", payload: record, key: record[keyPath] }]);
        return;
      }
      case "delete": {
        // `key` can be a range for bulk deletes; only a concrete IDBValidKey
        // is usable for VersionMeta (the outbox event is still written
        // either way). IDBKeyRange itself is not structured-clonable, so it
        // can't be stored raw inside the outbox record's payload either —
        // normalize it to plain, cloneable bounds first.
        const key = plan.key instanceof IDBKeyRange ? undefined : plan.key;
        await this.#writeOutboxAndMeta([
          { modelName, operation: "delete", payload: { key: serializableKey(plan.key) }, key },
        ]);
        return;
      }
      case "update": {
        const merged = rows[0];
        if (!merged) return;
        await this.#writeOutboxAndMeta([
          { modelName, operation: "update", payload: { patch: plan.patch, key: plan.key }, key: merged[keyPath] },
        ]);
        return;
      }
      case "scan-write": {
        const operation = plan.write === "delete" ? "delete" : "update";
        const entries: OutboxWriteEntry[] = rows.map((row) => {
          const key = row[keyPath];
          const payload = plan.write === "delete" ? { key } : { patch: plan.patch, key };
          return { modelName, operation, payload, key };
        });
        await this.#writeOutboxAndMeta(entries);
        return;
      }
      // `put` is untracked: `client-idb`'s mutation executor never issues it
      // against a live transaction scope for tracked-model writes today
      // (only this file's own outbox/version-meta bookkeeping does, which
      // bypasses `execute()` via `#writeOutboxAndMeta` and never reaches
      // here). Reads are never tracked.
      case "put":
      case "key-get":
      case "index-get":
      case "cursor-scan":
        return;
      default: {
        const _exhaustive: never = plan;
        return _exhaustive;
      }
    }
  }

  /** Writes every entry's outbox-add + VersionMeta-put, buffering it as ONE `commit()`-time `onOutboxWrite` batch — a no-op for an empty array (e.g. a scan-write that matched zero rows). */
  async #writeOutboxAndMeta(entries: readonly OutboxWriteEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const meta = syncPlanMeta(this.#config.contract);
    for (const { modelName, operation, payload, key } of entries) {
      const versionMetaId = key !== undefined ? versionMetaKey(modelName, key) : null;
      await this.#inner.execute(outboxAddOp(modelName, operation, payload, versionMetaId, meta));
      if (key !== undefined) {
        await this.#inner.execute(versionMetaPutOp(modelName, key, meta));
      }
    }
    this.#pendingBatches.push([...entries]);
  }
}
