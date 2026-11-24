/** Sync clients pass `middleware` to their runtime, including for writes that run in a transaction. */
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
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
  async function open(dbName: string, middleware: IdbMiddleware[]) {
    return createAutoMigratingSyncIdbClient({
      factory: new IDBFactory(),
      dbName,
      contractSpace: buildContractSpaceFixture(contract),
      extensions: [idbSyncExtension],
      middleware,
    });
  }

  it("reaches both the runtime path and the transaction path of an auto-migrating sync client", async () => {
    const events: string[] = [];
    const recorder = {
      name: "recorder",
      familyId: "idb",
      async activityStarted(activity, ctx) {
        events.push(`${activity.kind}:${ctx.scope}`);
      },
    } as IdbMiddleware;
    const client = await open("sync-middleware", [recorder]);
    try {
      // A plain read and write go through the runtime's query path, outside any transaction.
      await asAccessors(client.orm)["users"]!.create({ id: "u1", name: "A" });
      await asAccessors(client.orm)["users"]!.findUnique("u1");
      expect(events).toContain("statement:runtime");
      expect(events).not.toContain("statement:transaction");
      expect(events).not.toContain("transaction:transaction");
      events.length = 0;
      await client.transaction(["users"], async (tx) => {
        await (tx as unknown as Record<string, { create(data: object): Promise<unknown> }>)["users"]!.create({
          id: "u2",
          name: "B",
        });
      });
      // The transaction also writes the outbox event, so it runs more than the one create.
      expect(events).toContain("transaction:transaction");
      expect(events.filter((e) => e === "statement:transaction").length).toBeGreaterThan(1);
    } finally {
      await client.close();
    }
  });

  it("still saves the data and notifies outboxwrite when a transaction middleware hook throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new Error("ended failed");
    const thrower = {
      name: "thrower",
      familyId: "idb",
      async activityEnded(activity) {
        if (activity.kind === "transaction") throw failure;
      },
    } as IdbMiddleware;
    const client = await open("sync-middleware-throw", [thrower]);
    try {
      const emitted: number[] = [];
      client.on("outboxwrite", (entries) => emitted.push(entries.length));
      await client.transaction(["users"], async (tx) => {
        await (tx as unknown as Record<string, { create(data: object): Promise<unknown> }>)["users"]!.create({
          id: "u1",
          name: "A",
        });
      });
      expect(emitted).toEqual([1]);
      expect(await asAccessors(client.orm)["users"]!.count()).toBe(1);
      expect(error).toHaveBeenCalledWith(failure);
    } finally {
      error.mockRestore();
      await client.close();
    }
  });
});
