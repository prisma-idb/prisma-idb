import { describe, expect, it } from "vitest";
import { createSyncServer } from "@prisma-idb/sync-server";
import { createSqlSyncAdapter } from "../src/core/create-adapter";
import { sqlGetKeyField } from "../src/core/get-key-field";
import { ormRootFor } from "../src/core/orm-root";
import { seed, testContract, testDb } from "./helpers";

// The SQL fixture keeps @idb.exclude fields. Its client view drops them,
// following the same projection convention as test/helpers.ts.
const clientContract = structuredClone(testContract);
const models = clientContract.domain.namespaces["public"]!.models;
for (const name of Object.keys(models)) {
  if (!["User", "PrivateNote"].includes(name)) delete models[name];
}
delete models["PrivateNote"]!.fields["secret"];
delete models["PrivateNote"]!.fields["ownerId"];

const syncServer = createSyncServer({
  contract: testContract,
  clientContract,
  rootModel: "User",
  getKeyField: sqlGetKeyField,
});
const adapter = createSqlSyncAdapter({ contract: testContract, syncServer, contractCheck: "off" });
const serverRow = { id: "n1", title: "Visible", secret: "hidden", ownerId: "u1" };
const clientRow = { id: "n1", title: "Visible" };

/** Seeds a row whose authorization depends on a server-only foreign key. */
async function seedNote() {
  const db = await testDb();
  await seed(db, { User: [{ id: "u1", name: "Ann" }], PrivateNote: [serverRow] });
  return db;
}

/** Resolves the ownership check using the same client model filter as pull. */
function noteCheck(scopeKey: string) {
  return syncServer.buildPullQueries([{ changelogId: "log", model: "PrivateNote", key: "n1" }], { scopeKey })[0]!.check;
}

describe("client field projection", () => {
  it("projects a pulled row after authorizing through its server-only ownership field", async () => {
    const db = await seedNote();
    await seed(db, {
      Changelog: [
        {
          id: "019a0000-0000-7000-8000-000000000001",
          outboxEventId: "note-change",
          scopeKey: "u1",
          model: "PrivateNote",
          keyPath: "n1",
          operation: "update",
        },
      ],
    });
    const outcome = await adapter.pull(db, { scopeKey: "u1" });
    expect(outcome).toMatchObject({ ok: true, logs: [{ model: "PrivateNote", record: clientRow }] });
    if (!outcome.ok) throw new Error("Pull failed");
    expect(outcome.logs[0]!.record).toEqual(clientRow);
    expect(await ormRootFor(db, "PrivateNote").first({ id: "n1" })).toEqual(serverRow);
  });

  it("projects a rejected push's current record", async () => {
    const db = await seedNote();
    expect(
      await adapter.applyPush(db, {
        scopeKey: "u1",
        events: [
          {
            id: "bad-title",
            entityType: "PrivateNote",
            operation: "update",
            payload: { key: "n1", patch: { title: 42 } },
          },
        ],
      })
    ).toEqual({
      ok: true,
      results: [
        { id: "bad-title", success: false, error: "RECORD_VALIDATION_FAILURE", retryable: false, record: clientRow },
      ],
    });
  });

  it("projects the low-level record and still denies another scope", async () => {
    const db = await seedNote();
    expect(await adapter.resolvePullRecord(db, "PrivateNote", noteCheck("u1"), "n1", "update")).toEqual(clientRow);
    expect(await adapter.resolvePullRecord(db, "PrivateNote", noteCheck("u2"), "n1", "update")).toBeNull();
  });

  it("rejects without syncServer even when the check would return no record", async () => {
    const withoutServer = createSqlSyncAdapter({ contract: testContract });
    await expect(
      withoutServer.resolvePullRecord({}, "PrivateNote", { kind: "unknown-model" }, "n1", "update")
    ).rejects.toThrow("createSqlSyncAdapter: resolvePullRecord needs the `syncServer` option.");
  });
});
