import { computeProfileHash, computeStorageHash } from "@prisma/orm-framework/contract/hashing";
import type { Contract } from "@prisma/orm-framework/contract/types";
import { UNBOUND_DOMAIN_NAMESPACE_ID } from "@prisma/orm-framework/contract/types";
import type { IdbStorage } from "@prisma-idb/target-idb/pack";

type RawStoreSpec = {
  keyPath: string;
  autoIncrement?: boolean;
  indexes?: Record<string, { keyPath: string; unique: boolean; multiEntry?: boolean }>;
};

/**
 * Build a raw 0.12.0-shape IDB contract with the given object stores and an
 * (optionally empty) model set. Replaces the removed
 * `@prisma/orm-framework/contract/testing#createContract` helper.
 *
 * v0.12.0 (ADR 221): models live under `domain.namespaces.<ns>.models` and the
 * storage block carries a symmetric `namespaces` map; IDB uses the single
 * unbound namespace.
 */
export function createRawIdbContract(
  stores: Record<string, RawStoreSpec>,
  models: Record<string, unknown> = {}
): Contract<IdbStorage> {
  const ns = UNBOUND_DOMAIN_NAMESPACE_ID;
  const storageBlock = { stores, namespaces: { [ns]: { id: ns, entries: {} } } };
  const capabilities = { idb: { ddlOnlyInUpgrade: true, transactionalDDL: true } };
  const storageHash = computeStorageHash({ target: "idb", targetFamily: "idb", storage: storageBlock });
  const profileHash = computeProfileHash({ target: "idb", targetFamily: "idb", capabilities });

  return {
    target: "idb",
    targetFamily: "idb",
    roots: {},
    domain: { namespaces: { [ns]: { models } } } as unknown as Contract<IdbStorage>["domain"],
    storage: { ...storageBlock, storageHash } as IdbStorage,
    capabilities,
    extensions: {},
    meta: {},
    profileHash,
  };
}
