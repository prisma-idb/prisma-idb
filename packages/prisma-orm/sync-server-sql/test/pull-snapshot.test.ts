/**
 * A pull reads a row and then each ownership hop in separate statements. A
 * write committed between them must not be seen by the later reads.
 */
import { describe, expect, it } from "vitest";
import { createSqlSyncAdapter } from "../src/core/create-adapter";
import { withCurrentRecord } from "../src/core/rejected-record";
import { sqlGetKeyField } from "../src/core/get-key-field";
import { ormRootFor } from "../src/core/orm-root";
import { testContract, testSyncServer, seed, testDb } from "./helpers";
import { interleaved } from "./interleave";

describe("pull snapshot", () => {
  it("checks a pulled row's owner as of the moment it read the row", async () => {
    const db = await testDb();
    await seed(db, {
      User: [
        { id: "u1", name: "Ann" },
        { id: "u2", name: "Bo" },
      ],
      Board: [{ id: "b1", ownerId: "u1" }],
      Todo: [{ id: "t1", boardId: "b1" }],
      Changelog: [{ model: "Todo", keyPath: "t1", operation: "update", scopeKey: "u1", outboxEventId: "e1" }],
    });
    const adapter = createSqlSyncAdapter({ contract: testContract, syncServer: testSyncServer, contractCheck: "off" });
    // The board moves to u2 after the pull read the todo, before it reads the board.
    const moveBoard = async () => {
      await ormRootFor(db, "Board").select("id").where({ id: "b1" }).update({ ownerId: "u2" });
    };

    const pulled = await adapter.pull(interleaved(db, moveBoard), { scopeKey: "u1" });

    // The todo and its owner come from one state, in which the todo was u1's.
    expect(pulled).toMatchObject({ ok: true, logs: [{ keyPath: "t1", record: { id: "t1", boardId: "b1" } }] });
    expect((await ormRootFor(db, "Board").first({ id: "b1" }))?.["ownerId"]).toBe("u2");
  });
});

describe("rejected-record snapshot", () => {
  it("checks the rejected row's owner as of the moment it read the row", async () => {
    const db = await testDb();
    await seed(db, {
      User: [
        { id: "u1", name: "Ann" },
        { id: "u2", name: "Bo" },
      ],
      Board: [{ id: "b1", ownerId: "u1" }],
      Todo: [{ id: "t1", boardId: "b1" }],
    });
    const moveBoard = async () => {
      await ormRootFor(db, "Board").select("id").where({ id: "b1" }).update({ ownerId: "u2" });
    };
    const event = { id: "e1", entityType: "Todo", operation: "update" as const, payload: { key: "t1", patch: {} } };
    const rejected = { id: "e1", success: false as const, error: "WRITE_FAILED", retryable: false as const };

    const result = await withCurrentRecord(
      interleaved(db, moveBoard),
      testSyncServer,
      testContract,
      sqlGetKeyField,
      "u1",
      event,
      rejected
    );

    // The todo and its owner come from one state, in which the todo was u1's.
    expect(result).toMatchObject({ record: { id: "t1", boardId: "b1" } });
    expect((await ormRootFor(db, "Board").first({ id: "b1" }))?.["ownerId"]).toBe("u2");
  });
});

describe("custom pull record snapshot", () => {
  it("resolves the row and its ownership from the same snapshot", async () => {
    const db = await testDb();
    await seed(db, {
      User: [
        { id: "u1", name: "Ann" },
        { id: "u2", name: "Bo" },
      ],
      Board: [{ id: "b1", ownerId: "u2" }],
      Todo: [{ id: "t1", boardId: "b1" }],
    });
    const adapter = createSqlSyncAdapter({ contract: testContract, syncServer: testSyncServer, contractCheck: "off" });
    const [decision] = testSyncServer.buildPullQueries([{ changelogId: "e1", model: "Todo", key: "t1" }], {
      scopeKey: "u1",
    });
    const moveBoard = async () => {
      await ormRootFor(db, "Board").select("id").where({ id: "b1" }).update({ ownerId: "u1" });
    };

    const record = await adapter.resolvePullRecord(interleaved(db, moveBoard), "Todo", decision!.check, "t1", "update");

    expect(record).toBeNull();
    expect((await ormRootFor(db, "Board").first({ id: "b1" }))?.["ownerId"]).toBe("u1");
  });
});
