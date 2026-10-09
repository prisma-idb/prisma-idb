/**
 * IDB nested-write executor.
 *
 * IDB adaptation of `sql-orm-client/mutation-executor.ts`. Key differences
 * from the SQL vendor:
 *
 * - No column/field mapping — IDB field names ARE the storage keys.
 * - `applyCreateDefaults`/`applyUpdateDefaults` (`mutation-defaults.ts`) fill
 *   in every generator id `contract.execution.mutations.defaults` declares
 *   (see `IdbMutationDefaultGeneratorId`) — IDB has no server-rendered
 *   defaults, so this always runs client-side, unlike SQL's storage-plane
 *   `ColumnDefault`.
 * - `insertSingleRow` → `scope.execute({ kind: "add", ... })`.
 * - Mutation lookups use the query planner and reapply the full filter.
 *   IDB allows reads inside a readwrite transaction; the transaction scope accepts
 *   all `IdbAtomicPlan` types including `cursor-scan`.
 * - Child-owned `connect` → `scope.execute({ kind: "scan-write", write: "put-merged", ... })`.
 *   IDB has no UPDATE SET WHERE, so we use the scan-write plan with a filter closure.
 * - `connect()` for parent-owned (N:1) relations throws if the referenced row is not
 *   found — this is Phase 6.4's implicit FK validation for the connect case.
 * - Recursive nesting (nested writes inside nested writes) is not supported and throws.
 *
 * All multi-store writes are wrapped in a single `withMutationScope` call that opens
 * one IDB transaction spanning all required stores, per ADR 007.
 */

import type { PlanMeta } from "@prisma/orm-framework/contract/types";
import type { ContractReferenceRelation } from "@prisma/orm-framework/contract/types";
import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import type { IdbAtomicPlan, IdbPlanBody, IdbRowFilter } from "@prisma-idb/driver-idb/runtime";
import { andExpr, fieldFilter, shorthandToFilterExpr } from "@prisma-idb/adapter-idb/runtime";
import type { IdbFilterExpr } from "@prisma-idb/adapter-idb/runtime";
import type { IdbReferentialAction } from "@prisma-idb/target-idb/pack";
import type { IdbQueryExecutor } from "./executor";
import { assertEnumValues } from "./enum-validation";
import {
  applyCreateDefaults,
  applyUpdateDefaults,
  createMutationDefaultsCache,
  type MutationDefaultsCache,
} from "./mutation-defaults";
import { buildCatalog } from "./planner/catalog";
import { lowerExists, lowerRows, lowerWrite, type WriteRequest } from "./planner/lower";
import { planQuery } from "./planner/plan";
import { withMutationScope, type IdbQueryExecutorWithTransaction } from "./mutation-scope";
import { createRelationMutator, isRelationMutationCallback, isRelationMutationDescriptor } from "./relation-mutator";
import {
  type IdbContract,
  type IdbRelationMutation,
  type IdbRelationMutator,
  type MutationCreateInput,
  type MutationUpdateInput,
  extractKeyFromRow,
  fieldValuesEqual,
  getKeyPath,
  getStoreName,
  keyEquals,
  keyToken,
} from "./types";
import { keyPathFields } from "@prisma-idb/target-idb/pack";
import type { IdbTransactionScope } from "@prisma-idb/driver-idb/runtime";

// ── Internal types ─────────────────────────────────────────────────────────────

interface RelationDefinition {
  readonly relationName: string;
  readonly relatedModelName: string;
  readonly relatedStoreName: string;
  readonly cardinality: string | undefined;
  readonly localFields: readonly string[];
  readonly targetFields: readonly string[];
}

interface ParsedRelationMutation {
  readonly relation: RelationDefinition;
  readonly mutation: IdbRelationMutation<IdbContract, string>;
}

interface ParsedMutationInput {
  readonly scalarData: Record<string, unknown>;
  readonly relationMutations: readonly ParsedRelationMutation[];
}

// ── Plan meta helpers ─────────────────────────────────────────────────────────

export function makePlanMeta(contract: IdbContract): PlanMeta {
  return {
    target: "idb",
    storageHash: contract.storage.storageHash,
    lane: "idb-mutation-executor",
    annotations: { groupingKey: "nested" },
  };
}

// ── Relation definition resolution (cached) ──────────────────────────────────

const relationDefsCache = new WeakMap<object, Map<string, RelationDefinition[]>>();

function getRelationDefinitions(contract: IdbContract, modelName: string): RelationDefinition[] {
  let perContract = relationDefsCache.get(contract);
  if (!perContract) {
    perContract = new Map();
    relationDefsCache.set(contract, perContract);
  }

  const cached = perContract.get(modelName);
  if (cached) return cached;

  const model = domainModelsAtDefaultNamespace(contract.domain)[modelName];
  if (!model) {
    perContract.set(modelName, []);
    return [];
  }

  const defs: RelationDefinition[] = [];
  for (const [relationName, rawRelation] of Object.entries(model.relations)) {
    if (!rawRelation || typeof rawRelation !== "object" || !("on" in rawRelation)) continue;

    const relation = rawRelation as ContractReferenceRelation;
    // `relation.to` is a CrossReference `{ namespace, model }`.
    const relatedModelName = relation.to.model;
    const relatedStoreName = getStoreName(contract, relatedModelName);
    defs.push({
      relationName,
      relatedModelName,
      relatedStoreName,
      cardinality: relation.cardinality,
      localFields: relation.on.localFields,
      targetFields: relation.on.targetFields,
    });
  }

  perContract.set(modelName, defs);
  return defs;
}

// ── Public helpers ────────────────────────────────────────────────────────────

/**
 * Returns true if `data` contains at least one field that is both a known
 * relation name for `modelName` and a function (a mutation callback).
 */
export function hasNestedMutationCallbacks(
  contract: IdbContract,
  modelName: string,
  data: Record<string, unknown>
): boolean {
  const relationNames = new Set(getRelationDefinitions(contract, modelName).map((r) => r.relationName));
  for (const [fieldName, value] of Object.entries(data)) {
    if (relationNames.has(fieldName) && isRelationMutationCallback(value)) return true;
  }
  return false;
}

/**
 * Guards that the executor supports multi-store transactions.
 * Throws a clear error if `transaction()` is not available — the user must
 * use IdbRuntime (createIdbRuntime / createAutoMigratingIdbClient) rather than
 * a plain IdbQueryExecutor stub.
 */
export function requireTransactionExecutor(executor: IdbQueryExecutor): IdbQueryExecutorWithTransaction {
  if (typeof (executor as IdbQueryExecutorWithTransaction).transaction !== "function") {
    throw new Error(
      "This operation requires an executor with transaction support (nested relation writes, " +
        "FK-validated create/update, and referential-action delete all need it). " +
        "Use IdbRuntime (createIdbRuntime or createAutoMigratingIdbClient) instead of a plain IdbQueryExecutor."
    );
  }
  return executor as IdbQueryExecutorWithTransaction;
}

// ── Entry points ──────────────────────────────────────────────────────────────

export async function executeNestedCreateMutation(options: {
  executor: IdbQueryExecutorWithTransaction;
  contract: IdbContract;
  modelName: string;
  data: MutationCreateInput<IdbContract, string>;
}): Promise<Record<string, unknown>> {
  const { executor, contract, modelName, data } = options;
  const record = data as Record<string, unknown>;
  const storeNames = collectStoreNames(contract, modelName, record, "create");
  const defaultsCache = createMutationDefaultsCache();
  return withMutationScope(executor, storeNames, (scope) =>
    createGraph(scope, contract, modelName, record, defaultsCache)
  );
}

