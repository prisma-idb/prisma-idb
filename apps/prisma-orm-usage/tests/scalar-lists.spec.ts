import { expect, test } from "./helpers";

// Real browser coverage: fake-indexeddb cannot prove native structured-clone storage,
// transaction completion and reopening the persisted database across document navigation.
// Codec equality, defaults, projection and individual operations are covered in client-idb.
test("commits scalar-list updates to real IndexedDB across a page reload", async ({ runner, page }) => {
  await runner.run(
    'orm.scalar_list_samples.create({ id: "a", tags: ["draft"], dates: [new Date("2026-01-01")], decimals: ["1.00"] })'
  );
  await runner.run('orm.scalar_list_samples.update((u) => [u.tags.push("saved")])');
  await page.reload();
  expect(await runner.run('orm.scalar_list_samples.findUnique("a")')).toEqual({
    id: "a",
    tags: ["draft", "saved"],
    dates: ["2026-01-01T00:00:00.000Z"],
    decimals: ["1.00"],
  });
});
