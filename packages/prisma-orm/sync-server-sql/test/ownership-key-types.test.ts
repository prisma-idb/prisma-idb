import pg from "pg";
import { reviveWireKey } from "../src/core/wire-values";
import { createSyncServer } from "@prisma-idb/sync-server";
import { describe, expect, it } from "vitest";
import { createSqlSyncAdapter } from "../src/core/create-adapter";
import { lockRow } from "../src/core/row-lock";
import { testContract, testDb } from "./helpers";
import { sqlGetKeyField } from "../src/core/get-key-field";

const keyCases = [
  { type: "text", root: "User", child: "Board", owner: "ownerId", scopeKey: "owner", key: "child", patch: {} },
  {
    type: "bigint",
    root: "BigUser",
    child: "BigItem",
    owner: "ownerId",
    scopeKey: "9007199254740993",
    key: "9007199254740995",
    patch: { name: "child" },
  },
  {
    type: "uuid",
    root: "UuidUser",
    child: "UuidItem",
    owner: "ownerId",
    scopeKey: "d41e3f00-90d1-4a04-9d31-8c35b28f1d85",
    key: "cd727271-eaf9-4e56-8e9d-9d461008da48",
    patch: { name: "child" },
  },
  {
    type: "Bytes",
    root: "BytesUser",
    child: "BytesItem",
    owner: "ownerId",
    scopeKey: "AQIDBA==",
    key: "BQYHCA==",
    patch: { name: "child" },
  },
];

describe("ownership lock key casts", () => {
  it.each(keyCases)(
    "locks $type target and parent keys through the raw lane",
    async ({ root, child, owner, scopeKey, key, patch }) => {
      const db = await testDb();
      const namespace = testContract.domain.namespaces["public"]!;
      const server = createSyncServer({
        contract: testContract,
        clientContract: {
          ...testContract,
          domain: {
            namespaces: {
              public: {
                ...namespace,
                models: Object.fromEntries(
                  Object.entries(namespace.models).filter(([name]) => [root, child].includes(name))
                ),
              },
            },
          },
        },
        rootModel: root,
        getKeyField: sqlGetKeyField,
      });
      const adapter = createSqlSyncAdapter({ contract: testContract, syncServer: server, contractCheck: "off" });
      const events = [
        { id: "root", entityType: root, operation: "create" as const, payload: { id: scopeKey, name: "owner" } },
        {
          id: "child",
          entityType: child,
          operation: "create" as const,
          payload: { id: key, [owner]: scopeKey, ...patch },
        },
      ];
      expect(await adapter.applyPush(db, { scopeKey, events })).toEqual({
        ok: true,
        results: events.map(({ id }) => ({ id, success: true })),
      });
      const nativeScope = reviveWireKey(testContract, root, "id", scopeKey);
      const nativeKey = reviveWireKey(testContract, child, "id", key);
      const connection = new pg.Client({ connectionString: process.env["DATABASE_URL"] });
      await connection.connect();
      try {
        await connection.query("SET lock_timeout = '200ms'");
        await db.transaction(async (tx) => {
          expect(await lockRow(db, tx, testContract, child, nativeKey, "update")).toBe(true);
          expect(await lockRow(db, tx, testContract, root, nativeScope, "share")).toBe(true);
          await expect(
            connection.query(`SELECT 1 FROM "${child}" WHERE id = $1 FOR SHARE`, [nativeKey])
          ).rejects.toMatchObject({ code: "55P03" });
          await expect(
            connection.query(`SELECT 1 FROM "${root}" WHERE id = $1 FOR UPDATE`, [nativeScope])
          ).rejects.toMatchObject({ code: "55P03" });
        });
        expect(
          (await connection.query(`SELECT 1 FROM "${child}" WHERE id = $1 FOR UPDATE`, [nativeKey])).rowCount
        ).toBe(1);
      } finally {
        await connection.end();
      }
    }
  );

  it("uses the mapped table and primary-key column, including quoted names", async () => {
    const db = await testDb();
    const contract = structuredClone(testContract);
    const modelStorage = contract.domain.namespaces["public"]!.models["Board"]!.storage as {
      namespaceId: string;
      table: string;
      fields: Record<string, { column: string }>;
    };
    modelStorage.namespaceId = "pg_temp";
    modelStorage.table = 'mapped"board';
    modelStorage.fields["id"] = { column: 'mapped"key' };
    const storage = contract.storage as unknown as {
      namespaces: Record<string, { entries: { table: Record<string, unknown> } }>;
    };
    storage.namespaces["pg_temp"] = {
      entries: {
        table: {
          ['mapped"board']: {
            primaryKey: { columns: ['mapped"key'] },
            columns: { ['mapped"key']: { dataType: "pg/text" } },
          },
        },
      },
    };
    await db.transaction(async (tx) => {
      await tx.execute(
        db.raw.sql`CREATE TEMP TABLE "mapped""board" ("mapped""key" text PRIMARY KEY) ON COMMIT DROP`
          .affectedCount()
          .build()
      );
      await tx.execute(db.raw.sql`INSERT INTO "mapped""board" VALUES (${"key'with quote"})`.affectedCount().build());
      expect(await lockRow(db, tx, contract, "Board", "key'with quote", "update")).toBe(true);
      expect(await lockRow(db, tx, contract, "Board", "absent", "share")).toBe(false);
    });
  });

  it("does not require a raw SQL lane on SQLite", async () => {
    await expect(lockRow({}, {}, { ...testContract, target: "sqlite" }, "User", "owner", "share")).resolves.toBe(true);
    await expect(lockRow({}, {}, { ...testContract, target: "sqlite" }, "User", "owner", "update")).resolves.toBe(true);
  });
});