export async function executeNestedUpdateMutation(options: {
  executor: IdbQueryExecutorWithTransaction;
  contract: IdbContract;
  modelName: string;
  filters: readonly IdbFilterExpr[];
  data: MutationUpdateInput<IdbContract, string>;
}): Promise<Record<string, unknown> | null> {
  const { executor, contract, modelName, filters, data } = options;
  const record = data as Record<string, unknown>;
  const storeNames = collectStoreNames(contract, modelName, record, "update");
  const defaultsCache = createMutationDefaultsCache();
  return withMutationScope(executor, storeNames, (scope) =>
    updateFirstGraph(scope, contract, modelName, filters, record, defaultsCache)
  );
}

// ── Store name collection ─────────────────────────────────────────────────────

/**
 * Every store a nested write may touch: the model's own store, each related
 * store a relation callback writes to, and the parent stores that foreign-key
 * checks read, for the model and for each related model. An update also
 * declares the stores its `onUpdate` referential actions may touch.
 *
 * Parent stores are declared for every foreign key, not only the ones `data`
 * sets, because a nested write can set foreign keys through `connect()` or
 * through a default.
 */
function collectStoreNames(
  contract: IdbContract,
  modelName: string,
  data: Record<string, unknown>,
  kind: "create" | "update"
): string[] {
  const stores = new Set([getStoreName(contract, modelName), ...fkParentStoreNames(contract, modelName)]);
  const scalarData: Record<string, unknown> = {};
  const relationNames = new Set<string>();
  for (const def of getRelationDefinitions(contract, modelName)) {
    relationNames.add(def.relationName);
    if (def.relationName in data && isRelationMutationCallback(data[def.relationName])) {
      stores.add(def.relatedStoreName);
      for (const store of fkParentStoreNames(contract, def.relatedModelName)) stores.add(store);
    }
  }
  if (kind === "update") {
    for (const [field, value] of Object.entries(data)) {
      if (!relationNames.has(field)) scalarData[field] = value;
    }
    const patch = applyUpdateDefaults(
      contract.execution?.mutations.defaults,
      getStoreName(contract, modelName),
      scalarData,
      createMutationDefaultsCache()
    );
    for (const store of collectOnUpdateEnforcementStoreNames(contract, modelName, patch).storeNames) stores.add(store);
  }
  return [...stores];
}

/** The stores of every parent `modelName` has a foreign key to. */
function fkParentStoreNames(contract: IdbContract, modelName: string): string[] {
  return getRelationDefinitions(contract, modelName)
    .filter((def) => def.cardinality === "N:1")
    .map((def) => def.relatedStoreName);
}

// ── Graph operations ──────────────────────────────────────────────────────────

async function createGraph(
  scope: IdbTransactionScope,
  contract: IdbContract,
  modelName: string,
  input: Record<string, unknown>,
  defaultsCache: MutationDefaultsCache
): Promise<Record<string, unknown>> {
  const parsed = parseMutationInput(contract, modelName, input);
  const { parentOwned, childOwned } = partitionByOwnership(parsed.relationMutations);

  const scalarData = { ...parsed.scalarData };

  for (const item of parentOwned) {
    if (item.mutation.kind === "disconnect") {
      throw new Error("disconnect() is only supported in update() nested mutations");
    }
    await applyParentOwnedMutation(scope, contract, scalarData, item.relation, item.mutation, defaultsCache);
  }

  const parentRow = await insertSingleRow(scope, contract, modelName, scalarData, defaultsCache);

  for (const item of childOwned) {
    if (item.mutation.kind === "disconnect") {
      throw new Error("disconnect() is only supported in update() nested mutations");
    }
    await applyChildOwnedMutation(scope, contract, modelName, parentRow, item.relation, item.mutation, defaultsCache);
  }

  return parentRow;
}

async function updateFirstGraph(
  scope: IdbTransactionScope,
  contract: IdbContract,
  modelName: string,
  filters: readonly IdbFilterExpr[],
  input: Record<string, unknown>,
  defaultsCache: MutationDefaultsCache
): Promise<Record<string, unknown> | null> {
  const existingRow = await findFirstByFilters(scope, contract, modelName, filters);
  if (!existingRow) return null;

  const parsed = parseMutationInput(contract, modelName, input);
  const { parentOwned, childOwned } = partitionByOwnership(parsed.relationMutations);

  const scalarData = { ...parsed.scalarData };

  for (const item of parentOwned) {
    await applyParentOwnedMutation(scope, contract, scalarData, item.relation, item.mutation, defaultsCache);
  }

  let parentRow = existingRow;

  if (Object.keys(scalarData).length > 0) {
    const storeName = getStoreName(contract, modelName);
    const keyPath = getKeyPath(contract, modelName);
    const key = extractKeyFromRow(existingRow, keyPath);
    const meta = makePlanMeta(contract);
    const patch = applyUpdateDefaults(contract.execution?.mutations.defaults, storeName, scalarData, defaultsCache);
    assertEnumValues(contract, modelName, patch);
    await validateScalarFks(scope, contract, modelName, patch, existingRow);
    await applyReferentialActionsForRowOnUpdate(scope, contract, modelName, existingRow, patch);
    const rows = await scope.execute({ meta, kind: "update", storeName, key, patch });
    const updated = rows[0];
    if (updated) parentRow = updated;
  }

  for (const item of childOwned) {
    await applyChildOwnedMutation(scope, contract, modelName, parentRow, item.relation, item.mutation, defaultsCache);
  }

  return parentRow;
}

// ── Input parsing ─────────────────────────────────────────────────────────────

function parseMutationInput(
  contract: IdbContract,
  modelName: string,
  input: Record<string, unknown>
): ParsedMutationInput {
  const scalarData: Record<string, unknown> = {};
  const relationDefs = new Map(getRelationDefinitions(contract, modelName).map((r) => [r.relationName, r]));
  const relationMutations: ParsedRelationMutation[] = [];

  for (const [fieldName, value] of Object.entries(input)) {
    const relation = relationDefs.get(fieldName);
    if (!relation) {
      scalarData[fieldName] = value;
      continue;
    }

    if (!isRelationMutationCallback(value)) {
      throw new Error(`Relation field "${fieldName}" on model "${modelName}" expects a mutator callback`);
    }

    const mutator = createRelationMutator<IdbContract, string>();
    const mutation = value(mutator as IdbRelationMutator<IdbContract, string>);
    if (!isRelationMutationDescriptor(mutation)) {
      throw new Error(`Relation field "${fieldName}" on model "${modelName}" returned an invalid mutation descriptor`);
    }

    relationMutations.push({ relation, mutation });
  }

  return { scalarData, relationMutations };
}

// ── Ownership partitioning ────────────────────────────────────────────────────

function partitionByOwnership(mutations: readonly ParsedRelationMutation[]): {
  parentOwned: ParsedRelationMutation[];
  childOwned: ParsedRelationMutation[];
} {
  const parentOwned: ParsedRelationMutation[] = [];
  const childOwned: ParsedRelationMutation[] = [];

  for (const item of mutations) {
    if (item.relation.cardinality === "N:1") {
      parentOwned.push(item);
      continue;
    }
    if (item.relation.cardinality === "M:N") {
      throw new Error("M:N nested mutations are not supported");
    }
    childOwned.push(item);
  }

  return { parentOwned, childOwned };
}

