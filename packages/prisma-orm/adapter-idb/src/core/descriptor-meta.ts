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
       * Storage-level compound keys and indexes: `keyPath` may be an array.
       * The sync ownership DAG in `@prisma-idb/sync-server` has its own,
       * narrower limit and enforces it there.
       */
      compoundKeys: true,
    },
  },
} satisfies AdapterDescriptor<"idb", "idb">;
