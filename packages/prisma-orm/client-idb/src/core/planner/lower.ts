import type { PlanMeta } from "@prisma/orm-framework/contract/types";
import { evaluateFilter } from "@prisma-idb/adapter-idb/runtime";
import type { IdbAtomicPlan, IdbPlanBody, IdbRowFilter } from "@prisma-idb/driver-idb/runtime";
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

/** Lower row access without creating IDBKeyRange objects or awaiting work. */
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
      // Reapply the original predicate even for exact plans and key lookups.
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
