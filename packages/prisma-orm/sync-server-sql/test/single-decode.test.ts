import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSqlSyncAdapter } from "../src/core/create-adapter";
import { reviveWireValues } from "../src/core/wire-values";
import { seed, testContract, testDb, testSyncServer } from "./helpers";

vi.mock("../src/core/wire-values", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/core/wire-values")>();
  return { ...original, reviveWireValues: vi.fn(original.reviveWireValues) };
});

const adapter = createSqlSyncAdapter({ contract: testContract, syncServer: testSyncServer });

/** Payload revivals so far: one call per decoded event. Key revival goes through `reviveWireKey` and isn't counted. */
const revivals = () => vi.mocked(reviveWireValues).mock.calls.length;

beforeEach(() => {
  vi.mocked(reviveWireValues).mockClear();
});

describe("single decode", () => {
  it("applyPush revives each event's payload once", async () => {
    const db = await testDb();
    await seed(db, { User: [{ id: "u1", name: "Ann" }], Board: [{ id: "b1", ownerId: "u1" }] });
    const events = [
      { id: "e1", entityType: "Todo", operation: "create" as const, payload: { id: "t1", boardId: "b1" } },
      {
        id: "e2",
        entityType: "Todo",
        operation: "update" as const,
        payload: { key: "t1", patch: { dueAt: "2026-01-02T03:04:05.000Z" } },
      },
      { id: "e3", entityType: "Todo", operation: "delete" as const, payload: { key: "t1" } },
    ];

    const outcome = await adapter.applyPush(db, { events, scopeKey: "u1" });

    expect(outcome).toEqual({ ok: true, results: events.map(({ id }) => ({ id, success: true })) });
    expect(revivals()).toBe(events.length);
  });

  it("applyPushEvent revives the payload once", async () => {
    const db = await testDb();
    await seed(db, { User: [{ id: "u1", name: "Ann" }] });
    const record = { id: "b1", ownerId: "u1" };
    const [validation] = testSyncServer.validatePush(
      [{ id: "e1", model: "Board", operation: "create", payload: record, wirePayload: record }],
      { scopeKey: "u1" }
    );

    const result = await adapter.applyPushEvent(
      db,
      { id: "e1", operation: "create", payload: record },
      "Board",
      validation!.check,
      "u1"
    );

    expect(result).toEqual({ id: "e1", success: true });
    expect(revivals()).toBe(1);
  });
});
