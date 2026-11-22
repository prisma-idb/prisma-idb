/**
 * Middleware observes statements inside a transaction: each one is an activity beneath the
 * transaction, and every activity is finalized with the transaction's outcome once IndexedDB
 * commits or aborts it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import type { IdbMiddleware } from "@prisma-idb/runtime-idb/runtime";
import { createAutoMigratingIdbClient } from "../src/exports/client-auto";
import { buildContractSpaceFixture } from "./_contract-space-fixture";

const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: { store: "users", key: "id", fields: { id: "String" } },
    Post: {
      store: "posts",
      key: "id",
      fields: { id: "String", authorId: "String" },
      relations: { author: { to: "User", cardinality: "N:1", on: { local: ["authorId"], target: ["id"] } } },
    },
  },
});

let dbCounter = 0;
const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const client of opened.splice(0)) await client.close();
});

/** A middleware that records each hook as `hook:kind[:detail]`. */
function recorder(events: string[], extra: Partial<IdbMiddleware> = {}): IdbMiddleware {
  return {
    name: "recorder",
    familyId: "idb",
    async activityStarted(activity, ctx) {
      events.push(`started:${activity.kind}:${ctx.scope}`);
    },
    async activityEnded(activity, result) {
      events.push(`ended:${activity.kind}:${result.outcome}`);
    },
    async activityFinalized(activity, result) {
      events.push(`finalized:${activity.kind}:${result.outcome}`);
    },
    ...extra,
  } as IdbMiddleware;
}

async function open(middleware: IdbMiddleware[]) {
  const client = await createAutoMigratingIdbClient({
    contractSpace: buildContractSpaceFixture([contract]),
    dbName: `transaction-middleware-${++dbCounter}`,
    middleware,
  });
  opened.push(client);
  return client;
}

type Accessor = { create(data: Record<string, unknown>): Promise<unknown> };

describe("middleware inside transactions", () => {
  it("reports each statement beneath the transaction and finalizes all of them as committed", async () => {
    const events: string[] = [];
    const client = await open([recorder(events)]);
    await client.transaction(["users"], async (tx) => {
      await (tx["users"] as unknown as Accessor).create({ id: "u1" });
    });
    expect(events.filter((e) => e.split(":")[1] === "transaction")).toEqual([
      "started:transaction:transaction",
      "ended:transaction:succeeded",
      "finalized:transaction:committed",
    ]);
    const statements = events.filter((e) => e.split(":")[1] === "statement");
    expect(statements).toContain("started:statement:transaction");
    expect(statements).toContain("ended:statement:succeeded");
    expect(statements.filter((e) => e.startsWith("finalized:"))).not.toHaveLength(0);
    expect(
      statements.filter((e) => e.startsWith("finalized:")).every((e) => e === "finalized:statement:committed")
    ).toBe(true);
    // Statements are finalized before their transaction, once it has committed.
    expect(events.indexOf("finalized:transaction:committed")).toBe(events.length - 1);
  });

  it("finalizes the statements of an aborted transaction as rolled back", async () => {
    const events: string[] = [];
    const client = await open([recorder(events)]);
    await expect(
      client.transaction(["users"], async (tx) => {
        await (tx["users"] as unknown as Accessor).create({ id: "u1" });
        throw new Error("abort");
      })
    ).rejects.toThrow("abort");
    // `rollback()` is synchronous, so finalization runs right after the abort rather than before the rejection.
    await vi.waitFor(() => expect(events).toContain("finalized:transaction:rolled-back"));
    expect(events).toContain("finalized:statement:rolled-back");
    expect(events).toContain("finalized:transaction:rolled-back");
    expect(events).not.toContain("finalized:statement:committed");
  });

  it("reports a failed statement and finalizes the transaction it aborted as rolled back", async () => {
    const events: string[] = [];
    const client = await open([recorder(events)]);
    await (client.orm["users"] as unknown as Accessor).create({ id: "u1" });
    events.length = 0;
    await expect(
      client.transaction(["users"], async (tx) => {
        await (tx["users"] as unknown as Accessor).create({ id: "u1" });
      })
    ).rejects.toThrow();
    await vi.waitFor(() => expect(events).toContain("finalized:transaction:rolled-back"));
    expect(events).toContain("ended:statement:failed");
    expect(events).not.toContain("finalized:statement:committed");
  });

  it("observes the scoped statements of a delete, which checks referential actions, outside db.transaction()", async () => {
    const events: string[] = [];
    const client = await open([recorder(events)]);
    await (client.orm["users"] as unknown as Accessor).create({ id: "u1" });
    events.length = 0;
    await (client.orm["users"] as unknown as { delete(key: string): Promise<unknown> }).delete("u1");
    expect(events).toContain("started:statement:transaction");
    expect(events).toContain("finalized:transaction:committed");
  });

  it("does not await an async beforeEncode, so a hook that waits cannot hold the transaction", async () => {
    const events: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const client = await open([
      recorder(events, {
        // A hook that waits on something outside IndexedDB would let the transaction commit early if awaited.
        async beforeEncode() {
          await blocked;
        },
      }),
    ]);
    await client.transaction(["users"], async (tx) => {
      await (tx["users"] as unknown as Accessor).create({ id: "u1" });
      await (tx["users"] as unknown as Accessor).create({ id: "u2" });
    });
    release();
    expect(events).toContain("finalized:transaction:committed");
    expect(await client.orm["users"]!.all().toArray()).toHaveLength(2);
  });
});
