import { transformOutbox } from "../core/transform-outbox";
import type { IdbExtensionSpace } from "@prisma-idb/family-idb/control";
import { contractSpaceFromJson } from "@prisma/orm-toolchain/migration-tools/spaces";
import contractJson from "../contract.json" with { type: "json" };
import baselineMeta from "../../migrations/20260823T0941_baseline/migration.json" with { type: "json" };
import baselineOps from "../../migrations/20260823T0941_baseline/ops.json" with { type: "json" };
import backfillMeta from "../../migrations/20261011T0518_backfill_outbox_fields/migration.json" with { type: "json" };
import backfillOps from "../../migrations/20261011T0518_backfill_outbox_fields/ops.json" with { type: "json" };
import headRef from "../../migrations/refs/head.json" with { type: "json" };

export const SYNC_SPACE_ID = "idb-sync" as const;

const syncContractSpace = contractSpaceFromJson({
  contractJson,
  migrations: [
    {
      dirName: "20260823T0941_baseline",
      metadata: baselineMeta,
      ops: baselineOps,
    },
    {
      dirName: "20261011T0518_backfill_outbox_fields",
      metadata: backfillMeta,
      ops: backfillOps,
    },
  ],
  headRef: {
    hash: headRef.hash,
    invariants: headRef.invariants as readonly string[],
  },
});

export const idbSyncExtension = {
  spaceId: SYNC_SPACE_ID,
  contractSpace: syncContractSpace,
  onTransformRecords: transformOutbox,
} satisfies IdbExtensionSpace;
