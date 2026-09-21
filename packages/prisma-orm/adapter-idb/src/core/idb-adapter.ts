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
 * language to compile from. The `codecs` lookup and `ctx.contract` are
 * available for per-field codec encoding when custom codecs (e.g.
 * `idb/date@1`) need to transform field values before they reach the
 * driver. Since all current `idb/*` codecs are identity transforms, the
 * passthrough output is correct for the standard type set.
 */
export class IdbAdapter implements IdbRuntimeAdapterInstance {
  readonly familyId = "idb" as const;
  readonly targetId = "idb" as const;

  readonly #codecs: CodecLookup;

  constructor(codecs: CodecLookup) {
    this.#codecs = codecs;
  }

  lower(plan: IdbQueryPlan, ctx: IdbLowererContext): Promise<IdbPlanBody> {
    // Passthrough: idbPlan is execution-ready as-is since IDB has no query
    // language. When per-field codec encoding is added, walk
    // plan.idbPlan's record/key fields here, resolve each field's codec via
    // this.#codecs + ctx.contract's per-store schema, and call
    // codec.encode(value, ctx) to produce the wire value.
    void this.#codecs; // codec registry for per-field encoding
    void ctx.contract; // contract storage schema (field→codec resolution)
    void ctx.signal; // AbortSignal for cooperative cancellation
    return Promise.resolve(plan.idbPlan);
  }
}
