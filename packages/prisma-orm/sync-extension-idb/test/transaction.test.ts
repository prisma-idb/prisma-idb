/**
 * `SyncIdbClient.transaction()` — typed transactions with outbox tracking.
 *
 * `transaction()` records outbox rows for tracked writes in the same IDB
 * transaction. `rawClient.transaction()` is the untracked counterpart.
 */
import { describe, expect, it, vi } from "vitest";
import { IdbTransactionCommittedEarlyError } from "@prisma-idb/client-idb/client";
import { IdbRecordValidationError } from "@prisma-idb/client-idb/orm";
import { asAccessors, createTestSyncClient, scanAll, type TestStoreAccessor } from "./helpers";

type TestTx = Record<string, TestStoreAccessor>;
type LooseTransaction = <T>(rootKeys: string[], fn: (tx: TestTx) => Promise<T>) => Promise<T>;

/** `transaction()` is typed against the contract's roots, which the untyped test contract does not carry. */
function transactionOf(client: { transaction: unknown }): LooseTransaction {
  return client.transaction as LooseTransaction;
}

/**
 * Resolves once the next IndexedDB transaction opened after this call has finished. A timer
 * cannot wait for the auto-commit: it races fake-indexeddb's setImmediate-based commit.
 */
function untilNextTransactionFinishes(): () => Promise<void> {
  const finished: Promise<void>[] = [];
  const open = IDBDatabase.prototype.transaction;
  vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
    const tx = open.apply(this, args);
    finished.push(
      new Promise<void>((resolve) => {
        for (const event of ["complete", "abort", "error"]) tx.addEventListener(event, () => resolve());
      })
    );
    return tx;
  });
  return () => Promise.all(finished).then(() => undefined);
}

describe("SyncIdbClient.transaction()", () => {
  it.each([false, true])("rolls back scalar failures, outbox rows and notifications (caught: %s)", async (caught) => {
    const { client } = await createTestSyncClient();
    const emitted: number[] = [];
    let caughtError: unknown;
    client.on("outboxwrite", (entries) => emitted.push(entries.length));
    await expect(
      transactionOf(client)(["users"], async (tx) => {
        await tx["users"]!.create({ id: "u1", name: "Alice" });
        const invalid = tx["users"]!.where({ id: "u1" }).update({ name: 3 });
        if (caught)
          await invalid.catch((error: unknown) => {
            caughtError = error;
          });
        else await invalid;
      })
    ).rejects.toThrow();
    if (caught) expect(caughtError).toBeInstanceOf(IdbRecordValidationError);
    expect(await scanAll(client, "users")).toEqual([]);
    expect(await scanAll(client, "_idb_sync_outbox")).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it("rolls back nested scalar failures and their tracked writes", async () => {
    const { client } = await createTestSyncClient();
    const emitted: number[] = [];
    client.on("outboxwrite", (entries) => emitted.push(entries.length));
    await expect(
      asAccessors(client.orm)["users"]!.create({
        id: "u1",
        name: "Alice",
        posts: (rel: { create(data: Record<string, unknown>[]): unknown }) =>
          rel.create([
            { id: "p1", title: "valid" },
            { id: "p2", title: 3 },
          ]),
      })
    ).rejects.toThrow(IdbRecordValidationError);
    expect(await scanAll(client, "users")).toEqual([]);
    expect(await scanAll(client, "posts")).toEqual([]);
    expect(await scanAll(client, "_idb_sync_outbox")).toEqual([]);
    expect(emitted).toEqual([]);
  });
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

  it("notifies about the outbox rows that persisted when IndexedDB commits the transaction before the callback ends", async () => {
    const { client } = await createTestSyncClient();
    const emitted: number[] = [];
    client.on("outboxwrite", (entries) => emitted.push(entries.length));
    const finished = untilNextTransactionFinishes();

    const failure = await transactionOf(client)(["users"], async (tx) => {
      await tx["users"]!.create({ id: "u1", name: "Alice" });
      await finished();
    }).catch((error: unknown) => error);
    vi.restoreAllMocks();

    expect(failure).toBeInstanceOf(IdbTransactionCommittedEarlyError);
    expect(await scanAll(client, "_idb_sync_outbox")).toHaveLength(1);
    expect(emitted).toEqual([1]);
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
  it("validates untracked ORM writes and rolls back earlier writes", async () => {
    const { client } = await createTestSyncClient();
    await expect(
      transactionOf(client.rawClient)(["users"], async (tx) => {
        await tx["users"]!.create({ id: "u1", name: "Alice" });
        await tx["users"]!.create({ id: "u2", name: 3 });
      })
    ).rejects.toThrow(IdbRecordValidationError);
    expect(await scanAll(client, "users")).toEqual([]);
    expect(await scanAll(client, "_idb_sync_outbox")).toEqual([]);
  });
  it("writes the models without recording outbox rows", async () => {
    const { client } = await createTestSyncClient();

    await transactionOf(client.rawClient)(["users"], async (tx) => {
      await tx["users"]!.create({ id: "u1", name: "Alice" });
    });

    expect(await scanAll(client, "users")).toHaveLength(1);
    expect(await scanAll(client, "_idb_sync_outbox")).toEqual([]);
  });
});