// ── Parent-owned (N:1) mutations ──────────────────────────────────────────────

async function applyParentOwnedMutation(
  scope: IdbTransactionScope,
  contract: IdbContract,
  scalarData: Record<string, unknown>,
  relation: RelationDefinition,
  mutation: IdbRelationMutation<IdbContract, string>,
  defaultsCache: MutationDefaultsCache
): Promise<void> {
  if (mutation.kind === "disconnect") {
    for (const localField of relation.localFields) {
      scalarData[localField] = null;
    }
    return;
  }

  if (mutation.kind === "create") {
    const row = mutation.data[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`create() nested mutation for relation "${relation.relationName}" requires data`);
    }
    // Recursive nesting is not supported in Phase 6.4 — the nested record must
    // be a plain scalar create, not itself a nested mutation.
    const relatedRow = await insertSingleRow(scope, contract, relation.relatedModelName, row, defaultsCache);
    copyRelatedValuesToParent(relation, scalarData, relatedRow);
    return;
  }

  // connect()
  const criterion = mutation.criteria[0] as Record<string, unknown> | undefined;
  if (!criterion) {
    throw new Error(`connect() nested mutation for relation "${relation.relationName}" requires a criterion`);
  }
  const relatedRow = await findRowByCriterion(scope, contract, relation.relatedModelName, criterion);
  if (!relatedRow) {
    throw new Error(`connect() nested mutation for relation "${relation.relationName}" did not find a matching row`);
  }
  copyRelatedValuesToParent(relation, scalarData, relatedRow);
}

function copyRelatedValuesToParent(
  relation: RelationDefinition,
  scalarData: Record<string, unknown>,
  relatedRow: Record<string, unknown>
): void {
  // localFields = parent's FK fields; targetFields = related model's PK/unique fields
  for (let i = 0; i < relation.localFields.length; i++) {
    const localField = relation.localFields[i];
    const targetField = relation.targetFields[i];
    if (!localField || !targetField) continue;
    scalarData[localField] = relatedRow[targetField];
  }
}

// ── Child-owned (1:N / 1:1) mutations ────────────────────────────────────────

async function applyChildOwnedMutation(
  scope: IdbTransactionScope,
  contract: IdbContract,
  parentModelName: string,
  parentRow: Record<string, unknown>,
  relation: RelationDefinition,
  mutation: IdbRelationMutation<IdbContract, string>,
  defaultsCache: MutationDefaultsCache
): Promise<void> {
  // parentValues: childFkField → parentPkValue (e.g. "authorId" → "u1")
  const parentValues = readParentColumnValues(parentModelName, relation, parentRow);

  if (mutation.kind === "create") {
    for (const childInput of mutation.data) {
      const payload: Record<string, unknown> = { ...(childInput as Record<string, unknown>) };
      for (const [childField, parentValue] of parentValues.entries()) {
        payload[childField] = parentValue;
      }
      await insertSingleRow(scope, contract, relation.relatedModelName, payload, defaultsCache);
    }
    return;
  }

  if (mutation.kind === "connect") {
    for (const criterion of mutation.criteria) {
      const setValues: Record<string, unknown> = {};
      for (const [childField, parentValue] of parentValues.entries()) {
        setValues[childField] = parentValue;
      }
      const patch = applyUpdateDefaults(
        contract.execution?.mutations.defaults,
        relation.relatedStoreName,
        setValues,
        defaultsCache
      );
      const where = shorthandToFilterExpr(criterion as Record<string, unknown>);
      // scan-write + put-merged: set the FK fields on every child row matching
      // the criterion. No `take` cap — the vendor's relational connect
      // (`executeUpdateCount`) connects all matching rows; for the normal
      // unique-key criterion that is exactly one row anyway. (PLAN Issue #24.)
      await writeMutationRows(scope, contract, relation.relatedModelName, {
        write: "put-merged",
        patch,
        ...(where === undefined ? {} : { where }),
      });
    }
    return;
  }

  // disconnect()
  const setValues: Record<string, unknown> = {};
  for (const childField of parentValues.keys()) {
    setValues[childField] = null;
  }

  if (!mutation.criteria || mutation.criteria.length === 0) {
    // Disconnect all children of this parent.
    const patch = applyUpdateDefaults(
      contract.execution?.mutations.defaults,
      relation.relatedStoreName,
      setValues,
      defaultsCache
    );
    const parentJoinWhere = buildParentJoinWhere(parentValues);
    await writeMutationRows(scope, contract, relation.relatedModelName, {
      write: "put-merged",
      patch,
      where: parentJoinWhere,
    });
    return;
  }

  // Disconnect specific children matching each criterion AND the parent join.
  for (const criterion of mutation.criteria) {
    const patch = applyUpdateDefaults(
      contract.execution?.mutations.defaults,
      relation.relatedStoreName,
      setValues,
      defaultsCache
    );
    const criterionWhere = shorthandToFilterExpr(criterion as Record<string, unknown>);
    const parentJoinWhere = buildParentJoinWhere(parentValues);
    const where = criterionWhere === undefined ? parentJoinWhere : andExpr([parentJoinWhere, criterionWhere]);
    await writeMutationRows(scope, contract, relation.relatedModelName, {
      write: "put-merged",
      patch,
      where,
    });
  }
}

function readParentColumnValues(
  parentModelName: string,
  relation: RelationDefinition,
  parentRow: Record<string, unknown>
): Map<string, unknown> {
  const values = new Map<string, unknown>();
  // For 1:N: localFields = parent PK fields; targetFields = child FK fields
  for (let i = 0; i < relation.localFields.length; i++) {
    const localField = relation.localFields[i];
    const targetField = relation.targetFields[i];
    if (!localField || !targetField) continue;
    const parentValue = parentRow[localField];
    if (parentValue === undefined) {
      throw new Error(
        `Nested mutation requires parent field "${localField}" to be present in "${parentModelName}" row`
      );
    }
    // targetField is the child's FK column name; map it to the parent's value.
    values.set(targetField, parentValue);
  }
  return values;
}

// ── Row operations ────────────────────────────────────────────────────────────

async function insertSingleRow(
  scope: IdbTransactionScope,
  contract: IdbContract,
  modelName: string,
  data: Record<string, unknown>,
  defaultsCache: MutationDefaultsCache
): Promise<Record<string, unknown>> {
  assertNoNestedCallbacks(modelName, data);
  const storeName = getStoreName(contract, modelName);
  const meta = makePlanMeta(contract);
  const record = applyCreateDefaults(contract.execution?.mutations.defaults, storeName, data, defaultsCache);
  assertEnumValues(contract, modelName, record);
  await validateScalarFks(scope, contract, modelName, record);
  const rows = await scope.execute({ meta, kind: "add", storeName, record });
  return rows[0] ?? record;
}

/**
 * Recursive nesting (a relation callback inside an already-nested create) is
 * not supported in Phase 6.4. Without this guard the callback function would be
 * handed to `store.put(...)`, where IDB's structured-clone throws an opaque
 * `DataCloneError` ("could not be cloned") that gives the developer no hint
 * about the real cause. Surface a precise error instead. (PLAN Issue #22.)
 */
function assertNoNestedCallbacks(modelName: string, data: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(data)) {
    if (typeof value === "function") {
      throw new Error(
        `Recursive nested writes are not supported: field "${field}" on a nested "${modelName}" ` +
          "record is a relation callback. Only one level of relation nesting is supported — " +
          "flatten the inner relation into a separate create/connect call."
      );
    }
  }
}

