import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqlSyncAdapter } from "../src/core/create-adapter";
import { seed, testContract, testDb, testSyncServer } from "./helpers";

const adapter = createSqlSyncAdapter({ contract: testContract, syncServer: testSyncServer });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type TestDb = Awaited<ReturnType<typeof testDb>>;

/**
 * Wraps `db` so the push that uses it pauses right *after* its `Changelog`
 * insert and *before* its transaction commits — the window in which a
 * concurrent push can insert a later changelog id and commit first.
 */
function pausedAfterChangelogInsert(db: TestDb) {
  let inserted!: () => void;
  let release!: () => void;
  const insertedSignal = new Promise<void>((resolve) => (inserted = resolve));
  const releaseGate = new Promise<void>((resolve) => (release = resolve));

  type Root = {
    first: (where: never) => Promise<unknown>;
    where: (clause: never) => unknown;
    select: (...fields: string[]) => { create: (data: never) => Promise<unknown> };
  };
  // Plain delegating objects rather than Proxies: the ORM's collection
  // classes use private fields, which throw when `this` is a Proxy.
  const wrapRoot = (root: Root): Root => ({
    first: (where) => root.first(where),
    where: (clause) => root.where(clause),
    select: (...fields) => ({
      create: async (data) => {
        const result = await root.select(...fields).create(data);
        inserted();
        await releaseGate;
        return result;
      },
    }),
  });

  const wrapTx = (tx: Parameters<Parameters<TestDb["transaction"]>[0]>[0]) => {
    const models = tx.orm.public as unknown as Record<string, Root>;
    return {
      execute: tx.execute.bind(tx),
      query: tx.query.bind(tx),
      orm: {
        public: new Proxy({} as Record<string, Root>, {
          get: (_, model: string) => (model === "Changelog" ? wrapRoot(models[model]!) : models[model]),
        }),
      },
    };
  };

  const wrapped = {
    orm: db.orm,
    raw: db.raw,
    transaction: (fn: (tx: never) => Promise<unknown>) => db.transaction((tx) => fn(wrapTx(tx) as never)),
  };
  return { db: wrapped, inserted: insertedSignal, release };
}

const createBoard = (eventId: string, boardId: string, ownerId: string) => ({
  id: eventId,
  entityType: "Board",
  operation: "create" as const,
  payload: { id: boardId, ownerId },
});

async function pullAll(db: TestDb, scopeKey: string, lastChangelogId: string | null) {
  const outcome = await adapter.pull(db, { scopeKey, lastChangelogId });
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.logs;
}

