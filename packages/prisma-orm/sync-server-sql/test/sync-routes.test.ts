import { describe, expect, it, vi } from "vitest";
import { createSqlSyncAdapter } from "../src/core/create-adapter";
import { applyPush, DEFAULT_MAX_PUSH_BATCH_SIZE } from "../src/core/apply-push";
import { pull } from "../src/core/pull-changes";
import { sqlGetKeyField } from "../src/core/get-key-field";
import { ormRootFor } from "../src/core/orm-root";
import { seed, testContract, testDb, testSyncServer } from "./helpers";

const adapter = createSqlSyncAdapter({ contract: testContract, syncServer: testSyncServer });

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const create = (id: string, entityType: string, payload: Record<string, unknown>) => ({
  id,
  entityType,
  operation: "create" as const,
  payload,
});

describe("applyPush", () => {
  it("rejects malformed creates, patches and keys without opening an ownership transaction", async () => {
    const transaction = vi.fn();
    const outcome = await adapter.applyPush(
      { transaction },
      {
        scopeKey: "u1",
        events: [
          create("create", "User", { id: "u1", name: 42 }),
          {
            id: "update",
            entityType: "Todo",
            operation: "update",
            payload: { key: "t1", patch: { dueAt: "invalid-date" } },
          },
          { id: "key", entityType: "User", operation: "delete", payload: { key: 42 } },
          { id: "rekey", entityType: "User", operation: "update", payload: { key: "u1", patch: { id: "u2" } } },
        ],
      }
    );
    expect(outcome).toEqual({
      ok: true,
      results: [
        { id: "create", success: false, error: "RECORD_VALIDATION_FAILURE", retryable: false },
        { id: "update", success: false, error: "RECORD_VALIDATION_FAILURE", retryable: false },
        { id: "key", success: false, error: "KEYPATH_VALIDATION_FAILURE", retryable: false },
        { id: "rekey", success: false, error: "KEYPATH_VALIDATION_FAILURE", retryable: false },
      ],
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("applies a batch with data dependencies in order and returns one result per event", async () => {
    const db = await testDb();
    const outcome = await adapter.applyPush(db, {
      scopeKey: "u1",
      events: [
        create("e1", "User", { id: "u1", name: "Ann" }),
        create("e2", "Board", { id: "b1", ownerId: "u1" }),
        create("e3", "Todo", { id: "t1", boardId: "b1" }),
        {
          id: "e4",
          entityType: "Todo",
          operation: "update",
          payload: { key: "t1", patch: { dueAt: "2026-01-02T03:04:05.000Z" } },
        },
      ],
    });
    expect(outcome).toEqual({
      ok: true,
      results: ["e1", "e2", "e3", "e4"].map((id) => ({ id, success: true })),
    });
    expect((await ormRootFor(db, "Todo").first({ id: "t1" }))?.["dueAt"]).toEqual(new Date("2026-01-02T03:04:05.000Z"));
  });

  it("leaves dependent and malformed events pending after a retryable failure, then applies them on retry", async () => {
    const db = await testDb();
    const transaction = vi
      .fn(db.transaction.bind(db))
      .mockImplementationOnce(db.transaction.bind(db))
      .mockRejectedValueOnce(new Error("temporary database failure"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const events = [
      create("user", "User", { id: "u1", name: "Ann" }),
      create("board", "Board", { id: "b1", ownerId: "u1" }),
      create("todo", "Todo", { id: "t1", boardId: "b1" }),
      { id: "malformed", entityType: "Todo", operation: "create" as const, payload: null },
    ];
    try {
      expect(await adapter.applyPush({ raw: db.raw, transaction }, { scopeKey: "u1", events })).toEqual({
        ok: true,
        results: [
          { id: "user", success: true },
          { id: "board", success: false, error: "Failed to apply event board", retryable: true },
        ],
      });
      expect(transaction).toHaveBeenCalledTimes(2);
      expect(errorLog).toHaveBeenCalledExactlyOnceWith(
        "push apply failed for event board",
        new Error("temporary database failure")
      );
      expect(await ormRootFor(db, "Board").first({ id: "b1" })).toBeNull();
      expect(await ormRootFor(db, "Todo").first({ id: "t1" })).toBeNull();
      expect(await ormRootFor(db, "Changelog").first({ outboxEventId: "todo" })).toBeNull();

      expect(await adapter.applyPush(db, { scopeKey: "u1", events: events.slice(1) })).toEqual({
        ok: true,
        results: [
          { id: "board", success: true },
          { id: "todo", success: true },
          { id: "malformed", success: false, error: "RECORD_VALIDATION_FAILURE", retryable: false },
        ],
      });
      expect(await ormRootFor(db, "Todo").first({ id: "t1" })).toMatchObject({ id: "t1", boardId: "b1" });
    } finally {
      errorLog.mockRestore();
    }
  });

  it("signals an oversized batch without applying anything", async () => {
    const db = await testDb();
    const events = [create("e1", "User", { id: "u1", name: "Ann" }), create("e2", "User", { id: "u2", name: "Bo" })];
    expect(await adapter.applyPush(db, { scopeKey: "u1", events, maxBatchSize: 1 })).toEqual({
      ok: false,
      reason: "batch-too-large",
      maxBatchSize: 1,
      received: 2,
    });
    expect(await ormRootFor(db, "User").first({ id: "u1" })).toBeNull();
  });

  it("accepts a batch exactly at the limit, and defaults the limit to DEFAULT_MAX_PUSH_BATCH_SIZE", async () => {
    const db = await testDb();
    const atLimit = await adapter.applyPush(db, {
      scopeKey: "u1",
      events: [create("e1", "User", { id: "u1", name: "Ann" })],
      maxBatchSize: 1,
    });
    expect(atLimit.ok).toBe(true);

    const events = Array.from({ length: DEFAULT_MAX_PUSH_BATCH_SIZE + 1 }, (_, i) => create(`x${i}`, "Ghost", {}));
    expect(await adapter.applyPush(db, { scopeKey: "u1", events })).toMatchObject({
      ok: false,
      reason: "batch-too-large",
      maxBatchSize: DEFAULT_MAX_PUSH_BATCH_SIZE,
    });
  });

  it("rejects a batch with a duplicate event id", async () => {
    const db = await testDb();
    const outcome = await adapter.applyPush(db, {
      scopeKey: "u1",
      events: [create("e1", "User", { id: "u1", name: "Ann" }), create("e1", "User", { id: "u2", name: "Bo" })],
    });
    expect(outcome).toEqual({ ok: false, reason: "duplicate-event-id", eventId: "e1" });
    expect(await ormRootFor(db, "User").first({ id: "u1" })).toBeNull();
  });

  it.each([
    ["create", null],
    ["create", "text"],
    ["create", [1]],
    ["update", null],
    ["delete", null],
    ["delete", 5],
  ])("fails only the event for a %s with payload %j, not the batch", async (operation, payload) => {
    const db = await testDb();
    const outcome = await adapter.applyPush(db, {
      scopeKey: "u1",
      events: [
        { id: "bad", entityType: "User", operation: operation as "create", payload },
        create("good", "User", { id: "u1", name: "Ann" }),
      ],
    });
    expect(outcome).toEqual({
      ok: true,
      results: [
        { id: "bad", success: false, error: "RECORD_VALIDATION_FAILURE", retryable: false },
        { id: "good", success: true },
      ],
    });
    expect(await ormRootFor(db, "User").first({ id: "u1" })).not.toBeNull();
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["a string", "x"],
    ["an array", [1]],
  ])("fails an update whose patch is %s instead of deleting the row", async (_label, patch) => {
    const db = await testDb();
    await seed(db, { User: [{ id: "u1", name: "Ann" }] });
    const outcome = await adapter.applyPush(db, {
      scopeKey: "u1",
      events: [
        { id: "bad", entityType: "User", operation: "update", payload: { key: "u1", patch } },
        create("good", "Board", { id: "b1", ownerId: "u1" }),
      ],
    });
    expect(outcome).toEqual({
      ok: true,
      results: [
        { id: "bad", success: false, error: "RECORD_VALIDATION_FAILURE", retryable: false },
        { id: "good", success: true },
      ],
    });
    expect(await ormRootFor(db, "User").first({ id: "u1" })).not.toBeNull();
  });

  it("fails only the bad events, keeping results in input order", async () => {
    const db = await testDb();
    await seed(db, {
      User: [{ id: "u2", name: "Bo" }],
      Board: [{ id: "b2", ownerId: "u2" }],
    });
    const outcome = await adapter.applyPush(db, {
      scopeKey: "u1",
      events: [
        create("e1", "Ghost", { id: "g1" }),
        create("e2", "User", { id: "u1", name: "Ann" }),
        { id: "e3", entityType: "Board", operation: "update", payload: { patch: { ownerId: "u1" } } },
        { id: "e4", entityType: "Board", operation: "delete", payload: { key: "b2" } },
      ],
    });
    expect(outcome).toEqual({
      ok: true,
      results: [
        { id: "e1", success: false, error: "Unknown model", retryable: false },
        { id: "e2", success: true },
        {
          id: "e3",
          success: false,
          error: "KEYPATH_VALIDATION_FAILURE",
          retryable: false,
        },
        { id: "e4", success: false, error: "SCOPE_VIOLATION", retryable: false },
      ],
    });
    expect(await ormRootFor(db, "Board").first({ id: "b2" })).not.toBeNull();
  });

  it("is idempotent when the same batch is pushed again", async () => {
    const db = await testDb();
    const input = { scopeKey: "u1", events: [create("e1", "User", { id: "u1", name: "Ann" })] };
    await adapter.applyPush(db, input);
    expect(await adapter.applyPush(db, input)).toEqual({ ok: true, results: [{ id: "e1", success: true }] });
  });

  it("throws a clear error when the adapter has no syncServer", async () => {
    const bare = createSqlSyncAdapter({ contract: testContract });
    await expect(bare.applyPush(await testDb(), { scopeKey: "u1", events: [] })).rejects.toThrow(/syncServer/);
    await expect(bare.pull(await testDb(), { scopeKey: "u1" })).rejects.toThrow(/syncServer/);
  });

  it("works as a standalone function too", async () => {
    const db = await testDb();
    const outcome = await applyPush(db, testSyncServer, testContract, sqlGetKeyField, {
      scopeKey: "u1",
      events: [create("e1", "User", { id: "u1", name: "Ann" })],
    });
    expect(outcome.ok).toBe(true);
  });
});

describe("pull", () => {
  async function pushAnnAndBo() {
    const db = await testDb();
    await adapter.applyPush(db, {
      scopeKey: "u1",
      events: [
        create("a1", "User", { id: "u1", name: "Ann" }),
        create("a2", "Board", { id: "b1", ownerId: "u1" }),
        create("a3", "Todo", { id: "t1", boardId: "b1" }),
      ],
    });
    await adapter.applyPush(db, {
      scopeKey: "u2",
      events: [create("b1", "User", { id: "u2", name: "Bo" }), create("b2", "Board", { id: "b9", ownerId: "u2" })],
    });
    return db;
  }

  it("returns only the caller's changes, oldest first, with the current record", async () => {
    const db = await pushAnnAndBo();
    const outcome = await adapter.pull(db, { scopeKey: "u1" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.logs.map((l) => [l.model, l.operation, l.keyPath])).toEqual([
      ["User", "create", "u1"],
      ["Board", "create", "b1"],
      ["Todo", "create", "t1"],
    ]);
    expect(outcome.logs[1]?.record).toEqual({ id: "b1", ownerId: "u1" });
    const ids = outcome.logs.map((l) => l.changelogId);
    expect(ids.every((id) => UUID_V7.test(id))).toBe(true);
    expect(ids).toEqual([...ids].sort());
  });

  it.each([0, -1, 0.5, 1.5, NaN, Infinity, -Infinity])("rejects invalid limit %s before querying", async (limit) => {
    await expect(adapter.pull(null, { scopeKey: "u1", limit })).rejects.toThrow(RangeError);
  });

  it("defaults limit to 50", async () => {
    const db = await testDb();
    await seed(db, { User: [{ id: "u1", name: "Ann" }] });
    for (let i = 0; i < 51; i++) {
      await seed(db, {
        Changelog: [{ model: "User", keyPath: "u1", operation: "update", scopeKey: "u1", outboxEventId: `e${i}` }],
      });
    }
    const outcome = await adapter.pull(db, { scopeKey: "u1" });
    expect(outcome.ok && outcome.logs).toHaveLength(50);
  });

  it("pairs reordered ownership checks by changelog id and preserves page order", async () => {
    const db = await pushAnnAndBo();
    const baseline = await adapter.pull(db, { scopeKey: "u1" });
    const reordered = createSqlSyncAdapter({
      contract: testContract,
      syncServer: {
        ...testSyncServer,
        buildPullQueries: (logs, options) => [...testSyncServer.buildPullQueries(logs, options)].reverse(),
      },
    });
    expect(await reordered.pull(db, { scopeKey: "u1" })).toEqual(baseline);
  });

  it("treats lastChangelogId as an exclusive cursor", async () => {
    const db = await pushAnnAndBo();
    const first = await adapter.pull(db, { scopeKey: "u1", limit: 2 });
    if (!first.ok) throw new Error("unexpected");
    expect(first.logs).toHaveLength(2);
    const cursor = first.logs[1]!.changelogId;

    const rest = await adapter.pull(db, { scopeKey: "u1", lastChangelogId: cursor });
    if (!rest.ok) throw new Error("unexpected");
    expect(rest.logs.map((l) => l.keyPath)).toEqual(["t1"]);
  });

  it("accepts an upper-case cursor", async () => {
    const db = await pushAnnAndBo();
    const first = await adapter.pull(db, { scopeKey: "u1", limit: 1 });
    if (!first.ok) throw new Error("unexpected");
    const rest = await adapter.pull(db, { scopeKey: "u1", lastChangelogId: first.logs[0]!.changelogId.toUpperCase() });
    if (!rest.ok) throw new Error("unexpected");
    expect(rest.logs.map((l) => l.keyPath)).toEqual(["b1", "t1"]);
  });

  it("pages through many rows in order with no gaps or repeats", async () => {
    const db = await testDb();
    await seed(db, { User: [{ id: "u1", name: "Ann" }] });
    for (let i = 0; i < 25; i++) {
      await seed(db, {
        Changelog: [{ model: "User", keyPath: "u1", operation: "update", scopeKey: "u1", outboxEventId: `e${i}` }],
      });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: Awaited<ReturnType<typeof adapter.pull>> = await adapter.pull(db, {
        scopeKey: "u1",
        lastChangelogId: cursor,
        limit: 10,
      });
      if (!page.ok) throw new Error("unexpected");
      if (page.logs.length === 0) break;
      seen.push(...page.logs.map((l) => l.changelogId));
      cursor = page.logs.at(-1)!.changelogId;
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(seen).toEqual([...seen].sort());
  });

  it("returns an empty page once caught up", async () => {
    const db = await pushAnnAndBo();
    const all = await adapter.pull(db, { scopeKey: "u1" });
    if (!all.ok) throw new Error("unexpected");
    const last = all.logs.at(-1)!.changelogId;
    expect(await adapter.pull(db, { scopeKey: "u1", lastChangelogId: last })).toEqual({ ok: true, logs: [] });
  });

  it("returns record: null for deletes and for rows that changed owner since the push", async () => {
    const db = await pushAnnAndBo();
    await adapter.applyPush(db, {
      scopeKey: "u1",
      events: [{ id: "a4", entityType: "Todo", operation: "delete", payload: { key: "t1" } }],
    });
    // Board b1 was handed to u2 after u1 pushed it: still in u1's changelog, no longer u1's.
    await ormRootFor(db, "Board").select("id").where({ id: "b1" }).update({ ownerId: "u2" });

    const outcome = await adapter.pull(db, { scopeKey: "u1" });
    if (!outcome.ok) throw new Error("unexpected");
    const byKey = Object.fromEntries(
      outcome.logs.map((l) => [`${l.model}:${l.operation}:${String(l.keyPath)}`, l.record])
    );
    expect(byKey["User:create:u1"]).toEqual({ id: "u1", name: "Ann" });
    expect(byKey["Board:create:b1"]).toBeNull();
    expect(byKey["Todo:delete:t1"]).toBeNull();
  });

  it.each([
    ["abc"],
    [""],
    ["42"],
    ["2147483648"],
    [" 0190a2b4-7c3e-7d2a-8f1b-3c4d5e6f7a8b"],
    ["0190a2b4-7c3e-7d2a-8f1b-3c4d5e6f7a8"],
    ["0190a2b4-7c3e-7d2a-8f1b-3c4d5e6f7a8g"],
    ["0190a2b47c3e7d2a8f1b3c4d5e6f7a8b"],
    [42],
  ] as unknown as [string][])("rejects the invalid cursor %j", async (lastChangelogId) => {
    expect(await adapter.pull(await testDb(), { scopeKey: "u1", lastChangelogId })).toEqual({
      ok: false,
      reason: "invalid-cursor",
    });
  });

  it("works as a standalone function too", async () => {
    const db = await pushAnnAndBo();
    const outcome = await pull(db, testSyncServer, testContract, sqlGetKeyField, { scopeKey: "u2" });
    expect(outcome.ok && outcome.logs.map((l) => l.keyPath)).toEqual(["u2", "b9"]);
  });
});