async function findRowByCriterion(
  scope: IdbTransactionScope,
  contract: IdbContract,
  modelName: string,
  criterion: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  const expr = shorthandToFilterExpr(criterion);
  if (!expr) {
    throw new Error(`Nested connect for model "${modelName}" requires a non-empty criterion`);
  }
  return (await readMutationRows(scope, contract, modelName, expr, 1))[0] ?? null;
}

async function findFirstByFilters(
  scope: IdbTransactionScope,
  contract: IdbContract,
  modelName: string,
  filters: readonly IdbFilterExpr[]
): Promise<Record<string, unknown> | null> {
  if (filters.length === 0) return null;
  return (await readMutationRows(scope, contract, modelName, andExpr(filters), 1))[0] ?? null;
}

/** Execute lowered atomic operations without leaving the transaction's microtask chain. */
export async function executeMutationPlan(
  scope: IdbTransactionScope,
  plan: IdbPlanBody
): Promise<Record<string, unknown>[]> {
  const plans = plan.kind === "batch" ? plan.ops : [plan];
  const rows: Record<string, unknown>[] = [];
  for (const op of plans) rows.push(...(await scope.execute(op)));
  return rows;
}

/** Read mutation preimages through the planner, then reapply the original filter. */
export async function readMutationRows(
  scope: IdbTransactionScope,
  contract: IdbContract,
  modelName: string,
  where: IdbFilterExpr | undefined,
  take?: number
): Promise<Record<string, unknown>[]> {
  const catalog = buildCatalog(contract, getStoreName(contract, modelName));
  const request = { ...(where === undefined ? {} : { where }), ...(take === undefined ? {} : { take }) };
  const lowered = lowerRows(catalog, planQuery(catalog, request), makePlanMeta(contract), request);
  return lowered.finish(await executeMutationPlan(scope, lowered.idbPlan));
}

async function writeMutationRows(
  scope: IdbTransactionScope,
  contract: IdbContract,
  modelName: string,
  request: WriteRequest
): Promise<Record<string, unknown>[]> {
  const catalog = buildCatalog(contract, getStoreName(contract, modelName));
  const meta = makePlanMeta(contract);
  const lowered = lowerWrite(catalog, planQuery(catalog, request), meta, request);
  if (lowered.kind === "scan") return executeMutationPlan(scope, lowered.idbPlan);

  // Materialize all ranges before writing: moving a key could otherwise make
  // an already-written row enter a range we have not visited yet.
  const oldRows = lowered.rows.finish(await executeMutationPlan(scope, lowered.rows.idbPlan));
  const results: Record<string, unknown>[] = [];
  for (const row of oldRows) {
    const key = extractKeyFromRow(row, catalog.primaryKey.keyPath);
    const rows = await scope.execute({
      meta,
      storeName: catalog.storeName,
      ...(request.write === "delete" ? { kind: "delete", key } : { kind: "update", key, patch: request.patch ?? {} }),
    });
    results.push(...rows);
  }
  return results;
}

function buildParentJoinWhere(parentValues: Map<string, unknown>): IdbFilterExpr {
  return andExpr([...parentValues].map(([field, value]) => fieldFilter(field, "eq", value)));
}

// ── Referential action helpers ────────────────────────────────────────────────

/**
 * Which referential-action slot to read from `IdbRelationStorage`. Shared by
 * `onDelete` enforcement (delete/deleteAll/deleteCount) and `onUpdate`
 * enforcement (update/updateAll/updateCount/upsert) — both actions are
 * declared and resolved identically, just stored under a different key.
 */
type ReferentialActionKind = "onDelete" | "onUpdate";

function getStoredAction(
  contract: IdbContract,
  modelName: string,
  relationName: string,
  kind: ReferentialActionKind
): IdbReferentialAction | undefined {
  const model = domainModelsAtDefaultNamespace(contract.domain)[modelName];
  const storage = model?.storage as
    { relations?: Record<string, { onDelete?: string; onUpdate?: string }> } | undefined;
  return storage?.relations?.[relationName]?.[kind] as IdbReferentialAction | undefined;
}

function sameFields(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((field, index) => field === b[index]);
}

/**
 * Resolves the referential action for a child-enforcement relation: prefers
 * the action stored directly on this side, falls back to the same action
 * stored on the inverse (FK-owning) side of the relation, and finally to
 * `defaultAction` when neither side declares one.
 *
 * Both branches are live, for different authoring paths. PSL only ever
 * stores the action on the `N:1` (FK-owning) side — enforcement always walks
 * from the parent (`1:N`/non-owning-`1:1`) side, which PSL leaves bare, so
 * the fallback is what actually finds it. TS-DSL relation entries are
 * self-contained (no PSL-style pairing requirement) and typically declare
 * the action directly on the side this function is called for, so the direct
 * check is what fires there — see `contract-builder.ts`'s
 * `validateNoConflictingRelationActions`, which rejects declaring the same
 * action kind on both sides so this fallback never has to arbitrate a real
 * conflict.
 */
function getReferentialActionForRelation(
  contract: IdbContract,
  modelName: string,
  def: RelationDefinition,
  kind: ReferentialActionKind
): EnforcedReferentialAction {
  return enforcedAction(findDeclaredAction(contract, modelName, def, kind));
}

function findDeclaredAction(
  contract: IdbContract,
  modelName: string,
  def: RelationDefinition,
  kind: ReferentialActionKind
): IdbReferentialAction | undefined {
  const direct = getStoredAction(contract, modelName, def.relationName, kind);
  if (direct !== undefined) return direct;

  for (const inverse of getRelationDefinitions(contract, def.relatedModelName)) {
    if (inverse.relatedModelName !== modelName) continue;
    if (!sameFields(inverse.localFields, def.targetFields)) continue;
    if (!sameFields(inverse.targetFields, def.localFields)) continue;

    const inverseAction = getStoredAction(contract, def.relatedModelName, inverse.relationName, kind);
    if (inverseAction !== undefined) return inverseAction;
  }

  return undefined;
}

/** A referential action after defaults are applied and `noAction` is resolved. */
type EnforcedReferentialAction = Exclude<IdbReferentialAction, "noAction">;

/**
 * Applies the default and resolves `noAction`, matching what Postgres does
 * with the same schema, so a synced app behaves the same on both sides:
 *
 * - An undeclared action defaults to `restrict`, for `onDelete` and
 *   `onUpdate` alike. Prisma 8 emits no `ON DELETE`/`ON UPDATE` clause for an
 *   undeclared action, and the database default is `NO ACTION`.
 * - `noAction` behaves like `restrict`. In SQL, `NO ACTION` also rejects the
 *   change; it only defers the check to the end of the statement, which makes
 *   no difference here.
 */
function enforcedAction(declared: IdbReferentialAction | undefined): EnforcedReferentialAction {
  return declared === undefined || declared === "noAction" ? "restrict" : declared;
}

function isChildEnforcementRelation(contract: IdbContract, modelName: string, def: RelationDefinition): boolean {
  if (def.cardinality === "1:N") return true;
  if (def.cardinality === "1:1") {
    // Shared-PK 1:1: the non-owning side is the one whose *own* primary key
    // IS the FK (localFields === the model's own keyPath, field-for-field,
    // in order — a compound key must match the whole ordered field list, not
    // just its first member).
    const keyPath = getKeyPath(contract, modelName);
    return sameFields(def.localFields, keyPathFields(keyPath));
  }
  return false;
}

