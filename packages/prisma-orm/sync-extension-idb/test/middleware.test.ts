/** Sync clients pass `middleware` to their runtime, including for writes that run in a transaction. */
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import type { IdbMiddleware } from "@prisma-idb/runtime-idb/runtime";
import { idbSyncExtension } from "../src/exports/control";
import { createAutoMigratingSyncIdbClient } from "../src/exports/client";
import { buildContractSpaceFixture } from "./_contract-space-fixture";
import { asAccessors } from "./helpers";

const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: { User: { store: "users", key: "id", fields: { id: "String", name: "String" } } },
});

describe("sync client middleware", () => {
  it("reaches the runtime of an auto-migrating sync client", async () => {
    const events: string[] = [];
    const recorder = {
      name: "recorder",
      familyId: "idb",
      async activityFinalized(activity, result) {
        events.push(`${activity.kind}:${result.outcome}`);
      },
    } as IdbMiddleware;
    const client = await createAutoMigratingSyncIdbClient({
      factory: new IDBFactory(),
      dbName: "sync-middleware",
      contractSpace: buildContractSpaceFixture(contract),
      extensions: [idbSyncExtension],
      middleware: [recorder],
    });
    try {
      await asAccessors(client.orm)["users"]!.create({ id: "u1", name: "A" });
      expect(events).toContain("statement:committed");
      // The transaction also writes the outbox event of the create inside it.
      await client.transaction(["users"], async (tx) => {
        await (tx as unknown as Record<string, { create(data: object): Promise<unknown> }>)["users"]!.create({
          id: "u2",
          name: "B",
        });
      });
      expect(events).toContain("transaction:committed");
    } finally {
      await client.close();
    }
  });
});
