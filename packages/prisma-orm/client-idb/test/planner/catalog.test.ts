import { describe, expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import family from "@prisma-idb/family-idb/pack";
import target from "@prisma-idb/target-idb/pack";
import { buildCatalog } from "../../src/core/planner/catalog";

const contract = defineContract({
  family,
  target,
  enums: { Tag: ["one", "two"] },
  models: {
    Item: {
      store: "items",
      key: "id",
      fields: { id: "String", a: "String", b: "String?", count: "Int", tags: "Tag[]" },
      indexes: { ab: { keyPath: ["a", "b"], unique: true }, tags: { keyPath: "tags", multiEntry: true } },
    },
    Pair: { store: "pairs", key: ["a", "b"], fields: { a: "String", b: "Int" } },
  },
});

describe("buildCatalog", () => {
  it("records storage paths, index flags, codecs, and nullability", () => {
    const c = buildCatalog(contract, "items");
    expect(c.primaryKey).toEqual({ keyPath: "id", fields: ["id"], unique: true, multiEntry: false });
    expect(c.indexes).toEqual([
      { indexName: "ab", keyPath: ["a", "b"], fields: ["a", "b"], unique: true, multiEntry: false },
      { indexName: "tags", keyPath: "tags", fields: ["tags"], unique: false, multiEntry: true },
    ]);
    expect(c.fields).toMatchObject({
      a: { codecId: "idb/string@1", nullable: false, collection: false },
      b: { nullable: true },
      count: { codecId: "idb/int32@1" },
      tags: { collection: true },
    });
  });
  it("caches by contract identity and store without mutating the contract", () => {
    const before = structuredClone(contract);
    expect(buildCatalog(contract, "items")).toBe(buildCatalog(contract, "items"));
    expect(buildCatalog(structuredClone(contract), "items")).not.toBe(buildCatalog(contract, "items"));
    expect(buildCatalog(contract, "pairs").primaryKey.keyPath).toEqual(["a", "b"]);
    expect(contract).toEqual(before);
    expect(Object.isFrozen(buildCatalog(contract, "items").indexes)).toBe(true);
    expect(Object.isFrozen(buildCatalog(contract, "items").fields["a"])).toBe(true);
  });
  it("reports an unknown store", () => {
    expect(() => buildCatalog(contract, "missing")).toThrow('Store "missing" is not in the contract');
  });
});
