import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { applyPull } from "../src/core/apply-pull";
import { createSyncIdbClient } from "../src/exports/client";
import {
  OUTBOX_STORE,
  SYNC_META_STORE,
  USERS_STORE,
  VERSION_META_STORE,
  changelogId,
  openTestDb,
  scanAll,
  testDbName,
} from "./helpers";

/**
 * A synced User with three `@@ignore` models whose rows a delete of the user
 * changes: Legacy cascades; Trail, which has no key, has its foreign key set
 * to null; and Crumb, which has no key either, cascades.
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
        crumbs: { to: "Crumb", cardinality: "1:N", on: { local: ["id"], target: ["userId"] } },
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
    Crumb: {
      store: "crumb",
      fields: { note: "String", userId: "String" },
      relations: {
        user: { to: "User", cardinality: "N:1", on: { local: ["userId"], target: ["id"] }, onDelete: "cascade" },
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
    { name: "crumb", indexes: [{ name: "userId", keyPath: "userId" }] },
    OUTBOX_STORE,
    VERSION_META_STORE,
    SYNC_META_STORE,
  ]);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["legacy", "trail", "crumb"], "readwrite");
    tx.objectStore("legacy").put({ id: "l1", userId: "u1" });
    tx.objectStore("trail").add({ note: "kept", userId: "u1" });
    tx.objectStore("crumb").add({ note: "first", userId: "u1" });
    tx.objectStore("crumb").add({ note: "other", userId: "u2" });
    tx.objectStore("crumb").add({ note: "second", userId: "u1" });
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

describe("@@ignore models and pulled changes", () => {
  it("runs the referential actions of a pulled delete on the rows of an ignored model without a key", async () => {
    const client = await createClient("*");
    await applyPull(client, [
      {
        changelogId: changelogId(1),
        model: "User",
        operation: "create",
        keyPath: "u1",
        record: { id: "u1", name: "A" },
      },
      {
        changelogId: changelogId(2),
        model: "User",
        operation: "create",
        keyPath: "u2",
        record: { id: "u2", name: "B" },
      },
      { changelogId: changelogId(3), model: "User", operation: "delete", keyPath: "u1", record: null },
    ]);

    expect(await scanAll(client, "users")).toEqual([{ id: "u2", name: "B" }]);
    expect(await scanAll(client, "legacy")).toEqual([]);
    expect(await scanAll(client, "trail")).toMatchObject([{ note: "kept", userId: null }]);
    expect(await scanAll(client, "crumb")).toMatchObject([{ note: "other", userId: "u2" }]);
    expect(await scanAll(client, "_idb_sync_outbox")).toEqual([]);
  });
});
