import { describe, expect, it } from "vitest";
import { createSqlSyncAdapter } from "../src/core/create-adapter";
import { ormRootFor } from "../src/core/orm-root";
import { seed, testContract, testDb, testSyncServer } from "./helpers";

const adapter = createSqlSyncAdapter({
  contract: testContract,
  syncServer: testSyncServer,
  contractCheck: "off",
});

describe("authorized event keys", () => {
  it("applyPushEvent rejects a check that authorized a different key, writing nothing", async () => {
    const db = await testDb();
    await seed(db, { User: [{ id: "u1", name: "Ann" }] });
    const [validation] = testSyncServer.validatePush(
      [{ id: "e1", model: "Board", operation: "create", payload: { id: "b1", ownerId: "u1" }, wireKey: "b1" }],
      { scopeKey: "u1" }
    );

    const result = await adapter.applyPushEvent(
      db,
      { id: "e1", operation: "create", payload: { id: "b2", ownerId: "u1" } },
      "Board",
      validation!.check,
      "u1"
    );

    expect(result).toEqual({ id: "e1", success: false, error: "KEYPATH_VALIDATION_FAILURE", retryable: false });
    expect(await ormRootFor(db, "Board").first({ id: "b2" })).toBeNull();
  });
});
