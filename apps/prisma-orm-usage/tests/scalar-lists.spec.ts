import { expect, test } from "./helpers";

test("persists scalar lists with defaults, fluent updates, codec equality and projection", async ({ runner, page }) => {
  expect(await runner.run('orm.scalar_list_samples.create({ id: "a" })')).toEqual({
    id: "a",
    tags: [],
    dates: [],
    decimals: [],
  });
  await runner.run(
    'orm.scalar_list_samples.update((u) => [u.tags.push("draft"), u.dates.push(new Date("2026-01-01")), u.decimals.push("1.00")])'
  );
  expect(
    await runner.run('orm.scalar_list_samples.where((m) => m.decimals.eq(["1"])).select("id", "tags").all()')
  ).toEqual([{ id: "a", tags: ["draft"] }]);
  await runner.run('orm.scalar_list_samples.updateAll((u) => [u.tags.addToSet("draft")]).toArray()');
  await page.reload();
  expect(await runner.run('orm.scalar_list_samples.findUnique("a")')).toEqual({
    id: "a",
    tags: ["draft"],
    dates: ["2026-01-01T00:00:00.000Z"],
    decimals: ["1.00"],
  });
  expect(await runner.run('orm.scalar_list_samples.updateCount((u) => [u.tags.pull("draft")])')).toBe(1);
  expect(await runner.run('orm.scalar_list_samples.where((m) => m.tags.eq([])).select("id").all()')).toEqual([
    { id: "a" },
  ]);
});
