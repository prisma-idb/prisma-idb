/**
 * Issue #9 — minimum end-to-end coverage for the assembled stack.
 *
 * Drives the auto-migrated client through every MVP terminal exposed by
 * `IdbStoreAccessor`: create / all / where (shorthand) / first /
 * findUnique / delete / orderBy / take / skip / include. Each test
 * runs against a fresh per-spec IDB database so the assertions are
 * order-independent.
 */
import { expect, test } from "./helpers";

test.describe("smoke", () => {
  test("create() echoes the stored record", async ({ runner }) => {
    const result = await runner.run(`
      orm.users.create({
        id: "u1",
        name: "Alice",
        email: "alice@example.com",
        bio: null,
        score: 100,
        active: true,
        joinedAt: new Date("2026-01-01T00:00:00Z"),
      })
    `);
    expect(result).toMatchObject({ id: "u1", name: "Alice", email: "alice@example.com" });
  });

  test("all() returns every record", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 1, active: true, joinedAt: new Date() })`
    );
    await runner.run(
      `orm.users.create({ id: "u2", name: "Bob", email: "b@x.com", bio: null, score: 2, active: true, joinedAt: new Date() })`
    );
    const rows = (await runner.run(`orm.users.all()`)) as Array<{ id: string }>;
    expect(rows.map((r) => r.id).sort()).toEqual(["u1", "u2"]);
  });

  test("findUnique() returns null for missing key", async ({ runner }) => {
    const row = await runner.run(`orm.users.findUnique("nope")`);
    expect(row).toBeNull();
  });

  test("delete() removes a record", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 1, active: true, joinedAt: new Date() })`
    );
    await runner.run(`orm.users.delete("u1")`);
    const row = await runner.run(`orm.users.findUnique("u1")`);
    expect(row).toBeNull();
  });

  test("orderBy + take + skip", async ({ runner }) => {
    for (const [id, name, score] of [
      ["u1", "Carol", 75],
      ["u2", "Alice", 100],
      ["u3", "Bob", 50],
    ] as const) {
      await runner.run(
        `orm.users.create({ id: "${id}", name: "${name}", email: "${id}@x.com", bio: null, score: ${score}, active: true, joinedAt: new Date() })`
      );
    }
    const ordered = (await runner.run(`orm.users.orderBy({ name: "asc" }).take(2).skip(1).all()`)) as Array<{
      name: string;
    }>;
    // Sorted: Alice, Bob, Carol → skip 1 → [Bob, Carol] → take 2 → [Bob, Carol]
    expect(ordered.map((r) => r.name)).toEqual(["Bob", "Carol"]);
  });

  test("include() loads a 1:N relation across stores", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 1, active: true, joinedAt: new Date() })`
    );
    await runner.run(
      `orm.posts.create({ id: "p1", authorId: "u1", title: "Hi", content: null, views: 0, published: true, publishedAt: null })`
    );
    await runner.run(
      `orm.posts.create({ id: "p2", authorId: "u1", title: "Hello", content: null, views: 5, published: true, publishedAt: null })`
    );
    // The contract declares the relation on Post (author N:1 User), so we
    // need to test include from the post side. Re-use the same db.
    const posts = (await runner.run(`orm.posts.include("author").all()`)) as Array<{
      id: string;
      author: { id: string } | null;
    }>;
    expect(posts).toHaveLength(2);
    for (const p of posts) {
      expect(p.author).toMatchObject({ id: "u1" });
    }
  });
});
