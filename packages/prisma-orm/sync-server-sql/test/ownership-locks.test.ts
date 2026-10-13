import pg from "pg";
import { describe, expect, it } from "vitest";
import { createSqlSyncAdapter } from "../src/core/create-adapter";
import { ormRootFor } from "../src/core/orm-root";
import { seed, testContract, testDb, testSyncServer } from "./helpers";

const adapter = createSqlSyncAdapter({ contract: testContract, syncServer: testSyncServer, contractCheck: "off" });

/** Opens an independent application connection, outside the adapter's pool. */
async function applicationConnection() {
  const connection = new pg.Client({ connectionString: process.env["DATABASE_URL"] });
  await connection.connect();
  return connection;
}

/** Waits for a real database lock wait, rather than pausing adapter code. */
async function waitForBlockedPush(connection: pg.Client, push: Promise<unknown>, expectedWaiters = 1) {
  let completed = false;
  void push.then(
    () => {
      completed = true;
    },
    () => {
      completed = true;
    }
  );
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    // PostgreSQL caches activity snapshots inside the observer transaction.
    await connection.query("SELECT pg_stat_clear_snapshot()");
    const { rows } = await connection.query<{ waiting: number }>(`
      SELECT count(*)::int4 AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND pg_backend_pid() = ANY(pg_blocking_pids(pid))
    `);
    if (rows[0]?.waiting === expectedWaiters) return;
    if (completed) throw new Error("Push completed without waiting for the ownership lock");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Push did not reach its database lock wait");
}

/** Seeds the two owners and the ownership chain under test. */
async function seedOwnership() {
  const db = await testDb();
  await seed(db, {
    User: [
      { id: "alice", name: "Alice" },
      { id: "bob", name: "Bob" },
    ],
    Board: [{ id: "board", ownerId: "alice" }],
    Todo: [{ id: "todo", boardId: "board", dueAt: null }],
  });
  return db;
}

/** Creates an event for the same child without changing its parent implicitly. */
function todoEvent(operation: "create" | "update" | "delete", key = "todo", id = "edit") {
  const payload =
    operation === "create"
      ? { id: key, boardId: "board" }
      : operation === "update"
        ? { key, patch: { dueAt: "2026-01-01T00:00:00.000Z" } }
        : { key };
  return { id, entityType: "Todo", operation, payload };
}

/** Holds the scope lock so the push waits after its ownership locks and write. */
async function holdScope(connection: pg.Client) {
  await connection.query("BEGIN");
  await connection.query("SELECT pg_advisory_xact_lock($1::int4, hashtext($2))", [0x70_69_64_62, "alice"]);
}

/** A failed competing write rolls back to a savepoint without releasing the scope lock. */
async function expectLocked(connection: pg.Client, statement: string) {
  await connection.query("SET LOCAL lock_timeout = '200ms'");
  await connection.query("SAVEPOINT competing_write");
  await expect(connection.query(statement)).rejects.toMatchObject({ code: "55P03" });
  await connection.query("ROLLBACK TO SAVEPOINT competing_write");
}

const parentChanges = [
  { change: "reassigned", statement: `UPDATE "Board" SET "ownerId" = 'bob' WHERE id = 'board'` },
  { change: "deleted", statement: `DELETE FROM "Board" WHERE id = 'board'` },
];
const cases = parentChanges.flatMap((change) =>
  (["create", "update", "delete"] as const).map((operation) => ({ ...change, operation }))
);

