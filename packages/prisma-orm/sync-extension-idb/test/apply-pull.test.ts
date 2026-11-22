import { describe, expect, it, vi } from "vitest";
import { IDBKeyRange as FakeIDBKeyRange } from "fake-indexeddb";
import { applyPull, DISCARDED_BY_PULL } from "../src/core/apply-pull";
import type { LogWithRecord, VersionMetaRecord } from "../src/types";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import type { IdbContract } from "@prisma-idb/client-idb/orm";
import { createAutoMigratingSyncIdbClient, createSyncIdbClient } from "../src/exports/client";
import { idbSyncExtension } from "../src/exports/control";
import { buildContractSpaceFixture } from "./_contract-space-fixture";
import {
  OUTBOX_STORE,
  OUTBOX_ORDER_STORE,
  VERSION_META_STORE,
  asAccessors,
  changelogId,
  createTestSyncClient,
  keyGet,
  openTestDb,
  scanAll,
  testContract,
  testDbName,
} from "./helpers";

function log(
  overrides: Partial<Extract<LogWithRecord, { record: unknown }>> & Pick<LogWithRecord, "changelogId" | "operation">
): LogWithRecord {
  return {
    model: "User",
    keyPath: "u1",
    record: { id: "u1", name: "Alice" },
    ...overrides,
  };
}

async function getVersionMeta(
  client: Awaited<ReturnType<typeof createTestSyncClient>>["client"],
  id: string
): Promise<VersionMetaRecord | undefined> {
  return (await keyGet(client, "_idb_sync_version_meta", id)) as VersionMetaRecord | undefined;
}

async function seedVersionMeta(
  client: Awaited<ReturnType<typeof createTestSyncClient>>["client"],
  record: VersionMetaRecord
): Promise<void> {
  await client.withTransaction(["_idb_sync_version_meta"], async (scope) => {
    await scope.execute({
      kind: "add",
      storeName: "_idb_sync_version_meta",
      record: record as unknown as Record<string, unknown>,
    } as never);
  });
}

/** Writes `record` over any existing version-meta row with the same id. */
async function putVersionMeta(
  client: Awaited<ReturnType<typeof createTestSyncClient>>["client"],
  record: VersionMetaRecord
): Promise<void> {
  await client.withTransaction(["_idb_sync_version_meta"], async (scope) => {
    await scope.execute({
      kind: "put",
      storeName: "_idb_sync_version_meta",
      record: record as unknown as Record<string, unknown>,
    } as never);
  });
}

