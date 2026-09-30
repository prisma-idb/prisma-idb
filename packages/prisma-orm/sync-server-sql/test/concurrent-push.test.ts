import { describe, expect, it } from "vitest";
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
    select: (...fields: string[]) => { create: (data: never) => Promise<unknown> };
  };
  // Plain delegating objects rather than Proxies: the ORM's collection
  // classes use private fields, which throw when `this` is a Proxy.
  const wrapRoot = (root: Root): Root => ({
    first: (where) => root.first(where),
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
    await a.inserted;
    // Changelog ids are UUID v7 (ms timestamp prefix) — make B's strictly later.
    await sleep(10);

    // Push B, same scope, starts while A is still open. Unserialized it
    // commits immediately with the higher id; serialized it waits for A.
    const pushB = adapter.applyPush(db, { scopeKey: "u1", events: [createBoard("eb", "bb", "u1")] });
    await Promise.race([pushB, sleep(300)]);

    // A client pulls in between, then keeps the last id it saw as its cursor.
    const first = await pullAll(db, "u1", null);
    const cursor = first.at(-1)?.changelogId ?? null;

    a.release();
    await Promise.all([pushA, pushB]);

    const second = await pullAll(db, "u1", cursor);
    const seen = [...first, ...second].map((log) => log.keyPath);
    expect(seen.sort()).toEqual(["ba", "bb"]);
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
    await a.inserted;

    // u1's push is still open; u2's must finish without waiting for it.
    const outcome = await Promise.race([
      adapter.applyPush(db, { scopeKey: "u2", events: [createBoard("eb", "bb", "u2")] }),
      sleep(5_000).then(() => "blocked" as const),
    ]);
    expect(outcome).not.toBe("blocked");
    expect(outcome).toEqual({ ok: true, results: [{ id: "eb", success: true }] });

    a.release();
    await pushA;
  });
});