describe("concurrent pushes on one scope", () => {
  it("never let a pull's cursor advance past a not-yet-committed changelog row", async () => {
    const db = await testDb();
    await seed(db, { User: [{ id: "u1", name: "Ann" }] });

    // Push A inserts its changelog row, then stalls before committing.
    const a = pausedAfterChangelogInsert(db);
    const pushA = adapter.applyPush(a.db, { scopeKey: "u1", events: [createBoard("ea", "ba", "u1")] });
    let pushB: ReturnType<typeof adapter.applyPush> | undefined;
    let first: Awaited<ReturnType<typeof pullAll>>;
    try {
      await a.inserted;
      // Changelog ids are UUID v7 (ms timestamp prefix) — make B's strictly later.
      await sleep(10);

      // Push B, same scope, starts while A is still open. Unserialized it
      // commits immediately with the higher id; serialized it waits for A.
      pushB = adapter.applyPush(db, { scopeKey: "u1", events: [createBoard("eb", "bb", "u1")] });
      await Promise.race([pushB, sleep(300)]);

      // A client pulls in between, then keeps the last id it saw as its cursor.
      first = await pullAll(db, "u1", null);
    } finally {
      a.release();
    }
    const cursor = first.at(-1)?.changelogId ?? null;
    await Promise.all([pushA, pushB]);

    const second = await pullAll(db, "u1", cursor);
    const seen = [...first, ...second].map((log) => log.keyPath);
    expect(seen.sort()).toEqual(["ba", "bb"]);
  });

  it("reports success for a retry that races its own still-committing first request", async () => {
    const db = await testDb();
    await seed(db, { User: [{ id: "u1", name: "Ann" }] });

    // The first request applied the event but has not committed; a timed-out
    // client retries the same event meanwhile and collides with its unique keys.
    const first = pausedAfterChangelogInsert(db);
    const pushFirst = adapter.applyPush(first.db, { scopeKey: "u1", events: [createBoard("ea", "ba", "u1")] });
    let retry: ReturnType<typeof adapter.applyPush>;
    try {
      await first.inserted;
      retry = adapter.applyPush(db, { scopeKey: "u1", events: [createBoard("ea", "ba", "u1")] });
      await Promise.race([retry, sleep(300)]);
    } finally {
      first.release();
    }

    const expected = { ok: true, results: [{ id: "ea", success: true }] };
    expect(await pushFirst).toEqual(expected);
    expect(await retry).toEqual(expected);
    expect((await pullAll(db, "u1", null)).map((log) => log.keyPath)).toEqual(["ba"]);
  });

  it("does not block pushes on a different scope", async () => {
    const db = await testDb();
    await seed(db, {
      User: [
        { id: "u1", name: "Ann" },
        { id: "u2", name: "Bo" },
      ],
    });
    const a = pausedAfterChangelogInsert(db);
    const pushA = adapter.applyPush(a.db, { scopeKey: "u1", events: [createBoard("ea", "ba", "u1")] });
    try {
      await a.inserted;

      // u1's push is still open; u2's must finish without waiting for it.
      const outcome = await Promise.race([
        adapter.applyPush(db, { scopeKey: "u2", events: [createBoard("eb", "bb", "u2")] }),
        sleep(5_000).then(() => "blocked" as const),
      ]);
      expect(outcome).not.toBe("blocked");
      expect(outcome).toEqual({ ok: true, results: [{ id: "eb", success: true }] });
    } finally {
      a.release();
    }
    await pushA;
  });
});

