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
 *   found — this checks that the connected parent exists.
 * - Recursive nesting (nested writes inside nested writes) is not supported and throws.
 *
 * All multi-store writes are wrapped in a single `withMutationScope` call that opens
 * one IDB transaction spanning all required stores, per ADR 007.
 */

import { applyFieldUpdates, type IdbFieldOperation } from "./field-updates";
import type { PlanMeta } from "@prisma/orm-framework/contract/types";
import type { ContractReferenceRelation } from "@prisma/orm-framework/contract/types";
import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import type { IdbAtomicPlan, IdbPlanBody, IdbRowFilter } from "@prisma-idb/driver-idb/runtime";
import { andExpr, fieldFilter, shorthandToFilterExpr } from "@prisma-idb/adapter-idb/runtime";
import { assertKnownFilterFields } from "./filter-fields";
import type { IdbFilterExpr } from "@prisma-idb/adapter-idb/runtime";
import type { IdbReferentialAction } from "@prisma-idb/target-idb/pack";
import type { IdbQueryExecutor } from "./executor";
import { assertEnumValues } from "./enum-validation";
import { assertValidRecord } from "./record-validation";
import { deleteRecordNotFound } from "./record-not-found";
import {
  applyUpdateDefaults,
  updateDefaultsVaryByRow,
  completeCreateRecord,
  createMutationDefaultsCache,
  type MutationDefaultsCache,
} from "./mutation-defaults";
import { absentAsNull, decimalIdentityToken, isValidIdbKey } from "@prisma-idb/target-idb/runtime";
import { buildCatalog } from "./planner/catalog";
import { fieldValueChanged, IdbDecimalIdentityConflictError, preserveDecimalKeySpelling } from "./decimal-identity";
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
  getKeyPath,
  getStoreName,
  keyEquals,
  keyToken,
} from "./types";
import { keyPathFields, sameFieldSet, sameJoinPairs } from "@prisma-idb/target-idb/pack";
import type { IdbTransactionScope } from "@prisma-idb/driver-idb/runtime";

// ── Internal types ─────────────────────────────────────────────────────────────

/** The store and join fields needed to execute a reference relation. */
interface RelationDefinition {
  readonly relationName: string;
  readonly relatedModelName: string;
  readonly relatedStoreName: string;
  readonly cardinality: string | undefined;
  readonly localFields: readonly string[];
  readonly targetFields: readonly string[];
}

type ParsedRelationOperation =
  | Extract<IdbRelationMutation<IdbContract, string>, { kind: "create" }>
  | { readonly kind: "connect" | "disconnect"; readonly criteria: readonly IdbFilterExpr[] };

/** A relation paired with the operation and filters prepared from its callback. */
interface ParsedRelationMutation {
  readonly relation: RelationDefinition;
  readonly mutation: ParsedRelationOperation;
}

/** Scalar write data separated from relation mutation descriptors. */
interface ParsedMutationInput {
  readonly scalarData: Record<string, unknown>;
  readonly relationMutations: readonly ParsedRelationMutation[];
}

// ── Plan meta helpers ─────────────────────────────────────────────────────────

/** Plan metadata for the raw plans the mutation executor issues itself, outside any accessor's grouping key. */
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

/** Cache reference-relation metadata by contract identity and model. */
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

/** Create a parent and its nested related rows in one transaction. */
export async function executeNestedCreateMutation(options: {
  executor: IdbQueryExecutorWithTransaction;
  contract: IdbContract;
  modelName: string;
  data: MutationCreateInput<IdbContract, string>;
}): Promise<Record<string, unknown>> {
  const { executor, contract, modelName, data } = options;
  const parsed = parseMutationInput(contract, modelName, data as Record<string, unknown>, "create");
  const storeNames = collectStoreNames(contract, modelName, parsed, "create");
  const defaultsCache = createMutationDefaultsCache();
  return withMutationScope(executor, storeNames, (scope) =>
    createGraph(scope, contract, modelName, parsed, defaultsCache)
  );
}

/** Update the first filtered parent and its nested relations in one transaction. */
export async function executeNestedUpdateMutation(options: {
  executor: IdbQueryExecutorWithTransaction;
  contract: IdbContract;
  modelName: string;
  filters: readonly IdbFilterExpr[];
  data: MutationUpdateInput<IdbContract, string>;
}): Promise<Record<string, unknown> | null> {
  const { executor, contract, modelName, filters, data } = options;
  const parsed = parseMutationInput(contract, modelName, data as Record<string, unknown>, "update");
  const storeNames = collectStoreNames(contract, modelName, parsed, "update");
  const defaultsCache = createMutationDefaultsCache();
  return withMutationScope(executor, storeNames, (scope) =>
    updateFirstGraph(scope, contract, modelName, filters, parsed, defaultsCache)
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
  parsed: ParsedMutationInput,
  kind: "create" | "update"
): string[] {
  const stores = new Set([getStoreName(contract, modelName), ...fkParentStoreNames(contract, modelName)]);
  // A relation callback on a foreign key writes that key, which other rows may reference.
  const scalarData: Record<string, unknown> = { ...parsed.scalarData };
  for (const { relation } of parsed.relationMutations) {
    stores.add(relation.relatedStoreName);
    for (const store of fkParentStoreNames(contract, relation.relatedModelName)) stores.add(store);
    if (kind === "update" && isForeignKeyRelation(contract, modelName, relation)) {
      for (const field of relation.localFields) scalarData[field] = null;
    }
    // A connect or disconnect of children writes their foreign key and their
    // `onUpdate` defaults, whose referential actions may reach further stores.
    if (!isDeclaredChildRelation(contract, modelName, relation)) continue;
    const childPatch = applyUpdateDefaults(
      contract.execution?.mutations.defaults,
      relation.relatedStoreName,
      Object.fromEntries(relation.targetFields.map((field) => [field, null])),
      createMutationDefaultsCache()
    );
    for (const store of collectOnUpdateEnforcementStoreNames(contract, relation.relatedModelName, childPatch)
      .storeNames) {
      stores.add(store);
    }
  }
  if (kind === "update") {
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
  return getForeignKeyRelations(contract, modelName).map((def) => def.relatedStoreName);
}

// ── Graph operations ──────────────────────────────────────────────────────────

/** Resolve parent-owned references before inserting the parent, then write its children. */
async function createGraph(
  scope: IdbTransactionScope,
  contract: IdbContract,
  modelName: string,
  parsed: ParsedMutationInput,
  defaultsCache: MutationDefaultsCache
): Promise<Record<string, unknown>> {
  const { parentOwned, childOwned } = partitionByOwnership(contract, modelName, parsed.relationMutations);

  const scalarData = { ...parsed.scalarData };

  for (const item of parentOwned) {
    await applyParentOwnedMutation(scope, contract, scalarData, item.relation, item.mutation, defaultsCache);
  }

  const parentRow = await insertSingleRow(scope, contract, modelName, scalarData, defaultsCache);

  for (const item of childOwned) {
    await applyChildOwnedMutation(scope, contract, modelName, parentRow, item.relation, item.mutation, defaultsCache);
  }

  return parentRow;
}

/** Read the parent before resolving relation mutations and validating its scalar patch. */
async function updateFirstGraph(
  scope: IdbTransactionScope,
  contract: IdbContract,
  modelName: string,
  filters: readonly IdbFilterExpr[],
  parsed: ParsedMutationInput,
  defaultsCache: MutationDefaultsCache
): Promise<Record<string, unknown> | null> {
  const existingRow = await findFirstByFilters(scope, contract, modelName, filters);
  if (!existingRow) return null;

  const { parentOwned, childOwned } = partitionByOwnership(contract, modelName, parsed.relationMutations);

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
    assertValidRecord(contract, modelName, "update", patch);
    await validateScalarFks(scope, contract, modelName, patch, existingRow);
    const writes = createReferentialWrites("update", modelName, key);
    await applyReferentialActionsForRowOnUpdate(scope, contract, modelName, existingRow, patch, writes);
    const rows = await scope.execute({ meta, kind: "update", storeName, key, patch });
    await verifyReferentialWrites(scope, contract, [writes]);
    const updated = rows[0];
    if (updated) parentRow = absentAsNull(contract, modelName)(updated);
  }

  for (const item of childOwned) {
    await applyChildOwnedMutation(scope, contract, modelName, parentRow, item.relation, item.mutation, defaultsCache);
  }

  return parentRow;
}

// ── Input parsing ─────────────────────────────────────────────────────────────

/** Separate scalar values from validated relation callback results. */
function parseMutationInput(
  contract: IdbContract,
  modelName: string,
  input: Record<string, unknown>,
  kind: "create" | "update"
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

    if (kind === "create" && mutation.kind === "disconnect") {
      throw new Error("disconnect() is only supported in update() nested mutations");
    }
    if (relation.cardinality === "M:N") throw new Error("M:N nested mutations are not supported");
    relationMutations.push({ relation, mutation: prepareRelationOperation(contract, modelName, relation, mutation) });
  }

  return { scalarData, relationMutations };
}