describe("applyPull", () => {
  it("counts corrupt rows separately, writes valid rows and consumes the corrupt tail cursor", async () => {
    const { client } = await createTestSyncClient();
    const result = await applyPull(client, [
      log({ changelogId: changelogId(1), operation: "create", record: { id: "u1" } }),
      log({ changelogId: changelogId(2), operation: "create" }),
      log({ changelogId: changelogId(3), operation: "update", record: { id: "u1", name: 42 } }),
    ]);
    expect(result).toEqual({
      changes: expect.any(Array),
      applied: 1,
      skipped: 2,
      validationFailed: 2,
      halted: false,
      lastChangelogId: changelogId(3),
    });
    expect(await scanAll(client, "users")).toEqual([{ id: "u1", name: "Alice" }]);
    expect((await getVersionMeta(client, 'User::"u1"'))?.lastAppliedChangeId).toBe(changelogId(2));
  });

  it("rejects extra fields, invalid keys and record/key mismatches without storing records or version metadata", async () => {
    const { client } = await createTestSyncClient();
    const result = await applyPull(client, [
      log({ changelogId: changelogId(1), operation: "create", record: { id: "u1", name: "Alice", extra: true } }),
      log({ changelogId: changelogId(2), operation: "delete", record: null, keyPath: 42 }),
      log({ changelogId: changelogId(3), operation: "update", record: { id: "someone-else", name: "Alice" } }),
      log({ changelogId: changelogId(4), operation: "delete", record: null, keyPath: 42n }),
    ]);
    expect(result).toEqual({
      changes: expect.any(Array),
      applied: 0,
      skipped: 4,
      validationFailed: 4,
      halted: false,
      lastChangelogId: changelogId(4),
    });
    expect(await scanAll(client, "_idb_sync_version_meta")).toEqual([]);
    expect(await scanAll(client, "users")).toEqual([]);
  });

  it("reports a decode error as corruption and continues applying the batch", async () => {
    const { client, contract } = await createTestSyncClient();
    // Force the string field through a throwing decoder without changing the stores.
    contract.domain.namespaces[Object.keys(contract.domain.namespaces)[0]!]!.models["User"]!.fields["name"] = {
      nullable: false,
      type: { kind: "scalar", codecId: "idb/bigint@1" },
    };
    const result = await applyPull(client, [
      log({ changelogId: changelogId(1), operation: "create", record: { id: "u1", name: "not-a-bigint" } }),
      log({ changelogId: changelogId(2), operation: "create", record: { id: "u1", name: "42" } }),
    ]);
    expect(result).toEqual({
      changes: expect.any(Array),
      applied: 1,
      skipped: 1,
      validationFailed: 1,
      halted: false,
      lastChangelogId: changelogId(2),
    });
    expect(await scanAll(client, "users")).toEqual([{ id: "u1", name: 42n }]);
  });

  it("applies a create log and writes version-meta", async () => {
    const { client } = await createTestSyncClient();

    const result = await applyPull(client, [log({ changelogId: "c1", operation: "create" })]);

    expect(result).toEqual({
      changes: expect.any(Array),
      applied: 1,
      skipped: 0,
      validationFailed: 0,
      halted: false,
      lastChangelogId: "c1",
    });
    expect(await scanAll(client, "users")).toEqual([{ id: "u1", name: "Alice" }]);
    const meta = await getVersionMeta(client, 'User::"u1"');
    expect(meta?.lastAppliedChangeId).toBe("c1");
    expect(meta?.localChangePending).toBe(false);
  });

  it("applies an update log by overwriting the record", async () => {
    const { client } = await createTestSyncClient();
    await applyPull(client, [log({ changelogId: "c1", operation: "create" })]);

    const result = await applyPull(client, [
      log({ changelogId: "c2", operation: "update", record: { id: "u1", name: "Alicia" } }),
    ]);

    expect(result).toEqual({
      changes: expect.any(Array),
      applied: 1,
      skipped: 0,
      validationFailed: 0,
      halted: false,
      lastChangelogId: "c2",
    });
    expect(await scanAll(client, "users")).toEqual([{ id: "u1", name: "Alicia" }]);
  });

  it("applies a delete log, cascading onDelete: cascade to children", async () => {
    const { client } = await createTestSyncClient();
    await applyPull(client, [log({ changelogId: "c1", operation: "create" })]);
    await applyPull(client, [
      log({
        changelogId: "c2",
        model: "Post",
        keyPath: "p1",
        operation: "create",
        record: { id: "p1", title: "Hi", authorId: "u1" },
      }),
    ]);

    const result = await applyPull(client, [log({ changelogId: "c3", operation: "delete", record: null })]);

    expect(result).toEqual({
      changes: expect.any(Array),
      applied: 1,
      skipped: 0,
      validationFailed: 0,
      halted: false,
      lastChangelogId: "c3",
    });
    expect(await scanAll(client, "users")).toHaveLength(0);
    expect(await scanAll(client, "posts")).toHaveLength(0);
  });

  it.each([
    ["delete", "delete"],
    ["revocation", "update"],
  ] as const)(
    "discards the unsent edit of a child that a pulled %s of its parent cascades to",
    async (_, operation) => {
      const { client } = await createTestSyncClient();
      await applyPull(client, [
        log({ changelogId: "c1", operation: "create" }),
        log({
          changelogId: "c2",
          model: "Post",
          keyPath: "p1",
          operation: "create",
          record: { id: "p1", title: "Hi", authorId: "u1" },
        }),
      ]);
      await asAccessors(client.orm)["posts"]!.where({ id: "p1" }).update({ title: "Edited offline" });
      expect(await client.outbox.hasPending()).toBe(true);

      const result = await applyPull(client, [log({ changelogId: "c3", operation, record: null })]);

      expect(result).toMatchObject({ applied: 1, halted: false, lastChangelogId: "c3" });
      expect(await scanAll(client, "posts")).toEqual([]);
      // The server deleted the child too: its edit can't apply, so the queue no longer holds it.
      expect(await client.outbox.hasPending()).toBe(false);
      expect(await scanAll(client, "_idb_sync_outbox")).toMatchObject([
        { entityType: "Post", operation: "update", retryable: false, lastError: DISCARDED_BY_PULL },
      ]);
      expect(await keyGet(client, "_idb_sync_version_meta", 'Post::"p1"')).toMatchObject({
        localChangePending: false,
      });
    }
  );

  it("halts at a log when the local version-meta has a pending local change (local write wins)", async () => {
    const { client } = await createTestSyncClient();
    await seedVersionMeta(client, {
      id: 'User::"u1"',
      model: "User",
      key: "u1",
      lastAppliedChangeId: null,
      localChangePending: true,
    });

    const result = await applyPull(client, [log({ changelogId: "c1", operation: "create" })]);

    expect(result).toEqual({
      changes: expect.any(Array),
      applied: 0,
      skipped: 1,
      validationFailed: 0,
      halted: true,
      lastChangelogId: null,
    });
    expect(await scanAll(client, "users")).toHaveLength(0);
  });

  it("consumes a stale log (lastAppliedChangeId already >= incoming changelogId) without writing", async () => {
    const { client } = await createTestSyncClient();
    await applyPull(client, [log({ changelogId: "c5", operation: "create" })]);

    const result = await applyPull(client, [
      log({ changelogId: "c3", operation: "update", record: { id: "u1", name: "Stale" } }),
    ]);

    expect(result).toEqual({
      changes: expect.any(Array),
      applied: 0,
      skipped: 1,
      validationFailed: 0,
      halted: false,
      lastChangelogId: "c3",
    });
    expect(await scanAll(client, "users")).toEqual([{ id: "u1", name: "Alice" }]);
  });

  it("moves the cursor to the last id when a fully applied page is replayed", async () => {
    const { client } = await createTestSyncClient();
    const page = [
      log({ changelogId: changelogId(1), operation: "create" }),
      log({ changelogId: changelogId(2), operation: "update", record: { id: "u1", name: "Alicia" } }),
      log({
        changelogId: changelogId(3),
        model: "Post",
        keyPath: "p1",
        operation: "create",
        record: { id: "p1", title: "Hi", authorId: "u1" },
      }),
    ];
    await applyPull(client, page);

    const replay = await applyPull(client, page);

    expect(replay).toEqual({
      changes: expect.any(Array),
      applied: 0,
      skipped: 3,
      validationFailed: 0,
      halted: false,
      lastChangelogId: changelogId(3),
    });
    expect(await scanAll(client, "users")).toEqual([{ id: "u1", name: "Alicia" }]);
  });

  describe("a row that cannot be applied yet", () => {
    const page = () => [
      log({ changelogId: changelogId(1), operation: "create", record: { id: "u1", name: "Alice" } }),
      log({ changelogId: changelogId(2), keyPath: "u2", operation: "create", record: { id: "u2", name: "Bob" } }),
      log({ changelogId: changelogId(3), keyPath: "u3", operation: "create", record: { id: "u3", name: "Cy" } }),
    ];

    /** Makes the nth `withTransaction` call (1-based) reject, as a full disk or a closed connection would. */
    function failTransaction(client: Awaited<ReturnType<typeof createTestSyncClient>>["client"], nth: number) {
      const original = client.withTransaction.bind(client);
      let calls = 0;
      vi.spyOn(client, "withTransaction").mockImplementation(((...args: Parameters<typeof original>) =>
        ++calls === nth ? Promise.reject(new Error("QuotaExceededError")) : original(...args)) as never);
    }

    it("halts at a failed first row: later rows are not applied and the cursor does not move", async () => {
      const { client } = await createTestSyncClient();
      failTransaction(client, 1);

      const result = await applyPull(client, page());

      expect(result).toEqual({
        changes: expect.any(Array),
        applied: 0,
        skipped: 1,
        validationFailed: 0,
        halted: true,
        lastChangelogId: null,
      });
      expect(await scanAll(client, "users")).toEqual([]);
    });

    it("halts at a failed middle row: the cursor stops before it and later rows are not applied", async () => {
      const { client } = await createTestSyncClient();
      failTransaction(client, 2);

      const result = await applyPull(client, page());

      expect(result).toEqual({
        changes: expect.any(Array),
        applied: 1,
        skipped: 1,
        validationFailed: 0,
        halted: true,
        lastChangelogId: changelogId(1),
      });
      expect(await scanAll(client, "users")).toEqual([{ id: "u1", name: "Alice" }]);
    });

    it("applies the rest of the page when the next pull restarts at the halted row", async () => {
      const { client } = await createTestSyncClient();
      failTransaction(client, 2);
      await applyPull(client, page());

      const retry = await applyPull(client, page().slice(1));

      expect(retry).toEqual({
        changes: expect.any(Array),
        applied: 2,
        skipped: 0,
        validationFailed: 0,
        halted: false,
        lastChangelogId: changelogId(3),
      });
      expect(await scanAll(client, "users")).toHaveLength(3);
    });

    it("halts at a pending local edit until the flag clears", async () => {
      const { client } = await createTestSyncClient();
      await seedVersionMeta(client, {
        id: 'User::"u2"',
        model: "User",
        key: "u2",
        lastAppliedChangeId: null,
        localChangePending: true,
      });

      const held = await applyPull(client, page());
      expect(held).toEqual({
        changes: expect.any(Array),
        applied: 1,
        skipped: 1,
        validationFailed: 0,
        halted: true,
        lastChangelogId: changelogId(1),
      });
      expect(await scanAll(client, "users")).toEqual([{ id: "u1", name: "Alice" }]);

      await putVersionMeta(client, {
        id: 'User::"u2"',
        model: "User",
        key: "u2",
        lastAppliedChangeId: null,
        localChangePending: false,
      });
      const released = await applyPull(client, page().slice(1));
      expect(released).toEqual({
        changes: expect.any(Array),
        applied: 2,
        skipped: 0,
        validationFailed: 0,
        halted: false,
        lastChangelogId: changelogId(3),
      });
    });

    it("halts at a delete for a record with a pending local edit and keeps the record", async () => {
      const { client } = await createTestSyncClient();
      await applyPull(client, [log({ changelogId: changelogId(1), operation: "create" })]);
      await putVersionMeta(client, {
        id: 'User::"u1"',
        model: "User",
        key: "u1",
        lastAppliedChangeId: changelogId(1),
        localChangePending: true,
      });

      const result = await applyPull(client, [log({ changelogId: changelogId(2), operation: "delete", record: null })]);

      expect(result).toEqual({
        changes: expect.any(Array),
        applied: 0,
        skipped: 1,
        validationFailed: 0,
        halted: true,
        lastChangelogId: null,
      });
      expect(await scanAll(client, "users")).toEqual([{ id: "u1", name: "Alice" }]);
    });

    it("consumes a stale row for a record with a pending local edit instead of halting", async () => {
      const { client } = await createTestSyncClient();
      await applyPull(client, [log({ changelogId: changelogId(5), operation: "create" })]);
      await putVersionMeta(client, {
        id: 'User::"u1"',
        model: "User",
        key: "u1",
        lastAppliedChangeId: changelogId(5),
        localChangePending: true,
      });

      const result = await applyPull(client, [
        log({ changelogId: changelogId(4), operation: "update", record: { id: "u1", name: "Old" } }),
      ]);

      expect(result).toEqual({
        changes: expect.any(Array),
        applied: 0,
        skipped: 1,
        validationFailed: 0,
        halted: false,
        lastChangelogId: changelogId(4),
      });
    });
  });

  it("skips a row for a model not present in the contract without halting the page", async () => {
    const { client } = await createTestSyncClient();

    const result = await applyPull(client, [
      log({ changelogId: changelogId(1), operation: "create", model: "Nonexistent" }),
      log({ changelogId: changelogId(2), operation: "create" }),
    ]);

    expect(result).toEqual({
      changes: expect.any(Array),
      applied: 1,
      skipped: 1,
      validationFailed: 0,
      halted: false,
      lastChangelogId: changelogId(2),
    });
  });

  it("skips and consumes logs for a model not present in the contract", async () => {
    const { client } = await createTestSyncClient();

    const result = await applyPull(client, [log({ changelogId: "c1", operation: "create", model: "Nonexistent" })]);

    expect(result).toEqual({
      changes: [],
      applied: 0,
      skipped: 1,
      validationFailed: 0,
      halted: false,
      lastChangelogId: "c1",
    });
  });

  it("treats a create/update log with a null record as a no-op when nothing is materialized locally yet", async () => {
    const { client } = await createTestSyncClient();

    const result = await applyPull(client, [log({ changelogId: "c1", operation: "create", record: null })]);

    expect(result).toEqual({
      changes: expect.any(Array),
      applied: 1,
      skipped: 0,
      validationFailed: 0,
      halted: false,
      lastChangelogId: "c1",
    });
    expect(await scanAll(client, "users")).toHaveLength(0);
  });

  it("deletes an already-synced record when access is revoked (update log arrives with a null record)", async () => {
    const { client } = await createTestSyncClient();
    await applyPull(client, [log({ changelogId: "c1", operation: "create" })]);
    expect(await scanAll(client, "users")).toEqual([{ id: "u1", name: "Alice" }]);

    const result = await applyPull(client, [log({ changelogId: "c2", operation: "update", record: null })]);

    expect(result).toEqual({
      changes: expect.any(Array),
      applied: 1,
      skipped: 0,
      validationFailed: 0,
      halted: false,
      lastChangelogId: "c2",
    });
    expect(await scanAll(client, "users")).toHaveLength(0);
  });

  it("cascades onDelete: cascade to children when revocation deletes a parent (update log, null record)", async () => {
    const { client } = await createTestSyncClient();
    await applyPull(client, [log({ changelogId: "c1", operation: "create" })]);
    await applyPull(client, [
      log({
        changelogId: "c2",
        model: "Post",
        keyPath: "p1",
        operation: "create",
        record: { id: "p1", title: "Hi", authorId: "u1" },
      }),
    ]);

    const result = await applyPull(client, [log({ changelogId: "c3", operation: "update", record: null })]);

    expect(result).toEqual({
      changes: expect.any(Array),
      applied: 1,
      skipped: 0,
      validationFailed: 0,
      halted: false,
      lastChangelogId: "c3",
    });
    expect(await scanAll(client, "users")).toHaveLength(0);
    expect(await scanAll(client, "posts")).toHaveLength(0);
  });

  it("tracks lastChangelogId as the max across multiple applied logs, regardless of input order", async () => {
    const { client } = await createTestSyncClient();

    const result = await applyPull(client, [
      log({ changelogId: "c1", operation: "create" }),
      log({
        changelogId: "c9",
        model: "Post",
        keyPath: "p1",
        operation: "create",
        record: { id: "p1", title: "Hi", authorId: "u1" },
      }),
      log({ changelogId: "c5", operation: "update", record: { id: "u1", name: "Alicia" } }),
    ]);

    expect(result).toEqual({
      changes: expect.any(Array),
      applied: 3,
      skipped: 0,
      validationFailed: 0,
      halted: false,
      lastChangelogId: "c9",
    });
  });
  describe("UUID v7 changelog ids", () => {
    it("tracks lastChangelogId as the newest id regardless of input order", async () => {
      const { client } = await createTestSyncClient();

      const result = await applyPull(client, [
        log({ changelogId: changelogId(10), operation: "create" }),
        log({
          changelogId: changelogId(9),
          model: "Post",
          keyPath: "p1",
          operation: "create",
          record: { id: "p1", title: "Hi", authorId: "u1" },
        }),
      ]);

      expect(result).toEqual({
        changes: expect.any(Array),
        applied: 2,
        skipped: 0,
        validationFailed: 0,
        halted: false,
        lastChangelogId: changelogId(10),
      });
    });

    it("applies a newer log whose id is later than the stored one", async () => {
      const { client } = await createTestSyncClient();
      await applyPull(client, [log({ changelogId: changelogId(9), operation: "create" })]);

      const result = await applyPull(client, [
        log({ changelogId: changelogId(10), operation: "update", record: { id: "u1", name: "Alicia" } }),
      ]);

      expect(result).toEqual({
        changes: expect.any(Array),
        applied: 1,
        skipped: 0,
        validationFailed: 0,
        halted: false,
        lastChangelogId: changelogId(10),
      });
      expect(await scanAll(client, "users")).toEqual([{ id: "u1", name: "Alicia" }]);
      expect((await getVersionMeta(client, 'User::"u1"'))?.lastAppliedChangeId).toBe(changelogId(10));
    });

    it("consumes an older log whose id is earlier than the stored one", async () => {
      const { client } = await createTestSyncClient();
      await applyPull(client, [log({ changelogId: changelogId(10), operation: "create" })]);

      const result = await applyPull(client, [
        log({ changelogId: changelogId(9), operation: "update", record: { id: "u1", name: "Stale" } }),
      ]);

      expect(result).toEqual({
        changes: expect.any(Array),
        applied: 0,
        skipped: 1,
        validationFailed: 0,
        halted: false,
        lastChangelogId: changelogId(9),
      });
      expect(await scanAll(client, "users")).toEqual([{ id: "u1", name: "Alice" }]);
    });
  });
});

