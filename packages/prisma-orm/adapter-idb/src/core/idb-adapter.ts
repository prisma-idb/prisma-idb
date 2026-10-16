import type { CodecLookup } from "@prisma/orm-framework/components/codec";
import { canonicalStringify } from "@prisma/orm-framework/utils/canonical-stringify";
import type { IdbLoweredPlan, IdbQueryPlan } from "./idb-query-plan";
import type { IdbLowererContext, IdbRuntimeAdapterInstance } from "./runtime-adapter-instance";

/**
 * Concrete IDB runtime adapter.
 *
 * Implements {@link IdbRuntimeAdapterInstance} — the `lower()` method that
 * translates an {@link IdbQueryPlan} into an {@link IdbLoweredPlan} ready for
 * the driver.
 *
 * `lower()` preserves the driver operation: the `idbPlan` carried by
 * `IdbQueryPlan` is already execution-ready because IDB has no query
 * language to compile from. Every current `idb/*` codec is an identity
 * transform for stored values, so no field needs encoding. Structured AST
 * filters and sort specifications become canonical closure identities for
 * middleware; the driver remains independent of the query layer.
 *
 * The `codecs` constructor parameter matches the framework adapter shape and
 * is the extension point for field encoding with non-identity codecs.
 */
export class IdbAdapter implements IdbRuntimeAdapterInstance {
  readonly familyId = "idb" as const;
  readonly targetId = "idb" as const;

  readonly #codecs: CodecLookup;

  constructor(codecs: CodecLookup) {
    this.#codecs = codecs;
  }

  /** Preserve the driver operation and carry structured closure identity through lowering. */
  lower(plan: IdbQueryPlan, ctx: IdbLowererContext): Promise<IdbLoweredPlan> {
    // If a codec ever transforms stored values, encode plan.idbPlan's
    // record and key fields here: resolve each field's codec through
    // this.#codecs and ctx.contract, then call codec.encode(value, ctx).
    void this.#codecs; // codec registry for per-field encoding
    void ctx.contract; // contract storage schema (field→codec resolution)
    void ctx.signal; // AbortSignal for cooperative cancellation
    const ast = plan.ast;
    if (ast === undefined) return Promise.resolve(plan.idbPlan);

    const filter = "where" in ast ? closureIdentity(ast.where) : undefined;
    // Comparators visit fields in declaration order. Canonicalizing the record
    // itself would sort its keys and lose the priority of multi-field sorts.
    const comparator =
      "orderBy" in ast && ast.orderBy !== undefined ? closureIdentity(Object.entries(ast.orderBy)) : undefined;
    if (filter === undefined && comparator === undefined) return Promise.resolve(plan.idbPlan);

    return Promise.resolve({
      ...plan.idbPlan,
      queryIdentity: {
        ...(filter === undefined ? {} : { filter }),
        ...(comparator === undefined ? {} : { comparator }),
      },
    });
  }
}

/** Leave unsupported structured values opaque so identity generation cannot break a query. */
function closureIdentity(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return canonicalStringify(value);
  } catch {
    return undefined;
  }
}
