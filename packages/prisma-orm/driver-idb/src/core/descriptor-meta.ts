import type { DriverDescriptor } from "@prisma/orm-framework/components/components";

export const idbDriverDescriptorMeta = {
  kind: "driver",
  familyId: "idb",
  targetId: "idb",
  id: "idb",
  version: "0.0.1",
  capabilities: {},
} as const satisfies DriverDescriptor<"idb", "idb">;