describe("the scope lock's ordering guarantee", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("checks isolation and takes the scope lock in one raw query per new event", async () => {
    const db = await testDb();
    await seed(db, { User: [{ id: "u1", name: "Ann" }] });
    const query = vi.fn();
    const execute = vi.fn();
    const counted = {
      orm: db.orm,
      raw: db.raw,
      transaction: <T>(fn: (tx: never) => Promise<T>) =>
        db.transaction((tx) => {
          query.mockImplementation(tx.query.bind(tx));
          execute.mockImplementation(tx.execute.bind(tx));
          return fn({ orm: tx.orm, query, execute } as never);
        }),
    };

    expect(await adapter.applyPush(counted, { scopeKey: "u1", events: [createBoard("ea", "ba", "u1")] })).toEqual({
      ok: true,
      results: [{ id: "ea", success: true }],
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect((await pullAll(db, "u1", null)).map((log) => log.keyPath)).toEqual(["ba"]);
  });

  it("orders a push after the commit it waited on, even when its own clock reads earlier", async () => {
    const db = await testDb();
    await seed(db, { User: [{ id: "u1", name: "Ann" }] });

    // Push A draws its id from a clock an hour ahead, then stalls before committing.
    const aMs = Date.now() + 10 * 3_600_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(aMs);
    const a = pausedAfterChangelogInsert(db);
    const pushA = adapter.applyPush(a.db, { scopeKey: "u1", events: [createBoard("ea", "ba", "u1")] });
    let pushB: ReturnType<typeof adapter.applyPush> | undefined;
    try {
      await a.inserted;

      // Push B's clock reads a minute *before* A's. Its own fresh id would sort
      // below A's, so it only lands after A's cursor if B reads the scope's max
      // id after the lock — i.e. sees A's committed row. Reading it before
      // (B's transaction starts while A is still open) finds an empty scope.
      vi.setSystemTime(aMs - 60_000);
      pushB = adapter.applyPush(db, { scopeKey: "u1", events: [createBoard("eb", "bb", "u1")] });
      await Promise.race([pushB, sleep(300)]);
    } finally {
      a.release();
    }
    await Promise.all([pushA, pushB]);
    vi.useRealTimers();

    const all = await pullAll(db, "u1", null);
    expect(all.map((log) => log.keyPath)).toEqual(["ba", "bb"]);
    const [idA, idB] = all.map((log) => log.changelogId);
    expect(idB! > idA!).toBe(true);
    expect((await pullAll(db, "u1", idA!)).map((log) => log.keyPath)).toEqual(["bb"]);
  });

  it.each(["REPEATABLE READ", "SERIALIZABLE"] as const)(
    "refuses to push in a %s transaction, where the max-id read would use a pre-lock snapshot",
    async (level) => {
      const db = await testDb();
      await seed(db, { User: [{ id: "u1", name: "Ann" }] });
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      const atLevel = {
        orm: db.orm,
        raw: db.raw,
        transaction: <T>(fn: (tx: never) => Promise<T>) =>
          db.transaction(async (tx) => {
            // Must be the transaction's first statement, as a caller configuring its isolation would.
            const { sql } = db.raw;
            const setLevel =
              level === "REPEATABLE READ"
                ? sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`
                : sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`;
            await tx.execute(setLevel.affectedCount().build());
            return fn(tx as never);
          }),
      };
      const outcome = await adapter.applyPush(atLevel as never, {
        scopeKey: "u1",
        events: [createBoard("ea", "ba", "u1")],
      });

      // Retryable, so the client keeps the event until the server is fixed.
      expect(outcome).toEqual({
        ok: true,
        results: [{ id: "ea", success: false, error: "Failed to apply event ea", retryable: true }],
      });
      const logged = consoleError.mock.calls.flat().find((arg): arg is Error => arg instanceof Error);
      expect(logged?.message).toMatch(new RegExp(`READ COMMITTED.*${level.toLowerCase()}`));
      // The whole transaction rolled back: no board, no changelog row.
      expect(await pullAll(db, "u1", null)).toEqual([]);
    }
  );
});

/** A UUID v7 at `ms` whose 74 random bits are all ones (`highest`) or zeros — the extremes a same-millisecond id from another process can take. */
function v7At(ms: number, bits: "highest" | "lowest"): string {
  const ts = ms.toString(16).padStart(12, "0");
  const tail = bits === "highest" ? "7fff-bfff-ffffffffffff" : "7000-8000-000000000000";
  return `${ts.slice(0, 8)}-${ts.slice(8)}-${tail}`;
}

describe("changelog ids across app servers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The scope already holds `existingId` — committed by another app server —
   * and a client pulled it, so its cursor sits there. A push from this
   * server, whose clock reads `nowMs`, must still land after that cursor.
   */
  async function pushAfterExistingId(existingId: string, nowMs: number) {
    const db = await testDb();
    await seed(db, {
      User: [{ id: "u1", name: "Ann" }],
      Changelog: [
        {
          id: existingId,
          model: "Board",
          keyPath: "gone",
          operation: "delete",
          scopeKey: "u1",
          outboxEventId: "other-server",
        },
      ],
    });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(nowMs);
    const outcome = await adapter.applyPush(db, { scopeKey: "u1", events: [createBoard("ea", "ba", "u1")] });
    vi.useRealTimers();
    expect(outcome).toEqual({ ok: true, results: [{ id: "ea", success: true }] });

    return (await pullAll(db, "u1", existingId)).map((log) => log.keyPath);
  }

  // Both cases put the other server's id in the future, past anything this
  // process's own (monotonic) id generator has drawn so far, so that without
  // the fix the push's id sorts below it. Each test uses a later offset than
  // the one before for the same reason — the generator never steps backwards.
  const HOUR = 3_600_000;

  it("does not hide a push that shares a millisecond with an id it cannot see", async () => {
    // Another server drew its id in the same millisecond with a higher counter.
    const sameMs = Date.now() + HOUR;
    expect(await pushAfterExistingId(v7At(sameMs, "highest"), sameMs)).toEqual(["ba"]);
  });

  it("does not hide a push from a server whose clock runs behind", async () => {
    const otherServerMs = Date.now() + 3 * HOUR;
    expect(await pushAfterExistingId(v7At(otherServerMs, "lowest"), otherServerMs - 60_000)).toEqual(["ba"]);
  });
});
