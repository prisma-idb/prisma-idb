import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createIDBRuntimeDriver,
  MARKER_STORE_NAME,
  type IdbMarkerRecord as DriverMarker,
} from "@prisma-idb/driver-idb/runtime";
import { IdbMigrationPlanner } from "@prisma-idb/target-idb/migration";
import { openAndUpgrade, isIdbDdlOp, type IdbMarkerRecord as TargetMarker } from "@prisma-idb/target-idb/runtime";

describe("migration and runtime marker compatibility", () => {
  it("writes a marker that the runtime driver can read without changing its shape", async () => {
    const result = new IdbMigrationPlanner().plan({
      contract: { storage: { storageHash: "sha256:storage", stores: {} } },
      schema: null,
      policy: { allowedOperationClasses: ["additive"] },
      fromContract: null,
      frameworkComponents: [],
      spaceId: "app",
    });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") throw new Error("Marker migration planning failed");
    const operations = await Promise.all(result.plan.operations);
    expect(operations).toEqual([
      expect.objectContaining({ kind: "createObjectStore", storeName: MARKER_STORE_NAME, def: { keyPath: "space" } }),
    ]);
    expectTypeOf<keyof TargetMarker>().toEqualTypeOf<keyof DriverMarker>();
    // The reader permits missing metadata for older records; every writer field must fit it.
    expectTypeOf<TargetMarker>().toExtend<DriverMarker>();

    const dbName = "marker-compatibility-test";
    await openAndUpgrade({
      factory: indexedDB,
      dbName,
      targetVersion: 1,
      ops: operations.filter(isIdbDdlOp),
      markers: [
        {
          space: "app",
          storageHash: "sha256:storage",
          profileHash: "sha256:profile",
          invariants: ["schema"],
          contractJson: { target: "idb" },
          canonicalVersion: 1,
          appTag: "test",
          meta: { migration: "initial" },
        },
      ],
    });

    const driver = createIDBRuntimeDriver(dbName, 1).create();
    try {
      expect(await driver.readMarker()).toEqual({
        space: "app",
        storageHash: "sha256:storage",
        profileHash: "sha256:profile",
        updatedAt: expect.any(Date),
        invariants: ["schema"],
        contractJson: { target: "idb" },
        canonicalVersion: 1,
        appTag: "test",
        meta: { migration: "initial" },
      });
    } finally {
      await driver.close();
    }
  });
});
