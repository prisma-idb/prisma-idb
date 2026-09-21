/**
 * Phase 6.1 — filter operator API end-to-end coverage.
 *
 * Each test seeds a small users table then runs a `.where()` query via
 * the shell. The fixture in helpers.ts gives every spec its own IDB
 * database so we can hardcode ids/values without cross-test bleed.
 */
import { expect, test } from "./helpers";

const SEED = `
(async () => {
  await orm.users.create({ id: "u1", name: "Alice", email: "alice@example.com", bio: null, score: 100, active: true, joinedAt: new Date("2026-01-01") });
  await orm.users.create({ id: "u2", name: "Bob", email: "bob@example.com", bio: "Bob's bio", score: 50, active: false, joinedAt: new Date("2026-02-01") });
  await orm.users.create({ id: "u3", name: "Carol", email: "carol@example.com", bio: "Carol's bio", score: 75, active: true, joinedAt: new Date("2026-03-01") });
})()
`;

test.describe("where() — shorthand", () => {
  test("equality on a single field", async ({ runner }) => {
    await runner.run(SEED);
    const rows = (await runner.run(`orm.users.where({ name: "Alice" }).all()`)) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["u1"]);
  });

  test("null matches null + undefined (no spurious includes when value differs)", async ({ runner }) => {
    await runner.run(SEED);
    const rows = (await runner.run(`orm.users.where({ bio: null }).all()`)) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["u1"]);
  });
});

test.describe("where() — callback operators", () => {
  test("eq / neq", async ({ runner }) => {
    await runner.run(SEED);
    const eqRows = (await runner.run(`orm.users.where((m) => m.email.eq("bob@example.com")).all()`)) as Array<{
      id: string;
    }>;
    expect(eqRows.map((r) => r.id)).toEqual(["u2"]);
    const neqRows = (await runner.run(`orm.users.where((m) => m.active.neq(true)).all()`)) as Array<{ id: string }>;
    expect(neqRows.map((r) => r.id)).toEqual(["u2"]);
  });

  test("numeric ordering: gt / gte / lt / lte", async ({ runner }) => {
    await runner.run(SEED);
    const gt = (await runner.run(`orm.users.where((m) => m.score.gt(75)).all()`)) as Array<{ id: string }>;
    expect(gt.map((r) => r.id)).toEqual(["u1"]);
    const gte = (await runner.run(`orm.users.where((m) => m.score.gte(75)).all()`)) as Array<{ id: string }>;
    expect(gte.map((r) => r.id).sort()).toEqual(["u1", "u3"]);
    const lt = (await runner.run(`orm.users.where((m) => m.score.lt(75)).all()`)) as Array<{ id: string }>;
    expect(lt.map((r) => r.id)).toEqual(["u2"]);
    const lte = (await runner.run(`orm.users.where((m) => m.score.lte(75)).all()`)) as Array<{ id: string }>;
    expect(lte.map((r) => r.id).sort()).toEqual(["u2", "u3"]);
  });

  test("in / notIn", async ({ runner }) => {
    await runner.run(SEED);
    const inn = (await runner.run(`orm.users.where((m) => m.name.in(["Alice", "Bob"])).all()`)) as Array<{
      id: string;
    }>;
    expect(inn.map((r) => r.id).sort()).toEqual(["u1", "u2"]);
    const notIn = (await runner.run(`orm.users.where((m) => m.name.notIn(["Alice", "Bob"])).all()`)) as Array<{
      id: string;
    }>;
    expect(notIn.map((r) => r.id)).toEqual(["u3"]);
  });

  test("contains / startsWith / endsWith", async ({ runner }) => {
    await runner.run(SEED);
    const con = (await runner.run(`orm.users.where((m) => m.email.contains("arol")).all()`)) as Array<{
      id: string;
    }>;
    expect(con.map((r) => r.id)).toEqual(["u3"]);
    const sw = (await runner.run(`orm.users.where((m) => m.email.startsWith("bob")).all()`)) as Array<{ id: string }>;
    expect(sw.map((r) => r.id)).toEqual(["u2"]);
    const ew = (await runner.run(`orm.users.where((m) => m.name.endsWith("ce")).all()`)) as Array<{ id: string }>;
    expect(ew.map((r) => r.id)).toEqual(["u1"]);
  });

  test("isNull / isNotNull", async ({ runner }) => {
    await runner.run(SEED);
    const isNull = (await runner.run(`orm.users.where((m) => m.bio.isNull()).all()`)) as Array<{ id: string }>;
    expect(isNull.map((r) => r.id)).toEqual(["u1"]);
    const isNotNull = (await runner.run(`orm.users.where((m) => m.bio.isNotNull()).all()`)) as Array<{ id: string }>;
    expect(isNotNull.map((r) => r.id).sort()).toEqual(["u2", "u3"]);
  });
});

test.describe("where() — combinators", () => {
  test("and(a, b) intersects", async ({ runner }) => {
    await runner.run(SEED);
    const rows = (await runner.run(`orm.users.where((m) => and(m.active.eq(true), m.score.gte(75))).all()`)) as Array<{
      id: string;
    }>;
    expect(rows.map((r) => r.id).sort()).toEqual(["u1", "u3"]);
  });

  test("or(a, b) unions", async ({ runner }) => {
    await runner.run(SEED);
    const rows = (await runner.run(`orm.users.where((m) => or(m.name.eq("Alice"), m.name.eq("Bob"))).all()`)) as Array<{
      id: string;
    }>;
    expect(rows.map((r) => r.id).sort()).toEqual(["u1", "u2"]);
  });

  test("not(e) inverts", async ({ runner }) => {
    await runner.run(SEED);
    const rows = (await runner.run(`orm.users.where((m) => not(m.active.eq(true))).all()`)) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["u2"]);
  });

  test("nested: and(or(...), not(...))", async ({ runner }) => {
    await runner.run(SEED);
    const rows = (await runner.run(
      `orm.users.where((m) => and(or(m.name.eq("Alice"), m.name.eq("Carol")), not(m.score.lt(80)))).all()`
    )) as Array<{ id: string }>;
    // Alice 100 keeps; Carol 75 fails not(<80).
    expect(rows.map((r) => r.id)).toEqual(["u1"]);
  });

  test("chained .where() composes with AND", async ({ runner }) => {
    await runner.run(SEED);
    const rows = (await runner.run(
      `orm.users.where((m) => m.active.eq(true)).where((m) => m.score.gt(75)).all()`
    )) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["u1"]);
  });
});
