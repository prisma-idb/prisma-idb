import type { IdbFilterExpr, IdbGroupByAst, IdbQueryAst } from "@prisma-idb/adapter-idb/runtime";
import {
  assertValidAggregateSpec,
  computeAggregateSpec,
  createAggregateBuilder,
  toAggregateRequests,
} from "./aggregate-builder";
import { fieldValueToken } from "./types";
import type { DefaultModelRow, IdbAggregateBuilder, IdbAggregateResult, IdbAggregateSpec } from "./types";

/**
 * One grouped-aggregate result row: the group-key fields picked from the model
 * row, intersected with the aggregate aliases.
 */
export type GroupedResultRow<
  TContract,
  ModelName extends string,
  Fields extends readonly string[],
  Spec extends IdbAggregateSpec,
> = Pick<DefaultModelRow<TContract, ModelName>, Fields[number] & keyof DefaultModelRow<TContract, ModelName>> &
  IdbAggregateResult<Spec>;

/**
 * Grouped-aggregate builder returned by `accessor.groupBy(...)`.
 *
 * Port of the vendor `GroupedCollection` (`sql-orm-client/grouped-collection.ts`),
 * but purely in-memory: there is no SQL compilation, so `aggregate()`
 * materialises the matching rows, partitions them by the group-key fields, and
 * reduces each partition with the requested selectors.
 */
export interface IdbGroupedAccessor<TContract, ModelName extends string, Fields extends readonly string[]> {
  /**
   * Reduce each group to one row of `{ ...groupKeyFields, ...aggregates }`.
   *
   * @example
   * ```ts
   * const byUser = await db.posts
   *   .where({ published: true })
   *   .groupBy("authorId")
   *   .aggregate((agg) => ({ count: agg.count(), totalViews: agg.sum("views") }));
   * // [{ authorId: "u1", count: 3, totalViews: 120 }, ...]
   * ```
   */
  aggregate<Spec extends IdbAggregateSpec>(
    fn: (agg: IdbAggregateBuilder<TContract, ModelName>) => Spec
  ): Promise<Array<GroupedResultRow<TContract, ModelName, Fields, Spec>>>;
}

/** Runtime wiring handed to {@link createGroupedAccessor} by the store accessor. */
interface GroupedAccessorInit {
  readonly modelName: string;
  /** Group-key fields, in declaration order. */
  readonly by: readonly string[];
  /** Combined `where` expression carried over from the source accessor, if any. */
  readonly where: IdbFilterExpr | undefined;
  /**
   * Materialise all rows matching the source filters. The store accessor owns
   * plan-building; the grouped accessor only supplies the AST it wants attached
   * (for middleware visibility) and does the in-memory grouping.
   */
  readonly materialize: (ast: IdbQueryAst) => Promise<Record<string, unknown>[]>;
}

/**
 * Build a composite group key from type-tagged field tokens. Equal Date, binary,
 * array and JSON object values share a group; null and undefined also share a group.
 */
function groupKeyOf(by: readonly string[], row: Record<string, unknown>): string {
  return JSON.stringify(by.map((field) => groupToken(row[field])));
}

/** Keep `1n`, `1` and `"1"` apart while preserving structural grouping for JSON objects. */
function groupToken(value: unknown): readonly [string, unknown] {
  // Invalid Dates serialize as null, so give them a separate token.
  if (value instanceof Date && Number.isNaN(value.getTime())) return ["date", "invalid"];
  const token = fieldValueToken(value ?? null);
  return [typeof token, typeof token === "object" ? token : String(token)];
}

/** Build a grouped accessor that reduces materialized rows from the source accessor. */
export function createGroupedAccessor<TContract, ModelName extends string, Fields extends readonly string[]>(
  init: GroupedAccessorInit
): IdbGroupedAccessor<TContract, ModelName, Fields> {
  return {
    async aggregate<Spec extends IdbAggregateSpec>(
      fn: (agg: IdbAggregateBuilder<TContract, ModelName>) => Spec
    ): Promise<Array<GroupedResultRow<TContract, ModelName, Fields, Spec>>> {
      const spec = fn(createAggregateBuilder<TContract, ModelName>());
      assertValidAggregateSpec(spec, "groupBy().aggregate()");

      const ast: IdbGroupByAst = {
        kind: "groupBy",
        modelName: init.modelName,
        by: init.by,
        aggregates: toAggregateRequests(spec),
        ...(init.where !== undefined ? { where: init.where } : {}),
      };

      const rows = await init.materialize(ast);

      // Partition rows by their composite group key, preserving first-seen order.
      const groups = new Map<string, { key: Record<string, unknown>; rows: Record<string, unknown>[] }>();
      for (const row of rows) {
        const gk = groupKeyOf(init.by, row);
        let group = groups.get(gk);
        if (group === undefined) {
          const key: Record<string, unknown> = {};
          for (const field of init.by) key[field] = row[field];
          group = { key, rows: [] };
          groups.set(gk, group);
        }
        group.rows.push(row);
      }

      return Array.from(groups.values()).map(
        (group) =>
          ({ ...group.key, ...computeAggregateSpec(spec, group.rows) }) as GroupedResultRow<
            TContract,
            ModelName,
            Fields,
            Spec
          >
      );
    },
  };
}