// ── Existence lookups ─────────────────────────────────────────────────────────

/**
 * `true` if any child row matches the relation against `parentRow`'s values —
 * the existence check behind `restrict`. A null value references no child.
 */
async function childExists(
  scope: IdbTransactionScope,
  contract: IdbContract,
  meta: PlanMeta,
  def: RelationDefinition,
  parentRow: Record<string, unknown>
): Promise<boolean> {
  const values = def.localFields.map((field) => parentRow[field]);
  if (values.some((value) => value === null || value === undefined)) return false;
  return rowExists(scope, contract, meta, def.relatedStoreName, def.targetFields, values);
}

/**
 * Does `storeName` have a row whose `fields` equal `values`, pairwise?
 * Compares values the way IndexedDB compares keys. `additionalFilter` narrows
 * the match in memory; it makes the check read rows instead of keys.
 */
async function rowExists(
  scope: IdbTransactionScope,
  contract: IdbContract,
  meta: PlanMeta,
  storeName: string,
  fields: readonly string[],
  values: readonly unknown[],
  additionalFilter?: IdbRowFilter
): Promise<boolean> {
  const where = andExpr(fields.map((field, i) => fieldFilter(field, "eq", values[i])));
  const catalog = buildCatalog(contract, storeName);
  const lowered = lowerExists(catalog, planQuery(catalog, { where }), meta, { where }, additionalFilter);
  // The scope runs atomic plans only. Each `await` here resolves in a
  // microtask, so the transaction stays open between the requests.
  return lowered.finish(await executeMutationPlan(scope, lowered.idbPlan));
}

/**
 * Builds a filter matching a relation's children against one specific parent
 * row's values. Shared by `onDelete` cascade (`applyReferentialActionsForRow`)
 * and `onUpdate` cascade (`applyReferentialActionsForRowOnUpdate`).
 */
function buildChildWhereFromRow(def: RelationDefinition, row: Record<string, unknown>): IdbFilterExpr {
  return andExpr(def.targetFields.map((field, i) => fieldFilter(field, "eq", row[def.localFields[i]!])));
}

/** Reads a field's literal `@default(...)` value from `IdbModelStorage.fieldDefaults`, if declared. */
function getFieldDefault(contract: IdbContract, modelName: string, fieldName: string): unknown {
  const model = domainModelsAtDefaultNamespace(contract.domain)[modelName];
  const storage = model?.storage as { fieldDefaults?: Record<string, unknown> } | undefined;
  return storage?.fieldDefaults?.[fieldName];
}

/**
 * Builds the patch for a `setDefault` referential action: each of the
 * relation's `targetFields` (the child's FK fields) reset to its own
 * declared literal default — not the parent's. Throws when any target field
 * has no declared default; `setDefault` is only meaningful when every FK
 * field it resets has somewhere to reset to.
 */
function buildSetDefaultPatch(contract: IdbContract, def: RelationDefinition): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const targetField of def.targetFields) {
    const value = getFieldDefault(contract, def.relatedModelName, targetField);
    if (value === undefined) {
      throw new Error(
        `setDefault referential action on relation '${def.relationName}' requires field ` +
          `'${def.relatedModelName}.${targetField}' to declare a literal @default(...) value — ` +
          "no default is registered for that field."
      );
    }
    patch[targetField] = value;
  }
  return patch;
}

/**
 * Validates that a `setDefault` patch actually references a real row before
 * it's written — without this, `setDefault` would silently reintroduce the
 * exact dangling-FK problem the rest of this file exists to prevent. A real
 * SQL database only makes `SET DEFAULT` safe because its FK constraint
 * re-checks the new value transactionally at write time; IDB has no such
 * engine to delegate to, so this check is IDB's equivalent.
 *
 * Checks against `modelName`'s own store (the parent being deleted/updated)
 * using `def.localFields` — the relation's own semantics ("child.targetField
 * references parent.localField") mean that's exactly what a default value
 * written to the child's FK field must match. That store is always already
 * part of the transaction (it's the model literally being written), so no
 * store-list changes are needed to call this.
 *
 * A compound relation is checked as one tuple: a single parent row must
 * match every field's default.
 *
 * `excludeKey`, when given, excludes the parent row currently being
 * deleted/updated from the existence scan. That row is still physically
 * present in the store at this point (its own write/delete hasn't happened
 * yet — this check runs first, before the enforcement loop's caller applies
 * it), so without the exclusion, a default value equal to that row's *old*
 * `localField` value would false-positive: the scan would find the row about
 * to disappear (or change away from that value) and wrongly conclude the
 * default references a real row, when after the transaction nothing will.
 */
async function validateSetDefaultPatch(
  scope: IdbTransactionScope,
  contract: IdbContract,
  modelName: string,
  def: RelationDefinition,
  patch: Record<string, unknown>,
  excludeKey?: IDBValidKey
): Promise<void> {
  const values = def.targetFields.map((f) => patch[f]);
  // A default of null leaves no reference to check.
  if (values.some((v) => v === null || v === undefined)) return;

  const meta = makePlanMeta(contract);
  const exists = await parentExists(scope, contract, meta, modelName, def.localFields, values, excludeKey);
  if (!exists) {
    throw new Error(
      `setDefault referential action on relation '${def.relationName}' would set ` +
        `${def.relatedModelName} to ${describeTuple(def.targetFields, values)}, but no ${modelName} with ` +
        `${describeTuple(def.localFields, values)} exists — the declared default does not reference a real row.`
    );
  }
}

// ── Update referential action enforcement ─────────────────────────────────────

/**
 * Collects every store an `onUpdate`-enforced write to `modelName` might
 * touch: the model's own store, plus the related store of any 1:N/1:1-
 * parent-side relation whose `localFields` appear in the raw patch —
 * pessimistic (checks field *presence*, not whether the resolved value will
 * actually change, since the current row isn't read yet when this runs).
 * Once a `cascade` edge is entered, the walk continues transitively (mirrors
 * `collectDeleteStoreNames`'s cascade-only recursion), since a propagated
 * value change may itself need to cascade further.
 *
 * Returns `enforces: false` when no `onUpdate` enforcement can apply to this
 * write — callers use that to keep the existing fast blind-write path
 * instead of paying for a read-before-write. This is tracked as an explicit
 * flag rather than inferred from `storeNames.length > 1`: for a
 * self-referential relation, `def.relatedStoreName` equals `modelName`'s own
 * store (already the seed of the `Set`), so the store count alone can't tell
 * "no enforcement" apart from "enforces, but only against this same store".
 */
export function collectOnUpdateEnforcementStoreNames(
  contract: IdbContract,
  modelName: string,
  data: Record<string, unknown>
): { storeNames: string[]; enforces: boolean } {
  const stores = new Set([getStoreName(contract, modelName)]);
  const visitedModels = new Set<string>();
  let enforces = false;

  function walkCascadeChain(mName: string): void {
    if (visitedModels.has(mName)) return;
    visitedModels.add(mName);
    for (const def of getRelationDefinitions(contract, mName)) {
      if (!isChildEnforcementRelation(contract, mName, def)) continue;
      const action = getReferentialActionForRelation(contract, mName, def, "onUpdate");
      stores.add(def.relatedStoreName);
      if (action === "cascade") walkCascadeChain(def.relatedModelName);
    }
  }

  visitedModels.add(modelName);
  for (const def of getRelationDefinitions(contract, modelName)) {
    if (!isChildEnforcementRelation(contract, modelName, def)) continue;
    if (!def.localFields.some((f) => f in data)) continue;
    const action = getReferentialActionForRelation(contract, modelName, def, "onUpdate");
    enforces = true;
    stores.add(def.relatedStoreName);
    if (action === "cascade") walkCascadeChain(def.relatedModelName);
  }

  return { storeNames: [...stores], enforces };
}

