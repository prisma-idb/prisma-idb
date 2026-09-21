/**
 * Phase 6.2 — upsert()
 *
 * Inserts a new record when no match is found (create path) or updates an
 * existing record when found (update path). Always returns the final row.
 */
import { expect, test } from "../helpers";

test.describe("upsert()", () => {
  test("inserts and returns new row when not found (create path)", async ({ runner }) => {
    const row = (await runner.run(`
      orm.users.upsert({
        where:  { id: "u99" },
        create: { id: "u99", name: "New", email: "new@x.com", bio: null, score: 0, active: true, joinedAt: new Date() },
        update: { name: "Updated" },
      })
    `)) as Record<string, unknown>;
    expect(row).toMatchObject({ id: "u99", name: "New", email: "new@x.com" });
  });

  test("inserts the row permanently on create path", async ({ runner }) => {
    await runner.run(`
      orm.users.upsert({
        where:  { id: "u99" },
        create: { id: "u99", name: "New", email: "new@x.com", bio: null, score: 0, active: true, joinedAt: new Date() },
        update: { name: "Updated" },
      })
    `);
    const verify = (await runner.run(`orm.users.findUnique("u99")`)) as Record<string, unknown>;
    expect(verify).not.toBeNull();
    expect(verify).toMatchObject({ id: "u99", name: "New" });
  });

  test("updates and returns existing row when found (update path)", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true, joinedAt: new Date() })`
    );
    const row = (await runner.run(`
      orm.users.upsert({
        where:  { id: "u1" },
        create: { id: "u1", name: "Alice New", email: "new@x.com", bio: null, score: 0, active: false, joinedAt: new Date() },
        update: { name: "Alice Updated", score: 99 },
      })
    `)) as Record<string, unknown>;
    expect(row).toMatchObject({ id: "u1", name: "Alice Updated", score: 99 });
  });

  test("does not duplicate rows on update path", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true, joinedAt: new Date() })`
    );
    await runner.run(`
      orm.users.upsert({
        where:  { id: "u1" },
        create: { id: "u1", name: "Dup", email: "dup@x.com", bio: null, score: 0, active: false, joinedAt: new Date() },
        update: { name: "No Dup" },
      })
    `);
    const all = (await runner.run(`orm.users.all()`)) as unknown[];
    expect(all).toHaveLength(1);
  });

  test("update path only applies the update patch (not the create data)", async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "a@x.com", bio: null, score: 10, active: true, joinedAt: new Date() })`
    );
    await runner.run(`
      orm.users.upsert({
        where:  { id: "u1" },
        create: { id: "u1", name: "Alice Brand New", email: "other@x.com", bio: null, score: 0, active: false, joinedAt: new Date() },
        update: { score: 77 },
      })
    `);
    const row = (await runner.run(`orm.users.findUnique("u1")`)) as Record<string, unknown>;
    // Original email should be preserved (not overwritten by create data)
    expect(row).toMatchObject({ email: "a@x.com", score: 77 });
  });
});
