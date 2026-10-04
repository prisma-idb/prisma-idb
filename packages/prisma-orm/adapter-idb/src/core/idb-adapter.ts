import type { CodecLookup } from "@prisma/orm-framework/components/codec";
import type { IdbPlanBody } from "@prisma-idb/driver-idb/runtime";
import type { IdbQueryPlan } from "./idb-query-plan";
import type { IdbLowererContext, IdbRuntimeAdapterInstance } from "./runtime-adapter-instance";

/**
 * Concrete IDB runtime adapter.
 *
 * Implements {@link IdbRuntimeAdapterInstance} — the `lower()` method that
 * translates an {@link IdbQueryPlan} into an {@link IdbPlanBody} ready for
 * the driver.
 *
 * `lower()` is a structural passthrough: the `idbPlan` carried by
 * `IdbQueryPlan` is already execution-ready because IDB has no query
 * language to compile from. Every current `idb/*` codec is an identity
 * transform for stored values, so no field needs encoding.
 */
export class IdbAdapter implements IdbRuntimeAdapterInstance {
  readonly familyId = "idb" as const;
  readonly targetId = "idb" as const;

  readonly #codecs: CodecLookup;

  constructor(codecs: CodecLookup) {
    this.#codecs = codecs;
  }

  lower(plan: IdbQueryPlan, ctx: IdbLowererContext): Promise<IdbPlanBody> {
    // If a codec ever transforms stored values, encode plan.idbPlan's
    // record and key fields here: resolve each field's codec through
    // this.#codecs and ctx.contract, then call codec.encode(value, ctx).
    void this.#codecs; // codec registry for per-field encoding
    void ctx.contract; // contract storage schema (field→codec resolution)
    void ctx.signal; // AbortSignal for cooperative cancellation
    return Promise.resolve(plan.idbPlan);
  }
}
