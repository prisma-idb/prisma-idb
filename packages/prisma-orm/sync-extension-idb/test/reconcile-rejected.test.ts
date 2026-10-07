import { afterEach, describe, expect, it } from "vitest";
import { createSyncWorker } from "../src/core/sync-worker";
import type { PushCompletedEvent } from "../src/core/sync-worker";
import type { OutboxEvent, PushResult, VersionMetaRecord } from "../src/types";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import type { IdbContract } from "@prisma-idb/client-idb/orm";
import { createSyncIdbClient } from "../src/exports/client";
import {
  OUTBOX_STORE,
  VERSION_META_STORE,
  asAccessors,
  createTestSyncClient,
  keyGet,
  openTestDb,
  scanAll,
  testDbName,
} from "./helpers";

type TestClient = Awaited<ReturnType<typeof createTestSyncClient>>["client"];

const workers: ReturnType<typeof createSyncWorker>[] = [];

afterEach(() => {
  for (const worker of workers.splice(0)) worker.stop();
});

/** Runs one sync cycle whose push the server answers with `answer`; returns the cycle's `pushcompleted` events. */
async function syncOnce(
  client: TestClient,
  answer: (event: OutboxEvent) => PushResult,
  options: { batchSize?: number } = {}
): Promise<PushCompletedEvent[]> {
  const worker = createSyncWorker({
    syncClient: client,
    pushHandler: async (events) => events.map(answer),
    pullHandler: async () => [],
    ...options,
  });
  workers.push(worker);
  const pushes: PushCompletedEvent[] = [];
  worker.on("pushcompleted", (p) => pushes.push(p));
  await worker.forceSync();
  return pushes;
}

const accept = (event: OutboxEvent): PushResult => ({ id: event.id, success: true });

const reject =
  (record?: Record<string, unknown> | null) =>
  (event: OutboxEvent): PushResult => ({
    id: event.id,
    success: false,
    error: "Failed to apply event",
    retryable: false,
    ...(record !== undefined && { record }),
  });

const outbox = (client: TestClient) => scanAll(client, "_idb_sync_outbox") as unknown as Promise<OutboxEvent[]>;
const versionMeta = (client: TestClient, id: string) =>
  keyGet(client, "_idb_sync_version_meta", id) as Promise<VersionMetaRecord | undefined>;

