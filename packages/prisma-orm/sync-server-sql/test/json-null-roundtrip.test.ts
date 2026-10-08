import pg from "pg";
import { describe, expect, it } from "vitest";
import { createSqlSyncAdapter } from "../src/core/create-adapter";
import { ormRootFor } from "../src/core/orm-root";
import { seed, testContract, testDb, testSyncServer } from "./helpers";

const adapter = createSqlSyncAdapter({
  contract: testContract,
  syncServer: testSyncServer,
  contractFingerprintCheck: "off",
});

describe("required JSON null", () => {
  it("acknowledges create and update, stores JSON null, and pulls it through the real ORM", async () => {
    const db = await testDb();
    await seed(db, { User: [{ id: "u1", name: "Ann" }] });
    const events = [
      {
        id: "json-create",
        entityType: "JsonItem",
        operation: "create" as const,
        payload: { id: "j1", ownerId: "u1", value: null, jsonValue: null, optionalValue: null },
      },
      {
        id: "object-create",
        entityType: "JsonItem",
        operation: "create" as const,
        payload: {
          id: "j2",
          ownerId: "u1",
          value: { before: true },
          jsonValue: [null],
          optionalValue: { before: true },
        },
      },
      {
        id: "json-update",
        entityType: "JsonItem",
        operation: "update" as const,
        payload: { key: "j2", patch: { value: null, jsonValue: null, optionalValue: null } },
      },
    ];
    const acknowledged = { ok: true, results: events.map(({ id }) => ({ id, success: true })) };
    expect(await adapter.applyPush(db, { scopeKey: "u1", events })).toEqual(acknowledged);
    for (const id of ["j1", "j2"]) {
      expect(await ormRootFor(db, "JsonItem").first({ id })).toEqual({
        id,
        ownerId: "u1",
        value: null,
        jsonValue: null,
        optionalValue: null,
      });
    }

    // An ORM null alone cannot prove whether Postgres stored JSON null or SQL NULL.
    const sql = new pg.Client({ connectionString: process.env["DATABASE_URL"] });
    await sql.connect();
    try {
      expect(
        (
          await sql.query(
            'SELECT "id", "value" IS NULL AS "sqlNull", "value"::text AS "json", "jsonValue"::text AS "jsonText", "optionalValue" IS NULL AS "optionalSqlNull" FROM "JsonItem" ORDER BY "id"'
          )
        ).rows
      ).toEqual([
        { id: "j1", sqlNull: false, json: "null", jsonText: "null", optionalSqlNull: true },
        { id: "j2", sqlNull: false, json: "null", jsonText: "null", optionalSqlNull: true },
      ]);
    } finally {
      await sql.end();
    }

    const pulled = await adapter.pull(db, { scopeKey: "u1", lastChangelogId: null });
    if (!pulled.ok) throw new Error(pulled.reason);
    expect(pulled.logs).toHaveLength(3);
    expect(pulled.logs).toMatchObject([
      { keyPath: "j1", record: { id: "j1", ownerId: "u1", value: null, jsonValue: null } },
      { keyPath: "j2", record: { id: "j2", ownerId: "u1", value: null, jsonValue: null } },
      { keyPath: "j2", record: { id: "j2", ownerId: "u1", value: null, jsonValue: null } },
    ]);
    expect(JSON.parse(JSON.stringify(pulled))).toEqual(pulled);
    expect(await adapter.applyPush(db, { scopeKey: "u1", events })).toEqual(acknowledged);
    const retried = await adapter.pull(db, { scopeKey: "u1", lastChangelogId: null });
    if (!retried.ok) throw new Error(retried.reason);
    expect(retried.logs).toHaveLength(3);
    expect(events[0]!.payload.value).toBeNull();
    expect(events[2]!.payload.patch?.value).toBeNull();
  });

  it.each([{ value: { nested: null } }, { value: [null] }])("preserves nested JSON nulls: %j", async ({ value }) => {
    const db = await testDb();
    await seed(db, { User: [{ id: "u1", name: "Ann" }] });
    expect(
      await adapter.applyPush(db, {
        scopeKey: "u1",
        events: [
          {
            id: "json",
            entityType: "JsonItem",
            operation: "create",
            payload: { id: "j1", ownerId: "u1", value, jsonValue: value },
          },
        ],
      })
    ).toEqual({ ok: true, results: [{ id: "json", success: true }] });
    expect(await ormRootFor(db, "JsonItem").first({ id: "j1" })).toEqual({
      id: "j1",
      ownerId: "u1",
      value,
      jsonValue: value,
      optionalValue: null,
    });
  });
});
