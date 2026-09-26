import type { ContractReferenceRelation } from "@prisma/orm-framework/contract/types";
import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import type { IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import { evaluateFilter } from "@prisma-idb/adapter-idb/runtime";
import type { IdbRowFilter } from "@prisma-idb/driver-idb/runtime";
import type { IdbQueryExecutor } from "./executor";
import { buildRowComparator, combineFilterExprs } from "./query-shaping";
import type { IncludeEntry } from "./store-state";
import { keyPathFields, type IdbKeyPath } from "@prisma-idb/target-idb/pack";
import { fieldValueToken, getKeyPath, isValidIdbKey } from "./types";
import type { IdbContract } from "./types";

/**
 * Batch-load a single named relation for all rows in `rows` and attach the
 * result to each row under the `relName` key.
 *
 * The join matches every field of the relation, so compound foreign keys join
 * on the whole tuple. It uses one key-range scan per distinct tuple when an
 * index or the related primary key covers the target fields, and otherwise
 * one full scan with an in-memory filter. Rows are then grouped in memory,
 * which avoids N+1 queries.
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
  const relatedStoreName =
    typeof relatedModel.storage === "object" && relatedModel.storage !== null && "storeName" in relatedModel.storage
      ? String((relatedModel.storage as { storeName: unknown })["storeName"])
      : relatedModelName;

  const isScalar = entry.kind === "scalar";

  // Collect the distinct local tuples to drive the related-store lookup. A
  // tuple is keyed by `tupleToken`, so equal Date/binary values collapse and
  // match the related rows' freshly-deserialized values below. A row with a
  // null in any local field has no related rows.
  const localTuples = new Map<string, unknown[]>();
  for (const row of rows) {
    const token = tupleToken(row, localFields);
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

  // When an index or the related store's own primary key covers exactly the
  // target fields, run one IDBKeyRange.only() point-range scan per distinct
  // tuple. Each scan visits only matching records, so only the refined
  // `where` is applied as a row filter. Otherwise, scan the whole store.
  const rangeSource = findRangeSource(contract, relatedStoreName, relatedModelName, targetFields);

  let relatedRows: Record<string, unknown>[];
  if (rangeSource !== undefined) {
    const refinedFilter: IdbRowFilter | undefined =
      refinedWhere !== undefined ? (row: Record<string, unknown>) => evaluateFilter(refinedWhere, row) : undefined;

    // IDBKeyRange.only() throws DataError for invalid keys (boolean, NaN,
    // plain objects, etc.). Such values cannot be stored as IndexedDB keys,
    // so no related rows can match — skip them before building plans.
    const ranges: IDBKeyRange[] = [];
    for (const values of localTuples.values()) {
      const ordered = keyPathFields(rangeSource.keyPath).map((f) => values[targetFields.indexOf(f)]);
      if (!ordered.every((v) => isValidIdbKey(v))) continue;
      ranges.push(
        IDBKeyRange.only(
          typeof rangeSource.keyPath === "string" ? (ordered[0] as IDBValidKey) : (ordered as IDBValidKey[])
        )
      );
    }

    // One scan per distinct tuple — independent, so run concurrently.
    const rangeResults = await Promise.all(
      ranges.map(async (range) => {
        const plan: IdbQueryPlan<Record<string, unknown>> = {
          meta: planMeta,
          idbPlan: {
            meta: planMeta,
            kind: "cursor-scan",
            storeName: relatedStoreName,
            ...(rangeSource.indexName !== undefined ? { indexName: rangeSource.indexName } : {}),
            range,
            ...(refinedFilter !== undefined ? { filter: refinedFilter } : {}),
          },
        };
        const rows: Record<string, unknown>[] = [];
        for await (const row of executor.query(plan)) {
          rows.push(row);
        }
        return rows;
      })
    );
    relatedRows = rangeResults.flat();
  } else {
    relatedRows = [];
    // Full store scan with an in-memory FK membership + refined-where filter.
    const filter: IdbRowFilter = (row: Record<string, unknown>): boolean => {
      const token = tupleToken(row, targetFields);
      return (
        token !== null && localTuples.has(token) && (refinedWhere === undefined || evaluateFilter(refinedWhere, row))
      );
    };
    const plan: IdbQueryPlan<Record<string, unknown>> = {
      meta: planMeta,
      idbPlan: { meta: planMeta, kind: "cursor-scan", storeName: relatedStoreName, filter },
    };
    for await (const row of executor.query(plan)) {
      relatedRows.push(row);
    }
  }

  // ── Merge ──────────────────────────────────────────────────────────────────

  if (cardinality === "1:N") {
    // Group related rows by their target tuple.
    const grouped = new Map<string, Record<string, unknown>[]>();
    for (const rrow of relatedRows) {
      const gk = tupleToken(rrow, targetFields);
      if (gk === null) continue;
      const group = grouped.get(gk) ?? [];
      group.push(rrow);
      grouped.set(gk, group);
    }
    const groupFor = (row: Record<string, unknown>): Record<string, unknown>[] => {
      const token = tupleToken(row, localFields);
      return token === null ? [] : (grouped.get(token) ?? []);
    };

    if (isScalar) {
      // Scalar reducer (Phase 6.5: count) — attach the per-parent child count.
      return rows.map((row) => ({
        ...row,
        [relName]: groupFor(row).length,
      }));
    }

    // Collection: apply refined orderBy / skip / take per parent group.
    const comparator = buildRowComparator(entry.state.orderBy);
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
    const token = tupleToken(rrow, targetFields);
    if (token !== null) indexed.set(token, rrow);
  }
  return rows.map((row) => {
    const token = tupleToken(row, localFields);
    return { ...row, [relName]: (token === null ? undefined : indexed.get(token)) ?? null };
  });
}

/**
 * A `Map` key for the values of `fields` in `row`, or `null` when any of them
 * is null or undefined. Equal `Date`s and binary values give equal tokens.
 */
function tupleToken(row: Record<string, unknown>, fields: readonly string[]): string | null {
  const parts: unknown[] = [];
  for (const field of fields) {
    const value = row[field];
    if (value === null || value === undefined) return null;
    const token = fieldValueToken(value);
    parts.push([typeof token, String(token)]);
  }
  return JSON.stringify(parts);
}

/**
 * Finds an index, or else the store's primary key, whose key path has exactly
 * `fields` (in any order), so a lookup on those fields can use a key range.
 * Returns `undefined` when there is none, or when `IDBKeyRange` isn't available.
 */
function findRangeSource(
  contract: IdbContract,
  storeName: string,
  modelName: string,
  fields: readonly string[]
): { readonly indexName?: string; readonly keyPath: IdbKeyPath } | undefined {
  if (typeof IDBKeyRange === "undefined") return undefined;
  const coversFields = (keyPath: IdbKeyPath): boolean => {
    const keyFields = keyPathFields(keyPath);
    return keyFields.length === fields.length && keyFields.every((f) => fields.includes(f));
  };
  const indexes = contract.storage.stores[storeName]?.indexes ?? {};
  for (const [indexName, indexDef] of Object.entries(indexes)) {
    if (indexDef.multiEntry !== true && coversFields(indexDef.keyPath)) return { indexName, keyPath: indexDef.keyPath };
  }
  const primaryKey = getKeyPath(contract, modelName);
  return coversFields(primaryKey) ? { keyPath: primaryKey } : undefined;
}
