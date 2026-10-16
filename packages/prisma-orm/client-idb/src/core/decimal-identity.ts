import { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import type { IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import {
  IdbExecuteError,
  type IdbAtomicPlan,
  type IdbPlanBody,
  type IdbTransactionScope,
} from "@prisma-idb/driver-idb/runtime";
import { compareDecimalValues, isValidIdbKey, keyEquals, keyToken } from "@prisma-idb/target-idb/runtime";
import type { IdbQueryExecutor } from "./executor";
import type { IdbQueryExecutorWithTransaction } from "./mutation-scope";
import { buildCatalog, type QueryCatalog, type CatalogSource } from "./planner/catalog";
import { extractKeyFromRow, getStoreName, type IdbContract } from "./types";

/** A legacy store or sync metadata set contains several spellings of one Decimal key. */
export class IdbDecimalIdentityConflictError extends Error {
  readonly code = "DECIMAL_IDENTITY_CONFLICT";

  constructor(modelName: string) {
    super(
      `Several stored keys identify the same Decimal value in model "${modelName}". Resolve the conflicting records before retrying.`
    );
    this.name = "IdbDecimalIdentityConflictError";
  }
}

/** Whether a primary key contains a contract-declared Decimal field. */
export function hasDecimalPrimaryKey(contract: IdbContract, modelName: string): boolean {
  const catalog = buildCatalog(contract, getStoreName(contract, modelName), modelName);
  return hasDecimalFields(catalog, catalog.primaryKey);
}

/** Compare scalar or compound primary keys using Decimal codecs and native IDB equality elsewhere. */
export function decimalKeysEqual(contract: IdbContract, modelName: string, left: unknown, right: unknown): boolean {
  const catalog = buildCatalog(contract, getStoreName(contract, modelName), modelName);
  const leftParts = typeof catalog.primaryKey.keyPath === "string" ? [left] : left;
  const rightParts = typeof catalog.primaryKey.keyPath === "string" ? [right] : right;
  if (
    !Array.isArray(leftParts) ||
    !Array.isArray(rightParts) ||
    leftParts.length !== catalog.primaryKey.fields.length ||
    rightParts.length !== leftParts.length
  )
    return false;
  return catalog.primaryKey.fields.every((field, i) => valuesEqual(catalog, field, leftParts[i], rightParts[i]));
}

/** Keep an existing Decimal primary-key spelling when the supplied value identifies the same row. */
export function preserveDecimalKeySpelling(
  contract: IdbContract,
  modelName: string,
  record: Record<string, unknown>,
  storedKey: unknown
): Record<string, unknown> {
  const catalog = buildCatalog(contract, getStoreName(contract, modelName), modelName);
  const parts = typeof catalog.primaryKey.keyPath === "string" ? [storedKey] : storedKey;
  if (!Array.isArray(parts) || parts.length !== catalog.primaryKey.fields.length) return record;
  const result = { ...record };
  catalog.primaryKey.fields.forEach((field, i) => {
    if (
      catalog.fields[field]?.codecId === "idb/decimal@1" &&
      result[field] !== undefined &&
      valuesEqual(catalog, field, result[field], parts[i])
    )
      result[field] = parts[i];
  });
  return result;
}

/** Read the physical key first, then check Decimal aliases without choosing a legacy duplicate. */
export async function resolveDecimalKey(
  scope: Pick<IdbTransactionScope, "execute">,
  contract: IdbContract,
  modelName: string,
  key: unknown,
  snapshot?: readonly Record<string, unknown>[]
): Promise<Record<string, unknown> | undefined> {
  if (!isValidIdbKey(key)) return undefined;
  const storeName = getStoreName(contract, modelName);
  const decimal = hasDecimalPrimaryKey(contract, modelName);
  // Reject malformed Decimal operands even when there are no stored rows to compare.
  if (decimal && !decimalKeysEqual(contract, modelName, key, key)) return undefined;
  if (!snapshot) {
    const [exact] = await scope.execute({ kind: "key-get", storeName, key } as IdbAtomicPlan);
    if (!decimal) return exact;
  }
  // The physical index cannot reveal aliases, even on an exact hit. A scan
  // also detects ambiguous databases created before numeric uniqueness checks.
  const rows = snapshot ?? (await scope.execute({ kind: "cursor-scan", storeName } as IdbAtomicPlan));
  const matches = rows.filter((row) =>
    decimalKeysEqual(
      contract,
      modelName,
      extractKeyFromRow(row, buildCatalog(contract, storeName, modelName).primaryKey.keyPath),
      key
    )
  );
  if (matches.length > 1) throw new IdbDecimalIdentityConflictError(modelName);
  return matches[0];
}

/** Whether this key source needs numeric equality instead of the native string index. */
function hasDecimalFields(catalog: QueryCatalog, source: CatalogSource): boolean {
  return source.fields.some((field) => catalog.fields[field]?.codecId === "idb/decimal@1");
}

/** Compare one declared scalar without converting Decimal text through Number. */
function valuesEqual(catalog: QueryCatalog, field: string, left: unknown, right: unknown): boolean {
  return catalog.fields[field]?.codecId === "idb/decimal@1"
    ? typeof left === "string" && typeof right === "string" && compareDecimalValues(left, right) === 0
    : isValidIdbKey(left) && isValidIdbKey(right) && keyEquals(left, right);
}

/** Numeric unique sources only; ordinary native indexes continue to enforce their own constraints. */
function decimalUniqueSources(catalog: QueryCatalog): CatalogSource[] {
  return [catalog.primaryKey, ...catalog.indexes].filter(
    (source) => source.unique && hasDecimalFields(catalog, source)
  );
}

/** Match one index entry, excluding absent/null keys just as IndexedDB does. */
function sourceCollides(
  catalog: QueryCatalog,
  source: CatalogSource,
  left: Record<string, unknown>,
  right: Record<string, unknown>
): boolean {
  if (source.multiEntry && source.fields.length === 1) {
    const field = source.fields[0]!;
    const a = Array.isArray(left[field]) ? left[field] : [left[field]];
    const b = Array.isArray(right[field]) ? right[field] : [right[field]];
    return (a as unknown[]).some((x) => (b as unknown[]).some((y) => valuesEqual(catalog, field, x, y)));
  }
  return source.fields.every((field) => valuesEqual(catalog, field, left[field], right[field]));
}

/** Check new values against every other physical row inside the write transaction. */
async function assertUnique(
  scope: IdbTransactionScope,
  catalog: QueryCatalog,
  record: Record<string, unknown>,
  previousKey: IDBValidKey | undefined,
  kind: string,
  modelName: string,
  snapshot?: readonly Record<string, unknown>[]
): Promise<void> {
  const rows =
    snapshot ?? (await scope.execute({ kind: "cursor-scan", storeName: catalog.storeName } as IdbAtomicPlan));
  const previous = rows.find(
    (row) => previousKey !== undefined && keyEquals(extractKeyFromRow(row, catalog.primaryKey.keyPath), previousKey)
  );
  for (const source of decimalUniqueSources(catalog)) {
    const matches = rows.filter((row) => sourceCollides(catalog, source, row, record));
    if (
      matches.length > 1 ||
      (previous && rows.filter((row) => sourceCollides(catalog, source, row, previous)).length > 1)
    )
      throw new IdbDecimalIdentityConflictError(modelName);
    if (
      matches.some(
        (row) =>
          previousKey === undefined || !keyEquals(extractKeyFromRow(row, catalog.primaryKey.keyPath), previousKey)
      )
    ) {
      throw new IdbExecuteError(
        {
          code: kind === "add" ? "ADD_FAILED" : "PUT_FAILED",
          planKind: kind,
          storeName: catalog.storeName,
          cause: new DOMException("Numerically equal Decimal key already exists", "ConstraintError"),
        },
        "Unique constraint failed for a Decimal key"
      );
    }
  }
}

const decimalModelCache = new WeakMap<IdbContract, ReadonlyMap<string, string>>();

/** Cache the contract models whose uniqueness needs more than native string indexes. */
function decimalModels(contract: IdbContract): ReadonlyMap<string, string> {
  const cached = decimalModelCache.get(contract);
  if (cached) return cached;
  const models = new Map<string, string>();
  for (const modelName of Object.keys(domainModelsAtDefaultNamespace(contract.domain))) {
    const store = getStoreName(contract, modelName);
    if (decimalUniqueSources(buildCatalog(contract, store, modelName)).length > 0) models.set(store, modelName);
  }
  decimalModelCache.set(contract, models);
  return models;
}

/** Wrap the transaction seam so nested, bulk and raw sync writes share the same identity rules. */
export function withDecimalIdentityScope(scope: IdbTransactionScope, contract: IdbContract): IdbTransactionScope {
  const models = decimalModels(contract);
  if (models.size === 0) return scope;
  return {
    commit: () => scope.commit(),
    rollback: () => scope.rollback(),
    async execute(plan) {
      const modelName = models.get(plan.storeName);
      if (modelName === undefined) return scope.execute(plan);
      try {
        return await executeDecimalWrite(scope, contract, modelName, plan);
      } catch (error) {
        scope.rollback();
        throw error;
      }
    },
  };
}

/** Resolve a keyed write or materialize a scan before enforcing its numeric constraints. */
async function executeDecimalWrite(
  scope: IdbTransactionScope,
  contract: IdbContract,
  modelName: string,
  plan: IdbAtomicPlan,
  snapshot?: readonly Record<string, unknown>[]
): Promise<Record<string, unknown>[]> {
  const catalog = buildCatalog(contract, plan.storeName, modelName);
  if (plan.kind === "scan-write") return executeDecimalScanWrite(scope, contract, modelName, plan);
  if (plan.kind === "delete") {
    if (!isValidIdbKey(plan.key)) return scope.execute(plan);
    const row = await resolveDecimalKey(scope, contract, modelName, plan.key, snapshot);
    return scope.execute({ ...plan, key: row ? extractKeyFromRow(row, catalog.primaryKey.keyPath) : plan.key });
  }
  if (plan.kind !== "add" && plan.kind !== "put" && plan.kind !== "update") return scope.execute(plan);
  const key = plan.kind === "update" ? plan.key : extractKeyFromRow(plan.record, catalog.primaryKey.keyPath);
  const previous = plan.kind === "add" ? undefined : await resolveDecimalKey(scope, contract, modelName, key, snapshot);
  const previousKey = previous && extractKeyFromRow(previous, catalog.primaryKey.keyPath);
  const record = preserveDecimalKeySpelling(
    contract,
    modelName,
    plan.kind === "update" ? { ...previous, ...plan.patch } : plan.record,
    previousKey
  );
  await assertUnique(scope, catalog, record, previousKey, plan.kind, modelName, snapshot);
  return scope.execute(
    plan.kind === "update"
      ? {
          ...plan,
          key: previousKey ?? plan.key,
          patch: preserveDecimalKeySpelling(contract, modelName, plan.patch, previousKey),
        }
      : { ...plan, record }
  );
}

/** Materialize preimages once so moving indexed fields cannot revisit a row. */
async function executeDecimalScanWrite(
  scope: IdbTransactionScope,
  contract: IdbContract,
  modelName: string,
  plan: Extract<IdbAtomicPlan, { kind: "scan-write" }>
): Promise<Record<string, unknown>[]> {
  const catalog = buildCatalog(contract, plan.storeName, modelName);
  const { take, ...scan } = plan;
  const rows = await scope.execute({ ...scan, kind: "cursor-scan" });
  const seen = new Set<string>();
  const matches = rows
    .filter((row) => {
      const token = keyToken(extractKeyFromRow(row, catalog.primaryKey.keyPath));
      if (seen.has(token)) return false;
      seen.add(token);
      return true;
    })
    .slice(0, take);
  // The selected preimages omit rows outside the filter/range. Uniqueness
  // and legacy-alias checks must still include those rows.
  if (matches.length === 0) return [];
  const snapshot =
    !plan.indexName && !plan.range && !plan.filter
      ? [...rows]
      : await scope.execute({ kind: "cursor-scan", storeName: plan.storeName } as IdbAtomicPlan);
  const result: Record<string, unknown>[] = [];
  for (const row of matches) {
    const key = extractKeyFromRow(row, catalog.primaryKey.keyPath);
    const written = await executeDecimalWrite(
      scope,
      contract,
      modelName,
      plan.write === "delete"
        ? { ...plan, kind: "delete", key }
        : { ...plan, kind: "update", key, patch: plan.patch ?? {} },
      snapshot
    );
    result.push(...written);
    const index = snapshot.findIndex((stored) => keyEquals(extractKeyFromRow(stored, catalog.primaryKey.keyPath), key));
    snapshot.splice(index, 1, ...(plan.write === "delete" ? [] : written));
  }
  return result;
}

/** Decorate only Decimal-key mutations; all other queries retain their existing execution path. */
export function withDecimalIdentityExecutor(contract: IdbContract, executor: IdbQueryExecutor): IdbQueryExecutor {
  const models = decimalModels(contract);
  if (models.size === 0) return executor;
  const inner = executor as Partial<IdbQueryExecutorWithTransaction>;
  /** Only mutations of declared Decimal key sources need a transaction wrapper. */
  const needsCheck = (plan: IdbAtomicPlan): boolean => {
    if (!["add", "put", "update", "delete", "scan-write"].includes(plan.kind)) return false;
    return models.has(plan.storeName);
  };
  /** Keep validation and the write under the caller's transaction and sync interceptor. */
  const transaction = async (stores: string[], mode?: IDBTransactionMode): Promise<IdbTransactionScope> => {
    if (typeof inner.transaction !== "function")
      throw new Error("Decimal key mutations require a transaction-capable executor");
    return withDecimalIdentityScope(await inner.transaction(stores, mode), contract);
  };
  return {
    ...(typeof inner.transaction === "function" ? { transaction } : {}),
    query<Row>(plan: IdbQueryPlan<Row>): AsyncIterableResult<Row> {
      const body: IdbPlanBody = plan.idbPlan;
      const ops = body.kind === "batch" ? body.ops : [body];
      if (!ops.some(needsCheck)) return executor.query(plan);
      return new AsyncIterableResult(
        (async function* () {
          const scope = await transaction(body.kind === "batch" ? [...body.storeNames] : [body.storeName], "readwrite");
          try {
            const rows: Record<string, unknown>[] = [];
            for (const op of ops) rows.push(...(await scope.execute(op)));
            await scope.commit();
            for (const row of rows) yield row as Row;
          } catch (error) {
            scope.rollback();
            throw error;
          }
        })()
      );
    },
  };
}
