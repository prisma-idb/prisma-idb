import { describe, expect, it, vi } from "vitest";
import { createSqlSyncAdapter } from "../src/core/create-adapter";
import { ormRootFor } from "../src/core/orm-root";
import { isDeterministicWriteFailure, sqlState } from "../src/core/sqlstate";
import { seed, testContract, testDb, testSyncServer } from "./helpers";

const adapter = createSqlSyncAdapter({
  contract: testContract,
  syncServer: testSyncServer,
  contractFingerprintCheck: "off",
});

const createBoard = (eventId: string, boardId: string, ownerId: string) => ({
  id: eventId,
  entityType: "Board",
  operation: "create" as const,
  payload: { id: boardId, ownerId },
});

describe("sqlState", () => {
  it("reads the SQLSTATE from the error or its cause", () => {
    expect(sqlState(Object.assign(new Error("dup"), { code: "23505" }))).toBe("23505");
    expect(sqlState(new Error("wrapped", { cause: Object.assign(new Error("dup"), { code: "40001" }) }))).toBe("40001");
  });

  it("reads Prisma SQLSTATE fields, preferring them over generic error codes", () => {
    expect(sqlState({ sqlState: "23505", code: "P2002" })).toBe("23505");
    expect(sqlState(new Error("wrapped", { cause: { sqlState: "40001" } }))).toBe("40001");
    expect(sqlState({ sqlState: "invalid", code: "23503" })).toBe("23503");
    expect(isDeterministicWriteFailure({ sqlState: "23505" })).toBe(true);
  });

  it.each([new Error("plain"), Object.assign(new Error("net"), { code: "ECONNRESET" }), "23505", null])(
    "returns undefined for %j, which carries no SQLSTATE",
    (error) => {
      expect(sqlState(error)).toBeUndefined();
    }
  );

  it.each(["22003", "22021", "23502", "23503", "23505"])("treats %s as a failure retrying cannot fix", (code) => {
    expect(isDeterministicWriteFailure(Object.assign(new Error(), { code }))).toBe(true);
  });

  it.each(["08006", "40001", "40P01", "57014", "53300"])("treats %s as possibly transient", (code) => {
    expect(isDeterministicWriteFailure(Object.assign(new Error(), { code }))).toBe(false);
  });

  it("treats an error without a SQLSTATE as possibly transient", () => {
    expect(isDeterministicWriteFailure(new Error("connection lost"))).toBe(false);
  });
});

describe("a push the database rejects for good", () => {
  it("fails a unique violation as non-retryable and returns the row that holds the key", async () => {
    const db = await testDb();
    await seed(db, { User: [{ id: "u1", name: "Ann" }], Board: [{ id: "b1", ownerId: "u1" }] });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const outcome = await adapter.applyPush(db, { scopeKey: "u1", events: [createBoard("e1", "b1", "u1")] });

      expect(outcome).toEqual({
        ok: true,
        results: [
          {
            id: "e1",
            success: false,
            error: "Failed to apply event e1",
            retryable: false,
            record: { id: "b1", ownerId: "u1" },
          },
        ],
      });
    } finally {
      errorLog.mockRestore();
    }
  });

  it("reports no row when the key is held by another scope, leaking nothing", async () => {
    const db = await testDb();
    await seed(db, {
      User: [
        { id: "u1", name: "Ann" },
        { id: "u2", name: "Bo" },
      ],
      Board: [{ id: "b1", ownerId: "u2" }],
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const outcome = await adapter.applyPush(db, { scopeKey: "u1", events: [createBoard("e1", "b1", "u1")] });

      expect(outcome).toEqual({
        ok: true,
        results: [{ id: "e1", success: false, error: "Failed to apply event e1", retryable: false, record: null }],
      });
    } finally {
      errorLog.mockRestore();
    }
  });

  it("reports the current row for a rejected update and leaves the server unchanged", async () => {
    const db = await testDb();
    await seed(db, { User: [{ id: "u1", name: "Ann" }] });
    const outcome = await adapter.applyPush(db, {
      scopeKey: "u1",
      events: [{ id: "e1", entityType: "User", operation: "update", payload: { key: "u1", patch: { name: 42 } } }],
    });

    expect(outcome).toEqual({
      ok: true,
      results: [
        {
          id: "e1",
          success: false,
          error: "RECORD_VALIDATION_FAILURE",
          retryable: false,
          record: { id: "u1", name: "Ann" },
        },
      ],
    });
  });

  it("reports no row for a rejected delete of a row that is already gone", async () => {
    const db = await testDb();
    await seed(db, { User: [{ id: "u1", name: "Ann" }] });
    const outcome = await adapter.applyPush(db, {
      scopeKey: "u1",
      events: [{ id: "e1", entityType: "Board", operation: "delete", payload: { key: "gone" } }],
    });

    expect(outcome).toEqual({
      ok: true,
      results: [{ id: "e1", success: false, error: "SCOPE_VIOLATION", retryable: false, record: null }],
    });
    expect(await ormRootFor(db, "User").first({ id: "u1" })).not.toBeNull();
  });

  it("keeps a failure that may be transient retryable, with no record", async () => {
    const db = await testDb();
    await seed(db, { User: [{ id: "u1", name: "Ann" }] });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const dropped = {
      orm: db.orm,
      raw: db.raw,
      transaction: () => Promise.reject(new Error("connection lost")),
    };
    try {
      const outcome = await adapter.applyPush(dropped as never, {
        scopeKey: "u1",
        events: [createBoard("e1", "b1", "u1")],
      });

      expect(outcome).toEqual({
        ok: true,
        results: [{ id: "e1", success: false, error: "Failed to apply event e1", retryable: true }],
      });
    } finally {
      errorLog.mockRestore();
    }
  });
});
