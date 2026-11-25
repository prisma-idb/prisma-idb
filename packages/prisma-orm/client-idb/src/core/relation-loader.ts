import type { ContractReferenceRelation } from "@prisma/orm-framework/contract/types";
import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import type { IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import { andExpr, fieldFilter } from "@prisma-idb/adapter-idb/runtime";
import type { IdbQueryExecutor } from "./executor";
import { buildRowComparator, combineFilterExprs } from "./query-shaping";
import type { IncludeEntry } from "./store-state";
import { fieldValueToken, getStoreName } from "./types";
import { decimalIdentityToken } from "@prisma-idb/target-idb/runtime";
import type { IdbContract } from "./types";
import { buildCatalog, type QueryCatalog } from "./planner/catalog";
import { planQuery } from "./planner/plan";
import { lowerRows } from "./planner/lower";

/**
 * The stores a read of `modelName` touches: its own store, plus the related store of each relation in `relNames`.
 * A read with includes opens one transaction over these, so every relation sees the same state as the parent rows.
 */
export function storeNamesForRead(contract: IdbContract, modelName: string, relNames: readonly string[]): string[] {
  const stores = new Set([getStoreName(contract, modelName)]);
  const model = domainModelsAtDefaultNamespace(contract.domain)[modelName];
  for (const relName of relNames) {
    const relation = model?.relations[relName];
    // Embed relations live inline in the parent row, so they add no store.
    if (relation === undefined || !("on" in relation)) continue;
    stores.add(getStoreName(contract, (relation as ContractReferenceRelation).to.model));
  }
  return [...stores];
}

/**
 * Batch-load a single named relation for all rows in `rows` and attach the
 * result to each row under the `relName` key.
 *
 * The join matches every field of the relation, so compound foreign keys join
 * on the whole tuple. It plans one batch lookup for all parents, then groups
 * the rows in memory, which avoids N+1 queries.
 *
 * The `entry` carries any `include()` refinement:
 *
 * - `collection` — the refined `where` further filters the child scan;
 *   `orderBy` / `skip` / `take` are applied **per parent group** for `1:N`
 *   relations (each parent's children are independently sorted and paginated).
 * - `scalar` — the relation field becomes the `count` of matching children
 *   (to-many only; `include()` rejects scalar refinements on to-one relations).
 *
 * @param relName    - The relation key to load (e.g. `"posts"`, `"author"`).
 * @param entry      - How to materialise the relation (collection vs scalar + refinement state).
 * @param rows       - The parent rows to attach related data to.
 * @param contract   - The resolved IDB contract.
 * @param modelName  - The source model name (owner of the relation).
 * @param executor   - The query executor used to run the related-store scan.
 */
export async function loadRelation(
  relName: string,
  entry: IncludeEntry,
  rows: Record<string, unknown>[],
  contract: IdbContract,
  modelName: string,
  executor: IdbQueryExecutor,
  groupingKey: string
): Promise<Record<string, unknown>[]> {
  if (rows.length === 0) return rows;

  const models = domainModelsAtDefaultNamespace(contract.domain);
  const model = models[modelName];
  if (model === undefined) return rows;

  const rawRelation = model.relations[relName];
  if (rawRelation === undefined) return rows;

  // Only handle reference relations (cross-store joins). Embed relations don't
  // have an `on` block and are stored inline — nothing to load.
  if (!("on" in rawRelation)) return rows;

  const relation = rawRelation as ContractReferenceRelation;
  const { cardinality, on } = relation;
  // `relation.to` is a CrossReference `{ namespace, model }`.
  const relatedModelName = relation.to.model;

  const localFields = on.localFields;
  const targetFields = on.targetFields;
  if (localFields.length === 0 || localFields.length !== targetFields.length) return rows;

  const relatedModel = models[relatedModelName];
  if (relatedModel === undefined) return rows;

  // Resolve the related object store name from the model's storage metadata.
  const relatedStoreName = getStoreName(contract, relatedModelName);

  const isScalar = entry.kind === "scalar";
  const catalog = buildCatalog(contract, relatedStoreName, relatedModelName);
  // Decimal join fields match numerically, as the FK check does: "1" joins "1.00".
  const decimals = decimalPositions(catalog.fields, targetFields);

  // Collect the distinct local tuples to drive the related-store lookup. A
  // tuple is keyed by `tupleToken`, so equal Date/binary values collapse and
  // match the related rows' freshly-deserialized values below. A row with a
  // null in any local field has no related rows.
  const localTuples = new Map<string, unknown[]>();
  for (const row of rows) {
    const token = tupleToken(row, localFields, decimals);
    if (token !== null)
      localTuples.set(
        token,
        localFields.map((f) => row[f])
      );
  }

  // Short-circuit: if every local tuple has a null, attach empties.
  // (Scalar counts are 0; to-many is [], to-one is null.)
  if (localTuples.size === 0) {
    return rows.map((row) => ({
      ...row,
      [relName]: isScalar ? 0 : cardinality === "1:N" ? [] : null,
    }));
  }

  const refinedWhere = combineFilterExprs(entry.state.filters);

  const storageHash = contract.storage.storageHash;
  const planMeta = { target: "idb", storageHash, lane: "idb-orm", annotations: { groupingKey } } as const;

  // Each field's IN is a superset of the local tuples. Keep the tuple check
  // to reject crossed compound keys, and shape collections per parent below.
  const joinWhere = andExpr(
    targetFields.map((field, i) =>
      fieldFilter(
        field,
        "in",
        [...localTuples.values()].map((tuple) => tuple[i])
      )
    )
  );
  const where = refinedWhere === undefined ? joinWhere : andExpr([joinWhere, refinedWhere]);
  const request = { ...(refinedWhere === undefined ? {} : { where: refinedWhere }) };
  const lowered = lowerRows(catalog, planQuery(catalog, { where }), planMeta, request, (row) => {
    const token = tupleToken(row, targetFields, decimals);
    return token !== null && localTuples.has(token);
  });
  const plan: IdbQueryPlan<Record<string, unknown>> = { meta: planMeta, idbPlan: lowered.idbPlan };
  const relatedRows = lowered.finish(await executor.query(plan).toArray());

  return attachRelatedRows(relName, entry, rows, relatedRows, relation, catalog.fields, decimals);
}

/** Attach related rows by their join tuple, shaping each parent's collection independently. */
function attachRelatedRows(
  relName: string,
  entry: IncludeEntry,
  rows: Record<string, unknown>[],
  relatedRows: Record<string, unknown>[],
  relation: ContractReferenceRelation,
  fields: QueryCatalog["fields"],
  decimals: readonly boolean[]
): Record<string, unknown>[] {
  const {
    cardinality,
    on: { localFields, targetFields },
  } = relation;
  if (cardinality === "1:N") {
    // Group related rows by their target tuple.
    const grouped = new Map<string, Record<string, unknown>[]>();
    for (const rrow of relatedRows) {
      const gk = tupleToken(rrow, targetFields, decimals);
      if (gk === null) continue;
      const group = grouped.get(gk) ?? [];
      group.push(rrow);
      grouped.set(gk, group);
    }
    const groupFor = (row: Record<string, unknown>): Record<string, unknown>[] => {
      const token = tupleToken(row, localFields, decimals);
      return token === null ? [] : (grouped.get(token) ?? []);
    };

    if (entry.kind === "scalar") {
      // Counts include all filtered children, without collection pagination.
      return rows.map((row) => ({
        ...row,
        [relName]: groupFor(row).length,
      }));
    }

    // Collection: apply refined orderBy / skip / take per parent group.
    const comparator = buildRowComparator(entry.state.orderBy, fields);
    const skip = entry.state.skip ?? 0;
    const take = entry.state.take;
    return rows.map((row) => {
      let group = groupFor(row);
      if (comparator !== undefined) group = [...group].sort(comparator);
      if (skip > 0 || take !== undefined) {
        group = group.slice(skip, take !== undefined ? skip + take : undefined);
      }
      return { ...row, [relName]: group };
    });
  }

  // N:1 / 1:1: index related rows by their target tuple, attach singles.
  // A refined `where` that excludes the related row yields `null` here.
  const indexed = new Map<string, Record<string, unknown>>();
  for (const rrow of relatedRows) {
    const token = tupleToken(rrow, targetFields, decimals);
    if (token !== null) indexed.set(token, rrow);
  }
  return rows.map((row) => {
    const token = tupleToken(row, localFields, decimals);
    return { ...row, [relName]: (token === null ? undefined : indexed.get(token)) ?? null };
  });
}

/** Which positions of a join are Decimal fields, matched by numeric value rather than spelling. */
function decimalPositions(fields: QueryCatalog["fields"], joinFields: readonly string[]): boolean[] {
  return joinFields.map((field) => fields[field]?.codecId === "idb/decimal@1");
}

/**
 * A `Map` key for the values of `fields` in `row`, or `null` when any of them
 * is null or undefined. Equal `Date`s and binary values give equal tokens.
 */
function tupleToken(
  row: Record<string, unknown>,
  fields: readonly string[],
  decimals: readonly boolean[] = []
): string | null {
  const parts: unknown[] = [];
  for (const [index, field] of fields.entries()) {
    const value = row[field];
    if (value === null || value === undefined) return null;
    const token = fieldValueToken(decimals[index] ? decimalIdentityToken(value) : value);
    parts.push([typeof token, String(token)]);
  }
  return JSON.stringify(parts);
}