/** Prepare and validate the filters used by the relation write. */
function prepareRelationOperation(
  contract: IdbContract,
  modelName: string,
  relation: RelationDefinition,
  mutation: IdbRelationMutation<IdbContract, string>
): ParsedRelationOperation {
  if (mutation.kind === "create") return mutation;
  const { kind } = mutation;
  const parentOwned = isForeignKeyRelation(contract, modelName, relation);
  if (parentOwned && kind === "disconnect") return { kind, criteria: [] };

  let criteria = kind === "disconnect" ? (mutation.criteria ?? []) : mutation.criteria;
  const operation = `${kind}() nested mutation for relation "${relation.relationName}"`;
  if (parentOwned) {
    const first = criteria[0];
    if (first === undefined) throw new Error(`${operation} requires a criterion`);
    criteria = [first];
  }

  const filters: IdbFilterExpr[] = [];
  for (const criterion of criteria) {
    const filter = shorthandToFilterExpr(criterion);
    if (filter === undefined) throw new Error(`${operation} requires a non-empty criterion`);
    assertKnownFilterFields(contract, relation.relatedModelName, filter);
    filters.push(filter);
  }
  return { kind, criteria: filters };
}

// ── Ownership partitioning ────────────────────────────────────────────────────

/** Separate relations whose foreign keys belong to the parent from those owned by children. */
function partitionByOwnership(
  contract: IdbContract,
  modelName: string,
  mutations: readonly ParsedRelationMutation[]
): {
  parentOwned: ParsedRelationMutation[];
  childOwned: ParsedRelationMutation[];
} {
  const parentOwned: ParsedRelationMutation[] = [];
  const childOwned: ParsedRelationMutation[] = [];

  for (const item of mutations) {
    // A foreign key on this model, including a `1:1` declared on the foreign-key side.
    if (isForeignKeyRelation(contract, modelName, item.relation)) {
      parentOwned.push(item);
      continue;
    }
    childOwned.push(item);
  }

  return { parentOwned, childOwned };
}

// ── Parent-owned (foreign-key) mutations ──────────────────────────────────────

/** Resolve a to-one mutation into scalar foreign-key values on the parent. */
async function applyParentOwnedMutation(
  scope: IdbTransactionScope,
  contract: IdbContract,
  scalarData: Record<string, unknown>,
  relation: RelationDefinition,
  mutation: ParsedRelationOperation,
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
    // Recursive nesting is not supported — the nested record must
    // be a plain scalar create, not itself a nested mutation.
    const relatedRow = await insertSingleRow(scope, contract, relation.relatedModelName, row, defaultsCache);
    copyRelatedValuesToParent(relation, scalarData, relatedRow);
    return;
  }

  // Preparation keeps the first criterion for a parent-owned connect.
  const [relatedRow] = await readMutationRows(scope, contract, relation.relatedModelName, mutation.criteria[0]!, 1);
  if (!relatedRow) {
    throw new Error(`connect() nested mutation for relation "${relation.relationName}" did not find a matching row`);
  }
  copyRelatedValuesToParent(relation, scalarData, relatedRow);
}

/** Copy each referenced value into the matching local foreign-key field. */
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

/** Create, connect, or disconnect children using the persisted parent join values. */
async function applyChildOwnedMutation(
  scope: IdbTransactionScope,
  contract: IdbContract,
  parentModelName: string,
  parentRow: Record<string, unknown>,
  relation: RelationDefinition,
  mutation: ParsedRelationOperation,
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
    const setValues = Object.fromEntries(parentValues);
    for (const where of mutation.criteria) {
      await writeChildRows(scope, contract, relation, setValues, where, defaultsCache);
    }
    return;
  }

  // An incomplete parent key has no children to disconnect.
  if ([...parentValues.values()].some((value) => value === null)) return;
  const setValues = Object.fromEntries(Array.from(parentValues.keys(), (field) => [field, null] as const));
  const parentJoinWhere = buildParentJoinWhere(parentValues);
  if (mutation.criteria.length === 0) {
    await writeChildRows(scope, contract, relation, setValues, parentJoinWhere, defaultsCache);
    return;
  }

  for (const criterion of mutation.criteria) {
    await writeChildRows(scope, contract, relation, setValues, andExpr([parentJoinWhere, criterion]), defaultsCache);
  }
}

/** Resolve parent join values before writing children; missing values cannot form a relation. */
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

/** Complete and validate a nested record, then insert it with foreign-key checks. */
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
  const record = completeCreateRecord(contract, modelName, data, defaultsCache);
  assertEnumValues(contract, modelName, record);
  assertValidRecord(contract, modelName, "create", record);
  await validateScalarFks(scope, contract, modelName, record);
  const rows = await scope.execute({ meta, kind: "add", storeName, record });
  return rows[0] ?? record;
}

/**
 * Recursive nesting (a relation callback inside an already-nested create) is
 * not supported. Without this guard the callback function would be
 * handed to `store.put(...)`, where IDB's structured-clone throws an opaque
 * `DataCloneError` ("could not be cloned") that gives the developer no hint
 * about the real cause. Surface a precise error instead.
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

/** Find the first parent selected by the nested-update filters. */
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
  // Append one row at a time: spreading a large scan into push() overflows the call stack.
  for (const op of plans) for (const row of await scope.execute(op)) rows.push(row);
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
  const catalog = buildCatalog(contract, getStoreName(contract, modelName), modelName);
  const request = { ...(where === undefined ? {} : { where }), ...(take === undefined ? {} : { take }) };
  const lowered = lowerRows(catalog, planQuery(catalog, request), makePlanMeta(contract), request);
  return lowered.finish(await executeMutationPlan(scope, lowered.idbPlan));
}