describe("a push the server rejected for good", () => {
  it("undoes a rejected create: the local row goes, the flag clears and no new outbox event appears", async () => {
    const { client } = await createTestSyncClient();
    await asAccessors(client.orm)["users"]!.create({ id: "u1", name: "Alice" });

    const [push] = await syncOnce(client, reject(null));

    expect(push).toMatchObject({ synced: 0, failed: 1, unreconciled: 0, pullBlocked: false });
    expect(await scanAll(client, "users")).toEqual([]);
    expect((await versionMeta(client, 'User::"u1"'))?.localChangePending).toBe(false);
    // The rejected event is kept, marked dead, as the recovery record of what the user wrote.
    expect(await outbox(client)).toMatchObject([{ entityType: "User", synced: false, retryable: false, tries: 1 }]);
  });

  it("replaces a rejected update with the server's row", async () => {
    const { client } = await createTestSyncClient();
    const users = asAccessors(client.orm)["users"]!;
    await users.create({ id: "u1", name: "Alice" });
    await syncOnce(client, accept);
    await users.where({ id: "u1" }).update({ name: "Local edit" });

    await syncOnce(client, reject({ id: "u1", name: "Server name" }));

    expect(await scanAll(client, "users")).toEqual([{ id: "u1", name: "Server name" }]);
    expect((await versionMeta(client, 'User::"u1"'))?.localChangePending).toBe(false);
  });

  it("restores a row whose delete was rejected", async () => {
    const { client } = await createTestSyncClient();
    const users = asAccessors(client.orm)["users"]!;
    await users.create({ id: "u1", name: "Alice" });
    await syncOnce(client, accept);
    await users.delete("u1");
    expect(await scanAll(client, "users")).toEqual([]);

    await syncOnce(client, reject({ id: "u1", name: "Alice" }));

    expect(await scanAll(client, "users")).toEqual([{ id: "u1", name: "Alice" }]);
  });

  it.each([
    { name: "scalar", compound: false },
    { name: "compound", compound: true },
  ])("reconciles a rejected create whose key is Bytes ($name key)", async ({ compound }) => {
    const keyPath = compound ? ["tenant", "id"] : "id";
    const dbName = testDbName();
    (await openTestDb(dbName, [{ name: "assets", keyPath }, OUTBOX_STORE, VERSION_META_STORE])).close();
    const contract = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: { Asset: { store: "assets", key: keyPath, fields: { tenant: "String", id: "Bytes", name: "String" } } },
    }) as unknown as IdbContract;
    const client = createSyncIdbClient({ contract, dbName, trackedModels: "*" });
    const assets = asAccessors(client.orm)["assets"]!;
    const row = { tenant: "t1", id: new Uint8Array([1, 2]), name: "local" };
    const wireRow = { tenant: "t1", id: "AQI=", name: "server" };

    // `null`: the create is undone.
    await assets.create(row);
    await syncOnce(client, reject(null));
    expect(await scanAll(client, "assets")).toEqual([]);

    // A row: the local write is replaced by it.
    await assets.create(row);
    await syncOnce(client, reject(wireRow));
    expect(await scanAll(client, "assets")).toEqual([{ ...wireRow, id: new Uint8Array([1, 2]) }]);
    expect(await outbox(client)).toMatchObject([{ retryable: false }, { retryable: false }]);
  });

  it("carries on when a rejected delete targets a row the server already deleted", async () => {
    const { client } = await createTestSyncClient();
    const users = asAccessors(client.orm)["users"]!;
    await users.create({ id: "u1", name: "Alice" });
    await syncOnce(client, accept);
    await users.delete("u1");

    const [push] = await syncOnce(client, reject(null));

    expect(push).toMatchObject({ failed: 1, unreconciled: 0 });
    expect(await scanAll(client, "users")).toEqual([]);
  });

  it("removes the queued children of a rejected create when their own events are rejected", async () => {
    const { client } = await createTestSyncClient();
    await asAccessors(client.orm)["users"]!.create({ id: "u1", name: "Alice" });
    await asAccessors(client.orm)["posts"]!.create({ id: "p1", title: "Hello", authorId: "u1" });

    // One event per batch, so the child is rejected in a later batch than its parent.
    const pushes = await syncOnce(client, reject(null), { batchSize: 1 });

    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ failed: 2, unreconciled: 0 });
    expect(await scanAll(client, "users")).toEqual([]);
    expect(await scanAll(client, "posts")).toEqual([]);
  });

  it.each([
    ["has no record (an older server)", undefined],
    ["has a record that fails the client contract", { id: "u1", name: 42 }],
    ["has a record for a different key", { id: "u2", name: "Bob" }],
  ])("keeps the local write and counts it as unreconciled when the rejection %s", async (_label, record) => {
    const { client } = await createTestSyncClient();
    await asAccessors(client.orm)["users"]!.create({ id: "u1", name: "Alice" });

    const [push] = await syncOnce(client, reject(record));

    expect(push).toMatchObject({ failed: 1, unreconciled: 1 });
    expect(await scanAll(client, "users")).toEqual([{ id: "u1", name: "Alice" }]);
    expect(await outbox(client)).toMatchObject([{ retryable: false }]);
  });

  it("does not touch the local row for a failure the server says is retryable", async () => {
    const { client } = await createTestSyncClient();
    await asAccessors(client.orm)["users"]!.create({ id: "u1", name: "Alice" });

    const [push] = await syncOnce(client, (event) => ({
      id: event.id,
      success: false,
      error: "db down",
      retryable: true,
      record: null,
    }));

    expect(push).toMatchObject({ failed: 1, unreconciled: 0, pullBlocked: true });
    expect(await scanAll(client, "users")).toEqual([{ id: "u1", name: "Alice" }]);
  });
});
