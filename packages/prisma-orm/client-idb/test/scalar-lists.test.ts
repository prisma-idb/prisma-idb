import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { defineContract, type FieldSpec } from "@prisma-idb/family-idb/contract-ts";
import idbFamily from "@prisma-idb/family-idb/pack";
import idbTarget from "@prisma-idb/target-idb/pack";
import { createAutoMigratingIdbClient } from "../src/exports/client-auto";
import { buildContractSpaceFixture } from "./_contract-space-fixture";

const cases = [
  { scalar: "String", first: "a", equal: "a", second: "b" },
  { scalar: "Int", first: 1, equal: 1, second: 2 },
  { scalar: "Float", first: 1.25, equal: 1.25, second: 2.5 },
  { scalar: "BigInt", first: 1n, equal: 1n, second: 2n },
  { scalar: "Boolean", first: false, equal: false, second: true },
  { scalar: "Decimal", first: "1.0", equal: "1.00", second: "2" },
  { scalar: "DateTime", first: new Date("2026-01-01"), equal: new Date("2026-01-01"), second: new Date("2026-02-01") },
  { scalar: "Bytes", first: new Uint8Array([1]), equal: new Uint8Array([1]), second: new Uint8Array([2]) },
  { scalar: "Json", first: { a: 1, b: [true] }, equal: { b: [true], a: 1 }, second: { a: 2 } },
  { scalar: "Role", first: "ADMIN", equal: "ADMIN", second: "USER" },
] as const;
const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const client of opened.splice(0)) await client.close();
});

/** Open an isolated, migrated store with one required list and one defaulted list. */
async function fixture(scalar: string) {
  const spec = `${scalar}[]` as FieldSpec<"Role">;
  const contract = defineContract({
    family: idbFamily,
    target: idbTarget,
    enums: { Role: ["ADMIN", "USER"] },
    models: {
      Sample: {
        store: "samples",
        key: "id",
        fields: { id: "String", values: spec, defaulted: spec },
        defaults: { defaulted: [] },
      },
    },
  });
  const client = await createAutoMigratingIdbClient({
    contractSpace: buildContractSpaceFixture([contract]),
    dbName: `scalar-lists-${crypto.randomUUID()}`,
  });
  opened.push(client);
  return { client, samples: client.orm["samples"]! };
}

