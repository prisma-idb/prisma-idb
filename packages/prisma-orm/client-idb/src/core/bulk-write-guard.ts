import type { IdbAccessorState } from "./store-state";

/** The bulk writes that change every row matching the filter. */
export type IdbBulkWriteMethod = "updateAll" | "updateCount" | "deleteAll" | "deleteCount";

/**
 * A bulk write was called on a collection with `skip()` or `take()`.
 *
 * A bulk write changes every row that matches the filter, so it can't apply an offset or a limit. Without this
 * error it would change more rows than the chain asks for.
 */
export class IdbBulkWriteError extends Error {
  constructor(
    readonly modelName: string,
    readonly method: IdbBulkWriteMethod,
    readonly skip: number | undefined,
    readonly take: number | undefined
  ) {
    const parts = [
      skip === undefined ? [] : [["an offset", "skip()"]],
      take === undefined ? [] : [["a limit", "take()"]],
    ]
      .flat()
      .map(([noun, call]) => ({ noun: noun!, call: call! }));
    const nouns = parts.map((p) => p.noun).join(" and ");
    const calls = parts.map((p) => p.call).join(" and ");
    super(
      `Cannot ${method} ${modelName}: the collection has ${nouns}. ${method} changes every row that matches the filter, so it would change more rows than the chain asks for. Remove ${calls} before ${method}, or read the rows first and change them by their ids.`
    );
    this.name = "IdbBulkWriteError";
  }
}

/** Reject a bulk write on a collection whose `skip()` or `take()` it would ignore. */
export function assertBulkWriteIgnoresNothing(
  state: IdbAccessorState,
  modelName: string,
  method: IdbBulkWriteMethod
): void {
  if (state.skip === undefined && state.take === undefined) return;
  throw new IdbBulkWriteError(modelName, method, state.skip, state.take);
}
