import type { TargetDescriptor } from "@prisma/orm-framework/components/components";
import { codecDescriptors } from "./codecs";
import { idbDataTypes } from "./data-types";

/**
 * Descriptor metadata for the IndexedDB target.
 *
 * This is the identity record for the `idb` target within the `idb` family.
 * It is consumed by:
 * - The family descriptor (`family-idb`) to register this target in the control stack.
 * - The emitter during contract generation to stamp `contract.target = 'idb'`.
 *
 * `dataTypes` registers the data type every IDB codec names (ADR 254); the
 * framework refuses to assemble a stack with a codec whose type is unregistered.
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
  dataTypes: idbDataTypes,
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
