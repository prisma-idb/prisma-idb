import { describe, expect, it, vi } from "vitest";
import { applyPull } from "../src/core/apply-pull";
import type { LogWithRecord, VersionMetaRecord } from "../src/types";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import type { IdbContract } from "@prisma-idb/client-idb/orm";
import { createSyncIdbClient } from "../src/exports/client";
import {
  OUTBOX_STORE,
  OUTBOX_ORDER_STORE,
  SYNC_META_STORE,
  VERSION_META_STORE,
  asAccessors,
  changelogId,
  createTestSyncClient,
  keyGet,
  openTestDb,
  scanAll,
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

describe("a pull after a local write to a Bytes-key row", () => {
  // Every local write path records its pending flag under the id a pull looks up: the base64 form of the key.
  type Accessors = ReturnType<typeof asAccessors>;
  type Write = (client: Awaited<ReturnType<typeof openBytesClient>>, tables: Accessors) => Promise<unknown>;

  const bytes = new Uint8Array([1, 2, 255]);
  const wireBytes = "AQL/";

  async function openBytesClient(compound: boolean, related: boolean) {
    const keyPath = compound ? ["tenant", "id"] : "id";
    const dbName = testDbName();
    (
      await openTestDb(dbName, [
        { name: "owners", keyPath: "id" },
        { name: "assets", keyPath },
        OUTBOX_STORE,
        OUTBOX_ORDER_STORE,
        VERSION_META_STORE,
        SYNC_META_STORE,
      ])
    ).close();
    // A related `Asset` makes every write run through a transaction scope, and allows nested writes. An
    // unrelated one runs its plain create, createAll and delete as one batch plan.
    const contract = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        Owner: {
          store: "owners",
          key: "id",
          fields: { id: "Bytes", name: "String" },
          relations: related
            ? { assets: { to: "Asset", cardinality: "1:N", on: { local: ["id"], target: ["ownerId"] } } }
            : {},
        },
        Asset: {
          store: "assets",
          key: keyPath,
          fields: { tenant: "String", id: "Bytes", ownerId: "Bytes", name: "String" },
          relations: related
            ? { owner: { to: "Owner", cardinality: "N:1", on: { local: ["ownerId"], target: ["id"] } } }
            : {},
        },
      },
    }) as unknown as IdbContract;
    return createSyncIdbClient({ contract, dbName, trackedModels: "*" });
  }

  const row = { tenant: "t1", id: bytes, ownerId: new Uint8Array([9]), name: "Before" };
  const owner = { id: row.ownerId, name: "Owner" };

  const writes: Record<string, { seedRow: boolean; write: (compound: boolean) => Write }> = {
    create: { seedRow: false, write: () => (_client, t) => t["assets"]!.create(row) },
    createAll: { seedRow: false, write: () => (_client, t) => t["assets"]!.createAll([row]).toArray() },
    update: {
      seedRow: true,
      write: (compound) => (_client, t) =>
        t["assets"]!.where(compound ? { tenant: "t1", id: bytes } : { id: bytes }).update({ name: "After" }),
    },
    updateAll: {
      seedRow: true,
      write: () => (_client, t) => t["assets"]!.where({ name: "Before" }).updateAll({ name: "After" }).toArray(),
    },
    delete: {
      seedRow: true,
      write: (compound) => (_client, t) => t["assets"]!.delete(compound ? ["t1", bytes] : bytes),
    },
    deleteAll: {
      seedRow: true,
      write: () => (_client, t) => t["assets"]!.where({ name: "Before" }).deleteAll().toArray(),
    },
    "upsert, create branch": {
      seedRow: false,
      write: (compound) => (_client, t) =>
        t["assets"]!.upsert({
          where: compound ? { tenant: "t1", id: bytes } : { id: bytes },
          create: row,
          update: { name: "After" },
        }),
    },
    "upsert, update branch": {
      seedRow: true,
      write: (compound) => (_client, t) =>
        t["assets"]!.upsert({
          where: compound ? { tenant: "t1", id: bytes } : { id: bytes },
          create: row,
          update: { name: "After" },
        }),
    },
    "nested create": {
      seedRow: false,
      write: () => async (_client, t) => {
        const other = { id: new Uint8Array([7]), name: "Other owner" };
        await t["owners"]!.create({
          ...other,
          assets: (rel: { create(data: Record<string, unknown>[]): unknown }) =>
            rel.create([{ ...row, ownerId: other.id }]),
        });
      },
    },
    "explicit transaction": {
      seedRow: true,
      write: (compound) => (client, _t) =>
        client.transaction(["assets"], (tx) =>
          tx["assets"]!.where(compound ? { tenant: "t1", id: bytes } : { id: bytes }).update({ name: "After" })
        ),
    },
  };

  describe.each([true, false])("with relations: %s", (related) => {
    describe.each(Object.keys(writes).filter((name) => related || name !== "nested create"))("%s", (name) => {
      it.each([false, true])(
        "keeps the row's pending flag under one id that a pull finds (compound: %s)",
        async (compound) => {
          const { seedRow, write } = writes[name]!;
          const client = await openBytesClient(compound, related);
          try {
            const tables = asAccessors(client.orm);
            await client.withoutTracking(async (orm) => {
              await asAccessors(orm)["owners"]!.create(owner);
              if (seedRow) await asAccessors(orm)["assets"]!.create(row);
            });
            await write(compound)(client, tables);

            const wireKey = compound ? ["t1", wireBytes] : wireBytes;
            const metaId = `Asset::${JSON.stringify(wireKey)}`;
            const metas = await scanAll(client, "_idb_sync_version_meta");
            const assetMetas = metas.filter((meta) => meta["model"] === "Asset");
            expect(assetMetas).toMatchObject([{ id: metaId, localChangePending: true }]);
            const events = await scanAll(client, "_idb_sync_outbox");
            expect(events.filter((event) => event["entityType"] === "Asset")).toMatchObject([
              { versionMetaId: metaId },
            ]);

            const before = await scanAll(client, "assets");
            const result = await applyPull(client, [
              {
                changelogId: changelogId(1),
                model: "Asset",
                operation: "update",
                keyPath: wireKey,
                record: { tenant: "t1", id: wireBytes, ownerId: "CQ==", name: "Server" },
              },
            ]);

            expect(result).toMatchObject({ applied: 0, halted: true, lastChangelogId: null });
            expect(await scanAll(client, "assets")).toEqual(before);
            expect(
              (await scanAll(client, "_idb_sync_version_meta")).filter((meta) => meta["model"] === "Asset")
            ).toHaveLength(1);
          } finally {
            await client.close();
          }
        }
      );
    });
  });
});
