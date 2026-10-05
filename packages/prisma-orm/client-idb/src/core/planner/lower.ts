import type { PlanMeta } from "@prisma/orm-framework/contract/types";
import { evaluateFilter } from "@prisma-idb/adapter-idb/runtime";
import type { IdbAtomicPlan, IdbKeyRangeDescriptor, IdbPlanBody, IdbRowFilter } from "@prisma-idb/driver-idb/runtime";
import { buildRowComparator } from "../query-shaping";
import type { QueryCatalog } from "./catalog";
import type { LogicalPlan, PlanRequest } from "./plan";

/** Row shaping inputs. Pagination applies after the full filter. */
export interface RowsRequest extends PlanRequest {
  readonly skip?: number;
}

/** One driver operation and the synchronous shaping of its combined result. */
export interface LoweredRows {
  readonly idbPlan: IdbPlanBody;
  finish(rows: Record<string, unknown>[]): Record<string, unknown>[];
}

/**
 * Lower row access without creating IDBKeyRange objects or awaiting work.
 * Run `finish` after the executor has materialized all returned rows.
 * Without `orderBy`, row order and pagination selection are unspecified.
 * Rows tied on every ordering field may appear in any order, including at
 * pagination boundaries. Add a unique ordering field for deterministic pages.
 */
export function lowerRows(
  catalog: QueryCatalog,
  logical: LogicalPlan,
  meta: PlanMeta,
  request: RowsRequest,
  additionalFilter?: IdbRowFilter
): LoweredRows {
  const filter: IdbRowFilter = (row) =>
    (request.where === undefined || evaluateFilter(request.where, row)) &&
    (additionalFilter === undefined || additionalFilter(row));
  const comparator = logical.direction === undefined ? buildRowComparator(request.orderBy) : undefined;
  const base = { meta, storeName: catalog.storeName };
  const pagination = {
    ...(request.skip === undefined ? {} : { skip: request.skip }),
    ...(request.take === undefined ? {} : { take: request.take }),
  };
  let shapedByDriver = false;
  let idbPlan: IdbPlanBody;
  switch (logical.access.kind) {
    case "empty":
      idbPlan = { meta, kind: "batch", storeNames: [catalog.storeName], ops: [] };
      break;
    case "full":
      idbPlan = {
        ...base,
        kind: "cursor-scan",
        filter,
        ...(comparator === undefined ? {} : { comparator }),
        ...pagination,
      };
      shapedByDriver = true;
      break;
    case "ranges": {
      const { source } = logical.access;
      const ranges = [...logical.access.ranges];
      if (logical.direction === "prev") ranges.reverse();
      const single = ranges.length === 1;
      const ops: IdbAtomicPlan[] = ranges.map((range) => {
        if (range?.kind === "only" && source.indexName === undefined)
          return { ...base, kind: "key-get", key: range.key };
        const access = {
          ...base,
          ...(source.indexName === undefined ? {} : { indexName: source.indexName }),
          ...(range === undefined ? {} : { range }),
        };
        if (!single && logical.direction !== undefined && request.take !== undefined) {
          // Any row in the global page is within the first skip + take matches
          // of its range. Bound each cursor, then paginate the combined rows.
          return {
            ...access,
            kind: "cursor-scan",
            direction: logical.direction,
            filter,
            take: (request.skip ?? 0) + request.take,
          };
        }
        if (single && request.take !== undefined) {
          shapedByDriver = true;
          return {
            ...access,
            kind: "cursor-scan",
            filter,
            ...(logical.direction === undefined ? {} : { direction: logical.direction }),
            ...(comparator === undefined ? {} : { comparator }),
            ...pagination,
          };
        }
        // getAll has no descending traversal; a cursor preserves planned order.
        if (logical.direction === "prev") return { ...access, kind: "cursor-scan", direction: "prev", filter };
        return { ...access, kind: "get-all" };
      });
      idbPlan = single ? ops[0]! : { meta, kind: "batch", storeNames: [catalog.storeName], ops };
      break;
    }
  }
  return {
    idbPlan,
    finish(rows) {
      // Keep the full-filter safety boundary for every access path. Cursor
      // paths also filter before pagination, so their returned rows pass twice.
      let result = rows.filter(filter);
      if (!shapedByDriver) {
        if (comparator !== undefined) result.sort(comparator);
        const skip = request.skip ?? 0;
        result = result.slice(skip, request.take === undefined ? undefined : skip + request.take);
      }
      return result;
    },
  };
}

