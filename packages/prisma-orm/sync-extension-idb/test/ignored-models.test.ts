import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createSyncIdbClient } from "../src/exports/client";
import {
  OUTBOX_STORE,
  SYNC_META_STORE,
  USERS_STORE,
  VERSION_META_STORE,
  openTestDb,
  scanAll,
  testDbName,
} from "./helpers";

/**
 * A synced User with two `@@ignore` models whose rows a delete of the user
 * changes: Legacy cascades, and Trail, which has no key, has its foreign key
 * set to null.
 */
const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", name: "String" },
      relations: {
        legacy: { to: "Legacy", cardinality: "1:N", on: { local: ["id"], target: ["userId"] } },
        trails: { to: "Trail", cardinality: "1:N", on: { local: ["id"], target: ["userId"] } },
      },
    },
    Legacy: {
      store: "legacy",
      key: "id",
      fields: { id: "String", userId: "String" },
      relations: {
        user: { to: "User", cardinality: "N:1", on: { local: ["userId"], target: ["id"] }, onDelete: "cascade" },
      },
      ignored: true,
    },
    Trail: {
      store: "trail",
      fields: { note: "String", userId: "String?" },
      relations: {
        user: { to: "User", cardinality: "N:1", on: { local: ["userId"], target: ["id"] }, onDelete: "setNull" },
      },
      ignored: true,
    },
  },
});

async function createClient(trackedModels: ReadonlyArray<string> | "*") {
  const dbName = testDbName();
  const db = await openTestDb(dbName, [
    USERS_STORE,
    { name: "legacy", keyPath: "id", indexes: [{ name: "userId", keyPath: "userId" }] },
    { name: "trail", indexes: [{ name: "userId", keyPath: "userId" }] },
    OUTBOX_STORE,
    VERSION_META_STORE,
    SYNC_META_STORE,
  ]);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["legacy", "trail"], "readwrite");
    tx.objectStore("legacy").put({ id: "l1", userId: "u1" });
    tx.objectStore("trail").add({ note: "kept", userId: "u1" });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return createSyncIdbClient({ contract, dbName, trackedModels });
}

describe("@@ignore models and the outbox", () => {
  it.each([
    ["every model", "*" as const],
    ["a list naming the ignored models", ["User", "Legacy", "Trail"]],
  ])("queues no event for an ignored model's rows that a delete changes (%s)", async (_, trackedModels) => {
    const client = await createClient(trackedModels);
    const users = (
      client.orm as unknown as Record<
        string,
        { create(d: object): Promise<unknown>; delete(k: string): Promise<unknown> }
      >
    )["users"]!;
    await users.create({ id: "u1", name: "Alice" });
    await users.delete("u1");

    expect(await scanAll(client, "legacy")).toEqual([]);
    expect(await scanAll(client, "trail")).toMatchObject([{ note: "kept", userId: null }]);
    const events = (await scanAll(client, "_idb_sync_outbox"))
      .map((event) => `${String(event["entityType"])} ${String(event["operation"])}`)
      .sort();
    expect(events).toEqual(["User create", "User delete"]);
    expect((await scanAll(client, "_idb_sync_version_meta")).map((meta) => meta["model"])).toEqual(["User"]);
  });
});
