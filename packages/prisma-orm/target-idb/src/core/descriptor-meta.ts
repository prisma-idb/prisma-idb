import type { TargetDescriptor } from "@prisma/orm-framework/components/components";
import { codecDescriptors } from "./codecs";

/**
 * Descriptor metadata for the IndexedDB target.
 *
 * This is the identity record for the `idb` target within the `idb` family.
 * It is consumed by:
 * - The family descriptor (`family-idb`) to register this target in the control stack.
 * - The emitter during contract generation to stamp `contract.target = 'idb'`.
 *
 * `types.codecTypes.import` tells the emitter where to import `CodecTypes`
 * when generating `contract.d.ts`. The named export `CodecTypes` must be
 * re-exported from the `pack` entrypoint of this package.
 *
 * Targets are identifiers/descriptors — they do NOT declare capabilities.
 * Capabilities belong on the adapter descriptor.
 */
export const idbTargetDescriptorMeta = {
  kind: "target",
  familyId: "idb",
  targetId: "idb",
  id: "idb",
  version: "0.0.1",
  types: {
    codecTypes: {
      import: {
        package: "@prisma-idb/target-idb/pack",
        named: "CodecTypes",
        alias: "IdbCodecTypes",
      },
      codecDescriptors,
    },
  },
} as const satisfies TargetDescriptor<"idb", "idb">;