describe.each(cases)("$scalar lists", ({ scalar, first, equal, second }) => {
  it("stores plain arrays, applies only declared defaults and projects fields", async () => {
    const { samples } = await fixture(scalar);
    await expect(samples.create({ id: "missing" })).rejects.toThrow();
    await expect(samples.create({ id: "null-element", values: [null] })).rejects.toThrow();
    expect(await samples.create({ id: "a", values: [first] })).toEqual({ id: "a", values: [first], defaulted: [] });
    expect(await samples.createAll([{ id: "b", values: [] }]).toArray()).toEqual([
      { id: "b", values: [], defaulted: [] },
    ]);
    expect(await samples.createCount([{ id: "c", values: [] }])).toBe(1);
    expect(await samples.where({ id: "a" }).select("id").first()).toEqual({ id: "a" });
  });

  it("runs set, single push, addToSet, pull and both pop directions", async () => {
    const { samples } = await fixture(scalar);
    await samples.create({ id: "a", values: [first] });
    expect((await samples.update((u) => [u["values"]!.addToSet(second)]))?.["values"]).toEqual([first, second]);
    expect((await samples.update((u) => [u["values"]!.set([first, first])]))?.["values"]).toEqual([first, first]);
    expect((await samples.update((u) => [u["values"]!.push(second)]))?.["values"]).toEqual([first, first, second]);
    expect((await samples.update((u) => [u["values"]!.addToSet(equal)]))?.["values"]).toEqual([first, first, second]);
    if (scalar === "Json") {
      // pull compares complete elements: a partial object must preserve the larger objects.
      expect((await samples.update((u) => [u["values"]!.pull({ a: 1 })]))?.["values"]).toEqual([first, first, second]);
    }
    expect((await samples.update((u) => [u["values"]!.pull(equal)]))?.["values"]).toEqual([second]);
    expect((await samples.update((u) => [u["values"]!.pop(1)]))?.["values"]).toEqual([]);
    await samples.update({ values: [first, second] });
    expect((await samples.update((u) => [u["values"]!.pop(-1)]))?.["values"]).toEqual([second]);
    await samples.update({ values: [] });
    expect((await samples.update((u) => [u["values"]!.pop(-1)]))?.["values"]).toEqual([]);
  });

  it("resolves each bulk and upsert operation against its own row", async () => {
    const { samples } = await fixture(scalar);
    await samples
      .createAll([
        { id: "a", values: [] },
        { id: "b", values: [second] },
      ])
      .toArray();
    const rows = await samples.updateAll((u) => [u["values"]!.push(first)]).toArray();
    expect(rows.map((row) => row["values"])).toEqual([[first], [second, first]]);
    expect(await samples.updateCount((u) => [u["values"]!.addToSet(equal)])).toBe(2);
    expect(
      (
        await samples.upsert({
          where: { id: "a" },
          create: { id: "a", values: [] },
          update: (u) => [u["values"]!.push(second)],
        })
      )["values"]
    ).toEqual([first, second]);
    expect(
      (
        await samples.upsert({
          where: { id: "c" },
          create: { id: "c", values: [first] },
          update: (u) => [u["values"]!.push(second)],
        })
      )["values"]
    ).toEqual([first]);
  });

  it("compares complete lists by element codec and orders them lexicographically", async () => {
    const { samples } = await fixture(scalar);
    await samples
      .createAll([
        { id: "a", values: [] },
        { id: "b", values: [first] },
        { id: "c", values: [first, second] },
        { id: "d", values: [second] },
      ])
      .toArray();
    expect((await samples.where((m) => m["values"]!.eq([equal])).all()).map((row) => row["id"])).toEqual(["b"]);
    expect((await samples.where((m) => m["values"]!.neq([equal])).all()).map((row) => row["id"])).toEqual([
      "a",
      "c",
      "d",
    ]);
    expect((await samples.where((m) => m["values"]!.in([[equal], []])).all()).map((row) => row["id"])).toEqual([
      "a",
      "b",
    ]);
    expect((await samples.where((m) => m["values"]!.notIn([[equal], []])).all()).map((row) => row["id"])).toEqual([
      "c",
      "d",
    ]);
    expect((await samples.where((m) => m["values"]!.gt([equal])).all()).map((row) => row["id"])).toEqual(["c", "d"]);
    expect((await samples.where((m) => m["values"]!.gte([equal])).all()).map((row) => row["id"])).toEqual([
      "b",
      "c",
      "d",
    ]);
    expect((await samples.where((m) => m["values"]!.lt([equal])).all()).map((row) => row["id"])).toEqual(["a"]);
    expect((await samples.where((m) => m["values"]!.lte([equal])).all()).map((row) => row["id"])).toEqual(["a", "b"]);
    expect((await samples.orderBy({ values: "asc" }).all()).map((row) => row["id"])).toEqual(["a", "b", "c", "d"]);
    expect((await samples.orderBy({ values: "desc" }).all()).map((row) => row["id"])).toEqual(["d", "c", "b", "a"]);
  });
});

it("rejects unsupported list filters and operations even without matches", async () => {
  const { samples } = await fixture("String");
  await expect(
    samples
      .where((m) => m["values"]!.contains("x"))
      .all()
      .toArray()
  ).rejects.toThrow(/Unsupported operator/);
  await expect(samples.update((u) => [u["values"]!.push(["x"])])).rejects.toThrow();
  await expect(samples.update((u) => [u["values"]!.pop(0 as 1)])).rejects.toThrow(/pop/);
  await expect(samples.update(() => [{ operator: "$unset", field: "values" }])).rejects.toThrow(/cannot be unset/);
  await expect(samples.update((u) => [u["values"]!.push("x"), u["values"]!.pop(1)])).rejects.toThrow(/Conflicting/);
});

it("does not reinterpret unmigrated missing lists as empty", async () => {
  const { samples, client } = await fixture("String");
  await client.withTransaction(["samples"], (scope) =>
    scope.execute({ kind: "put", storeName: "samples", record: { id: "old" } } as never)
  );
  expect(await samples.findUnique("old")).toEqual({ id: "old" });
  expect(await samples.where((m) => m["values"]!.eq([])).all()).toEqual([]);
  await expect(samples.update((u) => [u["values"]!.push("x")])).rejects.toThrow(/migrate the store first/);
  expect(await samples.select("id").all()).toEqual([{ id: "old" }]);
});

it("clones declared defaults and rolls back a bulk operation if a later stored list is invalid", async () => {
  const { samples, client } = await fixture("String");
  const first = await samples.create({ id: "a", values: [] });
  (first["defaulted"] as string[]).push("local-only");
  expect((await samples.create({ id: "b", values: [] }))["defaulted"]).toEqual([]);
  await client.withTransaction(["samples"], (scope) =>
    scope.execute({ kind: "put", storeName: "samples", record: { id: "b" } } as never)
  );
  await expect(samples.updateAll((u) => [u["values"]!.push("x")]).toArray()).rejects.toThrow(/migrate the store first/);
  expect((await samples.findUnique("a"))?.["values"]).toEqual([]);
});
