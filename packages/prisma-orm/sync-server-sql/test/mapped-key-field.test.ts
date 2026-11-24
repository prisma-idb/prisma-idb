/**
 * A primary key mapped to another column (`id String @id @map("user_id")`)
 * is still addressed by its field name in the ORM and in sync payloads.
 */
import { describe, expect, it } from "vitest";
import { sqlGetKeyField } from "../src/core/get-key-field";
import { createSyncServer } from "@prisma-idb/sync-server";
import { createSqlSyncAdapter } from "../src/core/create-adapter";
import { seed, testClientContract, testContract, testDb, testSyncServer } from "./helpers";

describe("a primary key mapped to another column", () => {
  it("creates, pulls, updates and deletes a row with a mapped key in PostgreSQL", async () => {
    const db = await testDb();
    await seed(db, { User: [{ id: "u1", name: "Ann" }] });
    const adapter = createSqlSyncAdapter({ contract: testContract, syncServer: testSyncServer, contractCheck: "off" });
    const scopeKey = "u1";
    const record = { id: "n1", ownerId: scopeKey, text: "first" };
    const cases = [
      { operation: "create", payload: record, expected: record },
      {
        operation: "update",
        payload: { key: record.id, patch: { text: "second" } },
        expected: { ...record, text: "second" },
      },
      { operation: "delete", payload: { key: record.id }, expected: null },
    ] as const;

    let cursor: string | null = null;
    for (const { operation, payload, expected } of cases) {
      const event = { id: operation, entityType: "MappedNote", operation, payload };
      expect(await adapter.applyPush(db, { scopeKey, events: [event] })).toEqual({
        ok: true,
        results: [{ id: event.id, success: true }],
      });
      expect(await db.orm.public.MappedNote.first({ id: record.id })).toEqual(expected);
      const page = await adapter.pull(db, { scopeKey, lastChangelogId: cursor });
      if (!page.ok) throw new Error(page.reason);
      expect(page.logs).toMatchObject([{ model: "MappedNote", operation, keyPath: record.id, record: expected }]);
      cursor = page.logs[0]!.changelogId;
    }
  });

  it("follows mapped foreign keys through a parent with a mapped primary key", async () => {
    const db = await testDb();
    await seed(db, { User: [{ id: "u1", name: "Ann" }] });
    const adapter = createSqlSyncAdapter({ contract: testContract, syncServer: testSyncServer, contractCheck: "off" });
    const board = { id: "b1", ownerId: "u1" };
    const card = { id: "c1", boardId: "b1" };

    expect(
      await adapter.applyPush(db, {
        scopeKey: "u1",
        events: [
          { id: "board", entityType: "MappedBoard", operation: "create", payload: board },
          { id: "card", entityType: "MappedCard", operation: "create", payload: card },
        ],
      })
    ).toEqual({
      ok: true,
      results: [
        { id: "board", success: true },
        { id: "card", success: true },
      ],
    });
    expect(await db.orm.public.MappedCard.first({ id: "c1" })).toEqual(card);
    expect(await adapter.pull(db, { scopeKey: "u1" })).toMatchObject({
      ok: true,
      logs: [
        { model: "MappedBoard", keyPath: "b1", record: board },
        { model: "MappedCard", keyPath: "c1", record: card },
      ],
    });
  });

  it.each(["User", "MappedNote"])("rejects a compound key on synced %s at startup", (modelName) => {
    const contract = structuredClone(testContract);
    const tables = (
      contract.storage as unknown as {
        namespaces: { public: { entries: { table: Record<string, { primaryKey: { columns: string[] } }> } } };
      }
    ).namespaces.public.entries.table;
    tables[modelName]!.primaryKey.columns.push(modelName === "User" ? "name" : "text");

    expect(() =>
      createSyncServer({
        contract,
        clientContract: testClientContract,
        rootModel: "User",
        getKeyField: sqlGetKeyField,
      })
    ).toThrow(new RegExp(`Model "${modelName}" has no single-column primary key`));
  });
});
