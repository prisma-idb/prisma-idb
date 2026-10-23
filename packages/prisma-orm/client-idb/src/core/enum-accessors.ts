import { buildNamespacedEnums, type NamespacedEnums } from "@prisma/orm-framework/contract";
import { idbCodecLookup } from "@prisma-idb/target-idb/runtime";
import type { IdbContract } from "./types";

/** Build upstream enum accessors using the same codecs as IDB query results. */
export function createIdbEnums<TContract extends IdbContract>(contract: TContract): NamespacedEnums<TContract> {
  return buildNamespacedEnums<TContract>(contract.domain, (codecId) => {
    const codec = idbCodecLookup.get(codecId);
    if (codec === undefined) throw new Error(`Unknown IDB enum codec "${codecId}".`);
    return codec;
  });
}