/** One driver operation and the synchronous reduction of its result to a row count. */
export interface LoweredCount {
  readonly idbPlan: IdbPlanBody;
  finish(rows: Record<string, unknown>[]): number;
}

/** One driver operation and the synchronous reduction of its result to a yes or no. */
export interface LoweredExists {
  readonly idbPlan: IdbPlanBody;
  finish(rows: Record<string, unknown>[]): boolean;
}

/**
 * Lower a row count. An `exact` plan counts index entries and loads no rows.
 * The planner emits disjoint ranges on a non-multi-entry source, so each row
 * is counted once. Anything else counts the rows that pass the filter.
 * Pagination and `additionalFilter` always take the row path.
 */
export function lowerCount(
  catalog: QueryCatalog,
  logical: LogicalPlan,
  meta: PlanMeta,
  request: RowsRequest,
  additionalFilter?: IdbRowFilter
): LoweredCount {
  const paginated = request.skip !== undefined || request.take !== undefined;
  if (!logical.exact || paginated || additionalFilter !== undefined) {
    const lowered = lowerRows(catalog, logical, meta, request, additionalFilter);
    return { idbPlan: lowered.idbPlan, finish: (rows) => lowered.finish(rows).length };
  }
  return {
    idbPlan: combine(
      catalog,
      meta,
      accessOps(catalog, meta, logical, (target) => ({ ...target, kind: "count" }))
    ),
    finish: (rows) => rows.reduce((total, row) => total + (row["count"] as number), 0),
  };
}

/**
 * Lower an existence check. An `exact` plan reads one primary key per range
 * and loads no rows. Anything else stops each range at its first row that
 * passes the filter.
 */
export function lowerExists(
  catalog: QueryCatalog,
  logical: LogicalPlan,
  meta: PlanMeta,
  request: PlanRequest,
  additionalFilter?: IdbRowFilter
): LoweredExists {
  if (logical.exact && additionalFilter === undefined) {
    return {
      idbPlan: combine(
        catalog,
        meta,
        accessOps(catalog, meta, logical, (target) => ({ ...target, kind: "keys", take: 1 }))
      ),
      finish: (rows) => rows.length > 0,
    };
  }
  const filter: IdbRowFilter = (row) =>
    (request.where === undefined || evaluateFilter(request.where, row)) &&
    (additionalFilter === undefined || additionalFilter(row));
  return {
    idbPlan: combine(
      catalog,
      meta,
      accessOps(catalog, meta, logical, (target) => ({ ...target, kind: "cursor-scan", filter, take: 1 }))
    ),
    finish: (rows) => rows.some(filter),
  };
}

interface AccessTarget {
  readonly meta: PlanMeta;
  readonly storeName: string;
  readonly indexName?: string;
  readonly range?: IdbKeyRangeDescriptor;
}

/** One operation per planned range, in ascending key order. */
function accessOps(
  catalog: QueryCatalog,
  meta: PlanMeta,
  logical: LogicalPlan,
  build: (target: AccessTarget) => IdbAtomicPlan
): IdbAtomicPlan[] {
  const { access } = logical;
  const base = { meta, storeName: catalog.storeName };
  switch (access.kind) {
    case "empty":
      return [];
    case "full":
      return [build(base)];
    case "ranges": {
      const { indexName } = access.source;
      return access.ranges.map((range) =>
        build({
          ...base,
          ...(indexName === undefined ? {} : { indexName }),
          ...(range === undefined ? {} : { range }),
        })
      );
    }
  }
}

function combine(catalog: QueryCatalog, meta: PlanMeta, ops: IdbAtomicPlan[]): IdbPlanBody {
  return ops.length === 1 ? ops[0]! : { meta, kind: "batch", storeNames: [catalog.storeName], ops };
}
