import { describe, expect, it } from "vitest";
import type { OwnershipCheck } from "@prisma-idb/sync-server";
import { sqlGetKeyField } from "../src/core/get-key-field";
import { ormRootFor } from "../src/core/orm-root";
import { applyPushEvent } from "../src/core/push";
import { testContract, testDb } from "./helpers";

describe("pushes to missing root rows", () => {
  it.each(["update", "delete"] as const)(
    "accepts an authorized %s and stamps the changelog even when the root row is gone",
    async (operation) => {
      const db = await testDb();
      const check: OwnershipCheck = {
        kind: "root",
        keyField: "id",
        key: "u1",
        scopeKey: "u1",
        authorized: true,
      };
      const result = await applyPushEvent(
        db,
        testContract,
        sqlGetKeyField,
        {
          id: "missing-root-event",
          operation,
          payload: operation === "update" ? { key: "u1", patch: { name: "Changed" } } : { key: "u1" },
        },
        "User",
        check,
        "u1"
      );

      expect(result).toEqual({ id: "missing-root-event", success: true });
      expect(await ormRootFor(db, "User").first({ id: "u1" })).toBeNull();
      expect(await db.orm.public.Changelog.all()).toEqual([
        expect.objectContaining({
          model: "User",
          keyPath: "u1",
          scopeKey: "u1",
          operation,
          outboxEventId: "missing-root-event",
        }),
      ]);
    }
  );
});
