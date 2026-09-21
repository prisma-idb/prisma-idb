import type { ContractReferenceRelation } from "@prisma/orm-framework/contract/types";
import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import type { IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import { evaluateFilter } from "@prisma-idb/adapter-idb/runtime";
import type { IdbRowFilter } from "@prisma-idb/driver-idb/runtime";
import type { IdbQueryExecutor } from "./executor";
import { buildRowComparator, combineFilterExprs } from "./query-shaping";
import type { IncludeEntry } from "./store-state";
import { getIndexForField, getKeyPath, isValidIdbKey } from "./types";
import type { IdbContract } from "./types";

/**
 * Batch-load a single named relation for all rows in `rows` and attach the
 * result to each row under the `relName` key.
 *
 * The join is done with one cursor scan over the related store (with an
 * in-memory filter), then grouped/indexed in memory — avoiding N+1 queries.
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

  const localField = on.localFields[0];
  const foreignField = on.targetFields[0];
  if (localField === undefined || foreignField === undefined) return rows;

  const relatedModel = models[relatedModelName];
  if (relatedModel === undefined) return rows;

  // Resolve the related object store name from the model's storage metadata.
  const relatedStoreName =
    typeof relatedModel.storage === "object" && relatedModel.storage !== null && "storeName" in relatedModel.storage
      ? String((relatedModel.storage as { storeName: unknown })["storeName"])
      : relatedModelName;

  const isScalar = entry.kind === "scalar";

  // Collect all distinct local-field values to drive the in-memory filter.
  const localValues = new Set<unknown>();
  for (const row of rows) {
    const v = row[localField];
    if (v !== undefined && v !== null) localValues.add(v);
  }

  // Short-circuit: if all local values are null/undefined, attach empties.
  // (Scalar counts are 0; to-many is [], to-one is null.)
  if (localValues.size === 0) {
    return rows.map((row) => ({
      ...row,
      [relName]: isScalar ? 0 : cardinality === "1:N" ? [] : null,
    }));
  }

  const capturedForeignField = foreignField;
  const refinedWhere = combineFilterExprs(entry.state.filters);

  const storageHash = contract.storage.storageHash;
  const planMeta = { target: "idb", storageHash, lane: "idb-orm", annotations: { groupingKey } } as const;

  // When an IDB index exists on `foreignField` and IDBKeyRange is available,
  // run one IDBKeyRange.only() point-range scan per distinct FK value. Each
  // scan visits only records with that exact FK, so no membership re-check is
  // needed — only the refined `where` is applied as a row filter.
  // This is correct for any key type; the old bound-range heuristic used
  // JS lexicographic sort which produced wrong lo/hi for numeric keys.
  const fkIndexName =
    typeof IDBKeyRange !== "undefined" ? getIndexForField(contract, relatedStoreName, capturedForeignField) : undefined;

  // The related store's own primary key is never listed in its `indexes` map
  // (it doesn't need a named IDBIndex), but IDBObjectStore.openCursor(range)
  // scans the store's own keyPath directly — just as efficient as an index.
  // Without this, the very common N:1 case (e.g. `Post.author -> User.id`)
  // would miss acceleration entirely and fall back to a full store scan.
  const targetsRelatedPk =
    fkIndexName === undefined &&
    typeof IDBKeyRange !== "undefined" &&
    capturedForeignField === getKeyPath(contract, relatedModelName);

  let relatedRows: Record<string, unknown>[];
  if (fkIndexName !== undefined || targetsRelatedPk) {
    const refinedFilter: IdbRowFilter | undefined =
      refinedWhere !== undefined ? (row: Record<string, unknown>) => evaluateFilter(refinedWhere, row) : undefined;

    // IDBKeyRange.only() throws DataError for invalid keys (boolean, NaN,
    // plain objects, etc.). Such values cannot be stored as IndexedDB keys,
    // so no related rows can match — filter them out before building plans.
    const validValues = Array.from(localValues).filter(isValidIdbKey);

    // One index (or, for a PK target, store-keyspace) scan per distinct FK
    // value — independent, so run concurrently.
    const valueResults = await Promise.all(
      validValues.map(async (value) => {
        const plan: IdbQueryPlan<Record<string, unknown>> = {
          meta: planMeta,
          idbPlan: {
            meta: planMeta,
            kind: "cursor-scan",
            storeName: relatedStoreName,
            ...(fkIndexName !== undefined ? { indexName: fkIndexName } : {}),
            range: IDBKeyRange.only(value),
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
    relatedRows = valueResults.flat();
  } else {
    relatedRows = [];
    // No index: full store scan with an in-memory FK membership + refined-where filter.
    const filter: IdbRowFilter = (row: Record<string, unknown>): boolean =>
      localValues.has(row[capturedForeignField]) && (refinedWhere === undefined || evaluateFilter(refinedWhere, row));
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
    // Group related rows by their foreignField value.
    const grouped = new Map<unknown, Record<string, unknown>[]>();
    for (const rrow of relatedRows) {
      const gk = rrow[capturedForeignField];
      const group = grouped.get(gk) ?? [];
      group.push(rrow);
      grouped.set(gk, group);
    }

    if (isScalar) {
      // Scalar reducer (Phase 6.5: count) — attach the per-parent child count.
      return rows.map((row) => ({
        ...row,
        [relName]: (grouped.get(row[localField]) ?? []).length,
      }));
    }

    // Collection: apply refined orderBy / skip / take per parent group.
    const comparator = buildRowComparator(entry.state.orderBy);
    const skip = entry.state.skip ?? 0;
    const take = entry.state.take;
    return rows.map((row) => {
      let group = grouped.get(row[localField]) ?? [];
      if (comparator !== undefined) group = [...group].sort(comparator);
      if (skip > 0 || take !== undefined) {
        group = group.slice(skip, take !== undefined ? skip + take : undefined);
      }
      return { ...row, [relName]: group };
    });
  }

  // N:1 / 1:1: index related rows by their foreignField value, attach singles.
  // A refined `where` that excludes the related row yields `null` here.
  const indexed = new Map<unknown, Record<string, unknown>>();
  for (const rrow of relatedRows) {
    indexed.set(rrow[capturedForeignField], rrow);
  }
  return rows.map((row) => ({
    ...row,
    [relName]: indexed.get(row[localField]) ?? null,
  }));
}