describe("applyPull with a compound key", () => {
  async function createMembershipClient() {
    const name = testDbName();
    const bootstrapDb = await openTestDb(name, [
      { name: "memberships", keyPath: ["orgId", "userId"] },
      OUTBOX_STORE,
      OUTBOX_ORDER_STORE,
      VERSION_META_STORE,
    ]);
    bootstrapDb.close();
    const contract = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        Membership: {
          store: "memberships",
          key: ["orgId", "userId"],
          fields: { orgId: "String", userId: "String", role: "String" },
        },
      },
    }) as unknown as IdbContract;
    return createSyncIdbClient({ contract, dbName: name, trackedModels: "*" });
  }

  const membership = { orgId: "o1", userId: "u1", role: "admin" };

  it("applies a create and then a delete addressed by the key array", async () => {
    const client = await createMembershipClient();
    const keyPath = ["o1", "u1"];
    const created = await applyPull(client, [
      { changelogId: changelogId(1), model: "Membership", operation: "create", keyPath, record: membership },
    ]);
    expect(created).toEqual({
      changes: expect.any(Array),
      applied: 1,
      skipped: 0,
      validationFailed: 0,
      halted: false,
      lastChangelogId: changelogId(1),
    });
    expect(await scanAll(client, "memberships")).toEqual([membership]);
    expect((await getVersionMeta(client, 'Membership::["o1","u1"]'))?.lastAppliedChangeId).toBe(changelogId(1));

    await applyPull(client, [
      { changelogId: changelogId(2), model: "Membership", operation: "delete", keyPath, record: null },
    ]);
    expect(await scanAll(client, "memberships")).toEqual([]);
  });

  it("rejects a key that is not an array of the right length, or that does not match the record", async () => {
    const client = await createMembershipClient();
    const result = await applyPull(client, [
      { changelogId: changelogId(1), model: "Membership", operation: "create", keyPath: "o1", record: membership },
      { changelogId: changelogId(2), model: "Membership", operation: "create", keyPath: ["o1"], record: membership },
      {
        changelogId: changelogId(3),
        model: "Membership",
        operation: "create",
        keyPath: ["o1", "someone-else"],
        record: membership,
      },
    ]);
    expect(result).toEqual({
      changes: expect.any(Array),
      applied: 0,
      skipped: 3,
      validationFailed: 3,
      halted: false,
      lastChangelogId: changelogId(3),
    });
    expect(await scanAll(client, "memberships")).toEqual([]);
    expect(await scanAll(client, "_idb_sync_version_meta")).toEqual([]);
  });
});

