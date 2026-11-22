/**
 * A pull reads a row and then each ownership hop in separate statements. A
 * write committed between them must not be seen by the later reads.
 */
import { describe, expect, it } from "vitest";
import { createSqlSyncAdapter } from "../src/core/create-adapter";
import { ormRootFor } from "../src/core/orm-root";
import { testContract, testDb, testSyncServer, seed } from "./helpers";

type Db = Awaited<ReturnType<typeof testDb>>;

/**
 * The real client, except that inside a transaction the first read of a Todo
 * runs `between` on another connection before it returns: a write that commits
 * after the pull read the row and before it checks the row's owner.
 */
function interleaved(db: Db, between: () => Promise<void>): Db {
  let fired = false;
  const wrapTx = (tx: unknown) =>
    new Proxy(tx as object, {
      get(target, prop, receiver) {
        if (prop !== "orm") return Reflect.get(target, prop, receiver);
        const orm = Reflect.get(target, prop, receiver) as { public: Record<string, unknown> };
        const publicRoots = new Proxy(orm.public, {
          get(roots, model) {
            const root = Reflect.get(roots, model) as { first(where: unknown): Promise<unknown> };
            if (model !== "Todo") return root;
            return new Proxy(root, {
              get(r, method) {
                if (method !== "first") return Reflect.get(r, method);
                return async (where: unknown) => {
                  const row = await r.first(where);
                  if (!fired) {
                    fired = true;
                    await between();
                  }
                  return row;
                };
              },
            });
          },
        });
        return { ...orm, public: publicRoots };
      },
    });
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "transaction") return Reflect.get(target, prop, receiver);
      return (fn: (tx: unknown) => Promise<unknown>, options?: unknown) =>
        (target.transaction as (f: typeof fn, o?: unknown) => Promise<unknown>)((tx) => fn(wrapTx(tx)), options);
    },
  });
}

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
