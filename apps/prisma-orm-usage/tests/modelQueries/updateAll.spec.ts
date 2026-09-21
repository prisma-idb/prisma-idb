/**
 * Phase 6.2 — updateAll()
 *
 * Updates all matching rows and returns them as an awaitable Row[].
 */
import { expect, test } from "../helpers";

test.describe("updateAll()", () => {
  test("updates all rows when no filter", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true, joinedAt: new Date() })`
    );
    await runner.run(
      `orm.users.create({ id: "u2", name: "Bob",   email: "b@x.com", bio: null, score: 20, active: true, joinedAt: new Date() })`
    );
    const rows = (await runner.run(`orm.users.updateAll({ active: false })`)) as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r["active"] === false)).toBe(true);
  });

  test("scopes updates via chained .where()", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true,  joinedAt: new Date() })`
    );
    await runner.run(
      `orm.users.create({ id: "u2", name: "Bob",   email: "b@x.com", bio: null, score: 20, active: false, joinedAt: new Date() })`
    );
    const rows = (await runner.run(`orm.users.where({ active: false }).updateAll({ score: 0 })`)) as Record<
      string,
      unknown
    >[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "u2", score: 0 });
  });

  test("returns empty array when no rows match", async ({ runner }) => {
    const rows = await runner.run(`orm.users.where({ id: "nonexistent" }).updateAll({ name: "X" })`);
    expect(rows).toEqual([]);
  });

  test("persists changes to the store", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true, joinedAt: new Date() })`
    );
    await runner.run(`orm.users.updateAll({ name: "ALL_UPDATED" })`);
    const all = (await runner.run(`orm.users.all()`)) as Record<string, unknown>[];
    expect(all.every((r) => r["name"] === "ALL_UPDATED")).toBe(true);
  });

  test("preserves untouched fields", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true, joinedAt: new Date() })`
    );
    await runner.run(`orm.users.updateAll({ score: 99 })`);
    const row = (await runner.run(`orm.users.findUnique("u1")`)) as Record<string, unknown>;
    expect(row).toMatchObject({ id: "u1", name: "Alice", email: "a@x.com", score: 99 });
  });
});
