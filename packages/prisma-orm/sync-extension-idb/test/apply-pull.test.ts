import { describe, expect, it } from "vitest";
import { applyPull } from "../src/core/apply-pull";
import type { LogWithRecord, VersionMetaRecord } from "../src/types";
import { createTestSyncClient, keyGet, scanAll } from "./helpers";

function log(overrides: Partial<LogWithRecord> & Pick<LogWithRecord, "changelogId" | "operation">): LogWithRecord {
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

describe("applyPull", () => {
  it("applies a create log and writes version-meta", async () => {
    const { client } = await createTestSyncClient();

    const result = await applyPull(client, [log({ changelogId: "c1", operation: "create" })]);

    expect(result).toEqual({ applied: 1, skipped: 0, lastChangelogId: "c1" });
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

    expect(result).toEqual({ applied: 1, skipped: 0, lastChangelogId: "c2" });
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

    expect(result).toEqual({ applied: 1, skipped: 0, lastChangelogId: "c3" });
    expect(await scanAll(client, "users")).toHaveLength(0);
    expect(await scanAll(client, "posts")).toHaveLength(0);
  });

  it("skips a log when the local version-meta has a pending local change (local write wins)", async () => {
    const { client } = await createTestSyncClient();
    await seedVersionMeta(client, {
      id: 'User::"u1"',
      model: "User",
      key: "u1",
      lastAppliedChangeId: null,
      localChangePending: true,
    });

    const result = await applyPull(client, [log({ changelogId: "c1", operation: "create" })]);

    expect(result).toEqual({ applied: 0, skipped: 1, lastChangelogId: null });
    expect(await scanAll(client, "users")).toHaveLength(0);
  });

  it("skips a stale log (lastAppliedChangeId already >= incoming changelogId)", async () => {
    const { client } = await createTestSyncClient();
    await applyPull(client, [log({ changelogId: "c5", operation: "create" })]);

    const result = await applyPull(client, [
      log({ changelogId: "c3", operation: "update", record: { id: "u1", name: "Stale" } }),
    ]);

    expect(result).toEqual({ applied: 0, skipped: 1, lastChangelogId: null });
    expect(await scanAll(client, "users")).toEqual([{ id: "u1", name: "Alice" }]);
  });

  it("skips logs for a model not present in the contract", async () => {
    const { client } = await createTestSyncClient();

    const result = await applyPull(client, [log({ changelogId: "c1", operation: "create", model: "Nonexistent" })]);

    expect(result).toEqual({ applied: 0, skipped: 1, lastChangelogId: null });
  });

  it("treats a create/update log with a null record as a no-op when nothing is materialized locally yet", async () => {
    const { client } = await createTestSyncClient();

    const result = await applyPull(client, [log({ changelogId: "c1", operation: "create", record: null })]);

    expect(result).toEqual({ applied: 1, skipped: 0, lastChangelogId: "c1" });
    expect(await scanAll(client, "users")).toHaveLength(0);
  });

  it("deletes an already-synced record when access is revoked (update log arrives with a null record)", async () => {
    const { client } = await createTestSyncClient();
    await applyPull(client, [log({ changelogId: "c1", operation: "create" })]);
    expect(await scanAll(client, "users")).toEqual([{ id: "u1", name: "Alice" }]);

    const result = await applyPull(client, [log({ changelogId: "c2", operation: "update", record: null })]);

    expect(result).toEqual({ applied: 1, skipped: 0, lastChangelogId: "c2" });
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

    expect(result).toEqual({ applied: 1, skipped: 0, lastChangelogId: "c3" });
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

    expect(result).toEqual({ applied: 3, skipped: 0, lastChangelogId: "c9" });
  });
});
