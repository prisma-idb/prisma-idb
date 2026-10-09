/**
 * `SyncIdbClient.transaction()` — typed transactions with outbox tracking.
 *
 * `transaction()` records outbox rows for tracked writes in the same IDB
 * transaction. `rawClient.transaction()` is the untracked counterpart.
 */
import { describe, expect, it } from "vitest";
import { asAccessors, createTestSyncClient, scanAll, type TestStoreAccessor } from "./helpers";

type TestTx = Record<string, TestStoreAccessor>;
type LooseTransaction = <T>(rootKeys: string[], fn: (tx: TestTx) => Promise<T>) => Promise<T>;

/** `transaction()` is typed against the contract's roots, which the untyped test contract does not carry. */
function transactionOf(client: { transaction: unknown }): LooseTransaction {
  return client.transaction as LooseTransaction;
}

describe("SyncIdbClient.transaction()", () => {
  it("records outbox rows for every tracked write and notifies once the transaction commits", async () => {
    const { client } = await createTestSyncClient();
    const emitted: number[] = [];
    client.on("outboxwrite", (entries) => emitted.push(entries.length));
    let emittedInsideCallback = -1;

    await transactionOf(client)(["users", "posts"], async (tx) => {
      await tx["users"]!.create({ id: "u1", name: "Alice" });
      await tx["posts"]!.create({ id: "p1", title: "First", authorId: "u1" });
      emittedInsideCallback = emitted.length;
    });

    expect(emittedInsideCallback).toBe(0);
    expect(emitted).toEqual([2]);
    const outbox = await scanAll(client, "_idb_sync_outbox");
    expect(outbox.map((row) => row["entityType"]).sort()).toEqual(["Post", "User"]);
  });

  it("leaves no outbox rows and sends no notification when the callback throws", async () => {
    const { client } = await createTestSyncClient();
    const emitted: number[] = [];
    client.on("outboxwrite", (entries) => emitted.push(entries.length));

    await expect(
      transactionOf(client)(["users"], async (tx) => {
        await tx["users"]!.create({ id: "u1", name: "Alice" });
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(emitted).toEqual([]);
    expect(await scanAll(client, "_idb_sync_outbox")).toEqual([]);
    expect(await scanAll(client, "users")).toEqual([]);
  });

  it("records updates and deletes of existing rows", async () => {
    const { client } = await createTestSyncClient();
    await asAccessors(client.orm)["users"]!.create({ id: "u1", name: "Alice" });
    await asAccessors(client.orm)["users"]!.create({ id: "u2", name: "Bob" });

    await transactionOf(client)(["users"], async (tx) => {
      await tx["users"]!.where({ id: "u1" }).update({ name: "Alicia" });
      await tx["users"]!.delete("u2");
    });

    const operations = (await scanAll(client, "_idb_sync_outbox")).map((row) => row["operation"]);
    expect(operations.filter((operation) => operation === "update")).toHaveLength(1);
    expect(operations.filter((operation) => operation === "delete")).toHaveLength(1);
  });
});

describe("SyncIdbClient.rawClient.transaction()", () => {
  it("writes the models without recording outbox rows", async () => {
    const { client } = await createTestSyncClient();

    await transactionOf(client.rawClient)(["users"], async (tx) => {
      await tx["users"]!.create({ id: "u1", name: "Alice" });
    });

    expect(await scanAll(client, "users")).toHaveLength(1);
    expect(await scanAll(client, "_idb_sync_outbox")).toEqual([]);
  });
});