/**
 * Enforces every `onUpdate` action declared on `modelName`'s child relations
 * against one specific `oldRow` about to be patched with `patch`. Only
 * relations whose `localFields` are both present in `patch` and differ from
 * `oldRow`'s current value are enforced — a patch that sets a field to its
 * existing value, or never touches a locally-referenced field, is a no-op
 * here. Children are matched against `oldRow`'s pre-change values.
 *
 * `cascade` propagates the new value(s) onto the matched children's FK
 * fields and recurses into each child's own `onUpdate` relations before
 * writing (the propagated change may itself need to cascade further) —
 * mirrors `applyReferentialActionsForRow`'s recursive shape, including the
 * `visited` row-level cycle guard (see that function's doc comment for the
 * fresh-per-top-level-row / shared-across-one-row's-descent contract).
 * `setNull`/`setDefault` are leaf actions: the child's FK field changes but
 * its own key doesn't, so nothing below it needs re-enforcement.
 *
 * Compound relations use values from the same `oldRow`/`patch`, so every
 * child is matched against the full pre-change tuple.
 */
export async function applyReferentialActionsForRowOnUpdate(
  scope: IdbTransactionScope,
  contract: IdbContract,
  modelName: string,
  oldRow: Record<string, unknown>,
  patch: Record<string, unknown>,
  visited: Set<string> = new Set()
): Promise<void> {
  const keyPath = getKeyPath(contract, modelName);
  const rowKey = `${getStoreName(contract, modelName)}::${keyToken(extractKeyFromRow(oldRow, keyPath))}`;
  if (visited.has(rowKey)) return;
  visited.add(rowKey);

  const meta = makePlanMeta(contract);
  for (const def of getRelationDefinitions(contract, modelName)) {
    if (!isChildEnforcementRelation(contract, modelName, def)) continue;
    const changedFields = def.localFields.filter((f) => f in patch && !fieldValuesEqual(patch[f], oldRow[f]));
    if (changedFields.length === 0) continue;

    const action = getReferentialActionForRelation(contract, modelName, def, "onUpdate");

    const childWhere = buildChildWhereFromRow(def, oldRow);

    if (action === "restrict") {
      if (await childExists(scope, contract, meta, def, oldRow)) {
        throw new Error(
          `Cannot update ${modelName} '${keyToken(extractKeyFromRow(oldRow, keyPath))}': changing field(s) ${changedFields.join(", ")} ` +
            `would orphan child records on relation '${def.relationName}'. ` +
            "Update or remove those children first, or declare onUpdate: Cascade, SetNull or SetDefault on the relation."
        );
      }
      continue;
    }

    if (action === "cascade") {
      const childPatch: Record<string, unknown> = {};
      for (let i = 0; i < def.localFields.length; i++) {
        const lf = def.localFields[i]!;
        const tf = def.targetFields[i]!;
        if (changedFields.includes(lf)) childPatch[tf] = patch[lf];
      }
      const children = await readMutationRows(scope, contract, def.relatedModelName, childWhere);
      for (const child of children) {
        await applyReferentialActionsForRowOnUpdate(scope, contract, def.relatedModelName, child, childPatch, visited);
      }
      await writeMutationRows(scope, contract, def.relatedModelName, {
        write: "put-merged",
        patch: childPatch,
        where: childWhere,
      });
      continue;
    }

    if (action === "setNull") {
      const childPatch: Record<string, unknown> = {};
      for (const targetField of def.targetFields) childPatch[targetField] = null;
      await writeMutationRows(scope, contract, def.relatedModelName, {
        write: "put-merged",
        patch: childPatch,
        where: childWhere,
      });
      continue;
    }

    if (action === "setDefault") {
      const childPatch = buildSetDefaultPatch(contract, def);
      await validateSetDefaultPatch(scope, contract, modelName, def, childPatch, extractKeyFromRow(oldRow, keyPath));
      await writeMutationRows(scope, contract, def.relatedModelName, {
        write: "put-merged",
        patch: childPatch,
        where: childWhere,
      });
      continue;
    }
  }
}

// ── Scalar FK validation ──────────────────────────────────────────────────────

/**
 * Returns true if `data` contains at least one non-null value for a localField
 * of a N:1 relation — indicating scalar FK fields that need existence validation.
 */
export function hasScalarFkFields(contract: IdbContract, modelName: string, data: Record<string, unknown>): boolean {
  for (const def of getRelationDefinitions(contract, modelName)) {
    if (def.cardinality !== "N:1") continue;
    for (const localField of def.localFields) {
      if (localField in data && data[localField] !== null && data[localField] !== undefined) return true;
    }
  }
  return false;
}

export function collectScalarFkStoreNames(
  contract: IdbContract,
  modelName: string,
  data: Record<string, unknown>
): string[] {
  const stores = new Set([getStoreName(contract, modelName)]);
  for (const def of getRelationDefinitions(contract, modelName)) {
    if (def.cardinality !== "N:1") continue;
    const hasFkField = def.localFields.some((f) => f in data && data[f] !== null && data[f] !== undefined);
    if (hasFkField) stores.add(def.relatedStoreName);
  }
  return [...stores];
}

/**
 * Checks that every foreign key `data` sets points at an existing parent row,
 * inside the write's transaction.
 *
 * A compound foreign key is checked as one tuple: a single parent row must
 * match every field. Checking the fields one at a time could pass with each
 * value taken from a different parent. When `data` sets only some fields of a
 * compound key, the rest come from `existingRow`, the row being updated.
 * Callers must pass it in that case; see {@link fkCheckNeedsExistingRow}.
 *
 * A key with any `null` field isn't checked, like SQL's default `MATCH SIMPLE`.
 */
export async function validateScalarFks(
  scope: IdbTransactionScope,
  contract: IdbContract,
  modelName: string,
  data: Record<string, unknown>,
  existingRow?: Record<string, unknown>
): Promise<void> {
  const meta = makePlanMeta(contract);
  for (const def of getRelationDefinitions(contract, modelName)) {
    if (def.cardinality !== "N:1") continue;
    if (!def.localFields.some((f) => f in data)) continue;
    const values = def.localFields.map((f) => (f in data ? data[f] : existingRow?.[f]));
    if (values.some((v) => v === null || v === undefined)) continue;

    const exists = await parentExists(scope, contract, meta, def.relatedModelName, def.targetFields, values);
    if (!exists) {
      throw new Error(
        `FK violation on relation '${def.relationName}': no ${def.relatedModelName} with ${describeTuple(def.targetFields, values)}`
      );
    }
  }
}

/**
 * `true` when `data` sets some, but not all, fields of a compound foreign
 * key. Checking it then needs the rest of the key from the row being
 * updated, so the update has to read each row before writing it.
 */
function fkCheckNeedsExistingRow(contract: IdbContract, modelName: string, data: Record<string, unknown>): boolean {
  return getRelationDefinitions(contract, modelName).some((def) => {
    if (def.cardinality !== "N:1") return false;
    const set = def.localFields.filter((f) => f in data).length;
    return set > 0 && set < def.localFields.length;
  });
}

