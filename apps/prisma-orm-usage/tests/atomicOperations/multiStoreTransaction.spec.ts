/**
 * Phase 6.3 — multi-store atomic transaction tests.
 *
 * Exercises `withMutationScope` via the `transaction(storeNames, fn)`
 * helper exposed in the query-runner sandbox. The `scope.execute(plan)`
 * method runs `IdbAtomicPlan`s directly in the shared IDB transaction.
 *
 * `meta` is required by the plan type but never accessed by the driver;
 * a minimal placeholder is used throughout.
 */
import { expect, test } from "../helpers";

const META = `{ target: "idb", storageHash: "", lane: "test", annotations: { groupingKey: "g1" } }`;

const USER = (id: string, name: string) =>
  `{ meta: ${META}, kind: "put", storeName: "users", record: { id: "${id}", name: "${name}", email: "${id}@x.com", bio: null, score: 1, active: true, joinedAt: new Date().toISOString() } }`;

const POST = (id: string, authorId: string) =>
  `{ meta: ${META}, kind: "put", storeName: "posts", record: { id: "${id}", authorId: "${authorId}", title: "Hi", content: null, views: 0, published: true, publishedAt: null } }`;

test.describe("withMutationScope", () => {
  test("writes to two stores atomically — both visible after commit", async ({ runner }) => {
    await runner.run(`
      transaction(["users", "posts"], async (scope) => {
        await scope.execute(${USER("u1", "Alice")});
        await scope.execute(${POST("p1", "u1")});
      })
    `);
    const user = await runner.run(`orm.users.findUnique("u1")`);
    expect(user).toMatchObject({ id: "u1", name: "Alice" });
    const post = await runner.run(`orm.posts.findUnique("p1")`);
    expect(post).toMatchObject({ id: "p1", authorId: "u1" });
  });

  test("rollback on error — neither store is written", async ({ runner }) => {
    await runner.expectError(
      `
        transaction(["users", "posts"], async (scope) => {
          await scope.execute(${USER("u2", "Bob")});
          throw new Error("simulated failure");
        })
      `,
      "simulated failure"
    );
    const user = await runner.run(`orm.users.findUnique("u2")`);
    expect(user).toBeNull();
  });

  test("read inside scope sees pre-existing rows", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u3", name: "Carol", email: "c@x.com", bio: null, score: 3, active: true, joinedAt: new Date() })`
    );
    const result = await runner.run(`
      transaction(["users"], async (scope) => {
        const rows = await scope.execute({ meta: ${META}, kind: "key-get", storeName: "users", key: "u3" });
        return rows[0] ?? null;
      })
    `);
    expect(result).toMatchObject({ id: "u3", name: "Carol" });
  });

  test("two independent scopes do not share transaction state", async ({ runner }) => {
    await runner.run(`
      Promise.all([
        transaction(["users"], async (scope) => {
          await scope.execute(${USER("u4", "Dave")});
        }),
        transaction(["users"], async (scope) => {
          await scope.execute(${USER("u5", "Eve")});
        }),
      ])
    `);
    const all = (await runner.run(`orm.users.all()`)) as Array<{ id: string }>;
    expect(all.map((r) => r.id).sort()).toEqual(["u4", "u5"]);
  });
});
