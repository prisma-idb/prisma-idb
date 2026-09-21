/**
 * Phase 6.2 — deleteAll()
 *
 * Deletes all matching rows and returns them (the deleted records).
 */
import { expect, test } from "../helpers";

test.describe("deleteAll()", () => {
  test("returns deleted rows", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true, joinedAt: new Date() })`
    );
    const rows = (await runner.run(`orm.users.where({ id: "u1" }).deleteAll()`)) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "u1", name: "Alice" });
  });

  test("removes rows from the store", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true, joinedAt: new Date() })`
    );
    await runner.run(
      `orm.users.create({ id: "u2", name: "Bob",   email: "b@x.com", bio: null, score: 20, active: true, joinedAt: new Date() })`
    );
    await runner.run(`orm.users.where({ id: "u1" }).deleteAll()`);
    const remaining = (await runner.run(`orm.users.all()`)) as Record<string, unknown>[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ id: "u2" });
  });

  test("deletes all rows when no filter", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true, joinedAt: new Date() })`
    );
    await runner.run(
      `orm.users.create({ id: "u2", name: "Bob",   email: "b@x.com", bio: null, score: 20, active: true, joinedAt: new Date() })`
    );
    const rows = (await runner.run(`orm.users.deleteAll()`)) as unknown[];
    expect(rows).toHaveLength(2);
    const remaining = (await runner.run(`orm.users.all()`)) as unknown[];
    expect(remaining).toHaveLength(0);
  });

  test("returns empty array when no rows match", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true, joinedAt: new Date() })`
    );
    const rows = await runner.run(`orm.users.where({ id: "nonexistent" }).deleteAll()`);
    expect(rows).toEqual([]);
  });

  test("scopes deletion via chained .where()", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true,  joinedAt: new Date() })`
    );
    await runner.run(
      `orm.users.create({ id: "u2", name: "Bob",   email: "b@x.com", bio: null, score: 20, active: false, joinedAt: new Date() })`
    );
    await runner.run(`orm.users.where({ active: false }).deleteAll()`);
    const remaining = (await runner.run(`orm.users.all()`)) as Record<string, unknown>[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ id: "u1" });
  });
});
