import { describe, expect, it } from "vitest";
import { createSqlSync, createSqlSyncAdapter } from "../src/exports/index";
import type { ModelWritePolicies, SqlPushWireEvent } from "../src/exports/index";
import { seed, testClientContract, testContract, testDb, testSyncServer } from "./helpers";

/** Binds the policy under test to the real fixture contract and ownership server. */
function adapter(writePolicies: ModelWritePolicies) {
  return createSqlSyncAdapter({ contract: testContract, syncServer: testSyncServer, writePolicies });
}

/** Applies a batch with the authenticated fixture scope and current storage hash. */
async function push(writePolicies: ModelWritePolicies, events: readonly SqlPushWireEvent[]) {
  return adapter(writePolicies).applyPush(await testDb(), {
    events,
    scopeKey: "u1",
    clientStorageHash: testSyncServer.clientStorageHash,
  });
}

describe("per-model write policies", () => {
  it("rejects a policy for a model absent from the contract", () => {
    expect(() =>
      createSqlSyncAdapter({
        contract: testContract,
        writePolicies: { Usr: { operations: ["update"], writableFields: ["name"] } },
      })
    ).toThrow('createSqlSyncAdapter: write policy model "Usr" is not in the contract.');
  });

  it("allows creates with listed payload fields", async () => {
    const db = await testDb();
    expect(
      await push({ User: { operations: ["create"], writableFields: ["id", "name"] } }, [
        { id: "create", entityType: "User", operation: "create", payload: { id: "u1", name: "Ann" } },
      ])
    ).toEqual({ ok: true, results: [{ id: "create", success: true }] });
    expect(await db.orm.public.User.where({ id: "u1" }).first()).toMatchObject({ name: "Ann" });
  });

  it("allows updates with listed patch fields without treating the target key as a write", async () => {
    const db = await testDb();
    await seed(db, { User: [{ id: "u1", name: "Ann" }] });
    expect(
      await push({ User: { operations: ["update"], writableFields: ["name"] } }, [
        { id: "update", entityType: "User", operation: "update", payload: { key: "u1", patch: { name: "Ana" } } },
      ])
    ).toEqual({ ok: true, results: [{ id: "update", success: true }] });
    expect(await db.orm.public.User.where({ id: "u1" }).first()).toMatchObject({ name: "Ana" });
  });

  it("allows deletes without treating the target key as a write", async () => {
    const db = await testDb();
    await seed(db, { User: [{ id: "u1", name: "Ann" }] });
    expect(
      await push({ User: { operations: ["delete"], writableFields: [] } }, [
        { id: "delete", entityType: "User", operation: "delete", payload: { key: "u1" } },
      ])
    ).toEqual({ ok: true, results: [{ id: "delete", success: true }] });
    expect(await db.orm.public.User.where({ id: "u1" }).first()).toBeNull();
  });

  it.each(["create", "update", "delete"] as const)("rejects %s when the operation is not listed", async (operation) => {
    const db = await testDb();
    await seed(db, { User: [{ id: "u1", name: "Ann" }] });
    const payload = operation === "create" ? { id: "u1", name: "Ana" } : { key: "u1", patch: { name: "Ana" } };
    expect(
      await push({ User: { operations: [], writableFields: ["id", "name"] } }, [
        { id: "denied", entityType: "User", operation, payload },
      ])
    ).toEqual({ ok: false, reason: "write-policy-violation", eventId: "denied" });
    expect(await db.orm.public.User.where({ id: "u1" }).first()).toMatchObject({ name: "Ann" });
    expect(await db.orm.public.Changelog.all().toArray()).toEqual([]);
  });

  it.each(["create", "update"] as const)(
    "rejects unlisted fields in a %s, including fields unknown to the contract",
    async (operation) => {
      const db = await testDb();
      await seed(db, { User: [{ id: "u1", name: "Ann" }] });
      const fields = { name: "Ana", futureAuthField: true };
      const payload = operation === "create" ? { id: "u2", ...fields } : { key: "u1", patch: fields };
      expect(
        await push({ User: { operations: [operation], writableFields: ["id", "name"] } }, [
          { id: "denied", entityType: "User", operation, payload },
        ])
      ).toEqual({ ok: false, reason: "write-policy-violation", eventId: "denied" });
      expect(await db.orm.public.User.all().toArray()).toEqual([{ id: "u1", name: "Ann" }]);
      expect(await db.orm.public.Changelog.all().toArray()).toEqual([]);
    }
  );

  it("checks explicit update fields even when the primary key is unchanged", async () => {
    expect(
      await push({ User: { operations: ["update"], writableFields: ["name"] } }, [
        {
          id: "denied",
          entityType: "User",
          operation: "update",
          payload: { key: "u1", patch: { id: "u1", name: "Ana" } },
        },
      ])
    ).toEqual({ ok: false, reason: "write-policy-violation", eventId: "denied" });
  });

  it("returns HTTP 403 for a mixed batch without writing earlier permitted events or changelog rows", async () => {
    const db = await testDb();
    await seed(db, { User: [{ id: "u1", name: "Ann" }] });
    const handlers = createSqlSync({
      contract: testContract,
      clientContract: testClientContract,
      rootModel: "User",
      db,
      scopeKey: "u1",
      writePolicies: { User: { operations: ["update"], writableFields: ["name"] } },
    });
    const board: SqlPushWireEvent = {
      id: "board",
      entityType: "Board",
      operation: "create",
      payload: { id: "b1", ownerId: "u1" },
    };
    /** Sends the fixture's actual wire envelope to the public HTTP endpoint. */
    const request = (events: readonly SqlPushWireEvent[]) =>
      new Request("https://sync.test/push", {
        method: "POST",
        body: JSON.stringify({ storageHash: testSyncServer.clientStorageHash, events }),
      });
    const response = await handlers.push(
      request([
        board,
        { id: "profile", entityType: "User", operation: "update", payload: { key: "u1", patch: { name: "Ana" } } },
        { id: "denied", entityType: "User", operation: "delete", payload: { key: "u1" } },
      ])
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, reason: "write-policy-violation", eventId: "denied" });
    expect(await db.orm.public.Board.all().toArray()).toEqual([]);
    expect(await db.orm.public.User.where({ id: "u1" }).first()).toMatchObject({ name: "Ann" });
    expect(await db.orm.public.Changelog.all().toArray()).toEqual([]);
  });

  it("allows writes to a model without a policy", async () => {
    const db = await testDb();
    await seed(db, { User: [{ id: "u1", name: "Ann" }] });
    expect(
      await push({ User: { operations: ["update"], writableFields: ["name"] } }, [
        { id: "board", entityType: "Board", operation: "create", payload: { id: "b1", ownerId: "u1" } },
      ])
    ).toEqual({ ok: true, results: [{ id: "board", success: true }] });
    expect(await db.orm.public.Board.where({ id: "b1" }).first()).toMatchObject({ ownerId: "u1" });
  });

  it("leaves malformed allowed payloads to ordinary record validation", async () => {
    const result = await push({ User: { operations: ["update"], writableFields: ["name"] } }, [
      { id: "malformed", entityType: "User", operation: "update", payload: { key: "u1", patch: null } },
    ]);
    expect(result).toMatchObject({
      ok: true,
      results: [{ id: "malformed", success: false, error: "RECORD_VALIDATION_FAILURE" }],
    });
  });

  it("enforces the policy through the lower-level single-event API", async () => {
    const db = await testDb();
    await seed(db, { User: [{ id: "u1", name: "Ann" }] });
    const result = await adapter({ User: { operations: ["update"], writableFields: ["name"] } }).applyPushEvent(
      db,
      { id: "denied", operation: "delete", payload: { key: "u1" } },
      "User",
      { kind: "root", keyField: "id", key: "u1", scopeKey: "u1", authorized: true },
      "u1"
    );
    expect(result).toEqual({ id: "denied", success: false, error: "WRITE_POLICY_VIOLATION", retryable: false });
    expect(await db.orm.public.User.where({ id: "u1" }).first()).toMatchObject({ name: "Ann" });
    expect(await db.orm.public.Changelog.all().toArray()).toEqual([]);
  });
});