/**
 * Does `parentModel` have a row whose `fields` equal `values`, pairwise?
 *
 * `excludeKey` leaves out one parent row, for checks that run while that row
 * is being deleted or changed.
 */
async function parentExists(
  scope: IdbTransactionScope,
  contract: IdbContract,
  meta: PlanMeta,
  parentModel: string,
  fields: readonly string[],
  values: readonly unknown[],
  excludeKey?: IDBValidKey
): Promise<boolean> {
  const storeName = getStoreName(contract, parentModel);
  const keyPath = getKeyPath(contract, parentModel);
  const notExcluded =
    excludeKey === undefined
      ? undefined
      : (row: Record<string, unknown>): boolean => !keyEquals(extractKeyFromRow(row, keyPath), excludeKey);
  return rowExists(scope, contract, meta, storeName, fields, values, notExcluded);
}

/** `id='u1'`, or `orgId='a', id='u1'` for a compound key. */
function describeTuple(fields: readonly string[], values: readonly unknown[]): string {
  return fields.map((f, i) => `${f}='${String(values[i])}'`).join(", ");
}

export async function executeScalarCreateWithFkValidation(options: {
  executor: IdbQueryExecutorWithTransaction;
  contract: IdbContract;
  modelName: string;
  data: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const { executor, contract, modelName, data } = options;
  // Apply defaults first, so the transaction declares the parent store of a
  // foreign key that a default fills in. `insertSingleRow` checks the result.
  const defaultsCache = createMutationDefaultsCache();
  const record = applyCreateDefaults(
    contract.execution?.mutations.defaults,
    getStoreName(contract, modelName),
    data,
    defaultsCache
  );
  const storeNames = collectScalarFkStoreNames(contract, modelName, record);
  return withMutationScope(executor, storeNames, (scope) =>
    insertSingleRow(scope, contract, modelName, record, defaultsCache)
  );
}

/**
 * `createAll()` for rows that set foreign keys: checks every row's foreign
 * keys and inserts it, all in one transaction, so one bad row writes nothing.
 * The batch shares one defaults cache, like the plain `createAll()` path.
 */
export async function executeScalarCreateAllWithFkValidation(options: {
  executor: IdbQueryExecutorWithTransaction;
  contract: IdbContract;
  modelName: string;
  data: readonly Record<string, unknown>[];
}): Promise<Record<string, unknown>[]> {
  const { executor, contract, modelName, data } = options;
  const defaultsCache = createMutationDefaultsCache();
  const storeName = getStoreName(contract, modelName);
  const records = data.map((row) =>
    applyCreateDefaults(contract.execution?.mutations.defaults, storeName, row, defaultsCache)
  );
  const storeNames = [...new Set(records.flatMap((row) => collectScalarFkStoreNames(contract, modelName, row)))];
  return withMutationScope(executor, storeNames, async (scope) => {
    const inserted: Record<string, unknown>[] = [];
    for (const record of records) {
      inserted.push(await insertSingleRow(scope, contract, modelName, record, defaultsCache));
    }
    return inserted;
  });
}

/**
 * Combines FK-existence store scope (this model's own N:1 relations) with
 * `onUpdate` enforcement store scope (this model's child relations) for a
 * single write. Returns the union alongside whether `onUpdate` enforcement
 * actually applies, including self-relations that touch only this model's
 * own store. Callers use that flag to choose between the existing
 * fast blind-write path and the read-before-write enforcement path.
 */
function collectUpdateStoreNames(
  contract: IdbContract,
  modelName: string,
  data: Record<string, unknown>
): { storeNames: string[]; enforcesOnUpdate: boolean } {
  const fkStoreNames = collectScalarFkStoreNames(contract, modelName, data);
  const { storeNames: onUpdateStoreNames, enforces } = collectOnUpdateEnforcementStoreNames(contract, modelName, data);
  return {
    storeNames: [...new Set([...fkStoreNames, ...onUpdateStoreNames])],
    enforcesOnUpdate: enforces,
  };
}

interface ScalarUpdateOptions {
  readonly executor: IdbQueryExecutorWithTransaction;
  readonly contract: IdbContract;
  readonly modelName: string;
  readonly filters: readonly IdbFilterExpr[];
  readonly data: Record<string, unknown>;
}

/** Updates the first matching row with FK validation and referential actions. */
export async function executeScalarUpdateWithFkValidation(
  options: ScalarUpdateOptions
): Promise<Record<string, unknown> | null> {
  const rows = await executeScalarUpdates(options, 1);
  return rows[0] ?? null;
}

/**
 * Bulk counterpart to {@link executeScalarUpdateWithFkValidation}: same FK
 * validation and `onUpdate` enforcement, but applies the patch to every row
 * the filter matches (no `take: 1`) and returns all of them.
 *
 * The transaction scope lets the sync interceptor observe the affected rows
 * and write one outbox event per row in the same transaction. A bulk write's
 * affected keys are only known after it runs, so tracking cannot happen by
 * extending the plan before execution.
 */
export async function executeBulkUpdateWithFkValidation(
  options: ScalarUpdateOptions
): Promise<Record<string, unknown>[]> {
  return executeScalarUpdates(options);
}

/** Shares validation and atomic writes; only single-row updates limit the scan. */
async function executeScalarUpdates(options: ScalarUpdateOptions, take?: 1): Promise<Record<string, unknown>[]> {
  const { executor, contract, modelName, filters, data } = options;
  const storeName = getStoreName(contract, modelName);
  // Apply defaults first, so the checks and the store list see every field
  // the write sets, including one an `onUpdate` default fills in.
  const patch = applyUpdateDefaults(
    contract.execution?.mutations.defaults,
    storeName,
    data,
    createMutationDefaultsCache()
  );
  assertEnumValues(contract, modelName, patch);
  const { storeNames, enforcesOnUpdate } = collectUpdateStoreNames(contract, modelName, patch);
  const needsRowForFks = fkCheckNeedsExistingRow(contract, modelName, patch);
  return withMutationScope(executor, storeNames, async (scope) => {
    if (!needsRowForFks) await validateScalarFks(scope, contract, modelName, patch);
    const meta = makePlanMeta(contract);
    const where = filters.length === 0 ? undefined : andExpr(filters);
    if (!enforcesOnUpdate && !needsRowForFks) {
      return writeMutationRows(scope, contract, modelName, {
        write: "put-merged",
        patch,
        ...(take === undefined ? {} : { take }),
        ...(where === undefined ? {} : { where }),
      });
    }

    // Enforcement needs the preimage for changed referenced fields and for
    // compound foreign keys whose other fields are absent from the patch.
    const oldRows = await readMutationRows(scope, contract, modelName, where, take);
    const keyPath = getKeyPath(contract, modelName);
    const results: Record<string, unknown>[] = [];
    for (const oldRow of oldRows) {
      if (needsRowForFks) await validateScalarFks(scope, contract, modelName, patch, oldRow);
      if (enforcesOnUpdate) await applyReferentialActionsForRowOnUpdate(scope, contract, modelName, oldRow, patch);
      const key = extractKeyFromRow(oldRow, keyPath);
      const rows = await scope.execute({ meta, kind: "update", storeName, key, patch } as IdbAtomicPlan);
      const updated = rows[0];
      if (updated) results.push(updated);
    }
    return results;
  });
}

// ── Delete referential action enforcement ─────────────────────────────────────

/**
 * Returns true if the model has at least one child relation (1:N or parent-side
 * 1:1). Every such relation has an `onDelete` action to enforce: `noAction`
 * behaves like `restrict`, which is also the default.
 */
export function hasEnforceableChildRelations(contract: IdbContract, modelName: string): boolean {
  return getRelationDefinitions(contract, modelName).some((def) =>
    isChildEnforcementRelation(contract, modelName, def)
  );
}

/** The store of `modelName` plus the store of every model it has a relation to, in either direction. */
export function collectRelatedStoreNames(contract: IdbContract, modelName: string): string[] {
  const stores = new Set([getStoreName(contract, modelName)]);
  for (const def of getRelationDefinitions(contract, modelName)) stores.add(def.relatedStoreName);
  return [...stores];
}

/**
 * Transitively walks the `onDelete` cascade graph from `modelName`, collecting
 * every store a recursive delete might touch. `cascade` edges are walked
 * further (a cascaded child's own children may themselves cascade);
 * `restrict`/`setNull`/`setDefault` edges still need their store added (each
 * is read or written once) but don't recurse further, since none of them
 * delete the child row. Guarded by a model-level visited set — required
 * because IDB must declare every store a transaction might touch before it
 * opens, so this static walk must terminate even on a self-referential model
 * or a cycle of mutually-cascading models.
 */
export function collectDeleteStoreNames(contract: IdbContract, modelName: string): string[] {
  const stores = new Set<string>();
  const visitedModels = new Set<string>();

  function walk(mName: string): void {
    if (visitedModels.has(mName)) return;
    visitedModels.add(mName);
    stores.add(getStoreName(contract, mName));
    for (const def of getRelationDefinitions(contract, mName)) {
      if (!isChildEnforcementRelation(contract, mName, def)) continue;
      const action = getReferentialActionForRelation(contract, mName, def, "onDelete");
      stores.add(def.relatedStoreName);
      if (action === "cascade") walk(def.relatedModelName);
    }
  }

  walk(modelName);
  return [...stores];
}

/**
 * Enforces every `onDelete` action declared on `modelName`'s child relations
 * against one specific `row` about to be deleted. `cascade` recurses into
 * each matched child's own `onDelete` relations *before* deleting it — so a
 * multi-hop chain (`User --cascade--> Post --cascade--> Comment`) is fully
 * torn down, and a `restrict` several hops deep still aborts the whole
 * transaction (recursing before deleting means the delete never happens if a
 * deeper hop throws). `setNull`/`setDefault` are leaf actions: the child row
 * survives, so recursion never continues past them.
 *
 * `visited` (keyed by `storeName::key`) guards against row-level cycles — two
 * specific rows whose FKs point at each other through a self-referential or
 * mutually-cascading relation graph. Callers should leave it at its default
 * (a fresh `Set` per top-level call) so independent rows deleted in the same
 * `deleteAll()` batch don't cross-suppress each other's cascades; it's only
 * ever passed explicitly by this function's own recursive calls, to keep one
 * shared guard across a single row's full recursive descent.
 */
export async function applyReferentialActionsForRow(
  scope: IdbTransactionScope,
  contract: IdbContract,
  modelName: string,
  row: Record<string, unknown>,
  visited: Set<string> = new Set()
): Promise<void> {
  const keyPath = getKeyPath(contract, modelName);
  const rowKey = `${getStoreName(contract, modelName)}::${keyToken(extractKeyFromRow(row, keyPath))}`;
  if (visited.has(rowKey)) return;
  visited.add(rowKey);

  const meta = makePlanMeta(contract);
  for (const def of getRelationDefinitions(contract, modelName)) {
    if (!isChildEnforcementRelation(contract, modelName, def)) continue;
    const action = getReferentialActionForRelation(contract, modelName, def, "onDelete");

    const childWhere = buildChildWhereFromRow(def, row);

    if (action === "restrict") {
      if (await childExists(scope, contract, meta, def, row)) {
        throw new Error(
          `Cannot delete ${modelName} '${keyToken(extractKeyFromRow(row, keyPath))}': child records exist on relation '${def.relationName}'. ` +
            "Delete those children first, or declare onDelete: Cascade, SetNull or SetDefault on the relation."
        );
      }
      continue;
    }

    if (action === "cascade") {
      const childKeyPath = getKeyPath(contract, def.relatedModelName);
      const children = await readMutationRows(scope, contract, def.relatedModelName, childWhere);
      for (const child of children) {
        await applyReferentialActionsForRow(scope, contract, def.relatedModelName, child, visited);
        await scope.execute({
          meta,
          kind: "delete",
          storeName: def.relatedStoreName,
          key: extractKeyFromRow(child, childKeyPath),
        } as IdbAtomicPlan);
      }
      continue;
    }

    if (action === "setNull") {
      const patch: Record<string, unknown> = {};
      for (const targetField of def.targetFields) patch[targetField] = null;
      await writeMutationRows(scope, contract, def.relatedModelName, {
        write: "put-merged",
        patch,
        where: childWhere,
      });
      continue;
    }

    if (action === "setDefault") {
      const patch = buildSetDefaultPatch(contract, def);
      await validateSetDefaultPatch(scope, contract, modelName, def, patch, extractKeyFromRow(row, keyPath));
      await writeMutationRows(scope, contract, def.relatedModelName, {
        write: "put-merged",
        patch,
        where: childWhere,
      });
      continue;
    }
  }
}

export async function executeDeleteWithReferentialActions(options: {
  executor: IdbQueryExecutorWithTransaction;
  contract: IdbContract;
  modelName: string;
  key: IDBValidKey;
}): Promise<void> {
  const { executor, contract, modelName, key } = options;
  const storeNames = collectDeleteStoreNames(contract, modelName);
  await withMutationScope(executor, storeNames, async (scope) => {
    const storeName = getStoreName(contract, modelName);
    const meta = makePlanMeta(contract);
    const keyPath = getKeyPath(contract, modelName);
    const fields = keyPathFields(keyPath);
    const values = typeof keyPath === "string" ? [key] : (key as IDBValidKey[]);
    const where = andExpr(fields.map((field, i) => fieldFilter(field, "eq", values[i])));
    const rows = await readMutationRows(scope, contract, modelName, where, 1);
    const row = rows[0];
    if (!row) return [];
    await applyReferentialActionsForRow(scope, contract, modelName, row);
    await scope.execute({ meta, kind: "delete", storeName, key } as IdbAtomicPlan);
    return [];
  });
}

export async function executeDeleteAllWithReferentialActions(options: {
  executor: IdbQueryExecutorWithTransaction;
  contract: IdbContract;
  modelName: string;
  where?: IdbFilterExpr;
}): Promise<Record<string, unknown>[]> {
  const { executor, contract, modelName, where } = options;
  const storeNames = collectDeleteStoreNames(contract, modelName);
  return withMutationScope(executor, storeNames, async (scope) => {
    const storeName = getStoreName(contract, modelName);
    const meta = makePlanMeta(contract);
    const keyPath = getKeyPath(contract, modelName);
    if (!hasEnforceableChildRelations(contract, modelName)) {
      return writeMutationRows(scope, contract, modelName, {
        write: "delete",
        ...(where === undefined ? {} : { where }),
      });
    }
    const rows = await readMutationRows(scope, contract, modelName, where);
    for (const row of rows) {
      await applyReferentialActionsForRow(scope, contract, modelName, row);
      const key = extractKeyFromRow(row, keyPath);
      await scope.execute({ meta, kind: "delete", storeName, key } as IdbAtomicPlan);
    }
    return rows;
  });
}