describe("applyPull keeping an unsent move onto a deleted parent, whatever the relation references", () => {
  /**
   * A Parent identified by its key, a unique slug, a unique (tenant, code) pair, or a Decimal key in
   * DecParent. A Child points at one parent through each relation, and every relation cascades.
   */
  async function createClient() {
    const contract = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        Parent: {
          store: "parents",
          key: "id",
          fields: { id: "String", slug: "String", tenant: "String", code: "String" },
          indexes: {
            bySlug: { keyPath: "slug", unique: true },
            byTenantCode: { keyPath: ["tenant", "code"], unique: true },
          },
          relations: {
            childrenBySlug: { to: "Child", cardinality: "1:N", on: { local: ["slug"], target: ["parentSlug"] } },
            childrenByCode: {
              to: "Child",
              cardinality: "1:N",
              on: { local: ["tenant", "code"], target: ["tenant", "parentCode"] },
            },
          },
        },
        DecParent: {
          store: "decParents",
          key: "id",
          fields: { id: "Decimal" },
          relations: {
            children: { to: "Child", cardinality: "1:N", on: { local: ["id"], target: ["decParentId"] } },
          },
        },
        Child: {
          store: "children",
          key: "id",
          fields: {
            id: "String",
            title: "String",
            parentSlug: "String?",
            tenant: "String?",
            parentCode: "String?",
            decParentId: "Decimal?",
          },
          relations: {
            bySlug: {
              to: "Parent",
              cardinality: "N:1",
              on: { local: ["parentSlug"], target: ["slug"] },
              onDelete: "cascade",
            },
            byCode: {
              to: "Parent",
              cardinality: "N:1",
              on: { local: ["tenant", "parentCode"], target: ["tenant", "code"] },
              onDelete: "cascade",
            },
            byDecimal: {
              to: "DecParent",
              cardinality: "N:1",
              on: { local: ["decParentId"], target: ["id"] },
              onDelete: "cascade",
            },
          },
        },
      },
    });
    const client = await createAutoMigratingSyncIdbClient({
      contractSpace: buildContractSpaceFixture(contract),
      dbName: testDbName(),
      extensions: [idbSyncExtension],
    });
    const create = (n: number, model: string, keyPath: unknown, record: Record<string, unknown>): LogWithRecord =>
      ({ changelogId: changelogId(n), model, operation: "create", keyPath, record }) as LogWithRecord;
    await applyPull(client, [
      create(1, "Parent", "p1", { id: "p1", slug: "one", tenant: "t", code: "c1" }),
      create(2, "Parent", "p2", { id: "p2", slug: "two", tenant: "t", code: "c2" }),
      create(3, "DecParent", "1.50", { id: "1.50" }),
      create(4, "DecParent", "2.50", { id: "2.50" }),
    ]);
    return client;
  }

  async function seedChild(
    client: Awaited<ReturnType<typeof createClient>>,
    links: Record<string, unknown>
  ): Promise<void> {
    await applyPull(client, [
      {
        changelogId: changelogId(5),
        model: "Child",
        operation: "create",
        keyPath: "k1",
        record: {
          id: "k1",
          title: "server",
          parentSlug: null,
          tenant: null,
          parentCode: null,
          decParentId: null,
          ...links,
        },
      } as LogWithRecord,
    ]);
  }

  async function expectKeptPending(client: Awaited<ReturnType<typeof createClient>>, events = 1): Promise<void> {
    expect(await scanAll(client, "children")).toEqual([]);
    const outbox = (await scanAll(client, "_idb_sync_outbox")).filter((event) => event["entityType"] === "Child");
    expect(outbox).toHaveLength(events);
    for (const event of outbox) expect(event).toMatchObject({ retryable: true, lastError: null });
    expect(await keyGet(client, "_idb_sync_version_meta", 'Child::"k1"')).toMatchObject({ localChangePending: true });
  }

  it("matches a relation that references a unique field, not the key", async () => {
    const client = await createClient();
    try {
      await seedChild(client, { parentSlug: "one" });
      await asAccessors(client.orm)["children"]!.where({ id: "k1" }).update({ parentSlug: "two" });
      await applyPull(client, [
        { changelogId: changelogId(6), model: "Parent", operation: "delete", keyPath: "p2", record: null },
      ]);
      await expectKeptPending(client);
    } finally {
      await client.close();
    }
  });

  it("matches a compound reference when the move changed only one of its fields", async () => {
    const client = await createClient();
    try {
      await seedChild(client, { tenant: "t", parentCode: "c1" });
      await asAccessors(client.orm)["children"]!.where({ id: "k1" }).update({ parentCode: "c2" });
      await applyPull(client, [
        { changelogId: changelogId(6), model: "Parent", operation: "delete", keyPath: "p2", record: null },
      ]);
      await expectKeptPending(client);
    } finally {
      await client.close();
    }
  });

  it("matches a Decimal reference written with another spelling", async () => {
    const client = await createClient();
    try {
      await seedChild(client, { decParentId: "1.50" });
      await asAccessors(client.orm)["children"]!.where({ id: "k1" }).update({ decParentId: "2.5" });
      await applyPull(client, [
        { changelogId: changelogId(6), model: "DecParent", operation: "delete", keyPath: "2.50", record: null },
      ]);
      await expectKeptPending(client);
    } finally {
      await client.close();
    }
  });

  it("keeps every unsent event of a moved row, including one that did not move it", async () => {
    const client = await createClient();
    try {
      await seedChild(client, { parentSlug: "one" });
      const children = asAccessors(client.orm)["children"]!;
      await children.where({ id: "k1" }).update({ title: "edited offline" });
      await children.where({ id: "k1" }).update({ parentSlug: "two" });
      await applyPull(client, [
        { changelogId: changelogId(6), model: "Parent", operation: "delete", keyPath: "p2", record: null },
      ]);
      await expectKeptPending(client, 2);
    } finally {
      await client.close();
    }
  });

  it("discards an edit whose patch repeats the parent the row already had, and announces it", async () => {
    const client = await createClient();
    try {
      await seedChild(client, { parentSlug: "one" });
      // Lists the foreign key without changing it: the server has the row under the same parent.
      await asAccessors(client.orm)["children"]!.where({ id: "k1" }).update({ parentSlug: "one", title: "edited" });
      const [queued] = (await scanAll(client, "_idb_sync_outbox")).filter((e) => e["entityType"] === "Child");
      expect(queued).toMatchObject({ payload: { previous: { parentSlug: "one" } } });
      let changes = 0;
      const off = client.on("outboxchange", () => changes++);
      expect(await client.outbox.pendingCount()).toBe(1);

      await applyPull(client, [
        { changelogId: changelogId(6), model: "Parent", operation: "delete", keyPath: "p1", record: null },
      ]);
      off();

      expect(await scanAll(client, "children")).toEqual([]);
      expect((await scanAll(client, "_idb_sync_outbox")).find((e) => e["entityType"] === "Child")).toMatchObject({
        retryable: false,
        lastError: DISCARDED_BY_PULL,
      });
      expect(await keyGet(client, "_idb_sync_version_meta", 'Child::"k1"')).toMatchObject({
        localChangePending: false,
      });
      expect(await client.outbox.pendingCount()).toBe(0);
      expect(changes).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("discards the unsent edit of a row the delete cascaded to without a move", async () => {
    const client = await createClient();
    try {
      await seedChild(client, { parentSlug: "two" });
      await asAccessors(client.orm)["children"]!.where({ id: "k1" }).update({ title: "edited offline" });
      await applyPull(client, [
        { changelogId: changelogId(6), model: "Parent", operation: "delete", keyPath: "p2", record: null },
      ]);
      expect(await scanAll(client, "children")).toEqual([]);
      expect((await scanAll(client, "_idb_sync_outbox")).find((e) => e["entityType"] === "Child")).toMatchObject({
        retryable: false,
        lastError: DISCARDED_BY_PULL,
      });
    } finally {
      await client.close();
    }
  });
});

describe("applyPull discarding unsent edits of cascaded rows", () => {
  it("keeps an unsent move onto a parent the server deletes, so the push is rejected and reconciled", async () => {
    const { client } = await createTestSyncClient();
    try {
      await applyPull(client, [
        log({ changelogId: "c1", operation: "create" }),
        log({ changelogId: "c2", keyPath: "u2", operation: "create", record: { id: "u2", name: "Bob" } }),
        log({
          changelogId: "c3",
          model: "Post",
          keyPath: "p1",
          operation: "create",
          record: { id: "p1", title: "Hi", authorId: "u1" },
        }),
      ]);
      // Moved offline: the server still has p1 under u1, so deleting u2 there does not delete p1.
      await asAccessors(client.orm)["posts"]!.where({ id: "p1" }).update({ authorId: "u2" });

      const result = await applyPull(client, [
        log({ changelogId: "c4", keyPath: "u2", operation: "delete", record: null }),
      ]);

      expect(result).toMatchObject({ applied: 1, halted: false });
      expect(await scanAll(client, "posts")).toEqual([]);
      expect(await client.outbox.hasPending()).toBe(true);
      expect(await scanAll(client, "_idb_sync_outbox")).toMatchObject([
        { entityType: "Post", operation: "update", retryable: true, lastError: null },
      ]);
      expect(await keyGet(client, "_idb_sync_version_meta", 'Post::"p1"')).toMatchObject({
        localChangePending: true,
      });
    } finally {
      await client.close();
    }
  });

  /** Org → Board → Card cascades, a Note whose org is set to null, and a Decimal-keyed Card. */
  async function createTreeClient() {
    const name = testDbName();
    (
      await openTestDb(name, [
        { name: "orgs", keyPath: "id" },
        { name: "boards", keyPath: "id", indexes: [{ name: "orgId", keyPath: "orgId" }] },
        { name: "cards", keyPath: "id", indexes: [{ name: "boardId", keyPath: "boardId" }] },
        { name: "notes", keyPath: "id", indexes: [{ name: "orgId", keyPath: "orgId" }] },
        OUTBOX_STORE,
        OUTBOX_ORDER_STORE,
        VERSION_META_STORE,
      ])
    ).close();
    const contract = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        Org: {
          store: "orgs",
          key: "id",
          fields: { id: "String" },
          relations: {
            boards: { to: "Board", cardinality: "1:N", on: { local: ["id"], target: ["orgId"] } },
            notes: { to: "Note", cardinality: "1:N", on: { local: ["id"], target: ["orgId"] } },
          },
        },
        Board: {
          store: "boards",
          key: "id",
          fields: { id: "String", orgId: "String" },
          indexes: { orgId: { keyPath: "orgId" } },
          relations: {
            org: { to: "Org", cardinality: "N:1", on: { local: ["orgId"], target: ["id"] }, onDelete: "cascade" },
            cards: { to: "Card", cardinality: "1:N", on: { local: ["id"], target: ["boardId"] } },
          },
        },
        Card: {
          store: "cards",
          key: "id",
          fields: { id: "Decimal", boardId: "String", title: "String" },
          indexes: { boardId: { keyPath: "boardId" } },
          relations: {
            board: {
              to: "Board",
              cardinality: "N:1",
              on: { local: ["boardId"], target: ["id"] },
              onDelete: "cascade",
            },
          },
        },
        Note: {
          store: "notes",
          key: "id",
          fields: { id: "String", orgId: "String?", text: "String" },
          indexes: { orgId: { keyPath: "orgId" } },
          relations: {
            org: { to: "Org", cardinality: "N:1", on: { local: ["orgId"], target: ["id"] }, onDelete: "setNull" },
          },
        },
      },
    }) as unknown as IdbContract;
    const client = createSyncIdbClient({ contract, dbName: name, trackedModels: "*" });
    const create = (n: number, model: string, keyPath: unknown, record: Record<string, unknown>): LogWithRecord =>
      ({ changelogId: changelogId(n), model, operation: "create", keyPath, record }) as LogWithRecord;
    await applyPull(client, [
      create(1, "Org", "o1", { id: "o1" }),
      create(2, "Board", "b1", { id: "b1", orgId: "o1" }),
      create(3, "Card", "1.50", { id: "1.50", boardId: "b1", title: "server" }),
      create(4, "Note", "n1", { id: "n1", orgId: "o1", text: "server" }),
    ]);
    return client;
  }

  it("reads the version metadata once for a pulled delete that cascades to many Decimal-keyed rows", async () => {
    const client = await createTreeClient();
    try {
      await applyPull(
        client,
        [2, 3, 4].map(
          (n) =>
            ({
              changelogId: changelogId(5 + n),
              model: "Card",
              operation: "create",
              keyPath: `${n}.50`,
              record: { id: `${n}.50`, boardId: "b1", title: "server" },
            }) as LogWithRecord
        )
      );
      await asAccessors(client.orm)["cards"]!.where({ boardId: "b1" }).update({ title: "edited offline" });
      let metaScans = 0;
      const withTransaction = client.withTransaction.bind(client);
      client.withTransaction = ((stores, fn) =>
        withTransaction(stores, (scope) => {
          const execute = scope.execute.bind(scope);
          scope.execute = (plan) => {
            if (plan.kind === "cursor-scan" && plan.storeName === "_idb_sync_version_meta") metaScans++;
            return execute(plan);
          };
          return fn(scope);
        })) as typeof client.withTransaction;

      await applyPull(client, [
        { changelogId: changelogId(20), model: "Org", operation: "delete", keyPath: "o1", record: null },
      ]);

      expect(await scanAll(client, "cards")).toEqual([]);
      expect(metaScans).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("discards a grandchild's unsent edit, matched by its Decimal key, and keeps a SetNull child's", async () => {
    const client = await createTreeClient();
    try {
      const accessors = asAccessors(client.orm);
      await accessors["cards"]!.where({ boardId: "b1" }).update({ title: "edited offline" });
      await accessors["notes"]!.where({ id: "n1" }).update({ text: "edited offline" });
      expect(await scanAll(client, "_idb_sync_outbox")).toHaveLength(2);

      const result = await applyPull(client, [
        { changelogId: changelogId(5), model: "Org", operation: "delete", keyPath: "o1", record: null },
      ]);

      expect(result).toMatchObject({ applied: 1, halted: false });
      expect(await scanAll(client, "boards")).toEqual([]);
      expect(await scanAll(client, "cards")).toEqual([]);
      expect(await scanAll(client, "notes")).toMatchObject([{ id: "n1", orgId: null, text: "edited offline" }]);
      const events = await scanAll(client, "_idb_sync_outbox");
      expect(events.find((event) => event["entityType"] === "Card")).toMatchObject({
        retryable: false,
        lastError: DISCARDED_BY_PULL,
      });
      expect(events.find((event) => event["entityType"] === "Note")).toMatchObject({
        retryable: true,
        lastError: null,
      });
      expect(await client.outbox.pendingCount()).toBe(1);
    } finally {
      await client.close();
    }
  });
});

describe("applyPull with an injected IDBKeyRange and no global one", () => {
  it("cascades a pulled delete instead of halting on the missing global", async () => {
    const dbName = testDbName();
    (
      await openTestDb(dbName, [
        { name: "users", keyPath: "id" },
        { name: "posts", keyPath: "id", indexes: [{ name: "authorId", keyPath: "authorId" }] },
        OUTBOX_STORE,
        OUTBOX_ORDER_STORE,
        VERSION_META_STORE,
        SYNC_META_STORE,
      ])
    ).close();
    const client = createSyncIdbClient({
      contract: testContract(),
      dbName,
      trackedModels: "*",
      keyRange: FakeIDBKeyRange,
    });
    try {
      await applyPull(client, [
        log({ changelogId: "c1", operation: "create" }),
        log({
          changelogId: "c2",
          model: "Post",
          keyPath: "p1",
          operation: "create",
          record: { id: "p1", title: "Hi", authorId: "u1" },
        }),
      ]);
      vi.stubGlobal("IDBKeyRange", undefined);
      const result = await applyPull(client, [log({ changelogId: "c3", operation: "delete", record: null })]);
      expect(result).toMatchObject({ applied: 1, halted: false, lastChangelogId: "c3" });
      expect(await scanAll(client, "posts")).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      await client.close();
    }
  });
});
