/**
 * Phase 6.6 — aggregate()
 *
 * In-memory reduction over the rows matching the accumulated `.where()` filter.
 * `count()` is always a number; `sum`/`avg`/`min`/`max` are `null` over an empty
 * set (Prisma semantics). Run end-to-end against real Chromium IndexedDB.
 */
import { expect, test } from "../helpers";

test.describe("aggregate()", () => {
  test.beforeEach(async ({ runner }) => {
    await runner.run(
      `orm.users.create({ id: "u1", name: "Alice", email: "alice@test.com", bio: null, score: 1, active: true, joinedAt: new Date() })`
    );
    // views: 100, 50, 75, 200, 0 → sum 425, avg 85, min 0, max 200
    const posts: Array<[string, number, boolean]> = [
      ["p1", 100, true],
      ["p2", 50, false],
      ["p3", 75, true],
      ["p4", 200, true],
      ["p5", 0, false],
    ];
    for (const [id, views, published] of posts) {
      await runner.run(
        `orm.posts.create({ id: "${id}", authorId: "u1", title: "${id}", content: null, views: ${views}, published: ${published}, publishedAt: null })`
      );
    }
  });

  test("computes count/sum/avg/min/max over all rows", async ({ runner }) => {
    const result = await runner.run(
      `orm.posts.aggregate(agg => ({ total: agg.count(), totalViews: agg.sum("views"), avgViews: agg.avg("views"), minViews: agg.min("views"), maxViews: agg.max("views") }))`
    );
    expect(result).toEqual({ total: 5, totalViews: 425, avgViews: 85, minViews: 0, maxViews: 200 });
  });

  test("respects an accumulated where() filter", async ({ runner }) => {
    const result = await runner.run(
      `orm.posts.where({ published: true }).aggregate(agg => ({ count: agg.count(), sum: agg.sum("views") }))`
    );
    expect(result).toEqual({ count: 3, sum: 375 }); // 100 + 75 + 200
  });

  test("over an empty set: count 0, reducers null", async ({ runner }) => {
    const result = await runner.run(
      `orm.posts.where({ id: "missing" }).aggregate(agg => ({ count: agg.count(), sum: agg.sum("views"), avg: agg.avg("views") }))`
    );
    expect(result).toEqual({ count: 0, sum: null, avg: null });
  });

  test("an empty spec is rejected", async ({ runner }) => {
    await expect(runner.run(`orm.posts.aggregate(() => ({}))`)).rejects.toThrow(/at least one/);
  });
});
