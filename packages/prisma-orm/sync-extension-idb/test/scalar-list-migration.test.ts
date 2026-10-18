import { IDBFactory } from "fake-indexeddb";
import { expect, it } from "vitest";
import { computeMigrationHash } from "@prisma/orm-toolchain/migration-tools/hash";
import type { MigrationPackage } from "@prisma/orm-framework/components/control";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamily from "@prisma-idb/family-idb/pack";
import idbTarget from "@prisma-idb/target-idb/pack";
import { IdbMigrationPlanner } from "@prisma-idb/target-idb/migration";
import { createAutoMigratingSyncIdbClient } from "../src/exports/client";
import { idbSyncExtension } from "../src/exports/control";
import { buildContractSpaceFixture } from "./_contract-space-fixture";
import { asAccessors, scanAll } from "./helpers";

const oldContract = defineContract({
  family: idbFamily,
  target: idbTarget,
  models: { Sample: { store: "samples", key: "id", fields: { id: "String", name: "String" } } },
});
const newContract = defineContract({
  family: idbFamily,
  target: idbTarget,
  models: {
    Sample: {
      store: "samples",
      key: "id",
      fields: { id: "String", name: "String", tags: "String[]" },
      defaults: { tags: [] },
    },
  },
});

it("backfills stored rows and pending creates, preserves sparse patches, and tracks resolved list updates", async () => {
  const options = { factory: new IDBFactory(), dbName: "scalar-list-migration", extensions: [idbSyncExtension] };
  const baseline = buildContractSpaceFixture(oldContract);
  const old = await createAutoMigratingSyncIdbClient({ ...options, contractSpace: baseline });
  await asAccessors(old.orm)["samples"]!.create({ id: "create", name: "Created" });
  await asAccessors(old.rawClient.orm)["samples"]!.create({ id: "update", name: "Before" });
  await asAccessors(old.orm)["samples"]!.where({ id: "update" }).update({ name: "Edited" });
  await old.close();
  const planned = new IdbMigrationPlanner().plan({
    contract: newContract,
    fromContract: oldContract,
    origin: null,
    statements: [],
    schema: null,
    frameworkComponents: [],
    spaceId: "app",
    policy: { allowedOperationClasses: ["additive", "widening", "destructive", "data"] },
  });
  if (planned.kind !== "success") throw new Error("Expected a successful migration plan");
  const ops = planned.plan.operations as unknown as MigrationPackage["ops"];
  const metadata = {
    from: oldContract.storage.storageHash,
    to: newContract.storage.storageHash,
    providedInvariants: [],
    createdAt: "2026-10-18T00:00:00.000Z",
  };
  const current = await createAutoMigratingSyncIdbClient({
    ...options,
    contractSpace: {
      contractJson: newContract,
      headRef: { hash: newContract.storage.storageHash, invariants: [] },
      migrations: [
        ...baseline.migrations,
        { dirName: "0001_lists", metadata: { ...metadata, migrationHash: computeMigrationHash(metadata, ops) }, ops },
      ],
    },
  });
  try {
    const events = await scanAll(current, "_idb_sync_outbox");
    expect(events.find((event) => event["operation"] === "create")?.["payload"]).toEqual({
      id: "create",
      name: "Created",
      tags: [],
    });
    expect(events.find((event) => event["operation"] === "update")?.["payload"]).toEqual({
      key: "update",
      patch: { name: "Edited" },
    });
    expect(await asAccessors(current.orm)["samples"]!.findUnique("update")).toEqual({
      id: "update",
      name: "Edited",
      tags: [],
    });
    await current.orm["samples"]!.where({ id: "update" }).update((u) => [u["tags"]!.push("queued")]);
    expect(await scanAll(current, "_idb_sync_outbox")).toContainEqual(
      expect.objectContaining({ payload: { key: "update", patch: { tags: ["queued"] } } })
    );
  } finally {
    await current.close();
  }
});