describe("push ownership locks", () => {
  it.each(cases)(
    "rejects $operation when its parent is $change before the locking read",
    async ({ statement, operation, change }) => {
      const db = await seedOwnership();
      const connection = await applicationConnection();
      const key = operation === "create" ? "new-todo" : "todo";
      let push: ReturnType<typeof adapter.applyPush> | undefined;
      try {
        await connection.query("BEGIN");
        await connection.query(statement);
        push = adapter.applyPush(db, { scopeKey: "alice", events: [todoEvent(operation, key)] });
        await waitForBlockedPush(connection, push);
        await connection.query("COMMIT");
        expect(await push).toMatchObject({
          ok: true,
          results: [{ success: false, error: "SCOPE_VIOLATION", retryable: false, record: null }],
        });
        const row = await ormRootFor(db, "Todo").first({ id: key });
        if (operation === "create" || change === "deleted") expect(row).toBeNull();
        else expect(row).toMatchObject({ dueAt: null, boardId: "board" });
        expect(await ormRootFor(db, "Changelog").first({ outboxEventId: "edit" })).toBeNull();
      } finally {
        await connection.query("ROLLBACK");
        await push;
        await connection.end();
      }
    }
  );

  it.each(cases)("prevents a parent being $change during $operation until commit", async ({ statement, operation }) => {
    const db = await seedOwnership();
    const connection = await applicationConnection();
    const key = operation === "create" ? "new-todo" : "todo";
    let push: ReturnType<typeof adapter.applyPush> | undefined;
    try {
      await holdScope(connection);
      push = adapter.applyPush(db, { scopeKey: "alice", events: [todoEvent(operation, key)] });
      await waitForBlockedPush(connection, push);
      await expectLocked(connection, statement);
      await connection.query("COMMIT");
      expect(await push).toEqual({ ok: true, results: [{ id: "edit", success: true }] });
      expect(await ormRootFor(db, "Changelog").first({ outboxEventId: "edit" })).not.toBeNull();
      await connection.query(statement);
    } finally {
      await connection.query("ROLLBACK");
      await push;
      await connection.end();
    }
  });

  it("locks both the stored and new parent of a reparenting update", async () => {
    const db = await seedOwnership();
    await seed(db, { Board: [{ id: "new-board", ownerId: "alice" }] });
    const connection = await applicationConnection();
    let push: ReturnType<typeof adapter.applyPush> | undefined;
    try {
      await holdScope(connection);
      push = adapter.applyPush(db, {
        scopeKey: "alice",
        events: [
          {
            id: "move",
            entityType: "Todo",
            operation: "update",
            payload: { key: "todo", patch: { boardId: "new-board" } },
          },
        ],
      });
      await waitForBlockedPush(connection, push);
      for (const board of ["board", "new-board"]) {
        await expectLocked(connection, `UPDATE "Board" SET "ownerId" = 'bob' WHERE id = '${board}'`);
      }
      await connection.query("COMMIT");
      expect(await push).toEqual({ ok: true, results: [{ id: "move", success: true }] });
      expect(await ormRootFor(db, "Todo").first({ id: "todo" })).toMatchObject({ boardId: "new-board" });
    } finally {
      await connection.query("ROLLBACK");
      await push;
      await connection.end();
    }
  });

  it("lets two pushes under one Board reach the scope lock together", async () => {
    const db = await seedOwnership();
    await seed(db, { Todo: [{ id: "other-todo", boardId: "board" }] });
    const connection = await applicationConnection();
    let pushes: Promise<unknown> | undefined;
    try {
      await holdScope(connection);
      pushes = Promise.all(
        ["todo", "other-todo"].map((key) =>
          adapter.applyPush(db, { scopeKey: "alice", events: [todoEvent("update", key, key)] })
        )
      );
      await waitForBlockedPush(connection, pushes, 2);
      await connection.query("COMMIT");
      expect(await pushes).toEqual(
        ["todo", "other-todo"].map((id) => ({ ok: true, results: [{ id, success: true }] }))
      );
    } finally {
      await connection.query("ROLLBACK");
      await pushes;
      await connection.end();
    }
  });
});

/** A read-only path must finish even while an application holds a parent row lock. */
async function expectLockFree<T>(read: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Read waited for a row lock")), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

it("keeps pull and rejected-record authorization lock-free", async () => {
  const db = await seedOwnership();
  await seed(db, {
    Changelog: [{ model: "Todo", keyPath: "todo", operation: "update", scopeKey: "alice", outboxEventId: "previous" }],
  });
  const connection = await applicationConnection();
  let reads:
    Promise<[Awaited<ReturnType<typeof adapter.pull>>, Awaited<ReturnType<typeof adapter.applyPush>>]> | undefined;
  try {
    await connection.query("BEGIN");
    await connection.query(`UPDATE "Board" SET "ownerId" = 'bob' WHERE id = 'board'`);
    reads = Promise.all([
      adapter.pull(db, { scopeKey: "alice", lastChangelogId: null }),
      adapter.applyPush(db, {
        scopeKey: "alice",
        events: [
          {
            id: "invalid",
            entityType: "Todo",
            operation: "update",
            payload: { key: "todo", patch: { dueAt: "not-a-date" } },
          },
        ],
      }),
    ]);
    const [pull, rejected] = await expectLockFree(reads);
    expect(pull).toMatchObject({ ok: true, logs: [{ record: { id: "todo", boardId: "board" } }] });
    expect(rejected).toMatchObject({
      ok: true,
      results: [{ success: false, retryable: false, record: { id: "todo", boardId: "board" } }],
    });
  } finally {
    await connection.query("ROLLBACK");
    await reads;
    await connection.end();
  }
});

it("locks a tenant parent even when the direct ownership path already authorizes the row", async () => {
  const db = await seedOwnership();
  await seed(db, { Meal: [{ id: "meal", userId: "alice" }] });
  const connection = await applicationConnection();
  let push: ReturnType<typeof adapter.applyPush> | undefined;
  try {
    await holdScope(connection);
    push = adapter.applyPush(db, {
      scopeKey: "alice",
      events: [
        {
          id: "entry",
          entityType: "FoodEntry",
          operation: "create",
          payload: { id: "entry", userId: "alice", mealId: "meal" },
        },
      ],
    });
    await waitForBlockedPush(connection, push);
    await expectLocked(connection, `UPDATE "Meal" SET "userId" = 'bob' WHERE id = 'meal'`);
    await connection.query("COMMIT");
    expect(await push).toEqual({ ok: true, results: [{ id: "entry", success: true }] });
  } finally {
    await connection.query("ROLLBACK");
    await push;
    await connection.end();
  }
});