/** Write planned matches, collecting preimages first when changing the walked index key. */
async function writeMutationRows(
  scope: IdbTransactionScope,
  contract: IdbContract,
  modelName: string,
  request: WriteRequest
): Promise<Record<string, unknown>[]> {
  if (request.write !== "delete") assertValidRecord(contract, modelName, "update", request.patch ?? {});
  const catalog = buildCatalog(contract, getStoreName(contract, modelName), modelName);
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

/**
 * Writes `setValues` and the child store's `onUpdate` defaults to every child
 * row `where` matches, with the foreign-key checks and `onUpdate` referential
 * actions of any update. Rows are written one by one when a default gives each
 * row its own value, such as `uuid()`, when the patch changes a field other
 * rows reference, or when it sets only part of a compound foreign key, whose
 * other fields come from each row; otherwise one patch serves every row.
 */
async function writeChildRows(
  scope: IdbTransactionScope,
  contract: IdbContract,
  relation: RelationDefinition,
  setValues: Record<string, unknown>,
  where: IdbFilterExpr,
  defaultsCache: MutationDefaultsCache
): Promise<void> {
  const defaults = contract.execution?.mutations.defaults;
  const { relatedModelName: modelName, relatedStoreName: storeName } = relation;
  const sharedPatch = applyUpdateDefaults(defaults, storeName, setValues, defaultsCache);
  const { enforces, changesRootRows } = collectOnUpdateEnforcementStoreNames(contract, modelName, sharedPatch);
  const sharedPatchFits =
    !updateDefaultsVaryByRow(defaults, storeName, setValues) &&
    !enforces &&
    !fkCheckNeedsExistingRow(contract, modelName, sharedPatch);
  if (sharedPatchFits) {
    // One patch serves every row, and it sets whole foreign keys, so one
    // check covers them.
    await validateScalarFks(scope, contract, modelName, sharedPatch);
    await writeMutationRows(scope, contract, modelName, {
      write: "put-merged",
      patch: sharedPatch,
      where,
    });
    return;
  }
  // Every match is read before the first write, so a write cannot move a row
  // into or out of the match set.
  const meta = makePlanMeta(contract);
  const keyPath = getKeyPath(contract, modelName);
  const allWrites: ReferentialWrites[] = [];
  const decimalParents: DecimalParentConflicts = new Map();
  const selected = await readMutationRows(scope, contract, modelName, where);
  for (const [index, candidate] of selected.entries()) {
    const key = extractKeyFromRow(candidate, keyPath);
    const row =
      changesRootRows && index > 0 ? (await scope.execute({ meta, kind: "key-get", storeName, key }))[0] : candidate;
    if (!row) continue;
    const patch = applyUpdateDefaults(defaults, storeName, setValues, defaultsCache);
    assertValidRecord(contract, modelName, "update", patch);
    // A generated value can be a foreign key, or a field other rows reference,
    // so each row's patch gets the checks and actions of any other update.
    await validateScalarFks(scope, contract, modelName, patch, row);
    const writes = createReferentialWrites("update", modelName, key, decimalParents);
    allWrites.push(writes);
    await applyReferentialActionsForRowOnUpdate(scope, contract, modelName, row, patch, writes);
    await scope.execute({ meta, kind: "update", storeName, key, patch } as IdbAtomicPlan);
  }
  await verifyReferentialWrites(scope, contract, allWrites);
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

/** Read an explicitly declared referential action from model storage metadata. */
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

/** Find an action declared on the parent-side relation or on its matching foreign-key relation. */
function findDeclaredAction(
  contract: IdbContract,
  modelName: string,
  def: RelationDefinition,
  kind: ReferentialActionKind
): IdbReferentialAction | undefined {
  const direct = getStoredAction(contract, modelName, def.relationName, kind);
  if (direct !== undefined) return direct;

  for (const inverse of getRelationDefinitions(contract, def.relatedModelName)) {
    if (!isInverseOf(inverse, modelName, def)) continue;
    const inverseAction = getStoredAction(contract, def.relatedModelName, inverse.relationName, kind);
    if (inverseAction !== undefined) return inverseAction;
  }

  return undefined;
}

/** `true` when `inverse`, declared on `def`'s related model, joins back to `modelName` on the same fields. */
function isInverseOf(inverse: RelationDefinition, modelName: string, def: RelationDefinition): boolean {
  return (
    inverse.relatedModelName === modelName &&
    sameJoinPairs(inverse.localFields, inverse.targetFields, def.targetFields, def.localFields)
  );
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

/**
 * A reference from child rows to `modelName`, seen from the parent, with the
 * actions enforced when a parent row is deleted or its referenced fields change.
 * `localFields` are the parent's referenced fields; `targetFields` are the
 * child's foreign key.
 */
interface ChildEnforcementEdge extends RelationDefinition {
  readonly onDelete: EnforcedReferentialAction;
  readonly onUpdate: EnforcedReferentialAction;
  readonly needsUniqueParent: boolean;
  readonly checksDecimalParent: boolean;
}

const childEdgesCache = new WeakMap<object, Map<string, ChildEnforcementEdge[]>>();

/**
 * Every reference to `modelName` whose actions a delete or key change must
 * enforce. The edges come from each model's foreign keys, so
 * a reference is enforced whether or not `modelName` declares the inverse
 * relation. Parent-side relations that no foreign key covers, such as a
 * shared-primary-key `1:1`, are enforced from their own declaration.
 */
function getChildEnforcementEdges(contract: IdbContract, modelName: string): ChildEnforcementEdge[] {
  let perContract = childEdgesCache.get(contract);
  if (!perContract) {
    perContract = new Map();
    childEdgesCache.set(contract, perContract);
  }
  const cached = perContract.get(modelName);
  if (cached) return cached;

  const edges: ChildEnforcementEdge[] = [];
  const catalog = buildCatalog(contract, getStoreName(contract, modelName), modelName);
  const uniqueSources = [catalog.primaryKey, ...catalog.indexes].filter(
    (source) => source.unique && !source.multiEntry
  );
  const withActions = (
    def: RelationDefinition,
    action: (kind: ReferentialActionKind) => IdbReferentialAction | undefined,
    requiresUnambiguousParent: boolean
  ) =>
    edges.push({
      ...def,
      onDelete: enforcedAction(action("onDelete")),
      onUpdate: enforcedAction(action("onUpdate")),
      needsUniqueParent:
        requiresUnambiguousParent && !uniqueSources.some((source) => sameFieldSet(source.fields, def.localFields)),
      checksDecimalParent:
        requiresUnambiguousParent &&
        def.localFields.some((field) => catalog.fields[field]?.codecId === "idb/decimal@1"),
    });

  const declared = getRelationDefinitions(contract, modelName).filter((def) =>
    isDeclaredChildRelation(contract, modelName, def)
  );
  for (const def of declared) {
    const singular =
      def.cardinality === "1:1" ||
      getForeignKeyRelations(contract, def.relatedModelName).some(
        (owner) => owner.cardinality === "1:1" && isInverseOf(owner, modelName, def)
      );
    withActions(def, (kind) => findDeclaredAction(contract, modelName, def, kind), singular);
  }
  for (const childModelName of Object.keys(domainModelsAtDefaultNamespace(contract.domain))) {
    for (const fk of getForeignKeyRelations(contract, childModelName)) {
      if (fk.relatedModelName !== modelName) continue;
      // A declared parent edge already checks this join with its own action.
      if (declared.some((inverse) => isInverseOf(inverse, childModelName, fk))) continue;
      const def: RelationDefinition = {
        relationName: `${childModelName}.${fk.relationName}`,
        relatedModelName: childModelName,
        relatedStoreName: getStoreName(contract, childModelName),
        cardinality: "1:N",
        localFields: fk.targetFields,
        targetFields: fk.localFields,
      };
      withActions(def, (kind) => getStoredAction(contract, childModelName, fk.relationName, kind), true);
    }
  }

  perContract.set(modelName, edges);
  return edges;
}

const foreignKeyRelationsCache = new WeakMap<object, Map<string, RelationDefinition[]>>();

/** The relations of `modelName` that hold a foreign key. */
function getForeignKeyRelations(contract: IdbContract, modelName: string): RelationDefinition[] {
  let perContract = foreignKeyRelationsCache.get(contract);
  if (!perContract) {
    perContract = new Map();
    foreignKeyRelationsCache.set(contract, perContract);
  }
  let relations = perContract.get(modelName);
  if (!relations) {
    relations = getRelationDefinitions(contract, modelName).filter((def) =>
      isForeignKeyRelation(contract, modelName, def)
    );
    perContract.set(modelName, relations);
  }
  return relations;
}

/**
 * `true` for a relation that holds a foreign key: every `N:1`, and a `1:1`
 * declared on the foreign-key side, which isn't the parent side of its join
 * and either points at the other model's primary key or pairs with a `1:N`
 * there. Authoring classifies relations the same way. The foreign key is
 * checked on writes and its actions run whether or not the parent declares
 * the inverse, as with a SQL foreign-key constraint.
 */
function isForeignKeyRelation(contract: IdbContract, modelName: string, def: RelationDefinition): boolean {
  return def.cardinality === "N:1" || (def.cardinality === "1:1" && oneToOneSide(contract, modelName, def) === "owner");
}

/** Identify parent-side relations declared on this model that need child checks when it changes. */
function isDeclaredChildRelation(contract: IdbContract, modelName: string, def: RelationDefinition): boolean {
  return (
    def.cardinality === "1:N" || (def.cardinality === "1:1" && oneToOneSide(contract, modelName, def) === "inverse")
  );
}

/** Honor a declared direction before inferring the side from a legacy primary-key join. */
function oneToOneSide(
  contract: IdbContract,
  modelName: string,
  def: RelationDefinition
): "owner" | "inverse" | undefined {
  if (
    def.localFields.length !== def.targetFields.length ||
    new Set(def.localFields).size !== def.localFields.length ||
    new Set(def.targetFields).size !== def.targetFields.length
  ) {
    return undefined;
  }
  const inverses = getRelationDefinitions(contract, def.relatedModelName).filter((other) =>
    isInverseOf(other, modelName, def)
  );
  if (inverses.some((other) => other.cardinality === "N:1")) return "inverse";
  if (inverses.some((other) => other.cardinality === "1:N")) return "owner";
  if (sameFieldSet(def.localFields, keyPathFields(getKeyPath(contract, modelName)))) return "inverse";
  if (sameFieldSet(def.targetFields, keyPathFields(getKeyPath(contract, def.relatedModelName)))) return "owner";
  return undefined;
}

// ── Existence lookups ─────────────────────────────────────────────────────────

/** A parent tuple with a null or missing value has no referencing children. */
function childJoinValues(def: RelationDefinition, row: Record<string, unknown>): unknown[] | undefined {
  const values = def.localFields.map((field) => row[field]);
  return values.some((value) => value === null || value === undefined) ? undefined : values;
}

/** A one-sided mutating action needs a unique referenced key to identify the parent. */
async function refuseNonUniqueAction(
  scope: IdbTransactionScope,
  contract: IdbContract,
  meta: PlanMeta,
  def: RelationDefinition,
  values: readonly unknown[]
): Promise<void> {
  if (await rowExists(scope, contract, meta, def.relatedModelName, def.targetFields, values)) {
    throw new Error(
      `Cannot apply referential action on relation '${def.relationName}': the referenced fields must be unique.`
    );
  }
}

type DecimalParentConflicts = Map<string, Set<string>>;

/** A native unique index can contain legacy spellings of the same Decimal tuple. */
async function checkDecimalParent(
  scope: IdbTransactionScope,
  contract: IdbContract,
  meta: PlanMeta,
  modelName: string,
  def: ChildEnforcementEdge,
  row: Record<string, unknown>,
  cache: DecimalParentConflicts
): Promise<boolean> {
  const catalog = buildCatalog(contract, getStoreName(contract, modelName), modelName);
  const tokenFor = (record: Record<string, unknown>) => {
    const keys = def.localFields.map((field) =>
      catalog.fields[field]?.codecId === "idb/decimal@1" ? decimalIdentityToken(record[field]) : record[field]
    );
    return isValidIdbKey(keys) ? keyToken(keys) : undefined;
  };
  const token = tokenFor(row);
  if (token === undefined) return true;

  const cacheKey = JSON.stringify([modelName, ...def.localFields]);
  let duplicates = cache.get(cacheKey);
  if (duplicates === undefined) {
    duplicates = new Set();
    const seen = new Set<string>();
    for (const parent of await readMutationRows(scope, contract, modelName, undefined)) {
      const key = tokenFor(parent);
      if (key === undefined) continue;
      if (seen.has(key)) duplicates.add(key);
      else seen.add(key);
    }
    cache.set(cacheKey, duplicates);
  }
  if (!duplicates.has(token)) return true;
  const values = def.localFields.map((field) => row[field]);
  if (!(await rowExists(scope, contract, meta, def.relatedModelName, def.targetFields, values))) return true;
  // Earlier writes in this transaction may have removed one of the aliases.
  const where = andExpr(def.localFields.map((field, index) => fieldFilter(field, "eq", values[index])));
  const matches = await readMutationRows(scope, contract, modelName, where, 2);
  if (matches.length > 1) throw new IdbDecimalIdentityConflictError(modelName);
  const [current] = matches;
  const keyPath = catalog.primaryKey.keyPath;
  if (!current || !keyEquals(extractKeyFromRow(current, keyPath), extractKeyFromRow(row, keyPath))) return false;
  duplicates.delete(token);
  return true;
}

/**
 * Does `modelName` have a row whose `fields` equal `values`, pairwise?
 * Compares values the way IndexedDB compares keys. `additionalFilter` narrows
 * the match in memory; it makes the check read rows instead of keys.
 */
async function rowExists(
  scope: IdbTransactionScope,
  contract: IdbContract,
  meta: PlanMeta,
  modelName: string,
  fields: readonly string[],
  values: readonly unknown[],
  additionalFilter?: IdbRowFilter
): Promise<boolean> {
  const where = andExpr(fields.map((field, i) => fieldFilter(field, "eq", values[i])));
  const catalog = buildCatalog(contract, getStoreName(contract, modelName), modelName);
  const lowered = lowerExists(catalog, planQuery(catalog, { where }), meta, { where }, additionalFilter);
  // The scope runs atomic plans only. Each `await` here resolves in a
  // microtask, so the transaction stays open between the requests.
  return lowered.finish(await executeMutationPlan(scope, lowered.idbPlan));
}

/** Match children against the parent's complete pre-change tuple. */
function buildChildWhere(def: RelationDefinition, values: readonly unknown[]): IdbFilterExpr {
  return andExpr(def.targetFields.map((field, i) => fieldFilter(field, "eq", values[i])));
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

// ── Update referential action enforcement ─────────────────────────────────────

/**
 * Collects every store an `onUpdate`-enforced write to `modelName` might
 * touch: the model's own store, plus the related store of any 1:N/1:1-
 * parent-side relation whose `localFields` appear in the raw patch —
 * pessimistic (checks field *presence*, not whether the resolved value will
 * actually change, since the current row isn't read yet when this runs).
 * A `cascade`, `setNull` or `setDefault` action can change fields another
 * relation references. Include the stores reached from those fields
 * so the transaction can apply those actions too.
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
): { storeNames: string[]; enforces: boolean; changesRootRows: boolean } {
  const rootStore = getStoreName(contract, modelName);
  const stores = new Set([rootStore]);
  const writtenStores = new Set<string>();
  const enforces = addOnUpdateStores(contract, modelName, stores, new Set(), Object.keys(data), writtenStores);
  return { storeNames: [...stores], enforces, changesRootRows: writtenStores.has(rootStore) };
}

/** The write that started a chain of referential actions. Errors name it, since that is the call the user made. */
interface ReferentialRoot {
  readonly operation: "delete" | "update";
  readonly modelName: string;
  readonly key: IDBValidKey;
  readonly decimalParents: DecimalParentConflicts;
}

/** A reference from a child's `fields` to a parent's `parentFields`, as checked after a referential write. */
interface CheckedReference {
  readonly relationName: string;
  readonly fields: readonly string[];
  readonly parentModelName: string;
  readonly parentFields: readonly string[];
}

/**
 * A row whose foreign key was rewritten by SetDefault. The relation can be
 * declared on the parent only, so use the reference from the action itself.
 */
interface ReferentialWrite {
  readonly modelName: string;
  readonly key: IDBValidKey;
  readonly cause: string;
  readonly references: CheckedReference[];
}

/** Rows changed by SetDefault, checked after the triggering writes land. */
export interface ReferentialWrites {
  readonly root: ReferentialRoot;
  readonly rows: Map<string, ReferentialWrite>;
}

/** Start collecting the referential writes caused by deleting or updating one row. */
export function createReferentialWrites(
  operation: ReferentialRoot["operation"],
  modelName: string,
  key: IDBValidKey,
  decimalParents: DecimalParentConflicts = new Map()
): ReferentialWrites {
  return { root: { operation, modelName, key, decimalParents }, rows: new Map() };
}

/** `Cascade`, `SetNull` or `SetDefault`, as the schema spells it. */
function actionLabel(action: "cascade" | "setNull" | "setDefault"): string {
  return action === "cascade" ? "Cascade" : action === "setNull" ? "SetNull" : "SetDefault";
}

/** `Cannot delete User 'u1'`: the start of an error about a referential action. */
function describeRoot(root: ReferentialRoot): string {
  return `Cannot ${root.operation} ${root.modelName} '${keyToken(root.key)}'`;
}

/** Check that each SetDefault action left a valid foreign key. */
export async function verifyReferentialWrites(
  scope: IdbTransactionScope,
  contract: IdbContract,
  all: readonly ReferentialWrites[]
): Promise<void> {
  const meta = makePlanMeta(contract);
  // Many children usually point at the same parent, so each parent is looked up once.
  const found = new Map<string, boolean>();
  for (const writes of all) {
    for (const write of writes.rows.values()) {
      const storeName = getStoreName(contract, write.modelName);
      const [row] = await scope.execute({ meta, kind: "key-get", storeName, key: write.key });
      if (!row) continue;
      for (const reference of write.references) {
        const values = reference.fields.map((field) => row[field]);
        if (values.some((value) => value === null || value === undefined)) continue;
        const { parentModelName, parentFields } = reference;
        const lookup = JSON.stringify([parentModelName, parentFields, keyToken(values as IDBValidKey[])]);
        let exists = found.get(lookup);
        if (exists === undefined) {
          exists = await parentExists(scope, contract, meta, parentModelName, parentFields, values);
          found.set(lookup, exists);
        }
        if (exists) continue;
        throw new Error(
          `${describeRoot(writes.root)}: ${write.cause} leaves ${write.modelName} '${keyToken(write.key)}' with ` +
            `${describeTuple(reference.fields, values)}, which does not reference a real row: relation ` +
            `'${reference.relationName}' has no ${parentModelName} with ${describeTuple(parentFields, values)}.`
        );
      }
    }
  }
}

/** `true` when both describe the same child fields pointing at the same parent fields. */
function sameReference(a: CheckedReference, b: CheckedReference): boolean {
  return a.parentModelName === b.parentModelName && sameJoinPairs(a.fields, a.parentFields, b.fields, b.parentFields);
}

/**
 * Write a referential action's `patch` to every child `where` matches. Each
 * child's own `onUpdate` actions run first. For SetDefault, record the new
 * reference to verify after the triggering write lands.
 */
async function writeReferentialUpdate(
  scope: IdbTransactionScope,
  contract: IdbContract,
  parentModelName: string,
  def: RelationDefinition,
  action: "cascade" | "setNull" | "setDefault",
  where: IdbFilterExpr,
  buildPatch: () => Record<string, unknown>,
  writes: ReferentialWrites,
  activeUpdates?: Set<string>
): Promise<void> {
  const children = await readMutationRows(scope, contract, def.relatedModelName, where);
  if (children.length === 0) return;
  const patch = buildPatch();
  const keyPath = getKeyPath(contract, def.relatedModelName);
  const cause = `${actionLabel(action)} on relation '${def.relationName}'`;
  const { enforces, changesRootRows } = collectOnUpdateEnforcementStoreNames(contract, def.relatedModelName, patch);
  let updated: Record<string, unknown>[];
  if (!enforces) {
    updated = await writeMutationRows(scope, contract, def.relatedModelName, { write: "put-merged", where, patch });
  } else {
    assertValidRecord(contract, def.relatedModelName, "update", patch);
    const meta = makePlanMeta(contract);
    updated = [];
    for (const [index, candidate] of children.entries()) {
      const key = extractKeyFromRow(candidate, keyPath);
      const child =
        changesRootRows && index > 0
          ? (await scope.execute({ meta, kind: "key-get", storeName: def.relatedStoreName, key }))[0]
          : candidate;
      if (!child) continue;
      const via = `${cause} changes ${def.relatedModelName} '${keyToken(key)}'`;
      await applyReferentialActionsForRowOnUpdate(
        scope,
        contract,
        def.relatedModelName,
        child,
        patch,
        writes,
        activeUpdates,
        via
      );
      const [row] = await scope.execute({ meta, kind: "update", storeName: def.relatedStoreName, key, patch });
      if (row) updated.push(row);
    }
  }

  if (action !== "setDefault") return;
  const reference = {
    relationName: def.relationName,
    fields: def.targetFields,
    parentModelName,
    parentFields: def.localFields,
  };
  for (const row of updated) {
    const key = extractKeyFromRow(row, keyPath);
    const rowId = keyToken([def.relatedStoreName, key]);
    const recorded = writes.rows.get(rowId);
    if (!recorded) {
      writes.rows.set(rowId, { modelName: def.relatedModelName, key, cause, references: [reference] });
    } else if (!recorded.references.some((checked) => sameReference(checked, reference))) {
      recorded.references.push(reference);
    }
  }
}

/**
 * Enforces every `onUpdate` action declared on `modelName`'s child relations
 * against one specific `oldRow` about to be patched with `patch`. Only
 * relations whose `localFields` are both present in `patch` and differ from
 * `oldRow`'s current value are enforced — a patch that sets a field to its
 * existing value, or never touches a locally-referenced field, is a no-op
 * here. Children are matched against `oldRow`'s pre-change values.
 *
 * `cascade`, `setNull` and `setDefault` can trigger further `onUpdate`
 * actions on the child. Track active actions by row and relation so cycles
 * terminate and a different relation on the same row can still enforce its
 * own action. The caller uses {@link verifyReferentialWrites} to check
 * defaults after its own write.
 * `via` describes the action that is changing `oldRow` when this runs for a
 * child, so a refusal names the write the user made.
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
  writes: ReferentialWrites,
  activeUpdates: Set<string> = new Set(),
  via?: string
): Promise<void> {
  const keyPath = getKeyPath(contract, modelName);
  const key = extractKeyFromRow(oldRow, keyPath);
  patch = preserveDecimalKeySpelling(contract, modelName, patch, key);

  const meta = makePlanMeta(contract);
  for (const def of getChildEnforcementEdges(contract, modelName)) {
    const changedFields = def.localFields.filter(
      (f) => f in patch && fieldValueChanged(contract, modelName, f, patch[f], oldRow[f])
    );
    if (changedFields.length === 0) continue;
    const values = childJoinValues(def, oldRow);
    if (!values) continue;

    const action = def.onUpdate;
    if (def.needsUniqueParent && action !== "restrict") {
      await refuseNonUniqueAction(scope, contract, meta, def, values);
      continue;
    }
    if (
      def.checksDecimalParent &&
      action !== "restrict" &&
      !(await checkDecimalParent(scope, contract, meta, modelName, def, oldRow, writes.root.decimalParents))
    )
      continue;

    if (action === "restrict") {
      const { root } = writes;
      const rootKey = root.operation === "delete" && root.modelName === def.relatedModelName ? root.key : undefined;
      const excludeDeletedRoot =
        rootKey === undefined
          ? undefined
          : (row: Record<string, unknown>) =>
              !keyEquals(extractKeyFromRow(row, getKeyPath(contract, def.relatedModelName)), rootKey);
      if (await rowExists(scope, contract, meta, def.relatedModelName, def.targetFields, values, excludeDeletedRoot)) {
        const fields = changedFields.join(", ");
        throw new Error(
          via === undefined
            ? `Cannot update ${modelName} '${keyToken(key)}': changing field(s) ${fields} ` +
                `would orphan child records on relation '${def.relationName}'. ` +
                "Update or remove those children first, or declare onUpdate: Cascade, SetNull or SetDefault on the relation."
            : `${describeRoot(writes.root)}: ${via}, and changing its field(s) ${fields} would orphan child ` +
                `records on relation '${def.relationName}'. Update or remove those children first, or declare ` +
                `onUpdate: Cascade, SetNull or SetDefault on '${def.relationName}'.`
        );
      }
      continue;
    }

    const childWhere = buildChildWhere(def, values);
    const actionKey = keyToken([modelName, key, def.relationName]);
    if (activeUpdates.has(actionKey)) continue;
    const buildPatch = () =>
      action === "setNull"
        ? Object.fromEntries(def.targetFields.map((field) => [field, null]))
        : action === "setDefault"
          ? buildSetDefaultPatch(contract, def)
          : Object.fromEntries(
              def.localFields.flatMap((field, i) =>
                changedFields.includes(field) ? [[def.targetFields[i]!, patch[field]]] : []
              )
            );
    activeUpdates.add(actionKey);
    try {
      await writeReferentialUpdate(
        scope,
        contract,
        modelName,
        def,
        action,
        childWhere,
        buildPatch,
        writes,
        activeUpdates
      );
    } finally {
      activeUpdates.delete(actionKey);
    }
  }
}

// ── Scalar FK validation ──────────────────────────────────────────────────────

/**
 * Returns true if `data` contains at least one non-null value for a field of
 * a foreign key, which then needs existence validation.
 */
export function hasScalarFkFields(contract: IdbContract, modelName: string, data: Record<string, unknown>): boolean {
  for (const def of getForeignKeyRelations(contract, modelName)) {
    for (const localField of def.localFields) {
      if (localField in data && data[localField] !== null && data[localField] !== undefined) return true;
    }
  }
  return false;
}

/** Include parent stores for the non-null foreign keys supplied by this write. */
export function collectScalarFkStoreNames(
  contract: IdbContract,
  modelName: string,
  data: Record<string, unknown>
): string[] {
  const stores = new Set([getStoreName(contract, modelName)]);
  for (const def of getForeignKeyRelations(contract, modelName)) {
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
  for (const def of getForeignKeyRelations(contract, modelName)) {
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
  return getForeignKeyRelations(contract, modelName).some((def) => {
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
  const keyPath = getKeyPath(contract, parentModel);
  const notExcluded =
    excludeKey === undefined
      ? undefined
      : (row: Record<string, unknown>): boolean => !keyEquals(extractKeyFromRow(row, keyPath), excludeKey);
  return rowExists(scope, contract, meta, parentModel, fields, values, notExcluded);
}

/** `id='u1'`, or `orgId='a', id='u1'` for a compound key. */
function describeTuple(fields: readonly string[], values: readonly unknown[]): string {
  return fields.map((f, i) => `${f}='${String(values[i])}'`).join(", ");
}

/** Create one completed record and check its foreign keys in the same transaction. */
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
  const record = completeCreateRecord(contract, modelName, data, defaultsCache);
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
  const records = data.map((row) => completeCreateRecord(contract, modelName, row, defaultsCache));
  const storeNames = [...new Set(records.flatMap((row) => collectScalarFkStoreNames(contract, modelName, row)))];
  return withMutationScope(executor, storeNames, async (scope) => {
    const inserted: Record<string, unknown>[] = [];
    for (const record of records) {
      inserted.push(await insertSingleRow(scope, contract, modelName, record, defaultsCache));
    }
    return inserted;
  });
}

/** Collect the stores reached by updates to the supplied fields, visiting each relation once. */
function addOnUpdateStores(
  contract: IdbContract,
  modelName: string,
  stores: Set<string>,
  visited: Set<RelationDefinition>,
  fields?: readonly string[],
  writtenStores?: Set<string>
): boolean {
  let enforces = false;
  for (const def of getChildEnforcementEdges(contract, modelName)) {
    if (fields && !def.localFields.some((field) => fields.includes(field))) continue;
    enforces = true;
    if (visited.has(def)) continue;
    visited.add(def);
    stores.add(def.relatedStoreName);
    if (def.onUpdate !== "restrict" && !def.needsUniqueParent) {
      writtenStores?.add(def.relatedStoreName);
      addOnUpdateStores(contract, def.relatedModelName, stores, visited, def.targetFields, writtenStores);
    }
  }
  return enforces;
}

/**
 * Every store an `onUpdate` enforcement on `modelName` could touch, whichever
 * fields the write sets. Use it to open a transaction before the write's
 * fields are known.
 */
export function collectOnUpdateClosureStoreNames(contract: IdbContract, modelName: string): string[] {
  const stores = new Set([getStoreName(contract, modelName)]);
  addOnUpdateStores(contract, modelName, stores, new Set());
  return [...stores];
}

/**
 * Combines the stores needed for this model's foreign-key checks with
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
): { storeNames: string[]; enforcesOnUpdate: boolean; changesRootRows: boolean } {
  const fkStoreNames = collectScalarFkStoreNames(contract, modelName, data);
  const {
    storeNames: onUpdateStoreNames,
    enforces,
    changesRootRows,
  } = collectOnUpdateEnforcementStoreNames(contract, modelName, data);
  return {
    storeNames: [...new Set([...fkStoreNames, ...onUpdateStoreNames])],
    enforcesOnUpdate: enforces,
    changesRootRows,
  };
}

/** The executor, contract, filters, and scalar patch for a validated update. */
interface ScalarUpdateOptions {
  readonly operations?: readonly IdbFieldOperation[];
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
  const defaults = contract.execution?.mutations.defaults;
  // One cache for the call, so every row shares one `now()`.
  const defaultsCache = createMutationDefaultsCache();
  // Apply defaults first, so the checks and the store list see every field
  // the write sets, including one an `onUpdate` default fills in.
  const patch = applyUpdateDefaults(defaults, storeName, data, defaultsCache);
  // A default such as `@onUpdate(uuid())` gives each row its own value, so the
  // rows are written one by one, each with its defaults resolved again.
  const defaultsPerRow = updateDefaultsVaryByRow(defaults, storeName, data);
  assertEnumValues(contract, modelName, patch);
  assertValidRecord(contract, modelName, "update", patch);
  const { storeNames, enforcesOnUpdate, changesRootRows } = collectUpdateStoreNames(contract, modelName, patch);
  const needsRowForFks = fkCheckNeedsExistingRow(contract, modelName, patch);
  const updatedRows = await withMutationScope(executor, storeNames, async (scope) => {
    // With defaults resolved per row, the first resolution is never written; each
    // row's own patch is checked in the loop below.
    if (!needsRowForFks && !defaultsPerRow) await validateScalarFks(scope, contract, modelName, patch);
    const meta = makePlanMeta(contract);
    const where = filters.length === 0 ? undefined : andExpr(filters);
    if (!enforcesOnUpdate && !needsRowForFks && !options.operations?.length && !defaultsPerRow) {
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
    const allWrites: ReferentialWrites[] = [];
    const decimalParents: DecimalParentConflicts = new Map();
    for (const [index, candidate] of oldRows.entries()) {
      const key = extractKeyFromRow(candidate, keyPath);
      const oldRow =
        changesRootRows && index > 0 ? (await scope.execute({ meta, kind: "key-get", storeName, key }))[0] : candidate;
      if (!oldRow) continue;
      const rowData = defaultsPerRow ? applyUpdateDefaults(defaults, storeName, data, defaultsCache) : patch;
      const rowPatch = applyFieldUpdates(
        contract,
        modelName,
        { patch: rowData, operations: options.operations ?? [] },
        oldRow
      );
      assertEnumValues(contract, modelName, rowPatch);
      assertValidRecord(contract, modelName, "update", rowPatch);
      if (needsRowForFks || defaultsPerRow) await validateScalarFks(scope, contract, modelName, rowPatch, oldRow);
      if (enforcesOnUpdate) {
        const writes = createReferentialWrites("update", modelName, key, decimalParents);
        allWrites.push(writes);
        await applyReferentialActionsForRowOnUpdate(scope, contract, modelName, oldRow, rowPatch, writes);
      }
      const rows = await scope.execute({ meta, kind: "update", storeName, key, patch: rowPatch } as IdbAtomicPlan);
      const updated = rows[0];
      if (updated) results.push(updated);
    }
    await verifyReferentialWrites(scope, contract, allWrites);
    return results;
  });
  // The rows come straight from the store, so a field added after they were written is absent.
  return updatedRows.map(absentAsNull(contract, modelName));
}

// ── Delete referential action enforcement ─────────────────────────────────────

/**
 * Returns true if any model references `modelName`, through a foreign key or
 * a parent-side relation. Every such reference has an `onDelete` action to
 * enforce: `noAction` behaves like `restrict`, which is also the default.
 */
export function hasEnforceableChildRelations(contract: IdbContract, modelName: string): boolean {
  return getChildEnforcementEdges(contract, modelName).length > 0;
}

/** Stores for direct relations and the foreign keys on rows nested writes can create. */
export function collectRelatedStoreNames(contract: IdbContract, modelName: string): string[] {
  const stores = new Set([getStoreName(contract, modelName)]);
  for (const def of getRelationDefinitions(contract, modelName)) {
    stores.add(def.relatedStoreName);
    for (const parentStore of fkParentStoreNames(contract, def.relatedModelName)) stores.add(parentStore);
    if (isDeclaredChildRelation(contract, modelName, def)) {
      for (const downstream of collectOnUpdateClosureStoreNames(contract, def.relatedModelName)) stores.add(downstream);
    }
  }
  return [...stores];
}

/**
 * Collects stores reached by `onDelete` actions, the `onUpdate` actions
 * triggered by `setNull` and `setDefault`. IndexedDB needs the full store list before opening
 * the transaction, so the traversal uses the contract and guards against cycles.
 */
export function collectDeleteStoreNames(contract: IdbContract, modelName: string): string[] {
  return collectDeleteActionScope(contract, modelName).storeNames;
}

function collectDeleteActionScope(
  contract: IdbContract,
  modelName: string
): { storeNames: string[]; changesRootRows: boolean } {
  const rootStore = getStoreName(contract, modelName);
  const stores = new Set<string>();
  const visitedModels = new Set<string>();
  const visitedUpdates = new Set<RelationDefinition>();
  const writtenStores = new Set<string>();

  /** Collect cascade stores once per model so cyclic relations cannot recurse indefinitely. */
  function walk(mName: string): void {
    if (visitedModels.has(mName)) return;
    visitedModels.add(mName);
    stores.add(getStoreName(contract, mName));
    for (const def of getChildEnforcementEdges(contract, mName)) {
      const action = def.onDelete;
      stores.add(def.relatedStoreName);
      if (action === "restrict" || def.needsUniqueParent) continue;
      writtenStores.add(def.relatedStoreName);
      if (action === "cascade") walk(def.relatedModelName);
      if (action === "setNull" || action === "setDefault") {
        addOnUpdateStores(contract, def.relatedModelName, stores, visitedUpdates, def.targetFields, writtenStores);
      }
    }
  }

  walk(modelName);
  return { storeNames: [...stores], changesRootRows: writtenStores.has(rootStore) };
}

/**
 * Enforces every `onDelete` action declared on `modelName`'s child relations
 * against one specific `row` about to be deleted. `cascade` recurses into
 * each matched child's own `onDelete` relations *before* deleting it — so a
 * multi-hop chain (`User --cascade--> Post --cascade--> Comment`) is fully
 * torn down, and a `restrict` several hops deep still aborts the whole
 * transaction (recursing before deleting means the delete never happens if a
 * deeper hop throws). `setNull` leaves the child row in place and runs any
 * `onUpdate` actions triggered by clearing its foreign key.
 *
 * `visited` (keyed by the store and primary key) guards against row-level cycles — two
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
  writes: ReferentialWrites,
  visited: Set<string> = new Set(),
  via?: string
): Promise<void> {
  const keyPath = getKeyPath(contract, modelName);
  const rowKey = keyToken([getStoreName(contract, modelName), extractKeyFromRow(row, keyPath)]);
  if (visited.has(rowKey)) return;
  visited.add(rowKey);

  const meta = makePlanMeta(contract);
  for (const def of getChildEnforcementEdges(contract, modelName)) {
    const values = childJoinValues(def, row);
    if (!values) continue;

    const action = def.onDelete;
    if (def.needsUniqueParent && action !== "restrict") {
      await refuseNonUniqueAction(scope, contract, meta, def, values);
      continue;
    }
    if (
      def.checksDecimalParent &&
      action !== "restrict" &&
      !(await checkDecimalParent(scope, contract, meta, modelName, def, row, writes.root.decimalParents))
    )
      continue;

    if (action === "restrict") {
      const key = extractKeyFromRow(row, keyPath);
      const excludesSelf: IdbRowFilter | undefined =
        def.relatedModelName === modelName ? (child) => !keyEquals(extractKeyFromRow(child, keyPath), key) : undefined;
      if (await rowExists(scope, contract, meta, def.relatedModelName, def.targetFields, values, excludesSelf)) {
        throw new Error(
          via === undefined
            ? `Cannot delete ${modelName} '${keyToken(extractKeyFromRow(row, keyPath))}': child records exist on relation '${def.relationName}'. ` +
                "Delete those children first, or declare onDelete: Cascade, SetNull or SetDefault on the relation."
            : `${describeRoot(writes.root)}: ${via}, but child records exist on relation '${def.relationName}'. ` +
                `Delete those children first, or declare onDelete: Cascade, SetNull or SetDefault on '${def.relationName}'.`
        );
      }
      continue;
    }

    const childWhere = buildChildWhere(def, values);
    if (action === "cascade") {
      const childKeyPath = getKeyPath(contract, def.relatedModelName);
      const children = await readMutationRows(scope, contract, def.relatedModelName, childWhere);
      for (const child of children) {
        const childKey = extractKeyFromRow(child, childKeyPath);
        const childVia = `Cascade on relation '${def.relationName}' deletes ${def.relatedModelName} '${keyToken(childKey)}'`;
        await applyReferentialActionsForRow(scope, contract, def.relatedModelName, child, writes, visited, childVia);
        await scope.execute({ meta, kind: "delete", storeName: def.relatedStoreName, key: childKey } as IdbAtomicPlan);
      }
      continue;
    }

    const buildPatch = () =>
      action === "setNull"
        ? Object.fromEntries(def.targetFields.map((field) => [field, null]))
        : buildSetDefaultPatch(contract, def);
    await writeReferentialUpdate(scope, contract, modelName, def, action, childWhere, buildPatch, writes);
  }
}

/** Delete a keyed row with its child actions atomically, or throw `P2025` before committing if missing. */
export async function executeDeleteWithReferentialActions(options: {
  executor: IdbQueryExecutorWithTransaction;
  contract: IdbContract;
  modelName: string;
  key: IDBValidKey;
}): Promise<Record<string, unknown>> {
  const { executor, contract, modelName, key } = options;
  const storeNames = collectDeleteStoreNames(contract, modelName);
  return withMutationScope(executor, storeNames, async (scope) => {
    const storeName = getStoreName(contract, modelName);
    const meta = makePlanMeta(contract);
    const keyPath = getKeyPath(contract, modelName);
    const fields = keyPathFields(keyPath);
    const values = typeof keyPath === "string" ? [key] : (key as IDBValidKey[]);
    const where = andExpr(fields.map((field, i) => fieldFilter(field, "eq", values[i])));
    const rows = await readMutationRows(scope, contract, modelName, where, 1);
    const row = rows[0];
    if (!row) throw deleteRecordNotFound(modelName);
    const writes = createReferentialWrites("delete", modelName, key);
    await applyReferentialActionsForRow(scope, contract, modelName, row, writes);
    await scope.execute({ meta, kind: "delete", storeName, key } as IdbAtomicPlan);
    await verifyReferentialWrites(scope, contract, [writes]);
    return row;
  });
}

/** Delete filtered rows with all child actions inside the same transaction. */
export async function executeDeleteAllWithReferentialActions(options: {
  executor: IdbQueryExecutorWithTransaction;
  contract: IdbContract;
  modelName: string;
  where?: IdbFilterExpr;
}): Promise<Record<string, unknown>[]> {
  const { executor, contract, modelName, where } = options;
  const { storeNames, changesRootRows } = collectDeleteActionScope(contract, modelName);
  return withMutationScope(executor, storeNames, async (scope) => {
    const storeName = getStoreName(contract, modelName);
    const meta = makePlanMeta(contract);
    const keyPath = getKeyPath(contract, modelName);
    if (!hasEnforceableChildRelations(contract, modelName)) {
      const deleted = await writeMutationRows(scope, contract, modelName, {
        write: "delete",
        ...(where === undefined ? {} : { where }),
      });
      return deleted.map(absentAsNull(contract, modelName));
    }
    const rows = await readMutationRows(scope, contract, modelName, where);
    const allWrites: ReferentialWrites[] = [];
    const decimalParents: DecimalParentConflicts = new Map();
    for (const row of rows) {
      const key = extractKeyFromRow(row, keyPath);
      // An earlier cascade can delete or rewrite a row selected by this bulk operation.
      const current = changesRootRows
        ? (await scope.execute({ meta, kind: "key-get", storeName, key } as IdbAtomicPlan))[0]
        : row;
      if (!current) continue;
      const writes = createReferentialWrites("delete", modelName, key, decimalParents);
      allWrites.push(writes);
      await applyReferentialActionsForRow(scope, contract, modelName, current, writes);
      await scope.execute({ meta, kind: "delete", storeName, key } as IdbAtomicPlan);
    }
    await verifyReferentialWrites(scope, contract, allWrites);
    return rows;
  });
}
