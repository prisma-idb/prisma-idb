import { createSyncServer } from "@prisma-idb/sync-server";
import { describe, expect, it } from "vitest";
import { createSqlSyncAdapter } from "../src/core/create-adapter";
import { sqlGetKeyField } from "../src/core/get-key-field";
import { ormRootFor } from "../src/core/orm-root";
import { testContract, testDb } from "./helpers";

const namespace = testContract.domain.namespaces["public"]!;
const syncServer = createSyncServer({
  contract: testContract,
  clientContract: {
    ...testContract,
    domain: {
      namespaces: {
        public: {
          ...namespace,
          models: Object.fromEntries(
            Object.entries(namespace.models).filter(([name]) => ["BytesUser", "BytesItem"].includes(name))
          ),
        },
      },
    },
  },
  rootModel: "BytesUser",
  getKeyField: sqlGetKeyField,
});
const adapter = createSqlSyncAdapter({ contract: testContract, syncServer, contractCheck: "off" });

describe("Bytes primary-key pushes", () => {
  it("creates, updates and deletes the stored row", async () => {
    const db = await testDb();
    const scopeKey = "AQIDBA==";
    const nativeKey = new Uint8Array([1, 2, 3, 4]);
    const rows = ormRootFor(db, "BytesUser");
    const events = [
      {
        id: "bytes-create",
        entityType: "BytesUser",
        operation: "create" as const,
        payload: { id: scopeKey, name: "before" },
      },
      {
        id: "bytes-update",
        entityType: "BytesUser",
        operation: "update" as const,
        payload: { key: scopeKey, patch: { name: "after" } },
      },
      {
        id: "bytes-delete",
        entityType: "BytesUser",
        operation: "delete" as const,
        payload: { key: scopeKey },
      },
    ];
    const expectedRows = [{ id: nativeKey, name: "before" }, { id: nativeKey, name: "after" }, null];

    for (const [index, event] of events.entries()) {
      expect(await adapter.applyPush(db, { scopeKey, events: [event] })).toEqual({
        ok: true,
        results: [{ id: event.id, success: true }],
      });
      expect(await rows.first({ id: nativeKey })).toEqual(expectedRows[index]);
    }
  });
});
