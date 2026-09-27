import type { AdapterDescriptor } from "@prisma/orm-framework/components/components";

export const idbAdapterDescriptorMeta = {
  kind: "adapter",
  familyId: "idb",
  targetId: "idb",
  id: "idb",
  version: "0.0.1",
  capabilities: {
    idb: {
      /** IDB's `upgradeneeded` callback IS a version-change transaction. */
      transactionalDDL: true,
      /** DDL can ONLY run inside `upgradeneeded` — never at query time. */
      ddlOnlyInUpgrade: true,
      /** IDB has no RETURNING clause. */
      returning: false,
      /**
       * Storage-level compound keys/indexes (Phase 9.1/9.2 —
       * `IdbStoreDefinition`/`IdbIndexDefinition.keyPath` accept an array).
       * This describes the `idb` adapter itself, not any optional add-on:
       * `@prisma-idb/sync-server`'s ownership DAG (used by
       * `sync-extension-idb`) separately does not support compound-keyed
       * models yet — `getKeyField` throws for anything but a single string
       * `keyPath` — but that's a `sync-server`-specific limitation enforced
       * (and documented) there, not a capability of this adapter/target
       * stack, and targets don't declare capabilities of their own (see
       * `target-idb/src/core/descriptor-meta.ts`) for a narrower consumer
       * to override this with.
       */
      compoundKeys: true,
    },
  },
} satisfies AdapterDescriptor<"idb", "idb">;
