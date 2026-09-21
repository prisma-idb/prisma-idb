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
      /** Compound keys are forbidden by sync ownership invariants. */
      compoundKeys: false,
    },
  },
} satisfies AdapterDescriptor<"idb", "idb">;
