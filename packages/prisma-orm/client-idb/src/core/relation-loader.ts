import type { ContractReferenceRelation } from "@prisma/orm-framework/contract/types";
import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import type { IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import { evaluateFilter } from "@prisma-idb/adapter-idb/runtime";
import type { IdbRowFilter } from "@prisma-idb/driver-idb/runtime";
import type { IdbQueryExecutor } from "./executor";
import { buildRowComparator, combineFilterExprs } from "./query-shaping";
import type { IncludeEntry } from "./store-state";
import { fieldValueToken, getStoreName } from "./types";
import type { IdbContract } from "./types";

/**
 * Batch-load a single named relation for all rows in `rows` and attach the
 * result to each row under the `relName` key.
 *
 * The join matches every field of the relation, so compound foreign keys join
 * on the whole tuple. It runs one scan of the related store for all parents,
 * then groups the rows in memory, which avoids N+1 queries.
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

  // One scan for every parent: keep rows whose target tuple belongs to some
  // parent and that pass the refined `where`.
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
  const relatedRows: Record<string, unknown>[] = [];
  for await (const row of executor.query(plan)) {
    relatedRows.push(row);
  }

  return attachRelatedRows(relName, entry, rows, relatedRows, relation);
}

/** Attach related rows by their join tuple, shaping each parent's collection independently. */
function attachRelatedRows(
  relName: string,
  entry: IncludeEntry,
  rows: Record<string, unknown>[],
  relatedRows: Record<string, unknown>[],
  relation: ContractReferenceRelation
): Record<string, unknown>[] {
  const {
    cardinality,
    on: { localFields, targetFields },
  } = relation;
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

    if (entry.kind === "scalar") {
      // Counts include all filtered children, without collection pagination.
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
