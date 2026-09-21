// THIS FILE IS AUTO-GENERATED — do not edit by hand.
// Regenerate with: prisma-idb migration contract-space

import type { Contract } from "./contract";
import { contractSpaceFromJson } from "@prisma/orm-toolchain/migration-tools/spaces";
import contractJson from "./contract.json" with { type: "json" };
import mig_20260823T0943_baseline_meta from "../../../migrations/app/20260823T0943_baseline/migration.json" with { type: "json" };
import mig_20260823T0943_baseline_ops from "../../../migrations/app/20260823T0943_baseline/ops.json" with { type: "json" };
import mig_20260823T0943_add_tag_meta from "../../../migrations/app/20260823T0943_add_tag/migration.json" with { type: "json" };
import mig_20260823T0943_add_tag_ops from "../../../migrations/app/20260823T0943_add_tag/ops.json" with { type: "json" };

export const contractSpace = contractSpaceFromJson<Contract>({
  contractJson,
  migrations: [
    {
      dirName: "20260823T0943_baseline",
      metadata: mig_20260823T0943_baseline_meta,
      ops: mig_20260823T0943_baseline_ops,
    },
    { dirName: "20260823T0943_add_tag", metadata: mig_20260823T0943_add_tag_meta, ops: mig_20260823T0943_add_tag_ops },
  ],
  headRef: {
    hash: mig_20260823T0943_add_tag_meta.to,
    invariants: (mig_20260823T0943_add_tag_meta.providedInvariants ?? []) as readonly string[],
  },
});
